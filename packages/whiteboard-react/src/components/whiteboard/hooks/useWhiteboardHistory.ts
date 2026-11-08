import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { util } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { BoardHistoryModel, DEFAULT_MAX_HISTORY_BYTES } from '../utils/boardHistory';
import { canvasObjectJson, HistoryObjectCache, restorePageObjects, stringifyHistoryObject } from '../utils/boardHistoryCanvas';
import { invalidateInkBake } from '../utils/inkBake';
import { isPointerDown } from '../utils/inputActivity';
import { enforceLockedImageInvariants, notifyLockedImagesChanged } from '../utils/lockedImages';
import { markRevivedFromJson } from '../utils/pdfScrollLayout';
import { restoreRenderInvariants } from '../utils/restoreRenderInvariants';

import type { HistoryEntry, PageListEntry, PageState } from '../utils/boardHistory';
import type { PdfScrollSession } from '../utils/pdfScrollSession';
import type { WhiteboardPage } from '../types';

export interface WhiteboardHistoryRestoreContext {
  signal: AbortSignal;
  isCurrent: () => boolean;
}

/** The scope the continuous PDF layout keeps its single document-wide stack under. */
export const DOCUMENT_HISTORY_SCOPE = 'document';

export interface UseWhiteboardHistoryProps {
  canvas: Canvas | null;
  /**
   * The page on the canvas in the paged board — its own stack, as it always had. Ignored while a scroll
   * session is active: the continuous layout keeps ONE stack for the whole document.
   */
  currentPageId: string;
  /** The continuous PDF layout's session, when it owns the canvas. */
  getScrollSession?: () => PdfScrollSession | null;
  /**
   * Lets a paged restore join the editor's page-load abort/generation scheme: a page switch while the
   * restore's objects are being revived wins, and the restore writes nothing.
   */
  createRestoreContext?: () => WhiteboardHistoryRestoreContext;
  /**
   * Apply a page-list entry: `insert` puts `entry.page` back at `entry.index`, `remove` takes it out.
   * Resolves false when it could not (the entry then stays where it was).
   */
  applyPageListChange?: (action: 'insert' | 'remove', entry: PageListEntry<WhiteboardPage>) => Promise<boolean> | boolean;
  /** Memory ceiling of one stack (UTF-16 code units of the strings its entries alone hold). */
  maxHistoryBytes?: number;
  /** The user changed the board: a gesture was committed, or an undo / redo step applied. */
  onUserChange?: () => void;
}

/** What {@link UseWhiteboardHistoryReturn.applyExternal} did. */
export type ExternalApplyResult = 'applied' | 'off-canvas' | 'failed';

export interface UseWhiteboardHistoryReturn {
  /** Resolves with the entry undone (null: nothing to undo, or it could not be applied). */
  undo: () => Promise<HistoryEntry<WhiteboardPage> | null>;
  redo: () => Promise<HistoryEntry<WhiteboardPage> | null>;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Something on the canvas changed by the user's hand. The checkpoint is taken when the gesture ends
   * (no contact down): one stroke, one erase swipe, one drag = one undo step.
   */
  noteMutation: () => void;
  /** Take the pending checkpoint now (before a page switch, a flush, an undo). */
  commitNow: () => void;
  /**
   * The paged board loaded `pageId`. `sources` are the loaded objects' strings from the page JSON, in
   * order (cached for the objects so they are never serialized again while unchanged).
   */
  seedLoadedPage: (pageId: string, sources?: string[]) => void;
  /** The scroll session hydrated a page (its `onPageHydrated`). */
  seedHydratedPage: (pageId: string, objects: FabricObject[], sources: string[]) => void;
  recordPageInsert: (page: WhiteboardPage, index: number) => void;
  recordPageDelete: (page: WhiteboardPage, index: number) => void;
  /** Shared with the scroll session so its flush reuses the history's per-object strings. */
  objectCache: HistoryObjectCache;
  pause: () => void;
  resume: () => void;
  /**
   * Someone else changed page `pageId` (live co-editing): put the page's live objects into
   * `makeTarget(current strings)` without scrolling to it, and restart its undo history there (undoing
   * onto a state recorded before their change would delete their ink). `off-canvas` = the page is not on
   * the canvas; the caller updates its stored JSON instead. Queued with undo / redo.
   */
  applyExternal: (pageId: string, makeTarget: (live: PageState) => PageState) => Promise<ExternalApplyResult>;
}

/** How often a pending checkpoint re-checks for the contact to lift. */
const GESTURE_POLL_MS = 48;

interface LivePage {
  pageId: string;
  objects: FabricObject[];
  state: PageState;
}

function isTrackable(object: FabricObject): boolean {
  return !(object as FabricObject & { excludeFromExport?: boolean }).excludeFromExport;
}

