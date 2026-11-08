import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { StudyQuestion, IStudyQuestion, AttemptResult } from "@/models/study/question";
import type { PendingQuizQuestion, TutorQuizState } from "@/models/study/conversation";
import { AttemptInputError, AttemptPlan, planAttempt, runPlan } from "../attempt-grading";
import { studentChoiceIndex } from "../ai";
import { recordAttempt, srsDto } from "../questions";
import { textJson, type Spend } from "../ai-models";
import type { Snippet } from "./retrieve";
import { anyTermRx, clip, overlap } from "./text";
import { buildGenerateTurn, buildGradeTurn, QUIZ_GENERATE_SYSTEM_PROMPT, QUIZ_GRADE_SYSTEM_PROMPT } from "./prompts";

/**
 * Quiz mode state machine (state lives on the conversation, `quiz`):
 *
 *   no pending ──turn──▶ ASK: pick/generate a question, store it as `pending`
 *   pending    ──turn──▶ GRADE the turn's text as the answer to `pending` (claimed atomically by
 *                        its token), give feedback, then ASK the next question (new `pending`).
 *
 * A bank question (`study_questions`) is graded with services/study/attempt-grading.ts and the
 * result is recorded with `recordAttempt` (stats, mastery, FSRS). A free-generated question is
 * graded by the text model only and touches no bank row.
 */

export interface QuizVerdict {
  result: AttemptResult;
  /** Grader's note (bank: the verdict hint; free: the model's feedback). */
  hint: string | null;
  correctAnswer: string;
  /** Bank only: what recordAttempt wrote. */
  bank: { questionId: string; stats: IStudyQuestion["stats"]; srs: ReturnType<typeof srsDto> } | null;
}

const LETTER = /^\(?([a-hA-H])\)?[.)]?$/;

/** The bank attempt input for a typed quiz reply: a letter / exact choice → `choice`, else `typed`. */
export function replyInput(q: Pick<IStudyQuestion, "type" | "choices">, reply: string): { choice?: string; typed?: string } {
  const t = reply.trim();
  if (q.type === "mcq" && q.choices?.length) {
    const letter = t.match(LETTER);
    const cand = letter ? letter[1] : t;
    if (studentChoiceIndex(q, cand) !== null) return { choice: cand };
  }
  return { typed: t };
}

/** `textJson` adds the class guide itself (P-CM `guidedSystem`, from the surrounding `runWithGuide`). */
export async function gradePending(userId: Types.ObjectId, pending: PendingQuizQuestion, reply: string, spend: Spend, signal?: AbortSignal): Promise<QuizVerdict | null> {
  if (pending.kind === "bank" && pending.questionId) {
    const q = await StudyQuestion.findOne({ _id: pending.questionId, userId }).lean<IStudyQuestion>();
    if (q) {
      let plan: AttemptPlan;
      try {
        plan = planAttempt(q, replyInput(q, reply));
      } catch (e) {
        if (!(e instanceof AttemptInputError)) throw e;
        plan = { kind: "model", work: reply.trim() }; // e.g. a choice question whose key is not a choice
      }
      const graded = await runPlan(q, plan, false, spend, signal);
      if ("aborted" in graded || "nothingRead" in graded) return null;
      const out = await recordAttempt(q, graded.verdict.result, { usedHelp: false });
      return { result: graded.verdict.result, hint: graded.verdict.hint, correctAnswer: q.answer ?? "", bank: { questionId: String(q._id), stats: out.stats, srs: out.srs } };
    }
    // The bank row is gone (deleted mid-quiz): grade it as a free question.
  }
  const raw = await textJson(QUIZ_GRADE_SYSTEM_PROMPT, buildGradeTurn({ stem: pending.stem, choices: pending.choices, answer: pending.answer, reply }), spend, { signal, maxTokens: 1500 });
  if (signal?.aborted) return null;
  const result: AttemptResult = raw?.result === "right" || raw?.result === "partial" ? raw.result : "wrong";
  const feedback = typeof raw?.feedback === "string" ? raw.feedback.trim().slice(0, 1500) : "";
  const correctAnswer = typeof raw?.correctAnswer === "string" && raw.correctAnswer.trim() ? raw.correctAnswer.trim().slice(0, 1000) : pending.answer;
  return { result, hint: feedback || null, correctAnswer, bank: null };
}

