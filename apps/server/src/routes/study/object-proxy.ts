import express, { Request, Response } from "express";
import { PROXY_OBJECT_MOUNT, PUBLIC_OBJECT_KEY_RE } from "@/compat/s3";
import { streamStudyObject, SIGNED_URL_TTL_SEC, verifyProxyGet } from "@/services/study/storage";
import { logger } from "@/services/logger.service";

/**
 * STORAGE_PROXY ONLY — serves bucket objects through this server, so a private MinIO (or any
 * bucket the device cannot reach) still works.
 *
 * `GET /objects/<key>?exp=<unix>&ct=<mime>&sig=<hmac>` streams the object. Like a presigned url it
 * needs NO JWT: the HMAC (keyed by JWT_SECRET, issued by signedGetUrl) is the authorisation, it
 * expires, and it is bound to exactly one key + response content type. Question images
 * (PUBLIC_OBJECT_KEY_RE, uuid-named) are served unsigned because their urls must never expire.
 * HTTP Range is passed through, so audio/video seeking works.
 */
const router = express.Router();
const KEY_RE = /^study\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9._\/-]{1,512}$/;

router.get(`${PROXY_OBJECT_MOUNT}/*`, async (req: Request, res: Response) => {
  const key = String((req.params as any)[0] ?? "");
  if (!KEY_RE.test(key) || key.includes("..")) return res.status(400).json({ message: "Invalid object key", code: "INVALID_KEY" });
  const ct = typeof req.query.ct === "string" ? req.query.ct : "";
  const isPublic = PUBLIC_OBJECT_KEY_RE.test(key);
  if (!isPublic && !verifyProxyGet(key, req.query.exp, ct, req.query.sig)) {
    return res.status(403).json({ message: "Bad or expired object signature", code: "OBJECT_FORBIDDEN" });
  }

  const range = typeof req.headers.range === "string" && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : undefined;
  try {
    const obj = await streamStudyObject(key, range);
    if (!obj) return res.status(404).json({ message: "Object not found", code: "NOT_FOUND" });
    res.status(obj.contentRange ? 206 : 200);
    res.setHeader("Content-Type", ct || obj.contentType || "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", isPublic ? "public, max-age=31536000, immutable" : `private, max-age=${SIGNED_URL_TTL_SEC}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (typeof obj.contentLength === "number") res.setHeader("Content-Length", String(obj.contentLength));
    if (obj.contentRange) res.setHeader("Content-Range", obj.contentRange);
    if (obj.etag) res.setHeader("ETag", obj.etag);
    if (obj.lastModified) res.setHeader("Last-Modified", obj.lastModified.toUTCString());
    obj.body.on("error", (e) => {
      logger.error("storage proxy stream failed", e instanceof Error ? e : new Error(String(e)), { key }).catch(() => {});
      res.destroy(e as Error);
    });
    res.on("close", () => obj.body.destroy());
    obj.body.pipe(res);
  } catch (e: any) {
    if (e?.status === 416) return res.status(416).end();
    logger.error("storage proxy read failed", e instanceof Error ? e : new Error(String(e)), { key }).catch(() => {});
    if (!res.headersSent) res.status(502).json({ message: "Storage unavailable", code: "STORAGE_ERROR" });
  }
});

export default router;
