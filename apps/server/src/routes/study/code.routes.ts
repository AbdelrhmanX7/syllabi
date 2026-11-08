import express from "express";
import { deleteProject, getProject, listProjects, postReview, postRun, putProject } from "@/controllers/study-code.controller";
import { createRateLimiter } from "@/middleware/rate-limit";

/**
 * /study/code/* — P4: C++ code run sandbox, code review (SSE), code projects.
 * Mounted under routes/study/router.ts, so auth (adminVerification + studyAccess) applies.
 */
const router = express.Router();

// 30 runs/min per user. In-memory per worker (never fails, unlike the fail-open Redis one);
// the per-process run semaphore in services/study/code/sandbox.ts is the real capacity guard.
export const runLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: "Too many code runs — wait a minute",
  code: "RATE_LIMITED",
  keyGenerator: (req) => `study-code-run:${String(req.adminId)}`,
});

router.post("/run", runLimiter, postRun);
router.post("/review", postReview);

router.get("/projects", listProjects);
router.get("/projects/:id", getProject);
router.put("/projects/:id", putProject);
router.delete("/projects/:id", deleteProject);

export default router;
