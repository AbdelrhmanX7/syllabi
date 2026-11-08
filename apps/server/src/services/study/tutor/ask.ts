import { Types } from "mongoose";
import { StudyClass, IStudyClass } from "@/models/study/class";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyPage, IStudyPage } from "@/models/study/page";
import { StudyLecture, IStudyLecture } from "@/models/study/lecture";
import { StudyConversation, IStudyConversation, TUTOR_MODES, TutorMessage, TutorMode, TutorQuizState, TutorSource } from "@/models/study/conversation";
import { logger } from "@/services/logger.service";
import { newSpend, textJson, type Spend } from "../ai-models";
import { textStream } from "../ai-stream";
import { recordStudyUsage } from "../usage";
import { classifyAiError, logAiFailure } from "../ai-errors";
import type { StudySse } from "../sse";
import { loadGuide, type ClassRef } from "./deps";
import { retrieve, type Snippet } from "./retrieve";
import { bestWindow, keywords, overlap, titleFrom } from "./text";
import { decodeImageB64, readLasso } from "./vision";
import {
  buildExplainTurn,
  buildFeedbackTurn,
  EXPLAIN_SYSTEM_PROMPT,
  HISTORY_TURNS,
  historyBlock,
  QUIZ_FEEDBACK_SYSTEM_PROMPT,
  renderQuestion,
  SUMMARY_SYSTEM_PROMPT,
} from "./prompts";
import { guidedSystem, runWithGuide } from "../class-guide";
import { askedStems, generateQuestion, gradePending, pendingFree, pendingFromBank, pickBankQuestion, verdictLine, type QuizVerdict } from "./quiz";

/**
 * POST /study/ai/ask — the class tutor. Validation + ownership happen in `prepareAsk` (a 4xx
 * JSON reply before any stream opens); `runAsk` streams
 *   meta {conversationId} → delta {text}* → sources {sources} → done {quiz?}
 * or ends with error {message, code}. The conversation is written once, after the answer.
 */

export const MAX_QUESTION = 8000;
export const MAX_CONTEXT_TEXT = 20_000;
/** Summarise once this many messages sit between the summary and the verbatim window. */
const SUMMARISE_AFTER = 4;

export class TutorInputError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface AskPrepared {
  userId: Types.ObjectId;
  mode: TutorMode;
  question: string;
  cls: IStudyClass | null;
  conversation: IStudyConversation | null;
  image: Buffer | null;
  text: string | null;
  itemId: Types.ObjectId | null;
  pageId: Types.ObjectId | null;
  lectureId: Types.ObjectId | null;
  videoAt: { itemId: Types.ObjectId; t: number } | null;
}

const isOid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v);
const oid = (v: string) => new Types.ObjectId(v);
const bad = (message: string) => new TutorInputError(400, "VALIDATION_ERROR", message);
const notFound = (what: string) => new TutorInputError(404, "NOT_FOUND", `${what} not found`);

function optId(v: unknown, name: string): Types.ObjectId | null {
  if (v === undefined || v === null || v === "") return null;
  if (!isOid(v)) throw bad(`${name} must be an id`);
  return oid(v);
}

