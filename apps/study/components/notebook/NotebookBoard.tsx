import type { WhiteboardDocument, WhiteboardStorage } from '@repo/whiteboard-core';
import type { EditorViewport, RulerEdgesRef, WhiteboardLiveHandle, WhiteboardPdfImportedEvent } from '@repo/whiteboard-react';
import type { BoardDoc, LiveOps } from '@/lib/notebooks/live-merge';
import type { LivePerson, LiveStatus } from '@/lib/notebooks/live';
import type {
  BoardAiService,
  ConceptMap,
  MergeOverlaysResult,
  WhiteboardSelectionAction,
  WhiteboardStorageUpdatedEventDetail,
} from '@repo/whiteboard-react';
import type { OpenNotebookSource, UploadOutcome } from '@/lib/notebooks/sync';
import type { ReactNode } from 'react';
import type { PageImageRenderer } from '@/lib/notebooks/page-renders';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChromeInset, useWhiteboardStorage, WHITEBOARD_STORAGE_UPDATED_EVENT } from '@repo/whiteboard-react';
import {
  AlertTriangle,
  ArrowLeft,
  CloudOff,
  CloudUpload,
  EyeOff,
  FileText,
  NotebookPen,
  Palette,
  RefreshCw,
  Ruler,
  ZoomOut,
} from 'lucide-react';
import dynamic from 'next/dynamic';

import { ClaudeFeedback } from '@/components/notebook/ClaudeFeedback';
import { RulerOverlay } from '@/components/notebook/RulerOverlay';
import { useRulerPresets, usePutRulerPreset } from '@/lib/api/hooks';
import { ActionButton, BOARD_CHIP, BOARD_CHIP_OVERRIDE } from '@/components/ui/primitives';
import { BOARD_DRAW_EVENT, boardGraphInput, clearBoardDraw, peekBoardDraw } from '@/features/conceptmaps/lib/boardDraw';
import { recordPhoneImage } from '@/features/conceptmaps/lib/pageImages';
import { browserStore } from '@/features/conceptmaps/notes/links';
import {
  inboxIdFromPdfFileName,
  InsertFromPhoneButton,
  markItemUsed,
  PageQueueChip,
  pdfWhollyOnPage,
  restoreInboxPdfAsset,
  usePageInboxQueue,
} from '@/features/inbox';
import { useAutoColorConfig } from '@/lib/ink/autoColorConfig';
import { useInkModels } from '@/lib/ink/models';
import { nativeInkRecognizer } from '@/lib/ink/nativeRecognizer';
import { inkEnabledForPage, savePageInkOverride, useInkSettings } from '@/lib/ink/settings';
import { syncPageRenders } from '@/lib/notebooks/page-renders';
import { markSyncedVersionDirty, readSyncedVersion, writeSyncedVersion } from '@/lib/notebooks/pages-cache';
import { pdfAssetIdsOf, queuePdfAssetUpload, restorePagePdfAsset } from '@/lib/notebooks/pdf-assets-sync';
import { LiveSession, presenceLine } from '@/lib/notebooks/live';
import { fetchBoardVersion, fetchLatestBoard, openLiveNotebook, openLiveStream, pushLiveOps } from '@/lib/notebooks/live-api';
import { applyOps, ensureDocIds, itemsOnlyFor } from '@/lib/notebooks/live-merge';
import { getPage } from '@/lib/api/endpoints';
import { parseJwt, readSessionToken } from '@/lib/auth';
import { LivePeopleChip } from '@/features/share/components/PageVersions';
import { useBoardTheme } from '@/lib/notebooks/board-theme';
import { usePaperSpacingDefaults } from '@/lib/notebooks/paper-settings';
import { useNotebookFillScreen } from '@/lib/notebooks/fill-screen';
import { useHidePenShortcuts } from '@/lib/notebooks/pen-shortcuts-button';
import { studyFileBridge } from '@/lib/platform/file-export';
import {
  forceUploadOverRemote,
  openNotebookDocument,
  replaceWithRemote,
  uploadNotebookDocument,
} from '@/lib/notebooks/sync';

const WhiteboardEditor = dynamic(() => import('@repo/whiteboard-react').then((mod) => mod.WhiteboardEditor), {
  ssr: false,
  loading: () => <BoardMessage>Loading the board…</BoardMessage>,
});

function BoardMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className='bg-st-bg flex h-full w-full items-center justify-center'>
      <div className='rounded-st border-st-clay-edge bg-st-surface text-st-fg shadow-clay border-2 px-4 py-2 text-sm font-medium'>
        {children}
      </div>
    </div>
  );
}

type SyncState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'uploading' }
  | { kind: 'synced'; at: number }
  | { kind: 'offline' }
  | { kind: 'conflict'; message: string }
  | { kind: 'error'; message: string };

const FREE_ZOOM_KEY = 'study_board_free_zoom';
const UPLOAD_DEBOUNCE_MS = 2_500;
/**
 * Page images for the Study MCP (`lib/notebooks/page-renders`) are drawn only after the board has been
 * left alone this long — a full-page render is real main-thread work, and it must never land mid-stroke.
 * Leaving the board renders right away.
 */
const RENDER_QUIET_MS = 20_000;

