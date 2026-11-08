import { StaticCanvas } from 'fabric';

import { drawOverlayImage } from './backgroundLayers';
import { drawLockedImages, enforceLockedImageInvariants, getLockedImages } from './lockedImages';
import { paintOverlayPattern } from './pageRender';
import { restoreRenderInvariants } from './restoreRenderInvariants';

import type { BackgroundType } from '../types';

/**
 * A page's server-merge overlay, rendered on a canvas that is never in the DOM.
 *
 * This is the Fabric half of `apps/whiteboard/lib/cloud-sync/offscreen-overlays.ts` — the only
 * code on that path that touches a canvas element or a Fabric object. Everything about WHICH
 * pages, WHAT frame, WHEN to yield and WHEN to stop lives on the app side with the tests; this
 * file answers exactly three questions for one page: load its JSON, where are its objects, and
 * what does its transparent overlay look like.
 *
 * The compositing is `createPageOverlaySnapshot` (WhiteboardEditor.tsx) verbatim, minus the live
 * canvas: pattern without the white fill (`paintOverlayPattern`), pinned images painted from the
 * object list (`drawLockedImages` — Fabric hides them, the background painter shows them), Fabric's
 * own export of the ink, then the shared background image on top. The PDF is never drawn; the
 * overlay stays transparent wherever the source page should show through on the backend.
 *
 * A `StaticCanvas` rather than a `Canvas`: no selection, no events, no upper canvas — half the
 * memory, and nothing to receive a pointer. `enableRetinaScaling` is off so the backing store is
 * the frame size and the export multiplier is the only scale in play.
 *
 * ## It must be interruptible, because it runs on the thread the pen writes on
 *
 * v0.1.164 shipped this with one abort point per page, on the app side, between pages. The teacher
 * reported the board «very very slow on writing, laggy and jittering»: staging starts after 10 s of
 * quiet, the pen comes back down, and the page already in flight runs to completion — an estimated
 * 300 ms – 1.5 s hitch at the exact moment writing resumes, ~60–130 MB of transient canvas with it.
 *
 * So the page render is no longer one atomic step. `checkpoint` is awaited between each heavy
 * stage below, and the encode is `toBlob` rather than `toDataURL` (see `encodePng`). Nothing here
 * decides WHEN to stop — that stays on the app side with the tests; this file only makes stopping
 * possible at more than one moment.
 */

export interface OffscreenOverlayFrame {
  width: number;
  height: number;
}

export interface OffscreenOverlayBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OffscreenOverlayRenderInput {
  bounds: OffscreenOverlayBounds;
  multiplier: number;
  backgroundType: BackgroundType;
  sharedBackgroundImageUrl?: string;
  sharedBackgroundImageOpacity: number;
  /**
   * Hand the main thread back and, if the render should stop, THROW. Called between the composite's
   * heavy steps — see the module header for why one abort point per page was not enough.
   *
   * Whatever it throws propagates out of `renderOverlayPng` untouched (the app side recognises its
   * own sentinel); the scratch bitmaps are released on the way out either way.
   */
  checkpoint?: () => Promise<void>;
}

export interface OffscreenOverlayCanvas {
  load: (canvasJSON: string) => Promise<void>;
  getExportableObjectBounds: () => OffscreenOverlayBounds[];
  /** The transparent overlay PNG as BYTES — never a base64 data URL. See the module header. */
  renderOverlayPng: (input: OffscreenOverlayRenderInput) => Promise<Blob>;
  dispose: () => Promise<void>;
}

function isExportable(object: { excludeFromExport?: boolean }): boolean {
  return !object.excludeFromExport;
}

const noCheckpoint = async (): Promise<void> => {};

/**
 * The composite as PNG BYTES, via the async `toBlob` rather than `toDataURL`.
 *
 * `toDataURL` encodes on the main thread and then builds a base64 string ~33 % larger than the
 * bytes; on a ~4 MP overlay (the 2400 px cap × multiplier 2) that measured as the single longest
 * uninterruptible step of a background page render — and the app side then walked the string back
 * to bytes, `charCodeAt` by `charCodeAt`, to get the blob the presigned PUT wanted all along.
 * `toBlob` is asynchronous and the browser encodes off the main thread, so the pen keeps drawing.
 */
function encodePng(canvasElement: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvasElement.toBlob((blob) => {
      if (blob) {
        resolve(blob);

        return;
      }

      reject(new Error('[offscreen-overlays] the merge canvas produced no PNG'));
    }, 'image/png');
  });
}