/** Validates the body and resolves every referenced row AS THE CALLER'S (404 otherwise). */
export async function prepareAsk(userId: Types.ObjectId, body: any): Promise<AskPrepared> {
  body = body ?? {};
  const mode = (body.mode ?? "explain") as TutorMode;
  if (!TUTOR_MODES.includes(mode)) throw bad("mode must be explain or quiz");
  const ctx = body.context && typeof body.context === "object" ? body.context : {};
  let question = typeof body.question === "string" ? body.question.trim() : "";
  if (body.question !== undefined && body.question !== null && typeof body.question !== "string") throw bad("question must be a string");
  if (question.length > MAX_QUESTION) throw bad(`question must be at most ${MAX_QUESTION} characters`);
  const text = typeof ctx.text === "string" && ctx.text.trim() ? ctx.text.trim().slice(0, MAX_CONTEXT_TEXT) : null;
  let image: Buffer | null = null;
  if (ctx.imagePngB64 !== undefined && ctx.imagePngB64 !== null && ctx.imagePngB64 !== "") {
    image = decodeImageB64(ctx.imagePngB64);
    if (!image) throw bad("context.imagePngB64 must be a base64 image (max ~8 MB)");
  }
  if (!question && !image && !text && mode === "explain") throw bad("question is required");
  if (!question) question = mode === "quiz" ? "Quiz me on this." : "Explain this.";

  const classId = optId(body.classId, "classId");
  const conversationId = optId(body.conversationId, "conversationId");
  const itemId = optId(ctx.itemId, "context.itemId");
  const pageId = optId(ctx.pageId, "context.pageId");
  const lectureId = optId(ctx.lectureId, "context.lectureId");
  let videoAt: AskPrepared["videoAt"] = null;
  if (ctx.videoAt !== undefined && ctx.videoAt !== null) {
    const t = Number(ctx.videoAt?.t);
    if (!isOid(ctx.videoAt?.itemId) || !Number.isFinite(t) || t < 0) throw bad("context.videoAt must be {itemId, t ≥ 0}");
    videoAt = { itemId: oid(ctx.videoAt.itemId), t };
  }

  const [conversation, item, page, lecture, video] = await Promise.all([
    conversationId ? StudyConversation.findOne({ _id: conversationId, userId }).lean<IStudyConversation>() : null,
    itemId ? StudyItem.findOne({ _id: itemId, userId }, { classId: 1 }).lean<IStudyItem>() : null,
    pageId ? StudyPage.findOne({ _id: pageId, userId, deletedAt: null }, { classId: 1 }).lean<IStudyPage>() : null,
    lectureId ? StudyLecture.findOne({ _id: lectureId, userId }, { classId: 1 }).lean<IStudyLecture>() : null,
    videoAt ? StudyItem.findOne({ _id: videoAt.itemId, userId }, { classId: 1 }).lean<IStudyItem>() : null,
  ]);
  if (conversationId && !conversation) throw notFound("Conversation");
  if (itemId && !item) throw notFound("Item");
  if (pageId && !page) throw notFound("Page");
  if (lectureId && !lecture) throw notFound("Lecture");
  if (videoAt && !video) throw notFound("Video item");

  // A conversation keeps the class it started in; otherwise the explicit class, else the class
  // of whatever the student is looking at.
  const effectiveClassId = conversation ? conversation.classId : (classId ?? item?.classId ?? video?.classId ?? lecture?.classId ?? page?.classId ?? null);
  let cls: IStudyClass | null = null;
  if (effectiveClassId) {
    cls = await StudyClass.findOne({ _id: effectiveClassId, userId }).lean<IStudyClass>();
    if (!cls && (classId || conversation?.classId)) throw notFound("Class");
  }
  return { userId, mode, question, cls, conversation, image, text, itemId, pageId, lectureId, videoAt };
}

const recentMessages = (c: IStudyConversation | null): TutorMessage[] => {
  if (!c?.messages?.length) return [];
  return c.messages.slice(Math.max(c.summarizedUpTo ?? 0, c.messages.length - HISTORY_TURNS));
};

const emptyQuiz = (): TutorQuizState => ({ topic: null, pending: null, asked: 0, right: 0, partial: 0, wrong: 0, bankAsked: [] });

function guideSource(guide: string | null, cls: ClassRef | null, terms: string[]): TutorSource | null {
  if (!guide || !cls || !overlap(guide, terms)) return null;
  return { kind: "guide", id: String(cls._id), title: "Class guide", snippet: bestWindow(guide, terms, 240) };
}

/**
 * The class guide is loaded once and the whole turn runs inside `runWithGuide`, so every
 * `textJson` call below (quiz grading / generation, bank grading, the summary) carries it via
 * P-CM's `guidedSystem`; the two `textStream` calls add it explicitly. Never both.
 */
