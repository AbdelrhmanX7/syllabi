import { ActiveSelection, util } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { invalidateInkBake } from './inkBake';
import { isLockedImage } from './lockedImages';
import { buildClipboard, placeClipboard, planSelectionRaster, recolorObject, rectsOverlap, restrokeObject, unionRects } from './selectionClipboard';

import type { ClipboardItem, ClipboardRect, RecolorableObject, WbClipboard } from './selectionClipboard';
import type { SceneTransform } from './pdfScrollLayout';

/**
 * The canvas half of the selection action bar: copy, paste, delete, recolour. Every action mutates
 * the canvas in ONE synchronous run and announces it through the ordinary `object:added` /
 * `object:removed` / `object:modified` events, so the editor's mutation → snapshot path records it
 * as a single undo step (the snapshot coalesces a burst of events into one checkpoint).
 */

/** What the actions operate on: the active objects minus a pinned image and editor-only overlays. */
export function selectedObjects(canvas: Canvas): FabricObject[] {
  return canvas
    .getActiveObjects()
    .filter((object) => !isLockedImage(object) && !(object as FabricObject & { excludeFromExport?: boolean }).excludeFromExport);
}

/**
 * Snapshot the selection into a clipboard. Members of a multi-selection carry group-relative
 * coordinates, so each is cloned and re-based onto its absolute matrix, then centre-origined so the
 * frame maths stays a plain scale-and-shift. `sourceTransformAt(sceneY)` names the page→scene map of
 * the page under the selection (identity in the paged layout).
 */
export async function captureSelection(
  canvas: Canvas,
  sourceTransformAt: (sceneY: number) => SceneTransform,
): Promise<WbClipboard | null> {
  const objects = selectedObjects(canvas);

  if (objects.length === 0) return null;

  const items: ClipboardItem[] = [];
  const rects: ClipboardRect[] = [];

  // Canvas stacking order, not selection order, so a paste keeps what was on top on top.
  const ordered = canvas.getObjects().filter((object) => objects.includes(object));

  for (const object of ordered) {
    const clone = await object.clone();

    util.applyTransformToObject(clone, object.calcTransformMatrix());

    const centre = clone.getCenterPoint();

    clone.set({ originX: 'center', originY: 'center' });
    clone.setPositionByOrigin(centre, 'center', 'center');
    clone.setCoords();

    const rect = clone.getBoundingRect();

    rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    items.push({
      json: clone.toObject() as Record<string, unknown>,
      originX: String(object.originX ?? 'left'),
      originY: String(object.originY ?? 'top'),
    });
  }

  const bounds = unionRects(rects);

  if (!bounds) return null;

  return buildClipboard(items, bounds, sourceTransformAt(bounds.top + bounds.height / 2));
}

/** Adds the clipboard centred on `at` (scene), scaled for the target page, and selects the result. */
export async function pasteClipboard(
  canvas: Canvas,
  clipboard: WbClipboard,
  at: { x: number; y: number },
  targetTransform: SceneTransform,
): Promise<FabricObject[]> {
  const placed = placeClipboard(clipboard, targetTransform, at);
  const objects = await util.enlivenObjects<FabricObject>(placed.items.map((item) => item.json));

  objects.forEach((object, index) => {
    const item = placed.items[index]!;
    const centre = object.getCenterPoint();

    object.set({ originX: item.originX as FabricObject['originX'], originY: item.originY as FabricObject['originY'] });
    object.setPositionByOrigin(centre, 'center', 'center');
    object.set({ selectable: true, evented: true });
    object.setCoords();
  });

  if (objects.length === 0) return objects;

  canvas.discardActiveObject();
  canvas.add(...objects);
  canvas.setActiveObject(objects.length === 1 ? objects[0]! : new ActiveSelection(objects, { canvas }));
  canvas.requestRenderAll();

  return objects;
}

export function deleteSelection(canvas: Canvas): number {
  const objects = selectedObjects(canvas);

  if (objects.length === 0) return 0;

  canvas.discardActiveObject();
  canvas.remove(...objects);
  canvas.requestRenderAll();

  return objects.length;
}

