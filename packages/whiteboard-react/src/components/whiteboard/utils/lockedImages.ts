import { FabricImage, util } from 'fabric';

import type { Canvas, FabricObject, StaticCanvas } from 'fabric';

/**
 * Pinned ("locked") images — teacher inserts an exam/question image, pins it, and annotates over it.
 *
 * A pinned image must survive every eraser. The pixel and palm erasers commit
 * `destination-out` paths that punch EVERY fabric pixel below them in z-order, so no in-layer
 * arrangement can protect an image while keeping the ink above it erasable. The only placement
 * that works is the one the PDF page background already uses: the separate background canvas
 * BELOW the (transparent) fabric canvas. So "pinning" keeps the FabricImage in the object list
 * (data model, persistence, unpin) but hides it from fabric rendering (`visible: false`) and
 * paints it onto the background canvas instead.
 */
export const LOCKED_IMAGE_PROP = 'wbLockedImage';

type LockableObject = FabricObject & { [LOCKED_IMAGE_PROP]?: boolean };

/**
 * `canvas.toJSON()` only serializes whitelisted props; without this registration the pin flag is
 * silently dropped on save (and by every undo/redo snapshot). The load side needs nothing: fabric
 * copies unknown JSON keys back onto the instance. Idempotent — safe to call from several modules.
 */
export function registerLockedImagePersistence(): void {
  if (!FabricImage.customProperties?.includes(LOCKED_IMAGE_PROP)) {
    FabricImage.customProperties = [...(FabricImage.customProperties ?? []), LOCKED_IMAGE_PROP];
  }
}

export function isLockedImage(obj: FabricObject | null | undefined): boolean {
  return Boolean((obj as LockableObject | null | undefined)?.[LOCKED_IMAGE_PROP]);
}

/**
 * Flips one image between pinned and normal. `visible: false` is what actually removes it from the
 * fabric compositing (and from eraser punches); the background painter draws it instead. Callers
 * must follow up with `notifyLockedImagesChanged(canvas)` once the batch of changes is done.
 */
export function applyImageLockState(obj: FabricObject, locked: boolean): void {
  (obj as LockableObject)[LOCKED_IMAGE_PROP] = locked;
  obj.visible = !locked;
  obj.selectable = !locked;
  obj.evented = !locked;
  obj.dirty = true;
}

/**
 * Re-asserts pin invariants after any `loadFromJSON` (page open, undo/redo). Also heals an image
 * left `visible: false` WITHOUT the pin flag — that state only arises when an older app build
 * (which drops the unregistered flag on save) re-saved a board with a pinned image; making it
 * visible again beats an image that exists but can never be seen or recovered.
 * Returns the number of pinned images so callers can skip background work when there are none.
 */
export function enforceLockedImageInvariants(canvas: StaticCanvas): number {
  let lockedCount = 0;

  for (const obj of canvas.getObjects()) {
    if (isLockedImage(obj)) {
      lockedCount += 1;
      applyImageLockState(obj, true);
    } else if (obj instanceof FabricImage && obj.visible === false && !obj.excludeFromExport) {
      obj.visible = true;
      obj.dirty = true;
    }
  }

  return lockedCount;
}

/** Pinned images in stacking order (the order they must be painted in). */
export function getLockedImages(canvas: StaticCanvas): FabricObject[] {
  return canvas.getObjects().filter((obj) => isLockedImage(obj));
}

/**
 * Paints pinned images in scene coordinates onto a 2D context, mirroring the background-layer
 * recipe in backgroundLayers.ts: the device-pixel ratio is folded into the transform so the image
 * lands on the device-pixel backing store 1:1. Pass the fabric `viewportTransform` for the live
 * background canvas, or the identity (with `pixelRatio` = export multiplier) for export surfaces.
 */
export function drawLockedImages(
  ctx: CanvasRenderingContext2D,
  images: FabricObject[],
  viewportTransform: [number, number, number, number, number, number] | number[] | undefined,
  pixelRatio = 1,
): void {
  if (images.length === 0) return;

  const dpr = pixelRatio > 0 ? pixelRatio : 1;
  const vt = viewportTransform ?? [1, 0, 0, 1, 0, 0];

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  for (const obj of images) {
    const element = obj instanceof FabricImage ? obj.getElement() : null;
    const width = obj.width ?? 0;
    const height = obj.height ?? 0;

    if (!element || width <= 0 || height <= 0) continue;

    // calcTransformMatrix() is center-origin and already carries angle/scale/flip, so the image is
    // drawn about (-w/2, -h/2) after folding viewport ∘ object into one device-pixel transform.
    const m = util.multiplyTransformMatrices(
      [vt[0] ?? 1, vt[1] ?? 0, vt[2] ?? 0, vt[3] ?? 1, vt[4] ?? 0, vt[5] ?? 0],
      obj.calcTransformMatrix(),
    );

    ctx.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
    ctx.globalAlpha = obj.opacity ?? 1;
    // The crop (`cropX`/`cropY`, `width`×`height` of the source) is what the image draws — the
    // 5-argument form would squeeze the whole source into the cropped size.
    const cropX = Math.max(0, (obj as FabricImage).cropX ?? 0);
    const cropY = Math.max(0, (obj as FabricImage).cropY ?? 0);

    ctx.drawImage(element, cropX, cropY, width, height, -width / 2, -height / 2, width, height);
  }

  ctx.restore();
}

/**
 * Change notifications, kept outside fabric's typed event map. The background painter
 * (WhiteboardCanvas) subscribes to repaint; the editor subscribes to persist the page snapshot.
 * Fire after every pin/unpin batch and after invariant enforcement restores pinned images.
 */
const lockedImagesListeners = new WeakMap<Canvas, Set<() => void>>();

export function onLockedImagesChanged(canvas: Canvas, listener: () => void): () => void {
  let listeners = lockedImagesListeners.get(canvas);

  if (!listeners) {
    listeners = new Set();
    lockedImagesListeners.set(canvas, listeners);
  }

  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function notifyLockedImagesChanged(canvas: Canvas): void {
  lockedImagesListeners.get(canvas)?.forEach((listener) => listener());
}
