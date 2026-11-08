import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { ActiveSelection, Textbox } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { SELECTION_MARQUEE } from '../utils/selectionChrome';

import { normalizeBox } from '../utils/boxSelection';
import { isLockedImage } from '../utils/lockedImages';
import {
  captureSelection,
  deleteSelection,
  pasteClipboard,
  recolorSelection,
  restrokeSelection,
  selectedObjects,
  selectionSceneBounds,
  writeSelectionPng,
} from '../utils/selectionActions';
import {
  IDENTITY_SCENE_TRANSFORM,
  lassoPolygon,
  readClipboard,
  subscribeClipboard,
  writeClipboard,
} from '../utils/selectionClipboard';
import { objectsInsidePolygon } from '../utils/selectionHitTest';

import type { SceneTransform } from '../utils/pdfScrollLayout';
import type { ClipboardRect } from '../utils/selectionClipboard';
import type { WhiteboardTool } from '../types';

/**
 * Everything behind the selection action bar, minus the bar itself: where the selection is on
 * screen, the actions, the select tool's freehand lasso, the «Paste» chip (finger long-press anywhere,
 * or a tap on empty canvas with the select tool), and Ctrl/Cmd + C / X / V / D.
 *
 * Screen positions are in canvas CSS pixels — the frame of the overlay layer the editor draws its
 * other selection HUDs (geometry readout, pin button) in.
 */

interface UseSelectionActionsOptions {
  canvas: Canvas | null;
  activeTool: WhiteboardTool;
  /** Read-only boards and view-only embeds get none of it. */
  enabled: boolean;
  /** Page→scene map of the page at scene `y` (the continuous PDF column); identity when absent. */
  sceneTransformAt?: (sceneY: number) => SceneTransform;
  /** A paste lands selected, so the select tool must be active to move it. */
  onSelectTool: () => void;
  /**
   * What a drag from empty canvas with the select tool draws: a freehand `lasso` (default) or a
   * dashed `box`. Either takes a stroke when most of its ink is inside (see `selectionHitTest`).
   */
  selectionShape?: 'lasso' | 'box';
  /** The marquee's fill + outline (default: the classic citrine wash with an ink dash). */
  marquee?: { fill: string; stroke: string };
}

export interface PasteChipState {
  left: number;
  top: number;
  scene: { x: number; y: number };
}

const LONG_PRESS_MS = 520;
const LONG_PRESS_SLOP_PX = 10;
const TAP_SLOP_PX = 6;
const PASTE_CHIP_TIMEOUT_MS = 4000;
/** Screen pixels a duplicate lands down-and-right of its original. */
const DUPLICATE_OFFSET_PX = 24;
const getClipboardSnapshot = () => readClipboard();
const getServerClipboardSnapshot = () => null;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

function viewportOf(canvas: Canvas): number[] {
  return (canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0]) as number[];
}

function sceneToView(canvas: Canvas, point: { x: number; y: number }) {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = viewportOf(canvas);

  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

function viewToScene(canvas: Canvas, point: { x: number; y: number }) {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = viewportOf(canvas);
  const det = a * d - b * c || 1;
  const x = point.x - e;
  const y = point.y - f;

  return { x: (d * x - c * y) / det, y: (a * y - b * x) / det };
}

/** Client (page) coordinates → canvas CSS pixels. */
function clientToView(canvas: Canvas, clientX: number, clientY: number) {
  const element = (canvas as unknown as { upperCanvasEl?: HTMLCanvasElement }).upperCanvasEl ?? canvas.getElement();
  const rect = element.getBoundingClientRect();
  const sx = canvas.getWidth() / (rect.width || canvas.getWidth() || 1);
  const sy = canvas.getHeight() / (rect.height || canvas.getHeight() || 1);

  return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
}

function screenBoxOf(canvas: Canvas, objects: FabricObject[]): ClipboardRect | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const object of objects) {
    for (const corner of object.getCoords()) {
      const point = sceneToView(canvas, corner);

      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
  }

  return Number.isFinite(left) ? { left, top, width: right - left, height: bottom - top } : null;
}

