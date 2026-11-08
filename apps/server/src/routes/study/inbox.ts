import express from "express";
import { makeRateLimiter } from "@/middleware/rate-limit";
import {
  getDropPage,
  inboxContentLengthGuard,
  inboxLimiterKey,
  inboxMultipart,
  inboxUploadAuth,
  postInboxItem,
} from "@/controllers/study-inbox.controller";

/**
 * Study phone inbox — PUBLIC router, mounted in routes/index.ts BEFORE the `/study` admin mount,
 * because these two routes also accept a drop token (`sk_drop_…`), which adminVerification never
 * does. Every other inbox route (list, stream, patch, delete, token management) lives in
 * routes/study/router.ts behind the admin mount. Paths are absolute and exact: `/study/inbox`
 * here never matches `/study/inbox/tokens` or `/study/inbox/:id`.
 *
 * Order on the upload: auth → rate limit (per token / per admin) → Content-Length guard → multer.
 * Nothing is buffered for an unauthenticated caller. The app-wide json/urlencoded parsers skip
 * multipart bodies on their own (type mismatch), so multer always sees the raw stream.
 */
const router = express.Router();

const byIp = (req: express.Request) => req.ip || req.socket.remoteAddress || "unknown";
/** 60 uploads / 10 min per drop token (or per admin on the JWT path). Redis, fleet-wide, fail-open. */
const uploadLimiter = makeRateLimiter({ windowSec: 600, max: 60, keyPrefix: "study-inbox-upload", keyFn: inboxLimiterKey });
const dropPageLimiter = makeRateLimiter({ windowSec: 600, max: 120, keyPrefix: "study-inbox-drop-page", keyFn: byIp });

router.post("/study/inbox", inboxUploadAuth, uploadLimiter, inboxContentLengthGuard, inboxMultipart, postInboxItem);
router.get("/study/drop", dropPageLimiter, getDropPage);

export default router;
