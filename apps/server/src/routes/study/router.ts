import express from "express";
import {
  deleteConnection,
  getClassItems,
  getClasses,
  getConnection,
  getItem,
  getModules,
  getToday,
  markSeen,
  patchClass,
  postClass,
  deleteClass,
  postSync,
  putConnection,
} from "@/controllers/study.controller";
import {
  commitPageContent,
  createPage,
  getPage,
  deletePage,
  getPageContent,
  listPages,
  listPageVersions,
  patchPage,
  putPageBlob,
  putPageContent,
  putPageOcr,
  restorePageVersion,
  search,
} from "@/controllers/study-pages.controller";
import { pushPageLive, streamPageLive } from "@/controllers/study-page-live.controller";
import { commitPageRenders, deletePageAnnotation, getPageRenders, listPageAnnotations, putPageRender, RENDER_MAX_BYTES } from "@/controllers/study-page-renders.controller";
import {
  attemptQuestion,
  createQuestions,
  deleteQuestion,
  extractQuestions,
  flashcards,
  getMastery,
  getReviewNext,
  listQuestions,
  patchQuestion,
  similarQuestions,
} from "@/controllers/study-questions.controller";
import {
  checkChunkIndex,
  createLecture,
  finishLecture,
  retranscribeLecture,
  getLecture,
  getVideoTranscript,
  listLectures,
  postVideoTranscript,
  presignChunk,
  putVideoTranscript,
  putChunk,
  rawChunkBody,
} from "@/controllers/study-lectures.controller";
import { createMcpKey, deleteMcpConnection, deleteMcpKey, listMcpConnections, listMcpKeys } from "@/controllers/study-mcp.controller";

import { getGradePlan } from "@/controllers/study-grade-plan.controller";
import {
  createInboxToken,
  deleteInbox,
  deleteInboxToken,
  listInbox,
  listInboxTokens,
  patchInbox,
  getInbox,
  streamInbox,
  postInboxToPage,
} from "@/controllers/study-inbox.controller";
import { getGlyphBank, putGlyphBank } from "@/controllers/study-handwriting.controller";
import { deletePageRuler, getPageRulers, putPageRuler } from "@/controllers/study-page-ruler.controller";
import { getDrawingProfile, patchDrawingProfile } from "@/controllers/study-drawing-profile.controller";
import { convertToPdf } from "@/controllers/study-convert.controller";
import { CONVERT_MAX_BYTES } from "@/services/study/office-to-pdf";
import examsRouter from "./exams.routes";
import codeRouter from "./code.routes";
import libraryRouter from "./library.routes";
import conceptMapsRouter from "./concept-maps.routes";
import aPlanRouter from "./a-plan.routes";
import tutorRouter from "./tutor.routes";
import { requireVerifiedEmail, requireVerifiedEmailForWrites } from "@/auth/verified";

/**
 * /study/* — personal study app backend (P1: Canvas, classes & items, today; P2: notebook
 * pages, search, question bank).
 * Auth (adminVerification + studyAccess) is applied at the mount in app.ts.
 */
const router = express.Router();

// AI routes need a verified email (403 EMAIL_NOT_VERIFIED). Registered first so they run before
// any handler below: everything under /ai that is not a read (tutor ask, flashcards, concept map
// from terms, board actions, ink classify, dictation), question extraction / similar questions,
// code review, exam grading, A-plan refresh and the concept-map AI actions.
router.use("/ai", requireVerifiedEmailForWrites);
router.post("/questions/extract", requireVerifiedEmail);
router.post("/questions/:id/similar", requireVerifiedEmail);
router.post("/code/review", requireVerifiedEmail);
router.post("/exams/:id/submit", requireVerifiedEmail);
router.post("/classes/:id/a-plan/refresh", requireVerifiedEmail);
router.post(/^\/concept-maps\/(?:grade|practice|predict|reference|[^/]+\/(?:notes-digest|short-answers))\/?$/, requireVerifiedEmail);

router.put("/canvas/connection", putConnection);
router.get("/canvas/connection", getConnection);
router.delete("/canvas/connection", deleteConnection);
router.post("/canvas/sync", postSync);

router.get("/classes", getClasses);
router.post("/classes", postClass);
router.patch("/classes/:id", patchClass);
router.delete("/classes/:id", deleteClass);
router.get("/classes/:id/modules", getModules);
router.get("/classes/:id/items", getClassItems);
router.get("/classes/:id/grade-plan", getGradePlan);
router.use("/classes", aPlanRouter);

router.get("/items/:id", getItem);
router.post("/items/:id/seen", markSeen);

router.get("/today", getToday);