function loadImage(url: string | undefined): Promise<HTMLImageElement | null> {
  if (!url) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const image = new Image();

    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

export function createOffscreenOverlayCanvas(frame: OffscreenOverlayFrame): OffscreenOverlayCanvas {
  // Created, sized, and never appended: Fabric needs a real element for its 2D context, not a
  // place in the document.
  const element = document.createElement('canvas');
  const canvas = new StaticCanvas(element, {
    enableRetinaScaling: false,
    height: frame.height,
    renderOnAddRemove: false,
    width: frame.width,
  });

  let disposed = false;

  return {
    load: async (canvasJSON) => {
      if (canvasJSON) {
        try {
          await canvas.loadFromJSON(JSON.parse(canvasJSON));
        } catch {
          // A page whose JSON does not parse renders as empty — the same fallback `loadPage` takes —
          // rather than failing the whole board's stage over one corrupt page.
          canvas.clear();
        }
      }

      // Same self-heal as `loadPage`: a `background`/`backgroundImage` restored from JSON would
      // paint an opaque layer into an overlay that must stay transparent.
      canvas.backgroundImage = undefined;
      canvas.backgroundColor = 'transparent';
      restoreRenderInvariants(canvas);
      enforceLockedImageInvariants(canvas);
    },
    getExportableObjectBounds: () =>
      canvas
        .getObjects()
        .filter(isExportable)
        .map((object) => {
          const rect = object.getBoundingRect();

          return { height: rect.height, left: rect.left, top: rect.top, width: rect.width };
        }),
    renderOverlayPng: async ({
      backgroundType,
      bounds,
      checkpoint = noCheckpoint,
      multiplier,
      sharedBackgroundImageOpacity,
      sharedBackgroundImageUrl,
    }) => {
      const overlayImage = await loadImage(sharedBackgroundImageUrl);
      const exportWidth = bounds.width * multiplier;
      const exportHeight = bounds.height * multiplier;
      const patternCanvas = document.createElement('canvas');
      const overlayCanvas = document.createElement('canvas');
      const mergedCanvas = document.createElement('canvas');
      const mergedContext = mergedCanvas.getContext('2d');
      let fabricSnapshot: HTMLCanvasElement | null = null;

      if (!mergedContext) {
        throw new Error('[offscreen-overlays] no 2D context for the merge canvas');
      }

      try {
        // The four expensive steps, each behind a checkpoint, in the order they cost: re-rendering
        // every Fabric object at export scale, painting two export-sized scratch bitmaps, the three
        // composite draws, and the encode. A pen that touches the glass now is served at the NEXT
        // checkpoint instead of after all four.
        await checkpoint();

        fabricSnapshot = canvas.toCanvasElement(multiplier, {
          filter: isExportable,
          height: bounds.height,
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
        });

        await checkpoint();

        paintOverlayPattern(patternCanvas, backgroundType, exportWidth, exportHeight);
        drawOverlayImage(overlayCanvas, exportWidth, exportHeight, overlayImage, sharedBackgroundImageOpacity);

        await checkpoint();

        mergedCanvas.width = exportWidth;
        mergedCanvas.height = exportHeight;
        mergedContext.drawImage(patternCanvas, 0, 0, exportWidth, exportHeight);
        drawLockedImages(mergedContext, getLockedImages(canvas), [1, 0, 0, 1, -bounds.left, -bounds.top], multiplier);
        mergedContext.drawImage(fabricSnapshot, 0, 0, exportWidth, exportHeight);
        mergedContext.drawImage(overlayCanvas, 0, 0, exportWidth, exportHeight);

        await checkpoint();

        return await encodePng(mergedCanvas);
      } finally {
        // Release the scratch bitmaps now rather than when the GC gets to them: three export-sized
        // canvases per page add up on a board CPU with little headroom. In a `finally` because an
        // abort throws straight through here and must not leave ~60–130 MB of them behind.
        for (const scratch of [patternCanvas, overlayCanvas, mergedCanvas, fabricSnapshot]) {
          if (scratch) {
            scratch.width = 0;
            scratch.height = 0;
          }
        }
      }
    },
    dispose: async () => {
      if (disposed) {
        return;
      }

      disposed = true;

      try {
        await canvas.dispose();
      } catch {
        // A second dispose (or one racing a render) throws by contract; the element is dropped below.
      }

      element.width = 0;
      element.height = 0;
    },
  };
}
