import type { WhiteboardApiSourcePdfMultipartPart } from './types';

import { WhiteboardApiClient, WhiteboardApiError } from './client';
import { uploadToWhiteboardPresignedUrl } from './upload';

const DEFAULT_MULTIPART_THRESHOLD = 16 * 1024 * 1024; // 16MB
const OCTET_STREAM = 'application/octet-stream';
const PART_PUT_MAX_ATTEMPTS = 3;
const PART_PUT_BASE_BACKOFF_MS = 250;

/**
 * Progress callback payload. `uploadedBytes`/`totalBytes` track the whole file; `part`/`totalParts`
 * are present only during the multipart path.
 */
export interface SourcePdfUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  part?: number;
  totalParts?: number;
}

/**
 * Server ids for an in-progress multipart upload, captured via {@link UploadSourcePdfAssetOptions.onMultipartStart}
 * and replayed via {@link UploadSourcePdfAssetOptions.resume} to continue an interrupted upload
 * WITHOUT re-uploading already-sent parts. `start` is NOT idempotent for unconfirmed uploads (a fresh
 * call mints new ids), so resume MUST reuse these — the server's `parts` listing then lets the
 * uploader skip the parts already PUT under this `uploadId`.
 */
export interface WhiteboardMultipartResumeInfo {
  assetId: string;
  uploadId: string;
  partSize: number;
}

export interface UploadSourcePdfAssetOptions {
  /**
   * Runs `fn` with a configured {@link WhiteboardApiClient}. Mirrors the board page's
   * `runWithWhiteboardAppClient`, so the caller owns key/baseUrl resolution and retries.
   */
  runWithClient: <T>(fn: (client: WhiteboardApiClient) => Promise<T>) => Promise<T>;
  documentId: string;
  file: Blob;
  fileName: string;
  mimeType?: string;
  pageCount: number;
  /** Precomputed SHA-256 hex; when omitted the uploader computes it from `file`. */
  checksum?: string;
  onProgress?: (progress: SourcePdfUploadProgress) => void;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  /** Bytes; files at or below this use the single-PUT path. Defaults to 16MB. */
  multipartThreshold?: number;
  /**
   * Resume an interrupted multipart upload: skip `start`, reuse these ids, and diff against the
   * server's already-uploaded parts so only the missing partNumbers are re-PUT. If the saved upload
   * is stale/expired the uploader transparently falls back to a fresh `start`.
   */
  resume?: WhiteboardMultipartResumeInfo;
  /** Fired once a multipart upload has its server ids — persist these to enable {@link resume}. */
  onMultipartStart?: (info: WhiteboardMultipartResumeInfo) => void;
}

export interface UploadSourcePdfAssetResult {
  assetId: string;
  deduped: boolean;
}

/** Lowercase hex SHA-256 of the given data via `crypto.subtle.digest`. */
export async function sha256Hex(data: ArrayBuffer | Blob | Uint8Array): Promise<string> {
  let buffer: ArrayBuffer;

  if (data instanceof Blob) {
    buffer = await data.arrayBuffer();
  } else if (data instanceof Uint8Array) {
    buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  } else {
    buffer = data;
  }

  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let hex = '';

  for (let index = 0; index < bytes.length; index += 1) {
    hex += bytes[index].toString(16).padStart(2, '0');
  }

  return hex;
}

function bindFetcher(fetcher: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Reflect.apply(
      fetcher as unknown as (...args: [RequestInfo | URL, RequestInit | undefined]) => Promise<Response>,
      globalThis,
      [input, init],
    )) as typeof fetch;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('The source PDF upload was aborted.', 'AbortError');
  }
}

function isRetriablePartError(error: unknown): boolean {
  // Abort is terminal; never retry.
  if (error instanceof DOMException && error.name === 'AbortError') {
    return false;
  }

  // 5xx from the part PUT is retriable; 4xx is not.
  if (error instanceof WhiteboardApiError) {
    return error.status >= 500;
  }

  // Network-level failures (TypeError from fetch, etc.) are retriable.
  return true;
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('The source PDF upload was aborted.', 'AbortError'));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();

        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * PUT a raw part to its presigned URL and read the etag from the JSON response BODY (B2 returns
 * the canonical part etag in the body, not a header). Throws {@link WhiteboardApiError} on !ok.
 */
