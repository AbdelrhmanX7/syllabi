import express from "express";
import { createExam, getExam, listExams, submitExam } from "@/controllers/study-exams.controller";

/** /study/exams — mock exams (P5). Mounted by routes/study/router.ts. */
const router = express.Router();

router.post("/", createExam);
router.get("/", listExams);
router.get("/:id", getExam);
router.post("/:id/submit", submitExam);

export default router;