const QUIZ_TYPES = ["free", "mcq"];

/** A bank question of this class for the quiz topic: relevant first, then due, never repeated. */
export async function pickBankQuestion(userId: Types.ObjectId, classId: Types.ObjectId, quiz: Pick<TutorQuizState, "bankAsked">, terms: string[], now = new Date()): Promise<IStudyQuestion | null> {
  const base = { userId, classId, type: { $in: QUIZ_TYPES }, _id: { $nin: quiz.bankAsked ?? [] } };
  const rx = anyTermRx(terms);
  const pool = rx ? await StudyQuestion.find({ ...base, $or: [{ stem: rx }, { topic: rx }, { tags: rx }] }).limit(50).lean<IStudyQuestion[]>() : [];
  if (!pool.length && !terms.length) pool.push(...(await StudyQuestion.find(base).sort({ "srs.dueAt": 1 }).limit(20).lean<IStudyQuestion[]>()));
  if (!pool.length) return null;
  const score = (q: IStudyQuestion) => 2 * (overlap(q.stem, terms) + overlap(q.topic, terms)) + (q.srs?.dueAt && new Date(q.srs.dueAt) <= now ? 1 : 0) + (1 - (q.stats?.mastery ?? 0));
  return pool.sort((a, b) => score(b) - score(a))[0];
}

export async function generateQuestion(o: { topic: string | null; snippets: Snippet[]; asked: string[]; className: string | null }, spend: Spend, signal?: AbortSignal) {
  const raw = await textJson(QUIZ_GENERATE_SYSTEM_PROMPT, buildGenerateTurn(o), spend, { signal, maxTokens: 2000 });
  const stem = typeof raw?.stem === "string" ? raw.stem.trim() : "";
  if (!stem) throw new Error("question generator returned no stem");
  const choices = Array.isArray(raw?.choices) ? raw.choices.filter((c: unknown) => typeof c === "string" && c.trim()).map((c: string) => c.trim().slice(0, 500)).slice(0, 6) : [];
  return {
    stem: stem.slice(0, 4000),
    choices: choices.length >= 2 ? choices : [],
    answer: typeof raw?.answer === "string" ? raw.answer.trim().slice(0, 1000) : "",
    topic: typeof raw?.topic === "string" && raw.topic.trim() ? raw.topic.trim().slice(0, 100) : o.topic,
  };
}

export const pendingFromBank = (q: IStudyQuestion): PendingQuizQuestion => ({
  token: randomUUID(),
  kind: "bank",
  questionId: q._id,
  stem: q.stem,
  choices: q.choices ?? [],
  answer: q.answer ?? "",
  topic: q.topic ?? null,
  askedAt: new Date(),
});

export const pendingFree = (g: { stem: string; choices: string[]; answer: string; topic: string | null }): PendingQuizQuestion => ({
  token: randomUUID(),
  kind: "free",
  questionId: null,
  stem: g.stem,
  choices: g.choices,
  answer: g.answer,
  topic: g.topic,
  askedAt: new Date(),
});

/** Deterministic verdict line shown before the model's feedback. */
export const verdictLine = (r: AttemptResult) => (r === "right" ? "✅ **Correct!**" : r === "partial" ? "🟡 **Partly right.**" : "❌ **Not quite.**");

export const askedStems = (messages: Array<{ role: string; mode: string; text: string }>) =>
  messages
    .filter((m) => m.role === "assistant" && m.mode === "quiz")
    .map((m) => m.text.match(/\*\*Question \d+:\*\* ([^\n]+)/)?.[1])
    .filter((s): s is string => !!s)
    .map((s) => clip(s, 200))
    .slice(-10);