export async function runAsk(p: AskPrepared, sse: StudySse): Promise<void> {
  const cls: ClassRef | null = p.cls ? { _id: p.cls._id, canvasCourseId: p.cls.canvasCourseId } : null;
  const guide = await loadGuide(p.userId, cls);
  return runWithGuide(guide, () => runTurn(p, sse, cls, guide));
}

async function runTurn(p: AskPrepared, sse: StudySse, cls: ClassRef | null, guide: string | null): Promise<void> {
  const startedAt = Date.now();
  const conversationId = p.conversation?._id ?? new Types.ObjectId();
  const textSpend = newSpend();
  const visionSpend = newSpend();
  const usageExtra = { itemId: p.itemId ?? p.videoAt?.itemId ?? null, lectureId: p.lectureId ?? null };
  let status: "done" | "error" | "stopped" = "stopped";
  let errorUsageRecorded = false;
  let error: string | undefined;
  let errorCode: string | undefined;
  sse.send("meta", { conversationId: String(conversationId) });

  try {
    // 1. The lasso image is read first; its reading is the student's selection.
    let reading = "";
    if (p.image) {
      try {
        reading = await readLasso(p.image, visionSpend, sse.signal);
      } catch (e) {
        if (sse.signal.aborted) return;
        error = `vision: ${String((e as Error)?.message ?? e)}`;
        status = "error";
        const c = classifyAiError(e, { code: "VISION_FAILED", message: "Couldn't read the selected area — try again" });
        errorCode = c.code;
        await logAiFailure("study tutor vision failed", e, {}, c.code);
        await recordStudyUsage(p.userId, "ask_vision", visionSpend, startedAt, "error", { ...usageExtra, error, errorCode: c.code });
        return sse.error(c.message, c.code);
      }
      await recordStudyUsage(p.userId, "ask_vision", visionSpend, startedAt, "done", usageExtra);
      if (sse.signal.aborted) return;
    }
    const selection = [reading, p.text].filter(Boolean).join("\n\n") || null;

    const conv = p.conversation;
    const quiz: TutorQuizState = { ...emptyQuiz(), ...(conv?.quiz ?? {}) };
    const pending = p.mode === "quiz" ? quiz.pending : null;
    const topicText = p.mode === "quiz" ? [pending?.stem, quiz.topic ?? p.question].filter(Boolean).join(" ") : "";
    const terms = keywords([p.question, selection ?? "", topicText].join(" "));

    const found = await retrieve({ userId: p.userId, classId: p.cls?._id ?? null, cls, terms, itemId: p.itemId, pageId: p.pageId, lectureId: p.lectureId, videoAt: p.videoAt });
    if (sse.signal.aborted) return;
    const history = historyBlock(conv?.summary ?? null, recentMessages(conv));
    const className = p.cls ? [p.cls.code, p.cls.name].filter(Boolean).join(" — ") : null;
    const onDelta = (t: string) => sse.send("delta", { text: t });
    let answer = "";
    const emit = (t: string) => {
      answer += t;
      onDelta(t);
    };
    const used: Snippet[] = found.snippets;
    let quizOut: Record<string, unknown> | undefined;

    if (p.mode === "explain") {
      answer = await textStream(
        guidedSystem(EXPLAIN_SYSTEM_PROMPT, guide),
        buildExplainTurn({ className, history, selection, snippets: found.snippets, questions: found.questions }, p.question),
        textSpend,
        onDelta,
        { signal: sse.signal }
      );
      if (sse.signal.aborted) return;
    } else {
      // 2a. GRADE the pending question (claimed by its token, so a double submit grades once).
      let verdict: QuizVerdict | null = null;
      if (pending && conv) {
        const claimed = await StudyConversation.findOneAndUpdate({ _id: conv._id, userId: p.userId, "quiz.pending.token": pending.token }, { $set: { "quiz.pending": null } });
        if (claimed) {
          const reply = [p.question, reading].filter(Boolean).join("\n");
          verdict = await gradePending(p.userId, pending, reply, textSpend, sse.signal);
          if (sse.signal.aborted || !verdict) return;
          quiz[verdict.result === "right" ? "right" : verdict.result === "partial" ? "partial" : "wrong"] += 1;
          emit(`${verdictLine(verdict.result)} `);
          const fb = await textStream(
            guidedSystem(QUIZ_FEEDBACK_SYSTEM_PROMPT, guide),
            buildFeedbackTurn({ stem: pending.stem, choices: pending.choices, answer: verdict.correctAnswer || pending.answer, reply, result: verdict.result, hint: verdict.hint, snippets: found.snippets }),
            textSpend,
            onDelta,
            { signal: sse.signal, maxTokens: 800 }
          );
          answer += fb;
          if (sse.signal.aborted) return;
          emit("\n\n");
        }
      }
      quiz.pending = null;
      if (!quiz.topic) quiz.topic = p.question.replace(/^\s*(please\s+)?(quiz|test)\s+me(\s+(on|about))?\s*/i, "").trim().slice(0, 500) || null;

      // 2b. ASK the next question: a bank question of this class first, else a generated one.
      const topicTerms = keywords(`${quiz.topic} ${selection ?? ""}`);
      const bank = p.cls ? await pickBankQuestion(p.userId, p.cls._id, quiz, topicTerms) : null;
      let next;
      if (bank) {
        next = pendingFromBank(bank);
        quiz.bankAsked = [...(quiz.bankAsked ?? []), bank._id];
      } else {
        const g = await generateQuestion({ topic: quiz.topic, snippets: found.snippets, asked: askedStems(conv?.messages ?? []), className }, textSpend, sse.signal);
        if (sse.signal.aborted) return;
        next = pendingFree(g);
      }
      quiz.pending = next;
      quiz.asked += 1;
      if (!verdict && !answer) emit(`Let's practise${quiz.topic && !/^this\.?$/i.test(quiz.topic) ? `: ${quiz.topic.slice(0, 120)}` : ""}.\n\n`);
      emit(renderQuestion(quiz.asked, next.stem, next.choices));
      quizOut = {
        questionId: next.questionId ? String(next.questionId) : null,
        questionKind: next.kind,
        asked: quiz.asked,
        right: quiz.right,
        partial: quiz.partial,
        wrong: quiz.wrong,
        ...(verdict ? { graded: { result: verdict.result, correctAnswer: verdict.correctAnswer, ...(verdict.bank ? { questionId: verdict.bank.questionId, stats: verdict.bank.stats, srs: verdict.bank.srs } : {}) } } : {}),
      };
    }

    const sources: TutorSource[] = used.map((s) => s.source);
    const gs = guideSource(guide, cls, terms);
    if (gs) sources.push(gs);
    sse.send("sources", { sources });

    // 3. Persist the turn (upsert: a new conversation is created only once it has an answer).
    const now = new Date();
    const userMsg: TutorMessage = { role: "user", text: [p.question, reading ? `[selection] ${reading}` : ""].filter(Boolean).join("\n"), mode: p.mode, createdAt: now };
    const botMsg: TutorMessage = { role: "assistant", text: answer, mode: p.mode, sources, createdAt: new Date(now.getTime() + 1) };
    const update: Record<string, any> = {
      $setOnInsert: { userId: p.userId, classId: p.cls?._id ?? null, title: titleFrom(p.question), summary: null, summarizedUpTo: 0 },
      $push: { messages: { $each: [userMsg, botMsg] } },
    };
    if (p.mode === "quiz") update.$set = { quiz };
    const saved = await StudyConversation.findOneAndUpdate({ _id: conversationId, userId: p.userId }, update, { upsert: true, new: true, setDefaultsOnInsert: true }).lean<IStudyConversation>();

    status = "done";
    await recordStudyUsage(p.userId, "ask", textSpend, startedAt, "done", usageExtra);
    sse.done(quizOut ? { quiz: quizOut } : {});
    if (saved) void maybeSummarise(saved).catch(() => undefined);
  } catch (e) {
    if (sse.signal.aborted) return;
    status = "error";
    error = String((e as Error)?.message ?? e);
    const c = classifyAiError(e, { code: "AI_FAILED", message: "The tutor failed — try again" });
    errorCode = c.code;
    await logAiFailure("study tutor ask failed", e, {}, c.code);
    // Write the usage row BEFORE closing the stream, as the success path does:
    // a client that reads usage as soon as the error frame lands must see it.
    await recordStudyUsage(p.userId, "ask", textSpend, startedAt, "error", { ...usageExtra, error, errorCode });
    errorUsageRecorded = true;
    sse.error(c.message, c.code);
  } finally {
    if (status !== "done" && !errorUsageRecorded) await recordStudyUsage(p.userId, "ask", textSpend, startedAt, sse.signal.aborted ? "stopped" : status, { ...usageExtra, error, errorCode });
  }
}

