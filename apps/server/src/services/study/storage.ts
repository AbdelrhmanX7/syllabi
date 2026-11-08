import { GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import type { Readable } from "stream";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";
import { putObjectWithRetry } from "@/utils/s3-put-with-retry";
import {
  getPresignS3,
  getS3,
  LOCAL_STORAGE_DIR,
  localObjectPath,
  localObjectUrl,
  proxyObjectUrl,
  s3Bucket,
  serverPublicBase,
  useLocalStorage,
  useStorageProxy,
} from "@/compat/s3";
import { getJwtSecret } from "@/compat/auth";

/**
 * Object storage for the study module (Canvas file copies, notebook pages, renders, lecture
 * audio, inbox media). Any S3-compatible store with STORAGE_DRIVER=s3, or the local disk
 * (served by app.ts) with STORAGE_DRIVER=local — see compat/s3.ts.
 *
 * GET urls are SIGNED for 1 h, so the bucket can stay private. Keys carry a uuid, never a Canvas id.
 * Three url modes:
 *   local   urls point at this server's /files static mount and the /study/dev-upload PUT.
 *   proxy   (STORAGE_PROXY) urls point at this server's signed /objects GET and the same PUT
 *           route; the server streams to/from the bucket, which never has to be reachable.
 *   direct  urls are presigned for the bucket itself (S3_PRESIGN_ENDPOINT or S3_ENDPOINT).
 */
const isDevelopment = useLocalStorage;
const LOCAL_DIR = LOCAL_STORAGE_DIR;
export const SIGNED_URL_TTL_SEC = 3600;

const localPath = localObjectPath;
const localBase = serverPublicBase;
const localUrl = localObjectUrl;

/** `study/<userId>/files/<uuid>.<ext>` — a fresh uuid per version, never overwritten. */
export const studyFileKey = (userId: string, ext: string) => `study/${userId}/files/${randomUUID()}.${ext}`;

export async function putStudyObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (isDevelopment()) {
    const dest = localPath(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, body);
    return;
  }
  await putObjectWithRetry(getS3(), {
    bucket: s3Bucket(),
    key,
    body,
    contentType,
    cacheControl: "private, max-age=31536000, immutable",
  });
}

export async function signedGetUrl(key: string, opts: { contentType?: string } = {}): Promise<{ url: string; expiresAt: string }> {
  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SEC * 1000).toISOString();
  if (isDevelopment()) return { url: localUrl(key), expiresAt };
  if (useStorageProxy()) {
    const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SEC;
    const ct = opts.contentType ?? "";
    const q = `exp=${exp}${ct ? `&ct=${encodeURIComponent(ct)}` : ""}&sig=${proxyGetSig(key, exp, ct)}`;
    return { url: `${proxyObjectUrl(key)}?${q}`, expiresAt: new Date(exp * 1000).toISOString() };
  }
  const url = await getSignedUrl(
    getPresignS3(),
    new GetObjectCommand({ Bucket: s3Bucket(), Key: key, ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}) }),
    { expiresIn: SIGNED_URL_TTL_SEC }
  );
  return { url, expiresAt };
}

// ─── notebook page content (P2) ─────────────────────────────────────────────────────────

/** `study/<userId>/pages/<pageId>/v<version>.json` — one immutable object per committed version. */
export const pageContentKey = (userId: string, pageId: string, version: number) => `study/${userId}/pages/${pageId}/v${version}.json`;
export const PAGE_CONTENT_KEY_RE = /^study\/[0-9a-f]{24}\/pages\/[0-9a-f]{24}\/v[1-9]\d{0,8}\.json$/;
export const UPLOAD_URL_TTL_SEC = 900;
/** `study/<userId>/pages/<pageId>/renders/<index>-<uuid>.<ext>` — a fresh key per upload (immutable cache), the row points at the current one. */
export const pageRenderKey = (userId: string, pageId: string, index: number, ext: string) =>
  `study/${userId}/pages/${pageId}/renders/${String(index).padStart(3, "0")}-${randomUUID()}.${ext}`;
/** Proxy upload path: index.ts must skip the app-wide json parser here so the raw body arrives intact. */
export const STUDY_BLOB_PATH = /^\/study\/pages\/[^/]+\/content\/blob\/?$/;
/** Office → PDF conversion POST (raw body, 50 MB). */
export const STUDY_CONVERT_PATH = /^\/study\/convert\/pdf\/?$/;
/** Glyph bank PUT (2.5 MB), perf telemetry POST (2 MB inflated, gzip) and ink-classify POST (16 KB) mount their own json parsers, after auth. */
export const STUDY_OWN_JSON_PARSER_PATH = /^\/study\/(?:handwriting\/bank|telemetry\/perf|ai\/ink-classify)\/?$/;

