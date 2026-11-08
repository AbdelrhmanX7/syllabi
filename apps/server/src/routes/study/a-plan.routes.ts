import express from "express";
import { getClassAPlan, refreshClassAPlan } from "@/controllers/study-a-plan.controller";

/** /study/classes/:id/a-plan — per-class A plan. Mounted by routes/study/router.ts under /classes. */
const router = express.Router();

router.get("/:id/a-plan", getClassAPlan);
router.post("/:id/a-plan/refresh", refreshClassAPlan);

export default router;
