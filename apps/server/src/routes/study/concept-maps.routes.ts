import express from "express";
import {
  createPractice,
  getConceptMap,
  gradeConceptMap,
  listAttempts,
  listConceptMaps,
  notesDigest,
  patchConceptMap,
  predictConceptMaps,
  referenceConceptMap,
  shortAnswers,
} from "@/controllers/study-concept-maps.controller";

/** /study/concept-maps — P-CM. Mounted by routes/study/router.ts. */
const router = express.Router();

router.get("/", listConceptMaps);
router.post("/grade", gradeConceptMap);
router.post("/practice", createPractice);
router.post("/predict", predictConceptMaps);
router.post("/reference", referenceConceptMap);
router.get("/:id", getConceptMap);
router.patch("/:id", patchConceptMap);
router.post("/:id/notes-digest", notesDigest);
router.get("/:id/attempts", listAttempts);
router.post("/:id/short-answers", shortAnswers);

export default router;
