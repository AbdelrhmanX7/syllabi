import type { TutorMessage } from "@/models/study/conversation";
import type { Snippet } from "./retrieve";
import { clip } from "./text";

/**
 * Tutor prompts. The SYSTEM prompts are constants (DeepSeek prefix cache); the class guide is
 * appended after them by P-CM's `guidedSystem` (constant per class) — automatically inside
 * `textJson`, explicitly for the `textStream` calls — and everything per-turn rides the user turn.
 */

const MATH = "Math as markdown with inline $LaTeX$ (display math $$…$$). Code in fenced blocks.";

export const EXPLAIN_SYSTEM_PROMPT = [
  "You are a patient personal tutor for ONE college class. The student is a beginner in this subject.",
  "Answer in English at a beginner level:",
  "- Define every technical term the FIRST time you use it, in plain words (a short parenthetical or one sentence).",
  "- Build up step by step; prefer a small concrete example over abstraction. Short paragraphs, light markdown.",
  `- ${MATH}`,
  "- Ground the answer in the numbered SOURCES from the student's own class material. Cite them inline as [1], [2] right after the claim they support. Never invent a source number.",
  "- If the sources do not cover something, say so briefly and answer from general knowledge, marked as such.",
  "- When a CLASS GUIDE is given and it says the professor's wording or definitions take precedence, use the professor's wording over a textbook's; if they conflict, say which one the class uses.",
  "- If the student shared a selection (a lasso reading or text), answer about THAT first.",
  "- Do not end with a list of follow-up offers. Do not repeat the question.",
].join("\n");

export const QUIZ_GRADE_SYSTEM_PROMPT = [
  "You grade a college student's reply to ONE practice question asked by their tutor.",
  'Return ONE JSON object: {"result":"right|partial|wrong","feedback":"...","correctAnswer":"..."}',
  "- result: right = correct (equivalent forms, sensible rounding, synonyms accepted); partial = the right idea with a slip or missing piece; wrong = otherwise, or no real attempt.",
  "- feedback: 1–3 short sentences to the student: what was right, what was missing or wrong and why. Beginner level; define a term if you use a new one. Never ask a new question.",
  "- correctAnswer: the correct answer in one line.",
  `- ${MATH}`,
].join("\n");

export const QUIZ_FEEDBACK_SYSTEM_PROMPT = [
  "You are a friendly tutor giving feedback on a student's answer to a practice question. The grading is ALREADY done (VERDICT); do not re-grade or contradict it.",
  "Write 2–4 short sentences in English: say whether it was right, explain the key idea behind the correct answer at beginner level (define any term the first time), and if it was not right, show the correct answer.",
  "Cite the numbered SOURCES as [1] when you use them. Do NOT ask a new question — the next question is added after your text.",
  `- ${MATH}`,
].join("\n");

export const QUIZ_GENERATE_SYSTEM_PROMPT = [
  "You write ONE practice question for a college student from their own class material (the numbered SOURCES).",
  'Return ONE JSON object: {"stem":"...","choices":[],"answer":"...","topic":"..."}',
  "- One clear, self-contained question that checks understanding (not trivia), answerable from the SOURCES, at the difficulty a beginner can reach.",
  "- choices: [] for a short-answer question, or 4 options (no letters) for multiple choice; vary the format across a quiz.",
  "- answer: the correct answer (the exact choice text for multiple choice).",
  "- topic: 1–4 words.",
  "- Do not repeat any question listed under ALREADY ASKED.",
  `- ${MATH}`,
].join("\n");

export const SUMMARY_SYSTEM_PROMPT = [
  "Summarise this tutoring conversation so it can continue later without the full transcript.",
  'Return ONE JSON object: {"summary":"..."} — at most 150 words: what the student asked about, what was explained (key definitions), their misunderstandings, and quiz results so far.',
].join("\n");

export const HISTORY_TURNS = 8;
const HISTORY_CHARS = 1200;

