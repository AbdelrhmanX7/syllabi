// Photo / file → PNG base64 for `/questions/extract`. Downscales so the long side is ≤ `maxPx`.

export const MAX_PHOTO_PX = 1600;

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

/** Fit `w×h` inside `maxPx`, never upscaling. */
export function fitWithin(w: number, h: number, maxPx: number): { w: number; h: number } {
  const scale = Math.min(1, maxPx / Math.max(w, h, 1));

  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

export async function fileToPngB64(file: Blob, maxPx = MAX_PHOTO_PX): Promise<string> {
  const image = await loadImage(file);
  const { w, h } = fitWithin(image.naturalWidth, image.naturalHeight, maxPx);
  const canvas = document.createElement('canvas');

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  if (!ctx) throw new Error('Canvas unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(image, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/png');

  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

export const b64ToDataUrl = (b64: string) => `data:image/png;base64,${b64}`;
