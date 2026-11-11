/**
 * The one sharing route that needs no account: what a share link points at, for the page someone sees
 * before they sign in («Cell notes · Notebook · from Maya» + «Create a free account to add it»).
 * Mounted at /share/preview and /study/share/preview, BEFORE the signed-in /share mount (app.ts).
 *
 *   GET /share/preview/:token   -> {preview: {title, resourceType, ownerName}}
 *
 * Only a link token works (never a share id), and only while the owner keeps the link on. It shows the
 * title, the kind and the owner's FIRST name: no email, no content, no class data, no ids. A wrong,
 * revoked or deleted link all answer the same 404. Rate limited per IP (app.ts trusts the proxy hop,
 * so req.ip is the visitor). The token is 32 random bytes, so guessing one is hopeless anyway.
 */
import { Router, Request, Response } from "express";
import { Admin } from "@/models/admin";
import { IShare, Share } from "@/models/share";
import { memoryRateLimit } from "@/auth/rate-limit";
import { RAW_TOKEN_RE } from "@/auth/tokens";
import { firstName } from "@/services/share/access";
import { loadOwned, resourceTitle } from "@/services/share/resources";
import { logger } from "@/services/logger.service";

const router = Router();

export const PREVIEW_LIMIT = { windowMs: 15 * 60_000, max: 120 };
const previewLimit = memoryRateLimit({ ...PREVIEW_LIMIT, message: "Too many requests. Try again in a few minutes." });

const notFound = (res: Response) =>
  res.status(404).json({ message: "This link doesn't work any more. Ask for a new one.", code: "NOT_FOUND" });

router.get("/:token", previewLimit, async (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  try {
    const token = req.params.token;
    if (!RAW_TOKEN_RE.test(token)) return notFound(res);
    const share = await Share.findOne({ "link.token": token }).lean<IShare>();
    if (!share?.link) return notFound(res);
    const resource = await loadOwned({ resourceType: share.resourceType, resourceId: share.resourceId, topic: share.topic }, share.ownerId);
    if (!resource) return notFound(res);
    const owner = await Admin.findById(share.ownerId, { name: 1 }).lean<{ name?: string }>();
    res.json({ preview: { title: resourceTitle(resource), resourceType: share.resourceType, ownerName: firstName(owner) } });
  } catch (e) {
    await logger.error("share preview failed", e instanceof Error ? e : new Error(String(e))).catch(() => {});
    if (!res.headersSent) res.status(500).json({ message: "Something went wrong", code: "INTERNAL" });
  }
});

export default router;
