/**
 * Download a board's source-PDF asset bytes (authenticated proxy GET via getSourcePdfReadAccess)
 * into a Blob, reporting streaming progress. Used on board open to hydrate the local IndexedDB
 * cache so the (local-first) PDF renderer can draw — and so a studio-uploaded board doesn't open
 * blank on a second device. Mirrors the SourcePdfUploadProgress contract.
 */

export interface SourcePdfDownloadProgress {
  receivedBytes: number;
  /** Best-effort total (Content-Length, else the caller-supplied asset size, else received). */
  totalBytes: number;
}

export interface DownloadSourcePdfOptions {
  url: string;
  headers?: Record<string, string>;
  /** Fallback total when the response has no Content-Length (e.g. the asset's recorded fileSize). */
  totalBytes?: number;
  signal?: AbortSignal;
  /** Override for tests / non-DOM environments. */
  fetcher?: typeof fetch;
  onProgress?: (progress: SourcePdfDownloadProgress) => void;
}

export async function downloadSourcePdfToBlob(options: DownloadSourcePdfOptions): Promise<Blob> {
  const { url, headers, totalBytes, signal, onProgress } = options;
  const fetcher = options.fetcher ?? fetch;

  const response = await fetcher(url, { headers, signal });

  if (!response.ok) {
    throw new Error(`Couldn't download the PDF (${response.status})`);
  }

  const headerTotal = Number(response.headers.get('content-length'));
  const knownTotal = Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : (totalBytes ?? 0);

  // Streaming path: report granular progress as chunks arrive.
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (value) {
        chunks.push(value);
        receivedBytes += value.byteLength;
        onProgress?.({ receivedBytes, totalBytes: knownTotal > 0 ? knownTotal : receivedBytes });
      }
    }

    return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
  }

  // Fallback (no streaming support): one-shot blob, single progress tick.
  const blob = await response.blob();

  onProgress?.({ receivedBytes: blob.size, totalBytes: knownTotal > 0 ? knownTotal : blob.size });

  return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
}
