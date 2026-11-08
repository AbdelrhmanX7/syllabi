/**
 * Object storage configuration for any S3-compatible store (MinIO, AWS S3, Cloudflare R2, Garage, ...).
 *
 *   STORAGE_DRIVER        "s3" | "local". Default: "local" unless NODE_ENV=production.
 *   S3_ENDPOINT           API endpoint the SERVER uses, e.g. http://minio:9000 (omit for AWS)
 *   S3_REGION             default "us-east-1"
 *   S3_BUCKET
 *   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 *   S3_FORCE_PATH_STYLE   default true (MinIO needs it; set false for AWS virtual-hosted buckets)
 *   S3_PRESIGN_ENDPOINT   endpoint the CLIENT can reach, used only to sign urls (default S3_ENDPOINT).
 *                         SigV4 signs the Host header, so a url signed for http://minio:9000 cannot
 *                         be rewritten afterwards; sign it for the public origin instead.
 *   STORAGE_PROXY         "true" streams every object through this server (signed /objects/<key>
 *                         urls + the /study/dev-upload PUT), so the bucket never needs to be
 *                         reachable from the device. Default: true when S3_ENDPOINT is set and
 *                         S3_PRESIGN_ENDPOINT is not (an internal MinIO), false otherwise.
 *   S3_PUBLIC_URL         public origin for unsigned object urls (question images); a public-read
 *                         bucket or CDN. S3_PUBLIC_BASE_URL is accepted as an alias.
 *   PUBLIC_BASE_URL       this server's public origin (local/proxy urls); default http://localhost:$PORT
 *   LOCAL_STORAGE_DIR     local driver root; default ./public/files
 */
import { S3Client } from "@aws-sdk/client-s3";
import path from "path";

const envFlag = (name: string): boolean | undefined => {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
};

export const useLocalStorage = (): boolean => {
  const d = (process.env.STORAGE_DRIVER || "").toLowerCase();
  if (d === "local") return true;
  if (d === "s3") return false;
  return process.env.NODE_ENV !== "production";
};

/** s3 driver whose objects are streamed through this server instead of presigned bucket urls. */
export const useStorageProxy = (): boolean => {
  if (useLocalStorage()) return false;
  const flag = envFlag("STORAGE_PROXY");
  if (flag !== undefined) return flag;
  return !!process.env.S3_ENDPOINT && !process.env.S3_PRESIGN_ENDPOINT;
};

/** Served statically at LOCAL_STORAGE_MOUNT by app.ts. */
export const LOCAL_STORAGE_DIR = path.resolve(process.env.LOCAL_STORAGE_DIR || path.join(process.cwd(), "public", "files"));
export const LOCAL_STORAGE_MOUNT = "/files";
/** Signed object reads through the server (STORAGE_PROXY). */
export const PROXY_OBJECT_MOUNT = "/objects";

export const s3Bucket = (): string => process.env.S3_BUCKET ?? "";

const makeClient = (endpoint: string | undefined) =>
  new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    ...(endpoint ? { endpoint } : {}),
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "" },
    forcePathStyle: envFlag("S3_FORCE_PATH_STYLE") ?? true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

let _s3: S3Client | null = null;
/** Client for the server's own requests (put/get/head/delete). */
export const getS3 = (): S3Client => (_s3 ??= makeClient(process.env.S3_ENDPOINT || undefined));

let _presign: S3Client | null = null;
/** Client used only to sign urls a device will fetch (S3_PRESIGN_ENDPOINT, else the normal client). */
export const getPresignS3 = (): S3Client => {
  const ep = process.env.S3_PRESIGN_ENDPOINT;
  if (!ep || ep === process.env.S3_ENDPOINT) return getS3();
  return (_presign ??= makeClient(ep));
};

/** This server's public origin, for urls that point back at it. */
export const serverPublicBase = (): string =>
  (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "") || `http://localhost:${process.env.PORT || 5000}`;

export const localObjectPath = (key: string) => path.join(LOCAL_STORAGE_DIR, key);
export const localObjectUrl = (key: string) => `${serverPublicBase()}${LOCAL_STORAGE_MOUNT}/${key}`;
export const proxyObjectUrl = (key: string) => `${serverPublicBase()}${PROXY_OBJECT_MOUNT}/${key}`;

/** Long-lived question images: the only keys the proxy serves without a signature (uuid-named, like a public bucket). */
export const PUBLIC_OBJECT_KEY_RE = /^study\/[0-9a-f]{24}\/question-images\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/;

/**
 * A plain (unsigned, non-expiring) url for a stored object. Local and proxy modes serve it from
 * this server; direct s3 mode needs S3_PUBLIC_URL (a public-read bucket or a CDN).
 */
export const publicUrlFor = (key: string): string => {
  if (useLocalStorage()) return localObjectUrl(key);
  const base = (process.env.S3_PUBLIC_URL || process.env.S3_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (base) return `${base}/${key}`;
  if (useStorageProxy()) return proxyObjectUrl(key);
  const endpoint = (process.env.S3_PRESIGN_ENDPOINT || process.env.S3_ENDPOINT || "").replace(/\/+$/, "");
  return endpoint ? `${endpoint}/${s3Bucket()}/${key}` : `https://${s3Bucket()}.s3.amazonaws.com/${key}`;
};