/** Fold the messages that slid out of the verbatim window into the rolling summary. */
export async function maybeSummarise(c: IStudyConversation, spend: Spend = newSpend()): Promise<boolean> {
  const upTo = c.messages.length - HISTORY_TURNS;
  const from = c.summarizedUpTo ?? 0;
  if (upTo - from < SUMMARISE_AFTER) return false;
  const startedAt = Date.now();
  const older = c.messages.slice(from, upTo).map((m) => `${m.role === "user" ? "Student" : "Tutor"}: ${m.text.slice(0, 1500)}`);
  const raw = await textJson(SUMMARY_SYSTEM_PROMPT, [c.summary ? `SUMMARY SO FAR:\n${c.summary}` : "", `NEW TURNS:\n${older.join("\n\n")}`].filter(Boolean).join("\n\n"), spend, { maxTokens: 800 });
  const summary = typeof raw?.summary === "string" ? raw.summary.trim().slice(0, 3000) : "";
  await recordStudyUsage(c.userId, "ask", spend, startedAt, summary ? "done" : "error", summary ? {} : { error: "summary: no JSON" });
  if (!summary) return false;
  const r = await StudyConversation.updateOne({ _id: c._id, userId: c.userId, summarizedUpTo: from }, { $set: { summary, summarizedUpTo: upTo } });
  return r.modifiedCount === 1;
}