export interface NotebookBoardProps {
  pageId: string;
  title: string;
  onBack: () => void;
  /** Builds the first document when neither this device nor the backend has one (PDF import). */
  seed?: (storage: WhiteboardStorage) => Promise<WhiteboardDocument | null>;
  /** Progress text while `seed` (or `restorePdfAsset`) runs (e.g. "Rendering PDF 3/12"). */
  seedProgress?: string | null;
  /**
   * The backend's board JSON carries only page refs to its PDFs; the board uploads the files themselves
   * after a save and fetches a missing one from the server first. When the server has no copy either
   * (imported on a device that never synced it), this re-downloads the PDF from the host's own source and
   * stores it under `assetId` — without either the pages open blank.
   */
  restorePdfAsset?: (storage: WhiteboardStorage, assetId: string) => Promise<void>;
  /** Extra controls for the top-right cluster, next to the sync chip (e.g. «Make questions»). */
  topRight?: ReactNode;
  /**
   * Typed body of a page Claude created through MCP (`add_note_page`): markdown + LaTeX. While the
   * board underneath is still empty it is shown as a read-only sheet with an «Open board» button;
   * once there is ink the board wins and the text stays one tap away.
   */
  typedMarkdown?: string | null;
  /** Board AI (lasso ask, generate, page check, concept map) — `useStudyBoardAi(pageId, classId)` from '@/features/tutor'. */
  boardAi?: BoardAiService;
  /** View-only (pan/zoom/scroll, no ink, no toolbar) — the host offers its own «Annotate» switch. */
  readOnly?: boolean;
  /** Drop the editor's window chrome (back / fullscreen) when the board is a pane inside a host screen. */
  hideChrome?: boolean;
  /** A pane, not the whole screen: no zoom-lock / quick-pen / page-manager floaters (no pager when read-only). */
  embedded?: boolean;
  /** An image to place on the current page (e.g. a slide photo); the host clears it in `onImageInserted`. */
  pendingImage?: File | null;
  onImageInserted?: () => void;
  /** A PDF whose pages are appended to this note (the editor's import sheet opens on it); cleared in `onPdfInserted`. */
  pendingPdf?: File | null;
  onPdfInserted?: () => void;
  /** A PDF (or deck) was imported into the board: the file's name, for a host that renames a default-named note. */
  onPdfFileImported?: (fileName: string) => void;
  /** Host buttons on the board's selection bar (e.g. «Concept map»). */
  extraSelectionActions?: readonly WhiteboardSelectionAction[];
  /** A picture file landed on the board (picker, phone, inbox): hosts offer «Make concept map». */
  onImagePlaced?: (file: File) => void;
  /** Host layers over the board (absolutely positioned; e.g. the concept strip and its sheet). */
  overlay?: ReactNode;
  /** `'paged'` = one page at a time (a board exam: one question per page). Default `'scroll'`. */
  pdfLayout?: 'paged' | 'scroll';
  /** Filled by the editor: every page's ink overlay + geometry, in order (a board exam grades from it). */
  buildMergeOverlaysRef?: React.MutableRefObject<(() => Promise<MergeOverlaysResult | null>) | null>;
  /**
   * Someone besides the owner may edit this page (sharing, "Can edit"): changes go out in small batches
   * and everyone else's come in live; never a "keep mine / keep theirs" choice. See lib/notebooks/live.ts.
   */
  live?: boolean;
}

const newClientId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * The board for one notebook page. Opens the document (device copy → backend → seed → blank) into the
 * whiteboard IndexedDB, mounts the editor on it, and pushes every autosave to the pages API with a
 * debounce. Offline edits stay on the device and are retried when the network comes back.
 */
/** A board with no ink and no imported pages — the state a page created by MCP arrives in. */
function isBoardEmpty(doc: WhiteboardDocument | null): boolean {
  if (!doc) return true;

  return doc.pages.every((page) => !hasInk(page.canvasJSON) && !page.pdfAssetId && !page.pdfImageUrl);
}

/** A saved Fabric scene with no objects (the board was opened, never drawn on) holds no ink. */
function hasInk(canvasJSON: string | undefined): boolean {
  if (!canvasJSON?.trim()) return false;
  try {
    const scene = JSON.parse(canvasJSON) as { objects?: unknown[] };

    return !Array.isArray(scene.objects) || scene.objects.length > 0;
  } catch {
    return true;
  }
}

// Markdown + KaTeX renderer shared with the question bank (client-only).
const Markdown = dynamic(() => import('@/features/bank').then((mod) => mod.Markdown), { ssr: false });

function TypedNoteSheet({
  title,
  markdown,
  onOpenBoard,
  onBack,
  actions,
}: {
  title: string;
  markdown: string;
  onOpenBoard: () => void;
  onBack: () => void;
  /** Header chips before «Open board» (the «waiting from Claude» queue). */
  actions?: ReactNode;
}) {
  return (
    <div className='bg-st-bg flex h-full w-full flex-col'>
      <header className='border-st-line bg-st-surface flex items-center gap-3 border-b px-4 py-3'>
        <ActionButton className='min-h-10' onClick={onBack}>
          <ArrowLeft className='h-4 w-4' /> Back
        </ActionButton>
        <h1 className='text-st-fg min-w-0 flex-1 truncate text-base font-semibold'>{title}</h1>
        <span className='text-st-muted hidden text-xs sm:inline'>Typed note from Claude · read-only</span>
        {actions}
        <ActionButton variant='primary' onClick={onOpenBoard}>
          <NotebookPen className='h-4 w-4' /> Open board
        </ActionButton>
      </header>
      <div className='flex-1 overflow-y-auto px-6 py-8'>
        <article className='bg-st-surface border-st-clay-edge rounded-st-lg shadow-clay mx-auto max-w-3xl border-2 px-8 py-7'>
          <Markdown text={markdown} />
        </article>
      </div>
    </div>
  );
}

/**
 * The PDF assets the document's pages render from (`all`), and those this device's storage does not
 * hold (`missing`, + their file name).
 */
