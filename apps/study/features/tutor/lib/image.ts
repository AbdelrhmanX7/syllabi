// Blob → base64 (no `data:` prefix) for `context.imagePngB64`. The board hands lassos over as PNG
// blobs; a downscaled retry may be JPEG — the field name stays, the backend sniffs the bytes.

export function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const url = String(reader.result ?? '');

      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the picture'));
    reader.readAsDataURL(blob);
  });
}

/** A JPEG copy with the long edge ≤ `maxPx` (for a 413 retry); null when the browser cannot. */
export async function downscaleBlob(image: Blob, maxPx = 1600): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(image);
    const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');

    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');

    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.88));
  } catch {
    return null;
  }
}
