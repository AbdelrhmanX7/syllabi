import { WhiteboardApiError } from './client';

export interface WhiteboardDirectUploadOptions {
  body: BodyInit;
  contentType?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  uploadUrl: string;
}

function bindFetcher(fetcher: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Reflect.apply(
      fetcher as unknown as (...args: [RequestInfo | URL, RequestInit | undefined]) => Promise<Response>,
      globalThis,
      [input, init],
    )) as typeof fetch;
}

export async function uploadToWhiteboardPresignedUrl({
  body,
  contentType,
  fetcher = fetch,
  signal,
  uploadUrl,
}: WhiteboardDirectUploadOptions): Promise<void> {
  const headers = new Headers();

  if (contentType) {
    headers.set('Content-Type', contentType);
  }

  const response = await bindFetcher(fetcher)(uploadUrl, {
    body,
    headers,
    method: 'PUT',
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    const fallbackMessage = errorText || response.statusText || 'Failed to upload the whiteboard asset.';

    throw new WhiteboardApiError(fallbackMessage, response.status, errorText);
  }
}
