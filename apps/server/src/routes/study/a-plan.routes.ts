import express from "express";
import { requireAi } from "@/auth/verified";
import { getClassAPlan, refreshClassAPlan } from "@/controllers/study-a-plan.controller";

/** /study/classes/:id/a-plan — per-class A plan. Mounted by routes/study/router.ts under /classes. */
const router = express.Router();

// A GET builds the plan with AI when it is missing or stale: AI accounts only (refresh: router.ts).
router.get("/:id/a-plan", requireAi, getClassAPlan);
router.post("/:id/a-plan/refresh", refreshClassAPlan);

export default router;
