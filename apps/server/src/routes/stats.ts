import express from "express";
import { createHash } from "crypto";
import { SiteStat, SITE_STAT_KINDS, SiteStatKind } from "@/models/site-stat";
import { createRateLimiter } from "@/middleware/rate-limit";
import { getJwtSecret } from "@/compat/auth";

/**
 * `POST /stats/event {kind, id?, version?, platform?}` → 204. Public and anonymous (see models/site-stat).
 * Always answers 204 so it can never break the page or the app.
 */
const router = express.Router();
const limit = createRateLimiter({ windowMs: 60_000, max: 30 });
const clean = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

router.post("/stats/event", limit, async (req, res) => {
  res.status(204).end();
  try {
    const kind = req.body?.kind as SiteStatKind;
    if (!SITE_STAT_KINDS.includes(kind)) return;
    const day = new Date().toISOString().slice(0, 10);
    const id = clean(req.body?.id, 64);
    const who =
      kind === "app_open" && id && /^[A-Za-z0-9-]{8,64}$/.test(id)
        ? id
        : createHash("sha256").update(`${getJwtSecret()}|${req.ip}|${day}`).digest("hex").slice(0, 32);
    await SiteStat.updateOne(
      { kind, who, day },
      { $setOnInsert: { kind, who, day, firstAt: new Date(), version: clean(req.body?.version, 20), platform: clean(req.body?.platform, 20) } },
      { upsert: true }
    );
  } catch {
    // counting is best-effort
  }
});

export default router;