// P2 — notebook pages. Dev uploads: routes/study/dev-upload.ts (mounted outside this router).
router.get("/pages", listPages);
router.post("/pages", createPage);
router.get("/pages/:id", getPage);
router.patch("/pages/:id", patchPage);
router.get("/pages/:id/content", getPageContent);
router.put("/pages/:id/content", putPageContent);
// Proxy upload. index.ts skips the app-wide json parser for this path (STUDY_BLOB_PATH), so the
// raw parser always sees the bytes. Runs after auth (mount), so an anonymous caller can't make us buffer 25 MB.
router.put("/pages/:id/content/blob", express.raw({ type: "*/*", limit: "25mb" }), putPageBlob);
router.post("/pages/:id/content/commit", commitPageContent);
router.put("/pages/:id/ocr", putPageOcr);
// Live co-editing (sharing phase 2 part B): small change batches in, everyone else's out over SSE.
router.post("/pages/:id/live", pushPageLive);
router.get("/pages/:id/live/stream", streamPageLive);
// Earlier versions (owner only): list with authors, restore one as a new version.
router.get("/pages/:id/versions", listPageVersions);
router.post("/pages/:id/versions/:version/restore", restorePageVersion);
// Page renders (ink over background, rendered by the client after a sync) + Claude annotations.
router.get("/pages/:id/renders", getPageRenders);
router.put("/pages/:id/renders/:index", express.raw({ type: "*/*", limit: RENDER_MAX_BYTES }), putPageRender);
router.post("/pages/:id/renders/commit", commitPageRenders);
router.get("/pages/:id/annotations", listPageAnnotations);
router.delete("/pages/:id/annotations/:annotationId", deletePageAnnotation);
// Per-board-page ruler presets (:page = 1-based board page number).
router.get("/pages/:id/ruler", getPageRulers);
router.put("/pages/:id/ruler/:page", putPageRuler);
router.delete("/pages/:id/ruler/:page", deletePageRuler);
router.delete("/pages/:id", deletePage);

router.get("/search", search);

// Office → PDF (LibreOffice). index.ts skips the app-wide parsers here (STUDY_CONVERT_PATH), so a
// text/plain or application/json body still reaches this raw parser intact.
router.post("/convert/pdf", express.raw({ type: "*/*", limit: CONVERT_MAX_BYTES }), convertToPdf);

// P2 — question bank (the three SSE endpoints: extract, attempt, similar).
router.get("/questions", listQuestions);
router.post("/questions", createQuestions);
router.post("/questions/extract", extractQuestions);
router.patch("/questions/:id", patchQuestion);
router.delete("/questions/:id", deleteQuestion);
router.post("/questions/:id/attempt", attemptQuestion);
router.post("/questions/:id/similar", similarQuestions);
router.get("/review/next", getReviewNext);
router.get("/mastery", getMastery);

// P3 — video transcripts, lectures, flashcards. The chunk proxy PUT has its own raw parser (10 MB);
// audio bodies are not json/urlencoded, so the app-wide parsers leave them alone.
router.get("/videos/:itemId/transcript", getVideoTranscript);
router.post("/videos/:itemId/transcript", postVideoTranscript);
router.put("/videos/:itemId/transcript", putVideoTranscript);
router.get("/lectures", listLectures);
router.post("/lectures", createLecture);
router.get("/lectures/:id", getLecture);
router.post("/lectures/:id/chunks", presignChunk);
router.put("/lectures/:id/chunks/:index", checkChunkIndex, rawChunkBody, putChunk);
router.post("/lectures/:id/finish", finishLecture);
router.post("/lectures/:id/retranscribe", retranscribeLecture);
router.post("/ai/flashcards", flashcards);
// P6 — personal API keys for the remote MCP server (the MCP + OAuth routes: routes/study/mcp.ts).
router.get("/mcp/keys", listMcpKeys);
router.post("/mcp/keys", createMcpKey);
router.delete("/mcp/keys/:id", deleteMcpKey);
// OAuth connections (one per authorized client) — list + revoke.
router.get("/mcp/connections", listMcpConnections);
router.delete("/mcp/connections/:id", deleteMcpConnection);

// Phone inbox (admin JWT only — a drop token is never valid here). The upload itself and the
// drop page are public routes in routes/study/inbox.ts, mounted before this router.
router.post("/inbox/tokens", createInboxToken);
router.get("/inbox/tokens", listInboxTokens);
router.delete("/inbox/tokens/:id", deleteInboxToken);
router.get("/inbox", listInbox);
router.get("/inbox/stream", streamInbox);
router.get("/inbox/:id", getInbox);
router.post("/inbox/:id/to-page", postInboxToPage);
router.patch("/inbox/:id", patchInbox);
router.delete("/inbox/:id", deleteInbox);

// Handwriting glyph bank. index.ts skips the app-wide parser here (STUDY_OWN_PARSER_PATH): the
// bank caps at 2 MB serialized (413 in the controller); this parser is the backstop.
router.get("/handwriting/bank", getGlyphBank);
router.put("/handwriting/bank", express.json({ limit: "2560kb" }), putGlyphBank);

// Ruler / device scale for real-size drawings (the Study MCP reads the same row).
router.get("/drawing-profile", getDrawingProfile);
router.patch("/drawing-profile", patchDrawingProfile);

// P5 — mock exams.
router.use("/exams", examsRouter);
// P4 — C++ code run sandbox, review SSE, code projects.
router.use("/code", codeRouter);
// Class tutor — POST /ai/ask (SSE), GET /ai/conversations[/:id].
router.use("/ai", tutorRouter);

// P-CM — class library / guide / exam schedule + results, and concept maps.
router.use(libraryRouter);
router.use("/concept-maps", conceptMapsRouter);

// express.raw throws on an oversized body; shape it here instead of the global handler.
router.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.type === "entity.too.large" || err?.status === 413) {
    const mb = Number(err?.limit) > 0 ? Math.round(Number(err.limit) / (1024 * 1024)) : 25;
    return res.status(413).json({ message: `Body exceeds the ${mb} MB limit`, code: "PAYLOAD_TOO_LARGE" });
  }
  next(err);
});

export default router;
