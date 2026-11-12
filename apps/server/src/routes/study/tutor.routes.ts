import express from "express";
import { getConversationById, getConversations, postAsk } from "@/controllers/study-tutor.controller";
import { conceptMapFromTerms } from "@/controllers/study-concept-maps.controller";
import { boardActions, boardActionsMultipart } from "@/controllers/study-board-actions.controller";
import { addBuddyNote, answerBuddyQuiz, deleteBuddyExpert, forgetBuddyNote, saveBuddyExpert, getBuddyMemory, getBuddyTurn, listBuddyExperts, listBuddyTurns, rateBuddyTurn } from "@/controllers/study-buddy.controller";
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
// The buddy's answer log, ratings, quick checks and memory (services/study/buddy).
router.get("/buddy/experts", listBuddyExperts);
router.put("/buddy/experts/:id", saveBuddyExpert);
router.delete("/buddy/experts/:id", deleteBuddyExpert);
router.post("/buddy/memory", addBuddyNote);
router.get("/buddy/turns", listBuddyTurns);
router.get("/buddy/turns/:id", getBuddyTurn);
router.post("/buddy/turns/:id/rating", rateBuddyTurn);
router.post("/buddy/turns/:id/quiz", answerBuddyQuiz);
router.get("/buddy/memory", getBuddyMemory);
router.post("/buddy/memory/forget", forgetBuddyNote);
// Own 16 KB parser: index.ts skips the app-wide one here (STUDY_OWN_JSON_PARSER_PATH).
router.post("/ink-classify", inkJson, inkClassify);
// Voice dictation: raw audio body (own 5 MB raw parser; the app-wide json parser ignores audio/*).
router.post("/transcribe", dictationRaw, transcribe);
router.get("/conversations/:id", getConversationById);

export default router;