/**
 * Notebook PDF backgrounds (the file under a page's ink), one object per account and asset id:
 * `study/<userId>/pdf-assets/<assetId>.pdf`. The id is the client-minted uuid the board JSON's pages
 * point at (`pdfAssetId`), so the same file backs every page and every copy that references it, and
 * account deletion removes them with the rest of `study/<userId>/`. Written once, never overwritten.
 */
export const PDF_ASSET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const PDF_ASSET_MAX_BYTES = 60 * 1024 * 1024;
export const pdfAssetKey = (userId: string, assetId: string) => {
  if (!/^[0-9a-f]{24}$/i.test(userId) || !PDF_ASSET_ID_RE.test(assetId)) throw new Error("pdfAssetKey: bad id");
  return `study/${userId}/pdf-assets/${assetId}.pdf`;
};
/** PDF asset PUTs (raw body, 60 MB) mount their own parser. */
export const STUDY_PDF_ASSET_PATH = /^\/study\/(?:pages\/[^/]+\/)?pdf-assets\/[^/]+\/?$/;

/** Server-routed upload signature (local driver and STORAGE_PROXY): HMAC over key + expiry, keyed by JWT_SECRET. */
const devSig = (key: string, exp: number) =>
  createHmac("sha256", `study-dev-upload:${getJwtSecret() ?? ""}`).update(`${key}\n${exp}`).digest("hex");

/** Proxied read signature (STORAGE_PROXY): a different HMAC domain, so a PUT signature never reads and vice versa. */
const proxyGetSig = (key: string, exp: number, contentType: string) =>
  createHmac("sha256", `study-proxy-get:${getJwtSecret() ?? ""}`).update(`${key}\n${exp}\n${contentType}`).digest("hex");

const checkSig = (want: string, exp: unknown, sig: unknown, now: number): boolean => {
  const e = Number(exp);
  if (!Number.isFinite(e) || e * 1000 < now || typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqual(Buffer.from(want, "hex"), Buffer.from(sig, "hex"));
};

export function verifyDevUpload(key: string, exp: unknown, sig: unknown, now = Date.now()): boolean {
  const e = Number(exp);
  if (!Number.isFinite(e)) return false;
  return checkSig(devSig(key, e), e, sig, now);
}

export function verifyProxyGet(key: string, exp: unknown, contentType: string, sig: unknown, now = Date.now()): boolean {
  const e = Number(exp);
  if (!Number.isFinite(e)) return false;
  return checkSig(proxyGetSig(key, e, contentType), e, sig, now);
}

/** Content type for a server-routed upload, by key extension (the client header is not trusted). */
export const contentTypeForKey = (key: string): string => {
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    json: "application/json",
    webm: "audio/webm",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
  };
  return map[ext] ?? "application/octet-stream";
};

/**
 * Presigned PUT for one object. Content-Type is deliberately NOT signed, so any client header
 * passes; reads force `application/json` via the signed GET instead. In dev the url points at
 * the local PUT handler (`PUT /study/dev-upload/<key>?exp&sig`, routes/study/dev-upload.ts).
 */
export async function presignedPutUrl(key: string): Promise<{ url: string; expiresAt: string }> {
  const exp = Math.floor(Date.now() / 1000) + UPLOAD_URL_TTL_SEC;
  const expiresAt = new Date(exp * 1000).toISOString();
  if (isDevelopment() || useStorageProxy()) return { url: `${localBase()}/study/dev-upload/${key}?exp=${exp}&sig=${devSig(key, exp)}`, expiresAt };
  const url = await getSignedUrl(getPresignS3(), new PutObjectCommand({ Bucket: s3Bucket(), Key: key }), {
    expiresIn: UPLOAD_URL_TTL_SEC,
  });
  return { url, expiresAt };
}

/** Whether an object exists (HeadObject; a file check in dev). */
export async function studyObjectExists(key: string): Promise<boolean> {
  if (isDevelopment()) return fs.promises.stat(localPath(key)).then((s) => s.isFile() && s.size > 0, () => false);
  try {
    await getS3().send(new HeadObjectCommand({ Bucket: s3Bucket(), Key: key }));
    return true;
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound" || e?.name === "NoSuchKey") return false;
    throw e;
  }
}