// ─── conversations (read) ───────────────────────────────────────────────────────────────

export async function listConversations(userId: Types.ObjectId, classId: Types.ObjectId | null) {
  const rows = await StudyConversation.find(classId ? { userId, classId } : { userId }, { title: 1, updatedAt: 1, classId: 1 })
    .sort({ updatedAt: -1 })
    .limit(200)
    .lean<IStudyConversation[]>();
  return rows.map((c) => ({ id: String(c._id), title: c.title, classId: c.classId ? String(c.classId) : null, updatedAt: new Date(c.updatedAt).toISOString() }));
}

export async function getConversation(userId: Types.ObjectId, id: Types.ObjectId) {
  const c = await StudyConversation.findOne({ _id: id, userId }).lean<IStudyConversation>();
  if (!c) return null;
  return {
    id: String(c._id),
    title: c.title,
    classId: c.classId ? String(c.classId) : null,
    messages: (c.messages ?? []).map((m) => ({ role: m.role, text: m.text, mode: m.mode, ...(m.sources?.length ? { sources: m.sources } : {}), createdAt: new Date(m.createdAt).toISOString() })),
    quiz: c.quiz?.pending ? { pending: { kind: c.quiz.pending.kind, stem: c.quiz.pending.stem, choices: c.quiz.pending.choices }, asked: c.quiz.asked, right: c.quiz.right, partial: c.quiz.partial, wrong: c.quiz.wrong } : null,
  };
}