async function putMultipartPart(
  url: string,
  body: Blob,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<{ etag: string; size: number }> {
  const response = await fetcher(url, {
    body,
    headers: { 'Content-Type': OCTET_STREAM },
    method: 'PUT',
    signal,
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new WhiteboardApiError(
      responseText || response.statusText || 'Failed to upload the source PDF part.',
      response.status,
      responseText,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new WhiteboardApiError('Part upload response was not valid JSON.', response.status, responseText);
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('etag' in parsed) ||
    typeof (parsed as { etag: unknown }).etag !== 'string'
  ) {
    throw new WhiteboardApiError('Part upload response missing etag.', response.status, parsed);
  }

  const sizeValue = (parsed as { size?: unknown }).size;

  return {
    etag: (parsed as { etag: string }).etag,
    size: typeof sizeValue === 'number' ? sizeValue : body.size,
  };
}

async function putMultipartPartWithRetry(
  url: string,
  body: Blob,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<{ etag: string; size: number }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= PART_PUT_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);

    try {
      return await putMultipartPart(url, body, fetcher, signal);
    } catch (error) {
      lastError = error;

      if (attempt >= PART_PUT_MAX_ATTEMPTS || !isRetriablePartError(error)) {
        throw error;
      }

      await delay(PART_PUT_BASE_BACKOFF_MS * attempt, signal);
    }
  }

  throw lastError;
}

const RESUME_LIST_MAX_ATTEMPTS = 2;

type ListPartsResponse = Awaited<ReturnType<WhiteboardApiClient['listSourcePdfMultipartParts']>>;

/**
 * Outcome of probing a saved (resumed) multipart upload:
 *   - `parts`     → reuse the listing; only the missing partNumbers get re-PUT.
 *   - `completed` → the asset is already confirmed server-side; adopt its `assetId` as done, NEVER
 *     re-upload.
 *   - `restart`   → the saved upload is gone/mismatched (or a transient outlived the bounded retry) →
 *     fall back to a fresh `start`.
 */
type ResumePartsResolution =
  | { kind: 'parts'; parts: ListPartsResponse }
  | { kind: 'completed'; assetId: string }
  | { kind: 'restart' };

/** True for the backend's `409 { alreadyCompleted: true, assetId }` "this upload is already done" body. */
function isAlreadyCompletedBody(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { alreadyCompleted?: unknown }).alreadyCompleted === true;
}

/**
 * Probe a saved (resumed) multipart upload against the now-live server contract (BE #210, deployed to
 * prod):
 *   - 200                              → reuse the listed parts.
 *   - 409 { alreadyCompleted, assetId} → asset already confirmed → adopt it as done, no re-upload.
 *   - 410 { gone } / 400               → uploadId expired/aborted/mismatched → fresh `start`.
 *   - 5xx                              → genuine transient (the backend keeps the asset + multipart
 *     intact across a transient, so the retry re-lists the SAME upload); bounded retry, then fall back
 *     to a fresh start so a flaky backend can never loop "continue" forever.
 * Abort is terminal. (Pre-#210 a dead uploadId surfaced as an ambiguous 500 — hence the retry; with
 * the deterministic 410 now live, the bounded retry covers only true transients.)
 */
/**
 * Infer the server's multipart part size from a parts listing.
 *
 * The listing is `{ parts }` with no `partSize` field, so this is the only way to check a persisted
 * part size against the server's current one. Every part except the LAST is exactly `partSize`, and
 * the uploader PUTs parts sequentially from 1 — so whenever the listing is non-empty it contains at
 * least one full-size part, and the maximum size across the listing is the server's `partSize`.
 *
 * The multipart path is only taken when the file exceeds the threshold, and the server's part size
 * is at most that threshold, so a real upload always has ≥2 parts. If a future server ever set a
 * part size LARGER than the client's threshold, a single-part upload could under-report here — that
 * reads as a mismatch and forces a fresh start, which is wasteful but never corrupting.
 *
 * @returns The inferred part size, or `null` when the listing is empty (nothing to infer from).
 */
function derivePartSizeFromParts(parts: WhiteboardApiSourcePdfMultipartPart[]): number | null {
  let largest: number | null = null;

  for (const part of parts) {
    if (largest === null || part.size > largest) {
      largest = part.size;
    }
  }

  return largest;
}

