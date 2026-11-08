import express from "express";
import { getPerf, perfBodyErrors, postPerf, studyOwnerOnly, studySessionAuth } from "@/controllers/study-telemetry.controller";

/**
 * /study/telemetry/perf — mounted at the root, BEFORE the `/study` admin mount (which would
 * 403 any non-full-admin session). Every handler is path-scoped so nothing here runs for
 * other requests. index.ts skips the app-wide parser for this path (STUDY_OWN_JSON_PARSER_PATH):
 * the json parser below runs after auth, inflates gzip, and caps the INFLATED body at 2 MB.
 */
const PATH = "/study/telemetry/perf";
const router = express.Router();

const perfJson = express.json({
  limit: "2mb",
  inflate: true,
  verify: (req, _res, buf) => {
    (req as any).perfRawBytes = buf.length;
  },
});

router.post(PATH, studySessionAuth, perfJson, postPerf);
router.get(PATH, studySessionAuth, studyOwnerOnly, getPerf);
router.use(PATH, perfBodyErrors);

export default router;
