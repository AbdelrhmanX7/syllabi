import express, { Request, Response } from "express";
import { LECTURE_CHUNK_KEY_RE, PAGE_CONTENT_KEY_RE, verifyDevUpload, writeLocalStudyObject } from "@/services/study/storage";

/**
 * LOCAL DRIVER / STORAGE_PROXY — stands in for the bucket's presigned PUT when the device should
 * not (or cannot) upload to the bucket directly.
 *
 * `PUT /study/dev-upload/study/<userId>/pages/<pageId>/v<n>.json?exp=<unix>&sig=<hmac>` writes
 * the body to `<LOCAL_STORAGE_DIR>/<key>` (local driver, served by app.ts's static mount) or to the
 * bucket (STORAGE_PROXY, read back through routes/study/object-proxy.ts). Like a presigned url it needs NO JWT: the HMAC (keyed by
 * JWT_SECRET, issued by `PUT /study/pages/:id/content`) is the authorisation, it expires, and
 * it is bound to exactly one key. app.ts mounts this for the local driver and STORAGE_PROXY, ahead of the
 * authenticated /study router.
 */
const router = express.Router();
const MAX_BYTES = 25 * 1024 * 1024;

router.put(
  "/study/dev-upload/*",
  // The app-wide JSON parser may already have parsed an application/json body; raw takes the rest.
  express.raw({ type: () => true, limit: MAX_BYTES }),
  async (req: Request, res: Response) => {
    const key = String((req.params as any)[0] ?? "");
    if (!PAGE_CONTENT_KEY_RE.test(key) && !LECTURE_CHUNK_KEY_RE.test(key)) return res.status(400).json({ message: "Invalid upload key", code: "INVALID_KEY" });
    if (!verifyDevUpload(key, req.query.exp, req.query.sig)) return res.status(403).json({ message: "Bad or expired upload signature", code: "UPLOAD_FORBIDDEN" });
    const body = Buffer.isBuffer(req.body) ? req.body : req.body && typeof req.body === "object" ? Buffer.from(JSON.stringify(req.body)) : Buffer.alloc(0);
    if (!body.length) return res.status(400).json({ message: "Empty body", code: "EMPTY_BODY" });
    await writeLocalStudyObject(key, body);
    res.status(200).end();
  }
);

export default router;