async function resolveResumeParts(
  runWithClient: UploadSourcePdfAssetOptions['runWithClient'],
  documentId: string,
  assetId: string,
  uploadId: string,
  signal: AbortSignal | undefined,
): Promise<ResumePartsResolution> {
  for (let attempt = 1; attempt <= RESUME_LIST_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);

    try {
      const parts = await runWithClient((client) =>
        client.listSourcePdfMultipartParts(documentId, assetId, { uploadId }),
      );

      return { kind: 'parts', parts };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }

      if (error instanceof WhiteboardApiError) {
        if (error.status === 409 && isAlreadyCompletedBody(error.body)) {
          const bodyAssetId = (error.body as { assetId?: unknown }).assetId;

          return { kind: 'completed', assetId: typeof bodyAssetId === 'string' ? bodyAssetId : assetId };
        }

        // 410 (gone) / 400 (mismatch) and any other 4xx → restart immediately, no retry.
        if (error.status >= 400 && error.status < 500) {
          return { kind: 'restart' };
        }
      }

      if (attempt >= RESUME_LIST_MAX_ATTEMPTS) {
        return { kind: 'restart' };
      }

      await delay(PART_PUT_BASE_BACKOFF_MS * attempt, signal);
    }
  }

  return { kind: 'restart' };
}

/**
 * Upload a source PDF to a whiteboard document, choosing the single-PUT or multipart path by size.
 * Always dedups first (zero upload when the backend already holds a matching checksum). Never calls
 * both the upload-url and multipart flows for a single file.
 */
