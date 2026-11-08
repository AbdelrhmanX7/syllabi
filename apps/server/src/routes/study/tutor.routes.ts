import express from "express";
import { getConversationById, getConversations, postAsk } from "@/controllers/study-tutor.controller";
import { conceptMapFromTerms } from "@/controllers/study-concept-maps.controller";
import { boardActions, boardActionsMultipart } from "@/controllers/study-board-actions.controller";
import { inkClassify, inkJson } from "@/controllers/study-ink-classify.controller";
import { dictationRaw, transcribe } from "@/controllers/study-dictation.controller";

/**
 * /study/ai/* — the class tutor (ask SSE + conversations), "map my terms" (concept-map/from-terms SSE)
 * board actions (multipart → JSON markup of the visible page) and ink-classify (JSON, own 16 KB parser). Mounted under routes/study/router.ts,
 * so auth (adminVerification + studyAccess) applies. Paths it does not own (e.g.
 * /study/ai/flashcards) fall through to the parent router.
 */
const router = express.Router();

router.post("/ask", postAsk);
router.get("/conversations", getConversations);
router.post("/concept-map/from-terms", conceptMapFromTerms);
router.post("/board-actions", boardActionsMultipart, boardActions);
// Own 16 KB parser: index.ts skips the app-wide one here (STUDY_OWN_JSON_PARSER_PATH).
router.post("/ink-classify", inkJson, inkClassify);
// Voice dictation: raw audio body (own 5 MB raw parser; the app-wide json parser ignores audio/*).
router.post("/transcribe", dictationRaw, transcribe);
router.get("/conversations/:id", getConversationById);

export default router;
