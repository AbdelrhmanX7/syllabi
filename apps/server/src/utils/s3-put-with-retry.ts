import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * PutObject with bounded retries and full-jitter backoff for any S3-compatible store.
 * Retries 429/5xx/server faults and transport errors (no HTTP status). After a transport
 * error the key is HEADed first: if an object of the same size is already there, the
 * earlier attempt landed and nothing is re-sent. The body must be a Buffer (replayable).
 */
export interface PutWithRetryOptions {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl: string;
  /** Total attempts including the first. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const TRANSPORT_ERROR_CODES = [
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "TimeoutError", "RequestTimeout", "NetworkingError", "AbortError",
];

const codesOf = (error: any): string[] => {
  const out: string[] = [];
  for (const e of [error, error?.cause]) {
    if (!e) continue;
    for (const v of [e.code, e.name, e.errno]) if (typeof v === "string") out.push(v);
  }
  return out;
};

export const isTransportError = (error: any): boolean =>
  error?.$metadata?.httpStatusCode === undefined && codesOf(error).some((c) => TRANSPORT_ERROR_CODES.includes(c));

export const isRetryableS3Error = (error: any): boolean => {
  const status: number | undefined = error?.$metadata?.httpStatusCode;
  if (typeof status === "number") {
    if (status === 429 || status >= 500) return true;
    if (status >= 400) return false;
  }
  if (error?.$fault === "server") return true;
  return isTransportError(error);
};

export const headObjectSize = async (s3: S3Client, bucket: string, key: string): Promise<number | null> => {
  try {
    const out = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return typeof out.ContentLength === "number" ? out.ContentLength : null;
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound" || e?.name === "NoSuchKey") return null;
    throw e;
  }
};

export const putObjectWithRetry = async (s3: S3Client, opts: PutWithRetryOptions): Promise<void> => {
  const { bucket, key, body, contentType, cacheControl, maxAttempts = 6 } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }));
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableS3Error(error) || attempt === maxAttempts) break;
      await sleep(Math.floor(random() * Math.min(30_000, 2 ** attempt * 500)));
      if (isTransportError(error)) {
        const remote = await headObjectSize(s3, bucket, key).catch(() => null);
        if (remote === body.length) return;
      }
    }
  }
  const err = lastError as any;
  const status = err?.$metadata?.httpStatusCode;
  const wrapped = new Error(`Storage upload failed for ${key} after ${attempts} attempt(s): ${err?.name ?? "unknown error"}${status ? ` (HTTP ${status})` : ""}`);
  (wrapped as any).cause = lastError;
  throw wrapped;
};
