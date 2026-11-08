// Picture → PNG base64 for `/concept-maps/grade`: cropped to the drawing, flattened on white, long
// side ≤ 2000 px. The crop maths (`contentBounds`) is pure so it can be unit-tested; everything
// touching a canvas lives below it.

export const MAX_MAP_PX = 2000;

export interface PixelBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bounding box of the pixels that differ from the background (the picture's corner colour) by more
 * than `threshold` on any channel, grown by `pad` and clamped. Null when the picture is blank. Works
 * for black-background Samsung Notes screenshots and white paper alike.
 */
export function contentBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  { threshold = 48, pad = 24 }: { threshold?: number; pad?: number } = {},
): PixelBounds | null {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;
  const bgR = data[0]!;
  const bgG = data[1]!;
  const bgB = data[2]!;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * 4;

    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + x * 4;

      if (data[offset + 3]! < 16) continue; // transparent = background
      if (
        Math.abs(data[offset]! - bgR) > threshold ||
        Math.abs(data[offset + 1]! - bgG) > threshold ||
        Math.abs(data[offset + 2]! - bgB) > threshold
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);

  return { x, y, w: Math.min(width, maxX + pad + 1) - x, h: Math.min(height, maxY + pad + 1) - y };
}

/** Fit `w×h` inside `maxPx`, never upscaling. */
export function fitWithin(w: number, h: number, maxPx: number): { w: number; h: number } {
  const scale = Math.min(1, maxPx / Math.max(w, h, 1));

  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    image.src = url;
  });
}

const stripDataUrl = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);

/**
 * A photo / screenshot of a map → base64 PNG (no prefix): cropped to the drawing, downscaled to
 * ≤ `maxPx`, flattened on white. A dark-background screenshot keeps its dark background (the model
 * reads it fine) — only transparency is flattened.
 */
export async function fileToMapPngB64(file: Blob, maxPx = MAX_MAP_PX): Promise<string> {
  const image = await loadImage(file);
  const source = document.createElement('canvas');
  // Analyse the crop on a bounded copy (a 4000 px photo is 64 MB of pixels at full size).
  const probe = fitWithin(image.naturalWidth, image.naturalHeight, 1200);

  source.width = probe.w;
  source.height = probe.h;
  const probeCtx = source.getContext('2d', { willReadFrequently: true });

  if (!probeCtx) throw new Error('Canvas unavailable');
  probeCtx.fillStyle = '#ffffff';
  probeCtx.fillRect(0, 0, probe.w, probe.h);
  probeCtx.drawImage(image, 0, 0, probe.w, probe.h);
  const pixels = probeCtx.getImageData(0, 0, probe.w, probe.h).data;
  const bounds = contentBounds(pixels, probe.w, probe.h) ?? { x: 0, y: 0, w: probe.w, h: probe.h };
  const scaleBack = image.naturalWidth / probe.w;
  const crop = {
    x: Math.floor(bounds.x * scaleBack),
    y: Math.floor(bounds.y * scaleBack),
    w: Math.ceil(bounds.w * scaleBack),
    h: Math.ceil(bounds.h * scaleBack),
  };
  const out = fitWithin(crop.w, crop.h, maxPx);
  const canvas = document.createElement('canvas');

  canvas.width = out.w;
  canvas.height = out.h;
  const ctx = canvas.getContext('2d');

  if (!ctx) throw new Error('Canvas unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.w, out.h);
  ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, out.w, out.h);

  return stripDataUrl(canvas.toDataURL('image/png'));
}

export const b64ToDataUrl = (b64: string): string => `data:image/png;base64,${b64}`;

/** Rough byte size of a base64 payload. */
export const b64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4);
