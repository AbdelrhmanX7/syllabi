import express from "express";
import { requireAi } from "@/auth/verified";
import { createExam, getExam, listExams, submitExam } from "@/controllers/study-exams.controller";

/** /study/exams — mock exams (P5). Mounted by routes/study/router.ts. */
const router = express.Router();

// Building an exam tops the bank up with AI-written questions: AI accounts only (submit is gated in router.ts).
router.post("/", requireAi, createExam);
router.get("/", listExams);
router.get("/:id", getExam);
router.post("/:id/submit", submitExam);

export default router;