function restyleSelection(canvas: Canvas, apply: (object: RecolorableObject) => number): number {
  const objects = selectedObjects(canvas);
  let changed = 0;

  for (const object of objects) {
    if (apply(object as unknown as RecolorableObject) === 0) continue;

    changed += 1;
    object.set('dirty', true);
    canvas.fire('object:modified', { target: object } as never);
  }

  if (changed > 0) {
    // The bake checks `dirty` too, but a group member's flag does not reach the top-level object.
    invalidateInkBake(canvas);
    canvas.requestRenderAll();
  }

  return changed;
}

export function recolorSelection(canvas: Canvas, color: string): number {
  return restyleSelection(canvas, (object) => recolorObject(object, color));
}

export function restrokeSelection(canvas: Canvas, width: number): number {
  return restyleSelection(canvas, (object) => restrokeObject(object, width));
}

/** The selection's scene bounds (the union of its members' boxes). */
export function selectionSceneBounds(canvas: Canvas): ClipboardRect | null {
  const active = canvas.getActiveObject();

  if (!active || selectedObjects(canvas).length === 0) return null;

  const rect = active.getBoundingRect();

  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * Best effort: put a PNG of the selection on the system clipboard so it pastes into other apps.
 * Needs a secure context and permission; any refusal is silent — the in-app clipboard is the real one.
 */
export function writeSelectionPng(canvas: Canvas): void {
  try {
    const active = canvas.getActiveObject();
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    const Item = typeof window === 'undefined' ? undefined : window.ClipboardItem;

    if (!active || !clipboard?.write || !Item) return;

    const element = active.toCanvasElement({ multiplier: 2, enableRetinaScaling: false });
    const blob = new Promise<Blob>((resolve, reject) => {
      element.toBlob((value) => (value ? resolve(value) : reject(new Error('png'))), 'image/png');
    });

    void clipboard.write([new Item({ 'image/png': blob })]).catch(() => undefined);
  } catch {
    // No system clipboard here; nothing to do.
  }
}

export interface SelectionRaster {
  /** PNG, base64 without the `data:` prefix. */
  pngBase64: string;
  width: number;
  height: number;
}

const isEraserMark = (object: FabricObject) =>
  (object as FabricObject & { globalCompositeOperation?: string }).globalCompositeOperation === 'destination-out';

/**
 * The selection as a picture on white: only the selected objects (ink, shapes, images) plus the
 * pixel-eraser marks over them, cropped to their bounds (+ padding), long side ≤ `maxPx`. Rendered
 * under an identity viewport so pan/zoom do not matter; the selection is dissolved for the render
 * (members of an ActiveSelection paint in group space) and put back afterwards. No mutation events.
 */
export function rasterizeSelection(canvas: Canvas, options: { maxPx?: number; padding?: number } = {}): SelectionRaster | null {
  const objects = selectedObjects(canvas);

  if (objects.length === 0 || typeof document === 'undefined') return null;

  const wasMulti = objects.length > 1;

  if (wasMulti) canvas.discardActiveObject();

  const bounds = unionRects(
    objects.map((object) => {
      const rect = object.getBoundingRect();

      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }),
  );

  if (!bounds) return null;

  const plan = planSelectionRaster(bounds, options);
  const only = new Set<FabricObject>(objects);
  const original = [...(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0])] as [number, number, number, number, number, number];
  let ink: HTMLCanvasElement | null = null;

  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);

  try {
    ink = canvas.toCanvasElement(plan.scale, {
      left: plan.region.left,
      top: plan.region.top,
      width: plan.region.width,
      height: plan.region.height,
      filter: (object) => {
        if (only.has(object as FabricObject)) return true;
        if (!isEraserMark(object as FabricObject)) return false;

        const rect = (object as FabricObject).getBoundingRect();

        return rectsOverlap(plan.region, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      },
    });
  } finally {
    canvas.setViewportTransform(original);
  }

  if (wasMulti) canvas.setActiveObject(new ActiveSelection(objects, { canvas }));
  canvas.requestRenderAll();

  const output = document.createElement('canvas');

  output.width = plan.width;
  output.height = plan.height;

  const context = output.getContext('2d');

  if (!context || !ink) return null;

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, plan.width, plan.height);
  context.drawImage(ink, 0, 0, plan.width, plan.height);

  return { pngBase64: output.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), width: plan.width, height: plan.height };
}
