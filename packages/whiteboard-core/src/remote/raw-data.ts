import { migrateWhiteboardDocument } from '../migrations';

import type { WhiteboardDocument } from '../types';

/**
 * Decode a remote raw-data payload to a current-schema document. Migration runs here
 * IN-MEMORY ONLY (§2.5): the syncer owns all cloud writes, so a decode must never trigger
 * a cloud resave even when the snapshot was an older schema version. `migrateWhiteboardDocument`
 * throws on irrecoverable non-object input, preserving the previous "invalid payload" contract.
 */
function ensureDocument(value: unknown): WhiteboardDocument {
  if (value === null || value === undefined) {
    throw new Error('Invalid whiteboard raw data payload.');
  }

  return migrateWhiteboardDocument(value).document;
}

function hasCompressionStreamSupport(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

function isGzipPayload(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function blobFromStream(stream: ReadableStream<Uint8Array>): Promise<Blob> {
  return new Response(stream).blob();
}

async function gzipBlob(blob: Blob): Promise<Blob> {
  if (typeof CompressionStream === 'undefined') {
    return blob;
  }

  return blobFromStream(blob.stream().pipeThrough(new CompressionStream('gzip')));
}

async function gunzipBlob(blob: Blob): Promise<Blob> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot read gzipped whiteboard drafts.');
  }

  return blobFromStream(blob.stream().pipeThrough(new DecompressionStream('gzip')));
}

function textBlob(value: string): Blob {
  return new Blob([value], { type: 'application/json' });
}

function bindFetcher(fetcher: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Reflect.apply(
      fetcher as unknown as (...args: [RequestInfo | URL, RequestInit | undefined]) => Promise<Response>,
      globalThis,
      [input, init],
    )) as typeof fetch;
}

export interface WhiteboardRawDataBlobResult {
  blob: Blob;
  contentType: string;
  encoding: 'gzip' | 'identity';
}

export function serializeWhiteboardRawData(document: WhiteboardDocument, pretty = false): string {
  return JSON.stringify(document, null, pretty ? 2 : 0);
}

export async function createWhiteboardRawDataBlob(
  document: WhiteboardDocument,
  options: { gzip?: boolean; pretty?: boolean } = {},
): Promise<WhiteboardRawDataBlobResult> {
  const sourceBlob = textBlob(serializeWhiteboardRawData(document, options.pretty));
  const shouldGzip = options.gzip !== false && hasCompressionStreamSupport();

  if (!shouldGzip) {
    return {
      blob: sourceBlob,
      contentType: 'application/octet-stream',
      encoding: 'identity',
    };
  }

  return {
    blob: await gzipBlob(sourceBlob),
    contentType: 'application/octet-stream',
    encoding: 'gzip',
  };
}

export async function decodeWhiteboardRawDataPayload(
  input: ArrayBuffer | Blob | Response | string | Uint8Array,
): Promise<WhiteboardDocument> {
  if (typeof input === 'string') {
    return ensureDocument(JSON.parse(input));
  }

  const sourceBlob =
    input instanceof Response
      ? await input.blob()
      : input instanceof Blob
        ? input
        : input instanceof Uint8Array
          ? new Blob([input])
          : new Blob([input]);
  const bytes = new Uint8Array(await sourceBlob.arrayBuffer());
  const normalizedBlob = isGzipPayload(bytes) ? await gunzipBlob(new Blob([bytes])) : new Blob([bytes]);
  const text = await normalizedBlob.text();

  return ensureDocument(JSON.parse(text));
}

export async function fetchWhiteboardRawData(
  rawDataUrl: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<WhiteboardDocument> {
  const response = await bindFetcher(fetcher)(rawDataUrl, {
    headers: {
      Accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.8',
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch whiteboard raw data (${response.status}).`);
  }

  return decodeWhiteboardRawDataPayload(response);
}