export async function uploadSourcePdfAsset(options: UploadSourcePdfAssetOptions): Promise<UploadSourcePdfAssetResult> {
  const {
    runWithClient,
    documentId,
    file,
    fileName,
    mimeType,
    pageCount,
    onProgress,
    signal,
    multipartThreshold = DEFAULT_MULTIPART_THRESHOLD,
    resume,
    onMultipartStart,
  } = options;
  const fetcher = bindFetcher(options.fetcher ?? fetch);
  const fileSize = file.size;
  const resolvedMimeType = mimeType ?? file.type ?? 'application/pdf';

  throwIfAborted(signal);

  const checksum = options.checksum ?? (await sha256Hex(file));

  // ── Single-PUT path (≤ threshold) ─────────────────────────────────────────
  if (fileSize <= multipartThreshold) {
    const uploadInfo = await runWithClient((client) =>
      client.requestSourcePdfUploadUrl(documentId, { checksum, fileName, fileSize }),
    );

    if (uploadInfo.deduped) {
      return { assetId: uploadInfo.assetId, deduped: true };
    }

    throwIfAborted(signal);

    await uploadToWhiteboardPresignedUrl({
      body: file,
      contentType: OCTET_STREAM,
      fetcher: options.fetcher,
      signal,
      uploadUrl: uploadInfo.uploadUrl,
    });

    await runWithClient((client) =>
      client.confirmSourcePdfUpload(documentId, {
        assetId: uploadInfo.assetId,
        checksum,
        fileSize,
        pageCount,
      }),
    );

    onProgress?.({ totalBytes: fileSize, uploadedBytes: fileSize });

    return { assetId: uploadInfo.assetId, deduped: false };
  }

  // ── Multipart path (> threshold) ──────────────────────────────────────────
  // `start` is only idempotent for already-CONFIRMED files (full dedup); for an interrupted upload a
  // fresh start mints new ids. So true resume reuses the persisted {assetId, uploadId, partSize} and
  // diffs against the server's part listing — only the missing parts are re-PUT.
  const startFreshMultipart = async (): Promise<
    { deduped: true; result: UploadSourcePdfAssetResult } | ({ deduped: false } & WhiteboardMultipartResumeInfo)
  > => {
    const start = await runWithClient((client) =>
      client.startSourcePdfMultipart(documentId, {
        checksum,
        fileName,
        fileSize,
        mimeType: resolvedMimeType,
        pageCount,
      }),
    );

    if (start.deduped) {
      return { deduped: true, result: { assetId: start.assetId, deduped: true } };
    }

    onMultipartStart?.({ assetId: start.assetId, partSize: start.partSize, uploadId: start.uploadId });

    return { assetId: start.assetId, deduped: false, partSize: start.partSize, uploadId: start.uploadId };
  };

  let assetId!: string;
  let uploadId!: string;
  let partSize!: number;
  let existingParts: ListPartsResponse | null = null;

  if (resume) {
    // Probe the saved upload against the live contract: adopt it if already completed, reuse its parts
    // if still open, or fall through to a fresh `start` if gone/mismatched. See resolveResumeParts.
    assetId = resume.assetId;
    uploadId = resume.uploadId;
    partSize = resume.partSize;

    const resolution = await resolveResumeParts(runWithClient, documentId, assetId, uploadId, signal);

    if (resolution.kind === 'completed') {
      // Already confirmed server-side (no re-upload). Adopt the asset and report progress as complete.
      onProgress?.({ totalBytes: fileSize, uploadedBytes: fileSize });

      return { assetId: resolution.assetId, deduped: false };
    }

    if (resolution.kind === 'parts') {
      // Do NOT trust the persisted `partSize`. It may have been saved days ago, and the server owns
      // that number (`MULTIPART_PART_SIZE`) — if it changed since, every already-uploaded part was
      // cut at the OLD boundaries while `totalParts` here would be computed from the new size. The
      // parts would not line up, and `complete` rejects with a 400 naming both counts (it compares
      // against the `expectedPartCount` frozen at `start`). Worse, a mismatch that happened to keep
      // the count EQUAL would assemble a corrupt PDF from correctly-numbered parts holding the wrong
      // bytes — no error anywhere, a file that simply does not open.
      //
      // Confirmed with BE 2026-08-10 (bridge `m_msnfnqgxf0f300`): `MULTIPART_PART_SIZE` is a
      // hard-coded 16MiB literal, never env-driven, never per-upload, and never edited since it was
      // written. So this guard is belt-and-braces TODAY — it is kept because it costs one comparison
      // and it is the only thing standing between a future edit of that constant and a silently
      // corrupt PDF.
      //
      // The server never echoes `partSize` back (the parts listing is `{ parts }` only), so it has
      // to be inferred from the listing — see `derivePartSizeFromParts`. On any disagreement the
      // saved upload is unusable and the only correct move is a fresh `start`; the uploaded parts
      // cannot be salvaged because their boundaries are wrong.
      const serverPartSize = derivePartSizeFromParts(resolution.parts.parts);

      if (serverPartSize !== null && serverPartSize === partSize) {
        existingParts = resolution.parts;
      }
      // serverPartSize === null means the listing was EMPTY: nothing has been uploaded under this
      // id, so there is nothing to verify and nothing to salvage. Falling through to a fresh start
      // costs no re-upload and avoids reusing a partSize we cannot check. This is also the expected
      // shape after a long gap, where the provider has expired the parts but not yet the upload.
    }
  }

  if (!existingParts) {
    const fresh = await startFreshMultipart();

    if (fresh.deduped) {
      return fresh.result;
    }

    assetId = fresh.assetId;
    uploadId = fresh.uploadId;
    partSize = fresh.partSize;
    existingParts = await runWithClient((client) =>
      client.listSourcePdfMultipartParts(documentId, assetId, { uploadId }),
    );
  }

  const totalParts = Math.ceil(fileSize / partSize);

  // Parts already on the server can be reused by their (guaranteed-matching) etag.
  const existingByNumber = new Map<number, { etag: string; size: number }>();

  for (const part of existingParts.parts) {
    existingByNumber.set(part.partNumber, { etag: part.etag, size: part.size });
  }

  const collectedParts: Array<{ etag: string; partNumber: number }> = [];
  let uploadedBytes = 0;

  for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
    throwIfAborted(signal);

    const startByte = (partNumber - 1) * partSize;
    const endByte = Math.min(startByte + partSize, fileSize);
    const partBytes = file.slice(startByte, endByte);
    const expectedSize = endByte - startByte;
    const existing = existingByNumber.get(partNumber);

    if (existing && existing.size === expectedSize) {
      collectedParts.push({ etag: existing.etag, partNumber });
      uploadedBytes += expectedSize;
      onProgress?.({ part: partNumber, totalBytes: fileSize, totalParts, uploadedBytes });

      continue;
    }

    const { url } = await runWithClient((client) =>
      client.getSourcePdfMultipartPartUrl(documentId, assetId, { partNumber, uploadId }),
    );
    const { etag } = await putMultipartPartWithRetry(url, partBytes, fetcher, signal);

    collectedParts.push({ etag, partNumber });
    uploadedBytes += expectedSize;
    onProgress?.({ part: partNumber, totalBytes: fileSize, totalParts, uploadedBytes });
  }

  collectedParts.sort((a, b) => a.partNumber - b.partNumber);

  await runWithClient((client) =>
    client.completeSourcePdfMultipart(documentId, assetId, { parts: collectedParts, uploadId }),
  );

  return { assetId, deduped: false };
}