/** Bytes of a stored object (Canvas file copies for question extraction). */
export async function getStudyObject(key: string): Promise<Buffer> {
  if (isDevelopment()) return fs.promises.readFile(localPath(key));
  const out = await getS3().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: key }));
  return Buffer.from(await out.Body!.transformToByteArray());
}

/**
 * A body received by the server-routed upload (`/study/dev-upload`): the local static dir with the
 * local driver, the bucket with STORAGE_PROXY. Content type comes from the key's extension.
 */
export async function writeLocalStudyObject(key: string, body: Buffer): Promise<void> {
  await putStudyObject(key, body, contentTypeForKey(key));
}

export interface StudyObjectStream {
  body: Readable;
  contentType?: string;
  contentLength?: number;
  /** `bytes a-b/total` when a Range was honoured (206). */
  contentRange?: string;
  etag?: string;
  lastModified?: Date;
}

/**
 * Stream an object for the proxy GET, passing an HTTP Range through (lecture audio seeking).
 * Returns null when the key does not exist.
 */
export async function streamStudyObject(key: string, range?: string): Promise<StudyObjectStream | null> {
  try {
    const out = await getS3().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: key, ...(range ? { Range: range } : {}) }));
    if (!out.Body) return null;
    return {
      body: out.Body as Readable,
      contentType: out.ContentType,
      contentLength: out.ContentLength,
      contentRange: out.ContentRange,
      etag: out.ETag,
      lastModified: out.LastModified,
    };
  } catch (e: any) {
    const status = e?.$metadata?.httpStatusCode;
    if (status === 404 || e?.name === "NoSuchKey" || e?.name === "NotFound") return null;
    if (status === 416 || e?.name === "InvalidRange") {
      const err = new Error("Range not satisfiable");
      (err as any).status = 416;
      throw err;
    }
    throw e;
  }
}

/** Used by cleanup tooling only — the sync never deletes a stored version. */
export async function deleteStudyObject(key: string): Promise<void> {
  if (isDevelopment()) {
    await fs.promises.rm(localPath(key), { force: true });
    return;
  }
  await getS3().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: key }));
}

export const localStudyDir = (userId: string) => path.join(LOCAL_DIR, "study", userId);

/**
 * Delete every stored object of one account (account deletion): all keys live under
 * `study/<userId>/`. Local driver: the directory; s3: list + batch delete by prefix.
 * Returns how many objects were removed (s3) or -1 (local, not counted).
 */
export async function deleteUserObjects(userId: string): Promise<number> {
  if (!/^[0-9a-f]{24}$/.test(userId)) throw new Error("deleteUserObjects: bad user id");
  if (isDevelopment()) {
    await fs.promises.rm(localStudyDir(userId), { recursive: true, force: true });
    return -1;
  }
  const s3 = getS3();
  const prefix = `study/${userId}/`;
  let removed = 0;
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: s3Bucket(), Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k && k.startsWith(prefix));
    if (keys.length) {
      const out = await s3.send(
        new DeleteObjectsCommand({ Bucket: s3Bucket(), Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } })
      );
      if (out.Errors?.length) throw new Error(`Could not delete ${out.Errors.length} stored file(s): ${out.Errors[0]?.Message ?? ""}`);
      removed += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return removed;
}

// ─── lecture audio (P3) ─────────────────────────────────────────────────────────────────

export const LECTURE_CHUNK_MAX_BYTES = 10 * 1024 * 1024;
export const LECTURE_MAX_CHUNKS = 10_000;
/** `study/<userId>/lectures/<lectureId>/chunks/<00042>.<ext>` — re-uploading an index overwrites it. */
export const lectureChunkKey = (userId: string, lectureId: string, index: number, ext: string) =>
  `study/${userId}/lectures/${lectureId}/chunks/${String(index).padStart(5, "0")}.${ext}`;
export const LECTURE_CHUNK_KEY_RE = /^study\/[0-9a-f]{24}\/lectures\/[0-9a-f]{24}\/chunks\/\d{5}\.(webm|m4a)$/;
/** The concatenated, re-encoded recording. */
export const lectureAudioKey = (userId: string, lectureId: string, ext: string) => `study/${userId}/lectures/${lectureId}/audio.${ext}`;
