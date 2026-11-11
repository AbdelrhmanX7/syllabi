// Shared transport for every feature. Real calls go to `${apiBase}/study/...`; when mock mode is on
// (no backend yet, or `localStorage.study_mock = '1'`) `lib/api/mock` answers instead, so features
// can be built and tested before the backend ships each phase.

import { studyApiError } from './errors';

export interface SseFrame<T = unknown> {
  event: string;
  data: T;
}

export interface StudyTransport {
  /** `headers` (e.g. `If-Match`) are merged into the live request; the mock may read them. */
  json<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  sse(path: string, body: unknown, onFrame: (frame: SseFrame) => void, signal?: AbortSignal): Promise<void>;
  /**
   * Send a RAW body (board JSON text, an audio chunk) straight to a study route — the backend's
   * answer to B2's CORS blocking browser PUTs to presigned URLs. Optional so older transports still
   * type-check; `studyPutRaw` throws when the installed transport lacks it.
   */
  raw?<T>(method: string, path: string, body: Blob | string, contentType: string): Promise<T>;
  /** Raw body in, raw body out (a file conversion). Live only — the mock has nothing to convert with. */
  rawBlob?(method: string, path: string, body: Blob, headers: Record<string, string>): Promise<Response>;
}

let transport: StudyTransport | null = null;

/** Installed once by the app shell (`lib/api/client.ts`) after it resolves base URL, token and mock mode. */
export function setStudyTransport(next: StudyTransport): void {
  transport = next;
}

function current(): StudyTransport {
  if (!transport) throw new Error('Study transport not installed yet');

  return transport;
}

export const studyGet = <T>(path: string, headers?: Record<string, string>) =>
  current().json<T>('GET', path, undefined, headers);
export const studyPost = <T>(path: string, body?: unknown) => current().json<T>('POST', path, body);
export const studyPut = <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
  current().json<T>('PUT', path, body, headers);
export const studyPatch = <T>(path: string, body?: unknown) => current().json<T>('PATCH', path, body);
export const studyDelete = <T = void>(path: string) => current().json<T>('DELETE', path);

/** PUT a raw body (not JSON-wrapped) to a study route; resolves with the parsed JSON answer. */
export const studyPutRaw = <T>(path: string, body: Blob | string, contentType: string) => {
  const transport = current();

  if (!transport.raw) throw new Error('Study transport has no raw-body support');

  return transport.raw<T>('PUT', path, body, contentType);
};

/** POST a raw body (a file upload) to a study route; resolves with the parsed JSON answer. */
export const studyPostRaw = <T>(path: string, body: Blob, contentType: string) => {
  const transport = current();

  if (!transport.raw) throw new Error('Study transport has no raw-body support');

  return transport.raw<T>('POST', path, body, contentType);
};

/** POST a raw body and get the raw answer back (`Response`, already checked `ok`). */
export const studyPostRawBlob = (path: string, body: Blob, headers: Record<string, string>) => {
  const transport = current();

  if (!transport.rawBlob) throw new Error('This needs the live backend (turn off sample mode)');

  return transport.rawBlob('POST', path, body, headers);
};

/** POST an SSE endpoint; resolves after `done`, rejects on `error` frames or transport failure. */
export const studySse = (path: string, body: unknown, onFrame: (frame: SseFrame) => void, signal?: AbortSignal) =>
  current().sse(path, body, onFrame, signal);

/** Parses a fetch Response body as SSE frames. Used by the real transport. */
export async function readSse(res: Response, onFrame: (frame: SseFrame) => void): Promise<void> {
  if (!res.body) throw new Error('Empty SSE body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    // Proxies may re-frame with CRLF; the study backend writes `event: x\ndata: {json}\n\n`.
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n?/g, '\n');
    let sep = buffer.indexOf('\n\n');

    while (sep !== -1) {
      const raw = buffer.slice(0, sep);

      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf('\n\n');
      let event: string | null = null;
      const dataLines: string[] = [];

      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      // `: ping` keep-alives (every 10 s) and blank blocks carry neither — not a frame.
      if (event === null && dataLines.length === 0) continue;
      event ??= 'message';
      const text = dataLines.join('\n');
      let data: unknown = text;

      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // plain-text data stays a string
      }
      if (event === 'error') {
        // `{ message, code, …extra }` like a JSON error body: features branch on `code`
        // (NO_TRANSCRIPT, NO_OCR_TEXT, NOT_AVAILABLE, AI_EMPTY). The message text is unchanged.
        const body =
          data && typeof data === 'object'
            ? (data as { message?: string; code?: string } & Record<string, unknown>)
            : null;
        const message = body?.message ?? String(text);

        throw studyApiError(res.status, message, body?.code, body ?? {});
      }
      onFrame({ event, data });
      if (event === 'done') return;
    }
  }
}
