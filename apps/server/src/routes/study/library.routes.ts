import express from "express";
import {
  createExamResult,
  getExamBlueprint,
  getExamsSchedule,
  getGuide,
  getLibraryDoc,
  listClassLibrary,
  listExamResults,
  listLabSpecimens,
  patchExamResult,
  putExamBlueprint,
  putExamsSchedule,
  putGuide,
  searchClassLibrary,
  uploadClassLibraryPdf,
} from "@/controllers/study-library.controller";
import { PDF_ASSET_MAX_BYTES } from "@/services/study/storage";

/** P-CM — class library, guide, exam schedule, exam results, lab kit. Mounted at /study by routes/study/router.ts. */
const router = express.Router();

router.get("/classes/:id/library", listClassLibrary);
// Upload a PDF to the class Library. app.ts skips the app-wide parsers here (STUDY_LIBRARY_UPLOAD_PATH).
router.post("/classes/:id/library", express.raw({ type: "*/*", limit: PDF_ASSET_MAX_BYTES }), uploadClassLibraryPdf);
router.get("/classes/:id/library/search", searchClassLibrary);
router.get("/library/:id", getLibraryDoc);
router.get("/classes/:id/guide", getGuide);
router.put("/classes/:id/guide", putGuide);
router.get("/classes/:id/exams-schedule", getExamsSchedule);
router.put("/classes/:id/exams-schedule", putExamsSchedule);
router.get("/classes/:id/exam-blueprint", getExamBlueprint);
router.put("/classes/:id/exam-blueprint", putExamBlueprint);
router.get("/classes/:id/exam-results", listExamResults);
router.post("/classes/:id/exam-results", createExamResult);
router.patch("/classes/:id/exam-results/:resultId", patchExamResult);
router.get("/classes/:id/lab-specimens", listLabSpecimens);

export default router;
