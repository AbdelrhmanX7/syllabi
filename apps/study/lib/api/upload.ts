// Presigned uploads/downloads. The contract hands out short-lived B2 URLs; the mock hands out
// `mock://…` URLs that resolve against its in-memory blob store so the same client code runs in both.
import { getMockBlobStore } from './mock/store';

export const MOCK_URL_PREFIX = 'mock://';

export async function putToUrl(url: string, body: Blob | string, contentType: string): Promise<void> {
  if (url.startsWith(MOCK_URL_PREFIX)) {
    const blob = typeof body === 'string' ? new Blob([body], { type: contentType }) : body;

    getMockBlobStore().set(url, blob);

    return;
  }

  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body });

  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`.trim());
}

export async function fetchBlobFromUrl(url: string): Promise<Blob> {
  if (url.startsWith(MOCK_URL_PREFIX)) {
    const blob = getMockBlobStore().get(url);

    if (!blob) throw new Error('Mock blob missing');

    return blob;
  }

  const res = await fetch(url);

  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`.trim());

  return res.blob();
}

export async function fetchJsonFromUrl<T>(url: string): Promise<T> {
  const blob = await fetchBlobFromUrl(url);
  const text = await blob.text();

  return JSON.parse(text) as T;
}

/**
 * A media URL the browser can play: a signed B2 link as-is, a `mock://` blob as an object URL
 * (an `<audio src="mock://…">` never loads, so the mock-backed lecture player would error forever).
 */
export function resolveMediaUrl(url: string): string {
  if (!url.startsWith(MOCK_URL_PREFIX)) return url;
  const blob = getMockBlobStore().get(url);

  return blob ? URL.createObjectURL(blob) : url;
}