export function useWhiteboardHistory({
  canvas,
  currentPageId,
  getScrollSession,
  createRestoreContext,
  applyPageListChange,
  maxHistoryBytes = DEFAULT_MAX_HISTORY_BYTES,
  onUserChange,
}: UseWhiteboardHistoryProps): UseWhiteboardHistoryReturn {
  const modelRef = useRef<BoardHistoryModel<WhiteboardPage> | null>(null);

  modelRef.current ??= new BoardHistoryModel<WhiteboardPage>({ maxBytes: maxHistoryBytes });

  const model = modelRef.current;
  const objectCacheRef = useRef<HistoryObjectCache | null>(null);

  objectCacheRef.current ??= new HistoryObjectCache();

  const objectCache = objectCacheRef.current;

  // Everything the async paths read lives in refs: an undo awaited across a page switch, or a gesture
  // timer armed before one, must act on the board as it is NOW, not as the closure saw it.
  const canvasRef = useRef(canvas);
  const currentPageIdRef = useRef(currentPageId);
  const getScrollSessionRef = useRef(getScrollSession);
  const createRestoreContextRef = useRef(createRestoreContext);
  const applyPageListChangeRef = useRef(applyPageListChange);

  canvasRef.current = canvas;
  currentPageIdRef.current = currentPageId;
  getScrollSessionRef.current = getScrollSession;
  createRestoreContextRef.current = createRestoreContext;
  applyPageListChangeRef.current = applyPageListChange;
  const onUserChangeRef = useRef(onUserChange);

  onUserChangeRef.current = onUserChange;

  const pausedRef = useRef(false);
  const applyingRef = useRef(false);
  const pendingRef = useRef(false);
  const gestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [canUndo, setCanUndoState] = useState(false);
  const [canRedo, setCanRedoState] = useState(false);
  // Mirrored in refs so a checkpoint per stroke skips the setState (and the editor re-render) when the
  // flags did not move.
  const canUndoRef = useRef(false);
  const canRedoRef = useRef(false);

  const scope = useCallback((): string => {
    return getScrollSessionRef.current?.() ? DOCUMENT_HISTORY_SCOPE : currentPageIdRef.current;
  }, []);

  const updateFlags = useCallback(() => {
    const key = scope();
    // A stroke whose checkpoint is still pending is already undoable (undo commits it first).
    const nextUndo = model.canUndo(key) || pendingRef.current;
    const nextRedo = model.canRedo(key) && !pendingRef.current;

    if (canUndoRef.current !== nextUndo) {
      canUndoRef.current = nextUndo;
      setCanUndoState(nextUndo);
    }

    if (canRedoRef.current !== nextRedo) {
      canRedoRef.current = nextRedo;
      setCanRedoState(nextRedo);
    }
  }, [model, scope]);

  /** The pages on the canvas now, with their current states (unchanged objects cost a cache hit). */
  const capture = useCallback((): LivePage[] => {
    const liveCanvas = canvasRef.current;

    if (!liveCanvas) return [];

    const session = getScrollSessionRef.current?.() ?? null;

    if (session) {
      return session.historyPages().map(({ key, objects, pageId }) => ({
        objects,
        pageId,
        state: objects.map((object) =>
          objectCache.get(object, key, () => stringifyHistoryObject(session.historyObjectJson(pageId, object))),
        ),
      }));
    }

    const pageId = currentPageIdRef.current;

    if (!pageId) return [];

    const key = `paged:${pageId}`;
    const objects = liveCanvas.getObjects().filter(isTrackable);

    return [
      {
        objects,
        pageId,
        state: objects.map((object) =>
          objectCache.get(object, key, () => stringifyHistoryObject(canvasObjectJson(liveCanvas, object))),
        ),
      },
    ];
  }, [objectCache]);

  const clearGestureTimer = useCallback(() => {
    if (gestureTimerRef.current !== null) {
      clearTimeout(gestureTimerRef.current);
      gestureTimerRef.current = null;
    }
  }, []);

  const commitNow = useCallback(() => {
    clearGestureTimer();

    if (!pendingRef.current) return;

    // A page load / restore owns the canvas: what is on it is not the user's action. The mutation that
    // armed this checkpoint is folded into the next one (or into the load's seed).
    if (pausedRef.current || applyingRef.current) return;

    pendingRef.current = false;
    model.commit(
      scope(),
      capture().map(({ pageId, state }) => ({ pageId, state })),
    );
    updateFlags();
    onUserChangeRef.current?.();
  }, [capture, clearGestureTimer, model, scope, updateFlags]);

  const noteMutation = useCallback(() => {
    if (pausedRef.current || applyingRef.current || !canvasRef.current) return;

    const wasPending = pendingRef.current;

    pendingRef.current = true;

    if (!wasPending) updateFlags();

    if (gestureTimerRef.current !== null) return;

    const check = () => {
      gestureTimerRef.current = null;

      // Still writing / erasing / dragging: the gesture is not over.
      if (isPointerDown()) {
        gestureTimerRef.current = setTimeout(check, GESTURE_POLL_MS);

        return;
      }

      commitNow();
    };

    gestureTimerRef.current = setTimeout(check, 0);
  }, [commitNow, updateFlags]);

  const seedLoadedPage = useCallback(
    (pageId: string, sources?: string[]) => {
      const liveCanvas = canvasRef.current;

      if (!liveCanvas) return;

      const key = `paged:${pageId}`;
      const objects = liveCanvas.getObjects().filter(isTrackable);

      if (sources && sources.length === objects.length) {
        objects.forEach((object, index) => objectCache.seed(object, key, sources[index] as string));
      }

      const state = objects.map((object) =>
        objectCache.get(object, key, () => stringifyHistoryObject(canvasObjectJson(liveCanvas, object))),
      );

      // Whatever was pending belonged to the canvas before this load.
      pendingRef.current = false;
      clearGestureTimer();
      model.seedPage(pageId, state);
      updateFlags();
    },
    [clearGestureTimer, model, objectCache, updateFlags],
  );

  const seedHydratedPage = useCallback(
    (pageId: string, objects: FabricObject[], sources: string[]) => {
      const state: PageState = sources.length === objects.length ? sources : [];

      model.seedPage(pageId, state);
      updateFlags();
    },
    [model, updateFlags],
  );

  const recordPageInsert = useCallback(
    (page: WhiteboardPage, index: number) => {
      commitNow();
      model.recordPageList(scope(), 'insert-page', page, page.id, index);
      updateFlags();
    },
    [commitNow, model, scope, updateFlags],
  );

  const recordPageDelete = useCallback(
    (page: WhiteboardPage, index: number) => {
      commitNow();
      model.recordPageList(scope(), 'delete-page', page, page.id, index, page.canvasJSON?.length ?? 0);
      updateFlags();
    },
    [commitNow, model, scope, updateFlags],
  );

  /** Put page `pageId` into `target`. Scroll layout: brought into view first. */
  const restorePage = useCallback(
    async (pageId: string, target: PageState, reveal = true): Promise<boolean> => {
      const liveCanvas = canvasRef.current;

      if (!liveCanvas) return false;

      const session = getScrollSessionRef.current?.() ?? null;

      if (session) {
        if (reveal && !(await session.revealPage(pageId))) return false;

        const live = capture().find((page) => page.pageId === pageId);

        if (!live) return false;

        const result = await session.restorePageState(pageId, live.state, target);

        if (!result?.ok) return false;

        const key = session.historyPages().find((page) => page.pageId === pageId)?.key;

        if (key) result.objects.forEach((object, index) => objectCache.seed(object, key, target[index] as string));

        return true;
      }

      if (pageId !== currentPageIdRef.current) return false;

      const live = capture()[0];

      if (!live) return false;

      const restore = createRestoreContextRef.current?.();
      const result = await restorePageObjects({
        canvas: liveCanvas,
        enliven: async (values) => {
          const objects = await util.enlivenObjects<FabricObject>(
            values.map((value) => JSON.parse(value) as Record<string, unknown>),
            restore ? { signal: restore.signal } : undefined,
          );

          markRevivedFromJson(objects);

          return objects;
        },
        isCurrent: () => canvasRef.current === liveCanvas && currentPageIdRef.current === pageId && (restore?.isCurrent() ?? true),
        live: live.objects,
        liveState: live.state,
        target,
      });

      if (!result.ok) return false;

      const key = `paged:${pageId}`;

      result.objects.forEach((object, index) => objectCache.seed(object, key, target[index] as string));
      // The page is in `target` from here on: a failure while repainting must not report the step as
      // unapplied (the model would then disagree with the canvas).
      try {
        invalidateInkBake(liveCanvas);
        restoreRenderInvariants(liveCanvas);
        // A restored state is raw object state: re-assert the pin invariants so undo can't bring a
        // pinned image back as a visible/erasable object, and notify so the layer painting pins repaints.
        enforceLockedImageInvariants(liveCanvas);
        notifyLockedImagesChanged(liveCanvas);
        liveCanvas.requestRenderAll();
      } catch {
        // painting only
      }

      return true;
    },
    [capture, objectCache],
  );

  const applyEntry = useCallback(
    async (entry: HistoryEntry<WhiteboardPage>, direction: 'undo' | 'redo'): Promise<boolean> => {
      if (entry.kind === 'content') {
        // Several pages (a stroke dragged across a page edge): apply all; a partial failure is
        // reported, and the pages already restored stay restored (the stacks are reset below).
        let applied = 0;

        for (const change of entry.changes) {
          if (await restorePage(change.pageId, direction === 'undo' ? change.before : change.after)) applied += 1;
        }

        return applied === entry.changes.length;
      }

      const apply = applyPageListChangeRef.current;

      if (!apply) return false;

      const insert = (entry.kind === 'delete-page') === (direction === 'undo');

      return apply(insert ? 'insert' : 'remove', entry);
    },
    [restorePage],
  );

  const step = useCallback(
    async (direction: 'undo' | 'redo'): Promise<HistoryEntry<WhiteboardPage> | null> => {
      if (!canvasRef.current || applyingRef.current || pausedRef.current) return null;

      // The stroke just drawn becomes its own step before anything is undone — otherwise an undo
      // pressed within the checkpoint delay would skip it AND the step before it.
      commitNow();

      const key = scope();
      const entry = direction === 'undo' ? model.beginUndo(key) : model.beginRedo(key);

      if (!entry) {
        updateFlags();

        return null;
      }

      applyingRef.current = true;

      let ok = false;

      try {
        ok = await applyEntry(entry, direction);
      } catch {
        ok = false;
      } finally {
        applyingRef.current = false;
      }

      if (ok) {
        if (direction === 'undo') model.settleUndo(key, entry);
        else model.settleRedo(key, entry);
      } else if (entry.kind === 'content' && entry.changes.length > 1) {
        // Half-applied: the pages no longer match any recorded state together. Re-seed from the canvas
        // (which clears the stacks that mention them) rather than undo onto a mixed state later.
        for (const page of capture()) model.seedPage(page.pageId, page.state);
      } else if (direction === 'undo') {
        model.cancelUndo(key, entry);
      } else {
        model.cancelRedo(key, entry);
      }

      updateFlags();
      if (ok) onUserChangeRef.current?.();

      return ok ? entry : null;
    },
    [applyEntry, capture, commitNow, model, scope, updateFlags],
  );

  const external = useCallback(
    async (pageId: string, makeTarget: (live: PageState) => PageState): Promise<ExternalApplyResult> => {
      if (!canvasRef.current || pausedRef.current) return 'failed';

      // The user's own last stroke is committed first, so it is in the live state the target builds on.
      commitNow();

      const live = capture().find((page) => page.pageId === pageId);

      if (!live) return 'off-canvas';

      const target = makeTarget(live.state);

      applyingRef.current = true;

      let ok = false;

      try {
        ok = target.length === live.state.length && target.every((value, index) => value === live.state[index]) ? true : await restorePage(pageId, target, false);
      } catch {
        ok = false;
      } finally {
        applyingRef.current = false;
      }

      // Applied or not, the page's undo history restarts from what is on the canvas now.
      const now = capture().find((page) => page.pageId === pageId);

      if (now) model.seedPage(pageId, now.state);
      updateFlags();

      return ok ? 'applied' : 'failed';
    },
    [capture, commitNow, model, restorePage, updateFlags],
  );

  // Steps run one after another: a quick double tap on undo is two undos, not one undo and a tap
  // dropped because the first restore was still reviving objects.
  const stepQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(
    (direction: 'undo' | 'redo') => {
      const run = stepQueueRef.current.then(() => step(direction));

      stepQueueRef.current = run.catch(() => null);

      return run;
    },
    [step],
  );
  const undo = useCallback(() => enqueue('undo'), [enqueue]);
  const applyExternal = useCallback(
    (pageId: string, makeTarget: (live: PageState) => PageState) => {
      const run = stepQueueRef.current.then(() => external(pageId, makeTarget));

      stepQueueRef.current = run.catch(() => null);

      return run;
    },
    [external],
  );
  const redo = useCallback(() => enqueue('redo'), [enqueue]);

  const pause = useCallback(() => {
    pausedRef.current = true;
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    updateFlags();
  }, [updateFlags]);

  // The flags follow the page in view (paged board) / the session coming and going.
  useEffect(() => {
    updateFlags();
  }, [currentPageId, canvas, updateFlags]);

  useEffect(() => clearGestureTimer, [clearGestureTimer]);

  return useMemo(
    () => ({
      undo,
      redo,
      canUndo,
      canRedo,
      noteMutation,
      commitNow,
      seedLoadedPage,
      seedHydratedPage,
      recordPageInsert,
      recordPageDelete,
      objectCache,
      pause,
      resume,
      applyExternal,
    }),
    [
      undo,
      redo,
      canUndo,
      canRedo,
      noteMutation,
      commitNow,
      seedLoadedPage,
      seedHydratedPage,
      recordPageInsert,
      recordPageDelete,
      objectCache,
      pause,
      resume,
      applyExternal,
    ],
  );
}