async function pdfAssetsOf(
  storage: WhiteboardStorage,
  pageId: string,
): Promise<{ all: string[]; missing: { id: string; sourceName: string | undefined }[] }> {
  const doc = await storage.loadWhiteboard(pageId);
  const byId = new Map<string, string | undefined>();

  for (const page of doc?.pages ?? []) {
    if (page.pdfAssetId && !byId.has(page.pdfAssetId)) byId.set(page.pdfAssetId, page.pdfSourceName);
  }
  const assets = Array.from(byId, ([id, sourceName]) => ({ id, sourceName }));
  const present = await Promise.all(assets.map(({ id }) => storage.loadPdfAsset(id).then((asset) => asset !== null)));

  return { all: assets.map(({ id }) => id), missing: assets.filter((_, index) => !present[index]) };
}

export function NotebookBoard({
  pageId,
  title,
  onBack,
  seed,
  seedProgress,
  restorePdfAsset,
  topRight,
  typedMarkdown,
  boardAi,
  readOnly = false,
  hideChrome = false,
  embedded = false,
  pendingImage = null,
  onImageInserted,
  pendingPdf = null,
  onPdfInserted,
  extraSelectionActions,
  onImagePlaced,
  overlay,
  pdfLayout = 'scroll',
  buildMergeOverlaysRef,
  onPdfFileImported,
  live = false,
}: NotebookBoardProps) {
  // The title only seeds a brand-new document; a rename must not re-open (and so remount) the board.
  const titleRef = useRef(title);

  titleRef.current = title;
  const storage = useWhiteboardStorage();
  const paperSpacingDefaults = usePaperSpacingDefaults();
  const boardTheme = useBoardTheme();
  const hidePenShortcuts = useHidePenShortcuts();
  const fillScreen = useNotebookFillScreen();
  const autoColor = useAutoColorConfig(pageId);
  const inkSettings = useInkSettings();
  const inkOnHere = inkEnabledForPage(inkSettings, pageId);
  const inkModelsReady = useInkModels().state === 'ready';
  // The top-right cluster shares the row with the editor's toolbar: publish its width as the editor's
  // end-side chrome inset so the toolbar (expanded or not) lays out beside it, never under it.
  const topEndClusterRef = useChromeInset('end');
  const [boardRoot, setBoardRoot] = useState<HTMLDivElement | null>(null);
  // The viewport zoom, for the ruler's page scale.
  const [boardZoom, setBoardZoom] = useState(1);
  // Typed sheet vs board: decided once the document is open (empty board → sheet), overridable by «Open board».
  const [boardEmpty, setBoardEmpty] = useState<boolean | null>(null);
  const [forceBoard, setForceBoard] = useState(false);
  // «Typed note» on the board: back to Claude's text after the board has ink.
  const [forceSheet, setForceSheet] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [rulerOn, setRulerOn] = useState(false);
  // Ruler presets (Claude or the student saved them for a board page): the editor's live viewport lets the ruler
  // pin its 0 end to a paper position; `viewportTick` re-renders the overlay when it moves.
  const viewportRef = useRef<(() => EditorViewport | null) | null>(null);
  const [viewportTick, setViewportTick] = useState(0);
  const rulerPresets = useRulerPresets(pageId);
  const putRulerPreset = usePutRulerPreset(pageId);
  const rulerPageNo = (viewportRef.current?.()?.pageIndex ?? 0) + 1;
  const rulerPreset = rulerPresets.data?.[rulerPageNo] ?? null;
  const autoRulerKey = useRef('');
  // «Free zoom»: unlocks the board's fit-width zoom floor and pan cage; remembered per device.
  const [freeZoom, setFreeZoom] = useState(false);
  useEffect(() => {
    setFreeZoom(browserStore()?.getItem(FREE_ZOOM_KEY) === '1');
  }, []);
  const toggleFreeZoom = useCallback(() => {
    setFreeZoom((on) => {
      try {
        browserStore()?.setItem(FREE_ZOOM_KEY, on ? '0' : '1');
      } catch {
        // storage blocked: the toggle still works for this session
      }

      return !on;
    });
  }, []);
  // Filled by the ruler overlay, read by the editor to straighten a stroke drawn along its edge.
  const rulerEdgesRef = useRef<RulerEdgesRef['current']>(null) as RulerEdgesRef;
  const [opened, setOpened] = useState<{ pageId: string; source: OpenNotebookSource } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncState>({ kind: 'idle' });
  // --- live co-editing (a page someone else may edit too)
  // A page that became shared while open switches over on its first conflicting save.
  const [switchedLive, setSwitchedLive] = useState(false);
  const liveMode = (live || switchedLive) && !readOnly;
  const liveBoardRef = useRef<WhiteboardLiveHandle | null>(null);
  // The live session reads the storage through this, so a storage change never restarts the session.
  const storageRef = useRef<WhiteboardStorage | null>(null);

  storageRef.current = storage.storage;
  const liveSessionRef = useRef<LiveSession | null>(null);
  const liveBaseRef = useRef<Awaited<ReturnType<typeof openLiveNotebook>>['base']>(null);
  const clientIdRef = useRef<string>('');
  const [people, setPeople] = useState<LivePerson[]>([]);
  // Bumped to reload the editor on the stored board (someone added, removed or moved a page).
  const [boardGeneration, setBoardGeneration] = useState(0);

  clientIdRef.current ||= newClientId();
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const uploadTimerRef = useRef<number | null>(null);
  const renderPageImageRef = useRef<PageImageRenderer | null>(null);
  const renderTimerRef = useRef<number | null>(null);
  const uploadingRef = useRef(false);
  const dirtyRef = useRef(false);
  // «Insert from phone»: one photo at a time through the editor's own image insert (viewport centre,
  // one object → one undo step). The host's `pendingImage` goes first when both are set.
  const [phoneImage, setPhoneImage] = useState<File | null>(null);
  // Remembered as a phone photo on this page: «Map the photo» reads its terms first.
  const insertPhoneImage = useCallback(
    (file: File, item: { id: string }) => {
      recordPhoneImage(pageId, file, item.id);
      setPhoneImage(file);
    },
    [pageId],
  );
  // «Insert from phone» on a PDF: its pages are appended through the editor's import sheet.
  const [phonePdf, setPhonePdf] = useState<File | null>(null);
  // «N waiting from Claude»: inbox items Claude filed into this note, appended one at a time on a tap
  // through the same two phone paths (photo → image insert, PDF → import sheet, pages at the end).
  // A PDF Claude filed in twice: the sheet would refuse it (Import disabled), so the queue skips it.
  const queuedPdfOnPage = useCallback(
    async (file: File) => {
      const target = storage.storage;

      if (!target) return false;
      const doc = await target.loadWhiteboard(pageId);
      const pages = (doc?.pages ?? []).filter((page) => page.pdfSourceName === file.name);
      const assetIds = Array.from(new Set(pages.flatMap((page) => (page.pdfAssetId ? [page.pdfAssetId] : []))));
      const assets = new Map(
        await Promise.all(assetIds.map(async (id) => [id, await target.loadPdfAsset(id)] as const)),
      );

      return pdfWhollyOnPage({ pages, assets, fileName: file.name, fileSize: file.size });
    },
    [pageId, storage.storage],
  );
  const pageQueue = usePageInboxQueue({
    pageId,
    enabled: !readOnly,
    placeImage: insertPhoneImage,
    placePdf: setPhonePdf,
    pdfOnPage: queuedPdfOnPage,
  });
  const { imageHandled: queueImageHandled, pdfImported: queuePdfImported } = pageQueue;
  const handleImageInserted = useCallback(() => {
    if (pendingImage) {
      onImageInserted?.();
    } else {
      setPhoneImage(null);
      queueImageHandled();
    }
  }, [onImageInserted, pendingImage, queueImageHandled]);
  const handlePdfInserted = useCallback(() => {
    if (pendingPdf) onPdfInserted?.();
    else setPhonePdf(null);
  }, [onPdfInserted, pendingPdf]);
  // An inbox PDF counts as used once its pages are in — not when the import sheet opens (Cancel is not a use).
  const handlePdfImported = useCallback(
    (event: WhiteboardPdfImportedEvent) => {
      const itemId = inboxIdFromPdfFileName(event.sourceFile.name);

      // An inbox PDF's file name is a `phone-<id>.pdf` handle, not a title.
      if (!itemId) {
        if (!readOnly) onPdfFileImported?.(event.sourceFile.name);

        return;
      }
      void markItemUsed(itemId);
      queuePdfImported(itemId);
    },
    [onPdfFileImported, queuePdfImported, readOnly],
  );
  // «Draw on board» (concept maps): a reference map queued for this page is drawn in hand ink once the
  // document is open — on mount, or right away when it is queued while the board is already open.
  const [pendingMap, setPendingMap] = useState<ConceptMap | null>(null);
  // A page that opens with a preset shows the ruler by itself, once per saved preset.
  useEffect(() => {
    if (!rulerPreset || readOnly) return;

    const key = `${pageId}:${rulerPageNo}:${rulerPreset.updatedAt}`;

    if (autoRulerKey.current === key) return;

    autoRulerKey.current = key;
    setRulerOn(true);
  }, [pageId, readOnly, rulerPageNo, rulerPreset]);

  const isOpen = Boolean(opened && opened.pageId === pageId);

  useEffect(() => {
    if (!isOpen || readOnly) return;
    let cancelled = false;
    const pick = () => {
      const graph = peekBoardDraw(browserStore(), pageId);

      if (!graph) return;
      void import('@repo/whiteboard-react').then((mod) => {
        if (cancelled) return;
        const parsed = mod.parseConceptMap(boardGraphInput(graph));

        if (parsed) setPendingMap({ ...parsed, serverLayout: true });
        else clearBoardDraw(browserStore(), pageId);
      });
    };
    const handleQueued = (event: Event) => {
      if ((event as CustomEvent<{ pageId?: string }>).detail?.pageId === pageId) pick();
    };

    pick();
    window.addEventListener(BOARD_DRAW_EVENT, handleQueued);

    return () => {
      cancelled = true;
      window.removeEventListener(BOARD_DRAW_EVENT, handleQueued);
    };
  }, [isOpen, pageId, readOnly]);

  const handleConceptMapDrawn = useCallback(() => {
    // Drawn or not, it is not retried on every open: the button queues it again.
    clearBoardDraw(browserStore(), pageId);
    setPendingMap(null);
  }, [pageId]);

  // --- open
  useEffect(() => {
    if (!storage.isReady || !storage.storage) return;
    let cancelled = false;
    // Re-opening a board that is on screen (it just turned live): save what the editor holds first, while
    // it is still mounted, so the live open merges it instead of reading an older copy.
    const saved = flushRef.current ? flushRef.current().catch(() => undefined) : Promise.resolve();

    setOpened(null);
    setOpenError(null);
    const target = storage.storage;

    const options = {
      pageId,
      title: titleRef.current,
      storage: target,
      seed: seed ? () => seed(target) : undefined,
    };
    const opening = liveMode
      ? saved.then(() => openLiveNotebook(options)).then((result) => {
          liveBaseRef.current = result.base;

          return { source: result.source, remoteVersion: result.base?.version ?? null };
        })
      : saved.then(() => openNotebookDocument(options));

    opening
      .then(async (result) => {
        // Before the editor mounts, so the PDF renders under the ink on the first paint. The server's copy
        // first (any PDF this account or the page owner saved); else a PDF that came from the phone inbox
        // is fetched from there, and any other asset is the host's (its own source file).
        const assets = await pdfAssetsOf(target, pageId).catch(() => ({ all: [] as string[], missing: [] }));

        if (result.source !== 'seed' && result.source !== 'blank') {
          for (const asset of assets.missing) {
            if (cancelled) return;
            if (await restorePagePdfAsset(target, pageId, asset.id, asset.sourceName)) continue;
            const fromInbox = await restoreInboxPdfAsset(target, asset.id, asset.sourceName).catch(() => false);

            if (!fromInbox) await restorePdfAsset?.(target, asset.id).catch(() => undefined);
          }
        }
        // PDFs on this device the server lacks (imported before PDFs synced) go up in the background.
        if (!cancelled) void queuePdfAssetUpload(pageId, assets.all, target);

        return result;
      })
      .then((result) => {
        if (cancelled || !result) return;
        setOpened({ pageId, source: result.source });
        if (typedMarkdown) {
          void target.loadWhiteboard(pageId).then((doc) => {
            if (!cancelled) setBoardEmpty(isBoardEmpty(doc));
          });
        } else {
          setBoardEmpty(false);
        }
        const synced = readSyncedVersion(pageId);

        if (synced?.dirty) {
          dirtyRef.current = true;
          setSync({ kind: 'pending' });
        } else if (result.source === 'seed' || result.source === 'blank') {
          // A freshly created document has never been uploaded.
          dirtyRef.current = true;
          setSync({ kind: 'pending' });
        } else {
          setSync(synced ? { kind: 'synced', at: synced.syncedAt } : { kind: 'idle' });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setOpenError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
    // `seed` is intentionally not a dependency: a new closure per render must not re-open the board.
  }, [pageId, storage.isReady, storage.storage, liveMode]);

  // --- upload
  const renderNow = useCallback(
    (version: number) => {
      const target = storage.storage;
      const render = renderPageImageRef.current;

      if (renderTimerRef.current !== null) window.clearTimeout(renderTimerRef.current);
      renderTimerRef.current = null;
      if (target && render && version > 0) void syncPageRenders(pageId, version, target, render);
    },
    [pageId, storage.storage],
  );
  const scheduleRenders = useCallback(
    (version: number) => {
      if (renderTimerRef.current !== null) window.clearTimeout(renderTimerRef.current);
      renderTimerRef.current = window.setTimeout(() => renderNow(version), RENDER_QUIET_MS);
    },
    [renderNow],
  );

  const runUpload = useCallback(async (): Promise<UploadOutcome | null> => {
    const target = storage.storage;

    if (!target || uploadingRef.current) return null;
    uploadingRef.current = true;
    dirtyRef.current = false;
    setSync({ kind: 'uploading' });

    const outcome = await uploadNotebookDocument(pageId, target);

    uploadingRef.current = false;

    if (outcome.ok) {
      setSync(dirtyRef.current ? { kind: 'pending' } : { kind: 'synced', at: Date.now() });
      scheduleRenders(outcome.version);
    } else if (outcome.reason === 'conflict') {
      // Shared to edit since it was opened: merge quietly from now on instead of asking.
      const nowLive = await getPage(pageId)
        .then((fresh) => Boolean(fresh.live))
        .catch(() => false);

      if (nowLive && !readOnly) {
        await flushRef.current?.().catch(() => undefined);
        setSwitchedLive(true);
      } else {
        setSync({ kind: 'conflict', message: outcome.message });
      }
    } else if (outcome.reason === 'offline') {
      dirtyRef.current = true;
      setSync({ kind: 'offline' });
    } else {
      dirtyRef.current = true;
      setSync({ kind: 'error', message: outcome.message });
    }

    return outcome;
  }, [pageId, readOnly, scheduleRenders, storage.storage]);

  const scheduleUpload = useCallback(() => {
    // New ink: the page images wait for the next synced version.
    if (renderTimerRef.current !== null) window.clearTimeout(renderTimerRef.current);
    renderTimerRef.current = null;
    dirtyRef.current = true;
    // Kept on the device too: the app can be closed before the upload below runs.
    markSyncedVersionDirty(pageId);
    setSync((current) => (current.kind === 'conflict' ? current : { kind: 'pending' }));
    if (uploadTimerRef.current !== null) window.clearTimeout(uploadTimerRef.current);
    uploadTimerRef.current = window.setTimeout(() => {
      uploadTimerRef.current = null;
      void runUpload();
    }, UPLOAD_DEBOUNCE_MS);
  }, [pageId, runUpload]);

  useEffect(() => {
    if (!opened) return;

    const handleUpdated = (event: Event) => {
      const detail = (event as CustomEvent<WhiteboardStorageUpdatedEventDetail>).detail;

      if (detail?.id !== pageId) return;
      // Live: the session sends (a backstop for changes that are not a stroke: a page, the paper).
      if (liveMode) liveSessionRef.current?.noteLocalChange();
      else scheduleUpload();
    };
    const handleOnline = () => {
      if (liveMode) liveSessionRef.current?.noteLocalChange();
      else if (dirtyRef.current) void runUpload();
    };

    window.addEventListener(WHITEBOARD_STORAGE_UPDATED_EVENT, handleUpdated);
    window.addEventListener('online', handleOnline);

    // A document that was seeded/created here, or left dirty last time, goes up right away.
    if (liveMode) {
      // the live session sends it
    } else if (dirtyRef.current) scheduleUpload();
    else {
      // Clean and synced: make sure its page images exist (notebooks synced before the MCP could see them).
      const synced = readSyncedVersion(pageId);

      if (synced && !synced.dirty) scheduleRenders(synced.version);
    }

    return () => {
      window.removeEventListener(WHITEBOARD_STORAGE_UPDATED_EVENT, handleUpdated);
      window.removeEventListener('online', handleOnline);
      if (uploadTimerRef.current !== null) window.clearTimeout(uploadTimerRef.current);
      if (renderTimerRef.current !== null) window.clearTimeout(renderTimerRef.current);
    };
  }, [liveMode, opened, pageId, runUpload, scheduleRenders, scheduleUpload]);

  // Someone else's change that cannot go in item by item (pages added, removed, moved): save it into the
  // stored board and reload the editor on it.
  const reloadWithRemote = useCallback(
    async (ops: LiveOps) => {
      const target = storage.storage;

      if (!target) return;
      await flushRef.current?.().catch(() => undefined);
      const stored = await target.loadWhiteboard(pageId).catch(() => null);

      if (!stored) return;
      const next = applyOps(ensureDocIds(stored as unknown as BoardDoc), ops) as unknown as WhiteboardDocument;

      await target.saveWhiteboard({ ...next, id: pageId });
      setBoardGeneration((n) => n + 1);
    },
    [pageId, storage.storage],
  );

  // --- the live session: one per open live page
  useEffect(() => {
    if (!liveMode || !isOpen) return;

    const session = new LiveSession(
      {
        pageId,
        clientId: clientIdRef.current,
        getLocal: () => (liveBoardRef.current?.getDocument() as unknown as BoardDoc | undefined) ?? null,
        applyRemote: async (ops) => {
          const handle = liveBoardRef.current;
          const local = handle?.getDocument() as unknown as BoardDoc | undefined;
          // Page settings that only differ in the recorded frame, or an order that is already ours, go in
          // item by item too: a reload for those would bounce between two tablets.
          const itemsOnly = local ? itemsOnlyFor(local, ops) : !ops.pages && !ops.removedPages && !ops.order;

          if (handle && itemsOnly && (await handle.applyRemoteItems(ops.items ?? []))) return true;
          await reloadWithRemote(ops);

          return true;
        },
        push: (ops) => pushLiveOps(pageId, clientIdRef.current, ops),
        fetchLatest: () => fetchLatestBoard(pageId),
        fetchVersion: (version) => fetchBoardVersion(pageId, version),
        lastVersion: readSyncedVersion(pageId)?.version ?? null,
        openStream: (handlers, signal) => openLiveStream(pageId, clientIdRef.current, handlers, signal),
        onPeople: setPeople,
        onStatus: (status: LiveStatus, detail?: string) => {
          if (status === 'sending') setSync({ kind: 'uploading' });
          else if (status === 'live') setSync({ kind: 'synced', at: Date.now() });
          else if (status === 'offline') setSync({ kind: 'offline' });
          else if (status === 'error') setSync({ kind: 'error', message: detail || 'Could not reach the server' });
          else if (status === 'revoked') {
            setPeople([]);
            setSync({ kind: 'error', message: 'You can no longer edit this page. Your changes stay on this tablet.' });
          }
        },
        onSynced: (version, dirty) => {
          writeSyncedVersion(pageId, version, dirty);
          if (!dirty) scheduleRenders(version);
          // Live saves skip uploadNotebookDocument: send the PDFs of the board in memory from here.
          const doc = liveBoardRef.current?.getDocument() as WhiteboardDocument | undefined;
          const target = storageRef.current;

          if (doc && target) void queuePdfAssetUpload(pageId, pdfAssetIdsOf(doc), target);
        },
      },
      liveBaseRef.current,
    );

    liveSessionRef.current = session;
    session.start();

    return () => {
      session.stop();
      if (liveSessionRef.current === session) liveSessionRef.current = null;
      setPeople([]);
    };
  }, [isOpen, liveMode, pageId, reloadWithRemote, scheduleRenders]);

  const handleBoardChange = useCallback(() => liveSessionRef.current?.noteLocalChange(), []);
  // My own other devices are not "someone else here".
  const presence = liveMode ? presenceLine(people, { clientId: clientIdRef.current, userId: parseJwt(readSessionToken() ?? '')?._id ?? null }) : null;

  const handleBack = useCallback(async () => {
    try {
      await flushRef.current?.();
    } catch {
      // the editor's own autosave already has the latest page
    }
    if (uploadTimerRef.current !== null) {
      window.clearTimeout(uploadTimerRef.current);
      uploadTimerRef.current = null;
    }
    if (liveMode) await liveSessionRef.current?.flushNow().catch(() => undefined);
    else if (dirtyRef.current) await runUpload();
    // Leaving: the page images go up now, not after the quiet wait (the renderer outlives the editor).
    const synced = readSyncedVersion(pageId);

    if (synced && !synced.dirty && renderTimerRef.current !== null) renderNow(synced.version);
    onBack();
  }, [liveMode, onBack, pageId, renderNow, runUpload]);

  const resolveKeepMine = useCallback(async () => {
    if (!storage.storage) return;
    setSync({ kind: 'uploading' });
    const outcome = await forceUploadOverRemote(pageId, storage.storage);

    setSync(outcome.ok ? { kind: 'synced', at: Date.now() } : { kind: 'error', message: outcome.message });
  }, [pageId, storage.storage]);

  const resolveKeepTheirs = useCallback(async () => {
    if (!storage.storage) return;
    setSync({ kind: 'uploading' });

    try {
      await replaceWithRemote(pageId, storage.storage);
      // Remount the editor on the replaced document.
      setOpened(null);
      setOpened({ pageId, source: 'remote' });
      setSync({ kind: 'synced', at: Date.now() });
    } catch (error) {
      setSync({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, [pageId, storage.storage]);

  if (storage.storageError) {
    return (
      <BoardMessage>
        <span className='text-st-danger'>Storage failed: {storage.storageError}</span>{' '}
        <button className='ml-2 underline' type='button' onClick={storage.retryStorage}>
          Retry
        </button>
      </BoardMessage>
    );
  }

  if (openError) {
    return (
      <BoardMessage>
        <span className='text-st-danger'>{openError}</span>
        <button className='ml-3 underline' type='button' onClick={onBack}>
          Back
        </button>
      </BoardMessage>
    );
  }

  if (!opened || opened.pageId !== pageId || (typedMarkdown && boardEmpty === null)) {
    return <BoardMessage>{seedProgress ?? 'Opening notebook…'}</BoardMessage>;
  }

  if (typedMarkdown && (forceSheet || (boardEmpty && !forceBoard))) {
    return (
      <TypedNoteSheet
        // Claude typed this note and then filed photos/PDFs into it: the queue shows here too (the
        // sheet hides the board), and a tap opens the board and appends them there.
        actions={
          !readOnly && (
            <PageQueueChip
              busy={pageQueue.busy}
              count={pageQueue.waiting.length}
              onAppend={() => {
                setForceSheet(false);
                setForceBoard(true);
                pageQueue.start();
              }}
            />
          )
        }
        markdown={typedMarkdown}
        title={title}
        onBack={onBack}
        onOpenBoard={() => {
          setForceSheet(false);
          setForceBoard(true);
        }}
      />
    );
  }

  return (
    <div ref={setBoardRoot} className='relative h-full w-full'>
      <WhiteboardEditor
        key={`${pageId}:${opened.source}:${boardGeneration}`}
        allowInsertBlankPages
        allowPaperSpacing
        allowPdfLayoutToggle
        compactSelectTool
        compactUndoRedo
        boardTheme={boardTheme}
        paperOverPdf
        straightenInk
        termsMap
        verticalNotebook
        autoColor={autoColor}
        boardAi={boardAi}
        buildMergeOverlaysRef={buildMergeOverlaysRef}
        defaultEraserMode='object'
        defaultPaperSpacingMm={paperSpacingDefaults}
        defaultToolbarDock='bottom'
        embedded={embedded}
        extraSelectionActions={readOnly ? undefined : extraSelectionActions}
        fileBridge={studyFileBridge}
        flushBeforeCloseRef={flushRef}
        liveBoardRef={liveMode ? liveBoardRef : undefined}
        onBoardChange={liveMode ? handleBoardChange : undefined}
        focusMode={focusMode}
        freeZoom={freeZoom}
        hideChrome={hideChrome}
        hideQuickPenTrigger={hidePenShortcuts}
        initialPenTool='brush'
        locale='en'
        notebookFillScreen={fillScreen}
        pdfLayout={pdfLayout}
        pendingConceptMap={pendingMap}
        pendingImageImport={pendingImage ?? phoneImage}
        pendingPdfImport={readOnly ? null : (pendingPdf ?? phonePdf)}
        readOnly={readOnly}
        renderPageImageRef={renderPageImageRef}
        rulerEdgesRef={rulerEdgesRef}
        selectionChrome='modern'
        selectionShape='box'
        toolbarLayout='full-scroll'
        whiteboardId={pageId}
        onBack={handleBack}
        onFocusModeChange={setFocusMode}
        onImagePlaced={readOnly ? undefined : onImagePlaced}
        onPdfImported={handlePdfImported}
        viewportRef={viewportRef}
        onViewportChange={() => setViewportTick((n) => n + 1)}
        onViewportZoomChange={setBoardZoom}
        onPendingConceptMapHandled={handleConceptMapDrawn}
        onPendingImageImportHandled={handleImageInserted}
        onPendingPdfImportHandled={handlePdfInserted}
      />
      {/* Focus mode: only the page (and the editor's small pen dock, which also exits) — every host
          chip and overlay goes with the editor's own chrome. */}
      {!focusMode && overlay}
      {rulerOn && !readOnly && (
        <RulerOverlay
          edgesRef={rulerEdgesRef}
          pageNo={rulerPageNo}
          preset={rulerPreset}
          root={boardRoot}
          saving={putRulerPreset.isPending}
          viewportRef={viewportRef}
          viewportTick={viewportTick}
          zoom={boardZoom}
          onClose={() => setRulerOn(false)}
          onSavePreset={(preset) => putRulerPreset.mutate({ page: rulerPageNo, preset })}
        />
      )}
      <div
        ref={topEndClusterRef}
        className={`pointer-events-none absolute right-3 top-[3.75rem] z-30 md:top-3 items-center gap-2 ${focusMode ? 'hidden' : 'flex'} ${boardTheme === 'dark' ? 'dark' : ''}`}
        // A narrow board (split screen, a side pane) shows the chips as icons: see `[data-chip-label]`.
        data-board-compact='true'
      >
        {!readOnly && (
          <PageQueueChip
            busy={pageQueue.busy}
            className='pointer-events-auto'
            count={pageQueue.waiting.length}
            onAppend={pageQueue.start}
          />
        )}
        {!readOnly && (
          <InsertFromPhoneButton
            className='pointer-events-auto'
            onInsert={insertPhoneImage}
            onInsertPdf={setPhonePdf}
          />
        )}
        {!readOnly &&
          nativeInkRecognizer &&
          inkModelsReady &&
          (inkSettings.enabled || inkSettings.pageOverrides[pageId] !== undefined) && (
            // This page's own auto-colour switch; back to the device setting when it matches it again.
            <ActionButton
              aria-pressed={inkOnHere}
              className={BOARD_CHIP_OVERRIDE}
              title={inkOnHere ? 'Auto-colour is on for this page' : 'Auto-colour is off for this page'}
              variant='secondary'
              onClick={() => savePageInkOverride(pageId, !inkOnHere === inkSettings.enabled ? undefined : !inkOnHere)}
            >
              <Palette className={`h-3.5 w-3.5 ${inkOnHere ? 'text-st-accent' : 'text-st-muted'}`} />{' '}
              <span data-chip-label>{inkOnHere ? 'Colour' : 'Colour off'}</span>
            </ActionButton>
          )}
        {!readOnly && <ClaudeFeedback className='pointer-events-auto' pageId={pageId} />}
        {presence && <LivePeopleChip text={presence} />}
        {topRight && <div className='pointer-events-auto'>{topRight}</div>}
        {!readOnly && (
          <ActionButton
            aria-pressed={freeZoom}
            className={`${BOARD_CHIP_OVERRIDE} ${freeZoom ? '!bg-st-accent-soft' : ''}`}
            title='Free zoom: zoom out far and fly across the board; turn off to snap back to the page'
            variant='secondary'
            onClick={toggleFreeZoom}
          >
            <ZoomOut className={`h-3.5 w-3.5 ${freeZoom ? 'text-st-accent' : 'text-st-fg'}`} />{' '}
            <span data-chip-label>Free zoom</span>
          </ActionButton>
        )}
        {!readOnly && (
          <ActionButton
            aria-pressed={rulerOn}
            className={`${BOARD_CHIP_OVERRIDE} ${rulerOn ? '!bg-st-accent-soft' : ''}`}
            title='Ruler: real cm / inch ticks; pen strokes along its edge go straight'
            variant='secondary'
            onClick={() => setRulerOn((on) => !on)}
          >
            <Ruler className={`h-3.5 w-3.5 ${rulerOn ? 'text-st-accent' : 'text-st-fg'}`} />{' '}
            <span data-chip-label>Ruler</span>
          </ActionButton>
        )}
        {!readOnly && (
          <ActionButton
            className={BOARD_CHIP_OVERRIDE}
            title='Focus mode: hide everything but the page'
            onClick={() => setFocusMode(true)}
          >
            <EyeOff className='h-3.5 w-3.5' /> <span data-chip-label>Focus</span>
          </ActionButton>
        )}
        {typedMarkdown && (
          <ActionButton className={BOARD_CHIP_OVERRIDE} onClick={() => setForceSheet(true)}>
            <FileText className='h-3.5 w-3.5' /> <span data-chip-label>Typed note</span>
          </ActionButton>
        )}
        <SyncChip
          state={sync}
          onKeepMine={resolveKeepMine}
          onKeepTheirs={resolveKeepTheirs}
          onRetry={() => void runUpload()}
        />
      </div>
    </div>
  );
}

/** Unsynced changes (saving, waiting, offline) only surface once they have lingered this long. */
const SYNC_ATTENTION_DELAY_MS = 10_000;

/**
 * Quiet sync indicator. Normal saving / syncing / synced shows NOTHING. A small icon appears only when
 * the writer should know: a failure, a conflict, or changes still unsynced after `SYNC_ATTENTION_DELAY_MS`.
 * It always occupies the same fixed slot (and the details open as an overlay), so the neighbouring
 * top-bar buttons never move in any state.
 */
function SyncChip({
  state,
  onRetry,
  onKeepMine,
  onKeepTheirs,
}: {
  state: SyncState;
  onRetry: () => void;
  onKeepMine: () => void;
  onKeepTheirs: () => void;
}) {
  const unsynced = state.kind === 'pending' || state.kind === 'uploading' || state.kind === 'offline';
  const [lingered, setLingered] = useState(false);
  const [open, setOpen] = useState(false);

  // One timer for the whole unsynced stretch: pending <-> uploading flips while writing must not restart it.
  useEffect(() => {
    if (!unsynced) {
      setLingered(false);

      return;
    }
    const timer = window.setTimeout(() => setLingered(true), SYNC_ATTENTION_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [unsynced]);

  const urgent = state.kind === 'error' || state.kind === 'conflict';
  const visible = urgent || (unsynced && lingered);

  // A conflict needs a decision, so its details open by themselves; everything else waits for a tap.
  const expanded = visible && (open || state.kind === 'conflict');

  let icon = <CloudUpload className='text-st-muted h-4 w-4' />;
  let detail: ReactNode = 'Changes are saved on this tablet and have not reached the cloud yet.';

  if (state.kind === 'offline') {
    icon = <CloudOff className='text-st-warn h-4 w-4' />;
    detail = 'Offline. Saved on this tablet; it will sync when you are back online.';
  } else if (state.kind === 'error') {
    icon = <AlertTriangle className='text-st-danger h-4 w-4' />;
    detail = `Sync failed: ${state.message}`;
  } else if (state.kind === 'conflict') {
    icon = <AlertTriangle className='text-st-warn h-4 w-4' />;
    detail = 'Edited elsewhere.';
  }

  return (
    <div aria-live='polite' className='pointer-events-none relative h-9 w-9 shrink-0'>
      {visible && (
        <button
          aria-expanded={expanded}
          aria-label='Sync status'
          className={BOARD_CHIP}
          type='button'
          onClick={() => setOpen((value) => !value)}
        >
          {icon}
        </button>
      )}
      {expanded && (
        <div className='rounded-st border-st-clay-edge bg-st-surface shadow-clay pointer-events-auto absolute right-0 top-full z-40 mt-2 flex w-64 flex-col gap-2 border-2 p-3 text-xs'>
          <span className='text-st-fg font-medium'>{detail}</span>
          {state.kind === 'conflict' ? (
            <div className='flex gap-2'>
              <ActionButton className='min-h-8 px-2 text-xs' onClick={onKeepMine}>
                Keep mine
              </ActionButton>
              <ActionButton className='min-h-8 px-2 text-xs' onClick={onKeepTheirs}>
                Use theirs
              </ActionButton>
            </div>
          ) : (
            <button
              className='text-st-fg inline-flex items-center gap-1 self-start underline'
              type='button'
              onClick={() => {
                setOpen(false);
                onRetry();
              }}
            >
              <RefreshCw className='h-3 w-3' /> {state.kind === 'error' ? 'Retry' : 'Sync now'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
