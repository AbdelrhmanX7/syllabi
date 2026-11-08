import type { WhiteboardFileBridge } from '@repo/whiteboard-react';

/**
 * Board exports (PDF / PNG / .kawb.json) as real files.
 *
 * The Android WebView ignores `<a download>` — the board's built-in export did nothing there. The
 * APK installs `window.StudyFiles` (FileExporter.kt): the file is streamed to it in base64 chunks and
 * lands in Downloads. The web build keeps the plain anchor download.
 */

interface StudyFilesBridge {
  begin(name: string, mime: string): string;
  append(id: string, base64: string): boolean;
  finish(id: string): boolean;
}

declare global {
  interface Window {
    StudyFiles?: StudyFilesBridge;
  }
}

// A multiple of 3, so every chunk encodes to base64 on its own without padding in the middle.
const CHUNK_BYTES = 3 * 256 * 1024;

function toBase64(bytes: Uint8Array): string {
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }

  return btoa(binary);
}

async function saveBytes(name: string, data: Uint8Array, mimeType: string): Promise<void> {
  const native = typeof window === 'undefined' ? undefined : window.StudyFiles;

  if (native) {
    const id = native.begin(name, mimeType);

    for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
      if (!native.append(id, toBase64(data.subarray(offset, offset + CHUNK_BYTES)))) {
        throw new Error('Export failed while writing the file');
      }
      // Let the page breathe between chunks of a large PDF.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!native.finish(id)) throw new Error('Export failed');

    return;
  }

  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mimeType }));
  const link = document.createElement('a');

  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

export const studyFileBridge: WhiteboardFileBridge = {
  saveBinary: ({ suggestedName, data, mimeType }) =>
    saveBytes(suggestedName, data, mimeType ?? 'application/octet-stream'),
  saveText: ({ suggestedName, text, mimeType }) =>
    saveBytes(suggestedName, new TextEncoder().encode(text), mimeType ?? 'text/plain'),
};
