import { classifyAiError } from "./ai-errors";
import { Types } from "mongoose";
import type { IStudyQuestion } from "@/models/study/question";
import { StudyAiUsage } from "@/models/study/ai-usage";
import { newSpend, Spend, textJson } from "./ai-models";
import { logger } from "@/services/logger.service";

/**
 * Text-model steps behind the MCP `explain_mistake` and `create_study_plan` tools. Same
 * plumbing as the question bank (./ai-models `textJson`: DeepSeek flash, json_object mode),
 * and every call writes a `study_ai_usages` row, success or not.
 */

const MATH_RULES = "Write in English. Math as markdown with inline $LaTeX$ (display math $$…$$). Code in fenced markdown blocks.";

export const EXPLAIN_SYSTEM_PROMPT = [
  "You are a patient tutor. A college student got a question from their own question bank wrong (or wants to understand it).",
  'Return ONE JSON object: {"explanation":"...","keyIdea":"...","commonMistakes":["..."],"nextStep":"..."}',
  "Rules:",
  `- ${MATH_RULES}`,
  "- explanation: walk through WHY the reference answer is right, step by step, in markdown. If the student's answer is given, point at the exact place their reasoning goes wrong first.",
  "- keyIdea: the one concept to remember, a single sentence.",
  "- commonMistakes: 1–3 short items. nextStep: one concrete thing to practise.",
  "- If no reference answer is stored, solve the question yourself carefully and say so.",
].join("\n");

export const PLAN_SYSTEM_PROMPT = [
  "You plan study time for a college student from their real deadlines and weak topics.",
  'Return ONE JSON object: {"summary":"...","days":[{"date":"YYYY-MM-DD","tasks":[{"title":"...","minutes":30,"kind":"assignment|review|study|exam_prep","classId":"... or null","itemId":"... or null"}]}]}',
  "Rules:",
  "- One entry per day from TODAY to UNTIL (inclusive), in order. A day may be light, never invented work beyond the inputs plus review of the listed weak topics / due reviews.",
  "- Put each assignment's work BEFORE its due date, splitting big ones across days. Keep a day under ~4 hours unless deadlines force more.",
  "- Use the given classId/itemId values verbatim when a task is about that class/item; otherwise null.",
  "- summary: 2–3 sentences on priorities.",
].join("\n");

async function recordUsage(userId: Types.ObjectId, endpoint: "mcp_explain" | "mcp_plan", spend: Spend, startedAt: number, status: "done" | "error", extra: { questionId?: Types.ObjectId; error?: string; errorCode?: string } = {}) {
  if (!spend.models.length && status !== "error") return;
  try {
    await StudyAiUsage.create({
      userId,
      endpoint,
      questionId: extra.questionId ?? null,
      status,
      error: extra.error ? extra.error.slice(0, 500) : null,
      errorCode: status === "error" ? extra.errorCode ?? null : null,
      models: spend.models,
      visionCostUsd: 0,
      textCostUsd: Number(spend.textCostUsd.toFixed(6)),
      costUsd: Number(spend.textCostUsd.toFixed(6)),
      latencyMs: Date.now() - startedAt,
    });
  } catch (e) {
    await logger.error("study ai usage write failed", e as Error, { endpoint });
  }
}

async function tracked<T>(userId: Types.ObjectId, endpoint: "mcp_explain" | "mcp_plan", fn: (spend: Spend) => Promise<T>, questionId?: Types.ObjectId): Promise<T> {
  const spend = newSpend();
  const startedAt = Date.now();
  try {
    const out = await fn(spend);
    await recordUsage(userId, endpoint, spend, startedAt, "done", { questionId });
    return out;
  } catch (e) {
    await recordUsage(userId, endpoint, spend, startedAt, "error", { questionId, error: String((e as Error)?.message ?? e), errorCode: classifyAiError(e).code });
    throw e;
  }
}

const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function explainMistake(q: IStudyQuestion, studentAnswer: string | null) {
  const parts = [`QUESTION (${q.type}, topic: ${q.topic}):\n${q.stem}`];
  if (q.choices?.length) parts.push(`CHOICES:\n${q.choices.map((c, i) => `${String.fromCharCode(65 + i)}) ${c}`).join("\n")}`);
  parts.push(q.answer ? `REFERENCE ANSWER:\n${q.answer}` : "REFERENCE ANSWER: (none stored)");
  if (q.solutionSteps?.length) parts.push(`REFERENCE SOLUTION:\n${q.solutionSteps.map((x, i) => `${i + 1}. ${x}`).join("\n")}`);
  parts.push(studentAnswer ? `STUDENT ANSWER:\n${studentAnswer.slice(0, 20_000)}` : `STUDENT ANSWER: (not given; last result: ${q.stats?.lastResult ?? "never attempted"})`);
  return tracked(
    q.userId,
    "mcp_explain",
    async (spend) => {
      const raw = await textJson(EXPLAIN_SYSTEM_PROMPT, parts.join("\n\n"), spend);
      if (!raw) throw new Error("the model returned no JSON");
      return {
        explanation: s(raw.explanation, 20_000),
        keyIdea: s(raw.keyIdea, 1000) || null,
        commonMistakes: (Array.isArray(raw.commonMistakes) ? raw.commonMistakes : []).map((m: unknown) => s(m, 500)).filter(Boolean).slice(0, 3),
        nextStep: s(raw.nextStep, 1000) || null,
      };
    },
    q._id
  );
}

export interface PlanInput {
  today: string;
  until: string;
  classes: { id: string; name: string }[];
  assignments: { itemId: string; classId: string; title: string; type: string; dueAt: string | null; points: number | null; state: string | null }[];
  weakTopics: { classId: string; topic: string; mastery: number }[];
  review: { dueCount: number; newCount: number };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function buildStudyPlan(userId: Types.ObjectId, input: PlanInput) {
  return tracked(userId, "mcp_plan", async (spend) => {
    const raw = await textJson(PLAN_SYSTEM_PROMPT, JSON.stringify(input), spend, { maxTokens: 8192 });
    if (!raw) throw new Error("the model returned no JSON");
    const ids = new Set([...input.classes.map((c) => c.id)]);
    const items = new Set(input.assignments.map((a) => a.itemId));
    const days = (Array.isArray(raw.days) ? raw.days : [])
      .filter((d: any) => typeof d?.date === "string" && DATE_RE.test(d.date) && d.date >= input.today && d.date <= input.until)
      .slice(0, 120)
      .map((d: any) => ({
        date: d.date,
        tasks: (Array.isArray(d.tasks) ? d.tasks : []).slice(0, 20).map((t: any) => ({
          title: s(t?.title, 300),
          minutes: Number.isFinite(Number(t?.minutes)) ? Math.max(5, Math.min(600, Math.round(Number(t.minutes)))) : 30,
          kind: ["assignment", "review", "study", "exam_prep"].includes(t?.kind) ? t.kind : "study",
          // Never echo an id the model made up.
          classId: typeof t?.classId === "string" && ids.has(t.classId) ? t.classId : null,
          itemId: typeof t?.itemId === "string" && items.has(t.itemId) ? t.itemId : null,
        })),
      }));
    return { summary: s(raw.summary, 2000), days };
  });
}