/** Rolling summary + the last few turns, as one block for the user turn. */
export function historyBlock(summary: string | null, recent: TutorMessage[]): string {
  const parts: string[] = [];
  if (summary?.trim()) parts.push(`EARLIER IN THIS CONVERSATION (summary):\n${summary.trim()}`);
  if (recent.length) parts.push(`RECENT TURNS:\n${recent.map((m) => `${m.role === "user" ? "Student" : "Tutor"}: ${clip(m.text, HISTORY_CHARS)}`).join("\n\n")}`);
  return parts.join("\n\n");
}

export function sourcesBlock(snippets: Snippet[]): string {
  if (!snippets.length) return "SOURCES: (none found in the class material)";
  return `SOURCES:\n${snippets
    .map((s, i) => `[${i + 1}] (${s.source.kind}${s.source.week ? `, week ${s.source.week}` : ""}) ${s.source.title}${s.source.t != null ? ` @${Math.floor(s.source.t / 60)}:${String(Math.floor(s.source.t % 60)).padStart(2, "0")}` : ""}\n${s.text}`)
    .join("\n\n")}`;
}

export interface TurnContext {
  className: string | null;
  history: string;
  selection: string | null;
  snippets: Snippet[];
  questions: Array<{ stem: string; answer: string }>;
}

export function buildExplainTurn(ctx: TurnContext, question: string): string {
  const parts: string[] = [];
  if (ctx.className) parts.push(`CLASS: ${ctx.className}`);
  if (ctx.history) parts.push(ctx.history);
  parts.push(sourcesBlock(ctx.snippets));
  if (ctx.questions.length) parts.push(`RELATED PRACTICE QUESTIONS (from the student's bank; not citable):\n${ctx.questions.map((q) => `- ${q.stem}${q.answer ? ` → ${q.answer}` : ""}`).join("\n")}`);
  if (ctx.selection) parts.push(`THE STUDENT'S SELECTION:\n${ctx.selection}`);
  parts.push(`QUESTION:\n${question}`);
  return parts.join("\n\n");
}

export function buildFeedbackTurn(o: { stem: string; choices: string[]; answer: string; reply: string; result: string; hint: string | null; snippets: Snippet[] }): string {
  return [
    sourcesBlock(o.snippets),
    `QUESTION:\n${o.stem}${o.choices.length ? `\n${o.choices.map((c, i) => `${String.fromCharCode(65 + i)}) ${c}`).join("\n")}` : ""}`,
    `REFERENCE ANSWER:\n${o.answer || "(none)"}`,
    `STUDENT'S ANSWER:\n${clip(o.reply, 4000)}`,
    `VERDICT: ${o.result}${o.hint ? `\nGRADER NOTE: ${o.hint}` : ""}`,
  ].join("\n\n");
}

export function buildGradeTurn(o: { stem: string; choices: string[]; answer: string; reply: string }): string {
  return [
    `QUESTION:\n${o.stem}${o.choices.length ? `\n${o.choices.map((c, i) => `${String.fromCharCode(65 + i)}) ${c}`).join("\n")}` : ""}`,
    `REFERENCE ANSWER:\n${o.answer || "(none — solve it yourself first)"}`,
    `STUDENT'S ANSWER:\n${clip(o.reply, 4000)}`,
  ].join("\n\n");
}

export function buildGenerateTurn(o: { topic: string | null; snippets: Snippet[]; asked: string[]; className: string | null }): string {
  return [
    o.className ? `CLASS: ${o.className}` : "",
    `QUIZ TOPIC: ${o.topic || "(the class material below)"}`,
    sourcesBlock(o.snippets),
    o.asked.length ? `ALREADY ASKED:\n${o.asked.map((s) => `- ${clip(s, 200)}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The question as the student sees it (appended after the feedback). */
export function renderQuestion(n: number, stem: string, choices: string[]): string {
  const lines = [`**Question ${n}:** ${stem}`];
  if (choices.length) lines.push("", ...choices.map((c, i) => `${String.fromCharCode(65 + i)}) ${c}`));
  return lines.join("\n");
}