const sameBox = (a: ClipboardRect | null, b: ClipboardRect | null) =>
  a === b ||
  (!!a &&
    !!b &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5);

export function useSelectionActions({
  canvas,
  activeTool,
  enabled,
  sceneTransformAt,
  onSelectTool,
  selectionShape = 'lasso',
  marquee = SELECTION_MARQUEE.classic,
}: UseSelectionActionsOptions) {
  const [selectionBox, setSelectionBox] = useState<ClipboardRect | null>(null);
  const [pasteChip, setPasteChip] = useState<PasteChipState | null>(null);
  const clipboard = useSyncExternalStore(subscribeClipboard, getClipboardSnapshot, getServerClipboardSnapshot);
  const transformAtRef = useRef(sceneTransformAt);
  const onSelectToolRef = useRef(onSelectTool);
  /** Last pointer position over the canvas (canvas CSS px) — where Ctrl+V pastes. */
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const busyRef = useRef(false);

  transformAtRef.current = sceneTransformAt;
  const marqueeRef = useRef(marquee);

  marqueeRef.current = marquee;
  onSelectToolRef.current = onSelectTool;

  const transformAt = useCallback((y: number) => transformAtRef.current?.(y) ?? IDENTITY_SCENE_TRANSFORM, []);
  const active = enabled && activeTool === 'select';

  // --- Where the selection is on screen ---------------------------------------------------------
  useEffect(() => {
    if (!canvas || !active) {
      setSelectionBox(null);

      return;
    }

    let frame: number | null = null;
    let transforming = false;

    const refresh = () => {
      frame = null;

      const objects = transforming ? [] : selectedObjects(canvas);
      const next = objects.length > 0 ? screenBoxOf(canvas, objects) : null;

      setSelectionBox((current) => (sameBox(current, next) ? current : next));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(refresh);
    };
    // The bar steps aside while the selection is dragged, scaled or turned, and comes back on release.
    const startTransform = () => {
      if (!transforming) {
        transforming = true;
        schedule();
      }
    };
    const endTransform = () => {
      if (transforming) {
        transforming = false;
        schedule();
      }
    };

    const events = ['selection:created', 'selection:updated', 'selection:cleared', 'object:modified', 'object:removed', 'after:render'] as const;
    const transformEvents = ['object:moving', 'object:scaling', 'object:rotating'] as const;

    events.forEach((name) => canvas.on(name, schedule as never));
    transformEvents.forEach((name) => canvas.on(name, startTransform as never));
    canvas.on('mouse:up', endTransform as never);
    schedule();

    return () => {
      events.forEach((name) => canvas.off(name, schedule as never));
      transformEvents.forEach((name) => canvas.off(name, startTransform as never));
      canvas.off('mouse:up', endTransform as never);

      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [active, canvas]);

  // --- Actions ----------------------------------------------------------------------------------
  const run = useCallback(async (action: () => Promise<void> | void) => {
    if (busyRef.current) return;

    busyRef.current = true;

    try {
      await action();
    } finally {
      busyRef.current = false;
    }
  }, []);

  const copy = useCallback(
    () =>
      run(async () => {
        if (!canvas) return;

        const next = await captureSelection(canvas, transformAt);

        if (!next) return;

        writeClipboard(next);
        writeSelectionPng(canvas);
      }),
    [canvas, run, transformAt],
  );

  const cut = useCallback(
    () =>
      run(async () => {
        if (!canvas) return;

        const next = await captureSelection(canvas, transformAt);

        if (!next) return;

        writeClipboard(next);
        writeSelectionPng(canvas);
        deleteSelection(canvas);
      }),
    [canvas, run, transformAt],
  );

  const remove = useCallback(() => {
    if (canvas) deleteSelection(canvas);
  }, [canvas]);

  const pasteAtScene = useCallback(
    (at: { x: number; y: number }) =>
      run(async () => {
        const current = readClipboard();

        setPasteChip(null);

        if (!canvas || !current) return;

        onSelectToolRef.current();
        await pasteClipboard(canvas, current, at, transformAt(at.y));
      }),
    [canvas, run, transformAt],
  );

  const viewCentreScene = useCallback(() => {
    if (!canvas) return { x: 0, y: 0 };

    return viewToScene(canvas, { x: canvas.getWidth() / 2, y: canvas.getHeight() / 2 });
  }, [canvas]);

  const pasteAtViewportCentre = useCallback(() => pasteAtScene(viewCentreScene()), [pasteAtScene, viewCentreScene]);

  const duplicate = useCallback(
    () =>
      run(async () => {
        if (!canvas) return;

        // A private snapshot: duplicating does not replace what the person copied.
        const snapshot = await captureSelection(canvas, transformAt);

        if (!snapshot) return;

        const zoom = canvas.getZoom() || 1;
        const bounds = selectionSceneBounds(canvas);

        if (!bounds) return;

        const centre = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
        const at = { x: centre.x + DUPLICATE_OFFSET_PX / zoom, y: centre.y + DUPLICATE_OFFSET_PX / zoom };

        await pasteClipboard(canvas, snapshot, at, transformAt(centre.y));
      }),
    [canvas, run, transformAt],
  );

  const recolor = useCallback(
    (color: string) => {
      if (canvas) recolorSelection(canvas, color);
    },
    [canvas],
  );

  const restroke = useCallback(
    (width: number) => {
      if (canvas) restrokeSelection(canvas, width);
    },
    [canvas],
  );

  // --- Paste chip: finger long-press anywhere, or a tap on empty canvas with the select tool -----
  const pasteChipFromView = useCallback(
    (view: { x: number; y: number }) => {
      if (!canvas || !readClipboard()) return;

      setPasteChip({ left: view.x, top: view.y, scene: viewToScene(canvas, view) });
    },
    [canvas],
  );

  useEffect(() => {
    if (!pasteChip) return;

    const timer = setTimeout(() => setPasteChip(null), PASTE_CHIP_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [pasteChip]);

  useEffect(() => {
    if (!canvas || !enabled) return;

    const element = (canvas as unknown as { upperCanvasEl?: HTMLCanvasElement }).upperCanvasEl ?? canvas.getElement();
    const touches = new Map<number, { x: number; y: number }>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    const onDown = (event: PointerEvent) => {
      setPasteChip(null);
      lastPointerRef.current = clientToView(canvas, event.clientX, event.clientY);

      if (event.pointerType !== 'touch') return;

      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      cancel();

      // One finger only: a second one is a pinch.
      if (touches.size !== 1 || !readClipboard()) return;

      const view = clientToView(canvas, event.clientX, event.clientY);

      timer = setTimeout(() => {
        timer = null;

        // Holding on the selection is the start of a drag, not a paste.
        const box = screenBoxOf(canvas, selectedObjects(canvas));
        const onSelection = box && view.x >= box.left && view.x <= box.left + box.width && view.y >= box.top && view.y <= box.top + box.height;

        if (!onSelection) pasteChipFromView(view);
      }, LONG_PRESS_MS);
    };

    const onMove = (event: PointerEvent) => {
      lastPointerRef.current = clientToView(canvas, event.clientX, event.clientY);

      const start = touches.get(event.pointerId);

      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel();
    };

    const onUp = (event: PointerEvent) => {
      touches.delete(event.pointerId);
      cancel();
    };

    element.addEventListener('pointerdown', onDown, { passive: true });
    element.addEventListener('pointermove', onMove, { passive: true });
    element.addEventListener('pointerup', onUp, { passive: true });
    element.addEventListener('pointercancel', onUp, { passive: true });

    return () => {
      cancel();
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
    };
  }, [canvas, enabled, pasteChipFromView]);

  // --- The select tool's freehand lasso (or box) -----------------------------------------------
  // A drag from empty canvas draws a free loop instead of Fabric's rubber band; whatever the loop
  // takes in is selected — a stroke when most of its ink is inside, not when its box merely crosses
  // the loop. With `selectionShape: 'box'` it draws a dashed rectangle from the down point to the
  // pointer instead, judged by the same rule. A tap (no drag) on empty canvas with nothing selected
  // raises the paste chip.
  useEffect(() => {
    if (!canvas || !active) return;

    let points: Array<{ x: number; y: number }> | null = null;
    let downScene: { x: number; y: number } | null = null;
    /** Furthest the pointer got from where it went down, in screen px — a closed loop ends where it began. */
    let travelled = 0;
    let hadSelection = false;
    let restoreSelection = false;
    const isBox = selectionShape === 'box';

    const drawLasso = () => {
      const ctx = canvas.contextTop;

      if (!ctx || !points || points.length < 2) return;

      // The box is the rectangle the down point and the latest point span (scene space, so it
      // follows zoom and the continuous PDF column exactly like the lasso loop does).
      const outline = isBox
        ? (() => {
            const box = normalizeBox(points[0]!, points[points.length - 1]!);

            return [
              { x: box.left, y: box.top },
              { x: box.right, y: box.top },
              { x: box.right, y: box.bottom },
              { x: box.left, y: box.bottom },
            ];
          })()
        : points;

      canvas.clearContext(ctx);
      ctx.save();

      const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = viewportOf(canvas);
      const retina = (canvas as unknown as { getRetinaScaling?: () => number }).getRetinaScaling?.() ?? 1;

      ctx.setTransform(a * retina, b * retina, c * retina, d * retina, e * retina, f * retina);
      ctx.beginPath();
      ctx.moveTo(outline[0]!.x, outline[0]!.y);

      for (const point of outline) ctx.lineTo(point.x, point.y);

      ctx.closePath();
      ctx.fillStyle = marqueeRef.current.fill;
      ctx.fill();
      ctx.setLineDash([6 / (a || 1), 4 / (a || 1)]);
      ctx.lineWidth = 1.5 / (a || 1);
      ctx.strokeStyle = marqueeRef.current.stroke;
      ctx.stroke();
      ctx.restore();
    };

    const onDownBefore = (options: { e: Event; scenePoint?: { x: number; y: number } }) => {
      const event = options.e as PointerEvent;

      if ((event as MouseEvent).button) return;

      hadSelection = selectedObjects(canvas).length > 0;

      const hit = (canvas as unknown as { findTarget: (e: Event) => { target?: FabricObject } | FabricObject | undefined }).findTarget(event);
      const target = hit && 'target' in hit ? hit.target : (hit as FabricObject | undefined);
      const activeObject = canvas.getActiveObject();
      const onControl = activeObject ? Boolean(activeObject.findControl(canvas.getViewportPoint(event as never), event.pointerType === 'touch')) : false;

      if ((target && target.selectable && !isLockedImage(target)) || onControl) return;

      // Empty canvas: this gesture is ours. Fabric's rubber band stays off until pointer-up.
      restoreSelection = canvas.selection;
      canvas.selection = false;
      points = options.scenePoint ? [{ x: options.scenePoint.x, y: options.scenePoint.y }] : [];
      downScene = options.scenePoint ? { x: options.scenePoint.x, y: options.scenePoint.y } : null;
      travelled = 0;
    };

    const onMove = (options: { scenePoint?: { x: number; y: number } }) => {
      if (!points || !options.scenePoint) return;

      const next = { x: options.scenePoint.x, y: options.scenePoint.y };

      // A box only needs where the drag began and where it is now.
      if (isBox && points.length >= 2) points[points.length - 1] = next;
      else points.push(next);

      if (downScene) {
        const zoom = canvas.getZoom() || 1;

        travelled = Math.max(travelled, Math.hypot(options.scenePoint.x - downScene.x, options.scenePoint.y - downScene.y) * zoom);
      }

      drawLasso();
    };

    const onUp = (options: { e: Event }) => {
      if (!points) return;

      const loop = points;
      const event = options.e as PointerEvent;
      const upView = clientToView(canvas, event.clientX, event.clientY);
      const tapped = travelled < TAP_SLOP_PX;

      points = null;
      canvas.selection = restoreSelection || canvas.selection;

      if (canvas.contextTop) canvas.clearContext(canvas.contextTop);

      if (tapped) {
        if (!hadSelection) pasteChipFromView(upView);
        canvas.requestRenderAll();

        return;
      }

      const polygon = isBox
        ? (() => {
            const box = normalizeBox(loop[0]!, loop[loop.length - 1]!);

            return [
              { x: box.left, y: box.top },
              { x: box.right, y: box.top },
              { x: box.right, y: box.bottom },
              { x: box.left, y: box.bottom },
            ];
          })()
        : lassoPolygon(loop);
      const candidates = canvas
        .getObjects()
        .filter(
          (object) =>
            object.selectable &&
            object.visible !== false &&
            !isLockedImage(object) &&
            !(object as FabricObject & { excludeFromExport?: boolean }).excludeFromExport,
        );
      const picked = objectsInsidePolygon(candidates, polygon);

      canvas.discardActiveObject();

      if (picked.length === 1) {
        canvas.setActiveObject(picked[0]!);
      } else if (picked.length > 1) {
        canvas.setActiveObject(new ActiveSelection(picked, { canvas }));
      }

      canvas.requestRenderAll();
    };

    canvas.on('mouse:down:before', onDownBefore as never);
    canvas.on('mouse:move', onMove as never);
    canvas.on('mouse:up', onUp as never);

    return () => {
      canvas.off('mouse:down:before', onDownBefore as never);
      canvas.off('mouse:move', onMove as never);
      canvas.off('mouse:up', onUp as never);

      if (points) {
        canvas.selection = restoreSelection || canvas.selection;

        if (canvas.contextTop) canvas.clearContext(canvas.contextTop);
      }
    };
  }, [active, canvas, pasteChipFromView, selectionShape]);

  // --- Keyboard ---------------------------------------------------------------------------------
  useEffect(() => {
    if (!canvas || !enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target)) return;

      const editing = canvas.getActiveObject();

      // Text being edited owns its own clipboard.
      if (editing instanceof Textbox && editing.isEditing) return;

      const key = event.key.toLowerCase();
      const hasSelection = selectedObjects(canvas).length > 0;

      if (key === 'c' && hasSelection) {
        event.preventDefault();
        void copy();
      } else if (key === 'x' && hasSelection) {
        event.preventDefault();
        void cut();
      } else if (key === 'd' && hasSelection) {
        event.preventDefault();
        void duplicate();
      } else if (key === 'v' && readClipboard()) {
        event.preventDefault();

        const pointer = lastPointerRef.current;
        const inside = pointer && pointer.x >= 0 && pointer.y >= 0 && pointer.x <= canvas.getWidth() && pointer.y <= canvas.getHeight();

        void pasteAtScene(inside ? viewToScene(canvas, pointer) : viewCentreScene());
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [canvas, copy, cut, duplicate, enabled, pasteAtScene, viewCentreScene]);

  return {
    selectionBox,
    pasteChip,
    canPaste: enabled && clipboard !== null,
    copy,
    cut,
    duplicate,
    remove,
    recolor,
    restroke,
    pasteAtScene,
    pasteAtViewportCentre,
    dismissPasteChip: () => setPasteChip(null),
  };
}
