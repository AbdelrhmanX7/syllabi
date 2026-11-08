import type { IStudyQuestion, AttemptResult } from "@/models/study/question";
import { parseJsonLoose, Spend, textJson, visionCall } from "./ai-models";

/**
 * Prompts + parsing for the study question bank's AI steps. English output; math as markdown
 * with `$LaTeX$`. Network calls go through ./ai-models only.
 */

const MATH_RULES = "Write in English. Math as markdown with inline $LaTeX$ (display math $$…$$). Code in fenced markdown blocks.";

// ─── extraction ─────────────────────────────────────────────────────────────────────────

/** Shapes of the two structured types — shared by the build and similar prompts. */
export const STRUCTURED_TYPE_RULES = [
  '- matching: {"type":"matching","stem":"Match each … to …","pairs":[{"left":"term","right":"its match"}],"choices":["every right, plus 0–3 plausible distractors, shuffled"]}. Lefts are unique; every right appears in choices. No answer field needed.',
  '- fill_blank: {"type":"fill_blank","stem":"text with ___ for each blank","answer":["word|alternative spelling or synonym", …]} — exactly one answer entry per ___ in the stem, in order. A crossword/vocabulary clue becomes one fill_blank: the clue as a sentence with ___ for the term.',
];

export const EXTRACT_VISION_PROMPT = [
  "This image is one page of course material: lecture slides, a worksheet, a textbook page, an exam, a quiz, or a photo of handwritten problems.",
  "Transcribe every self-contained question or exercise on it. Worked examples count as questions (the problem statement is the stem; the shown solution is the given answer).",
  'Return ONE JSON object: {"questions":[{"stem":"...","choices":["..."],"givenAnswer":"... or null","figure":"... or null"}]}',
  "Rules:",
  "- stem: the question text verbatim, with any sub-parts. Math as LaTeX between $…$. Code as fenced markdown blocks, copied exactly (indentation, symbols).",
  "- choices: printed answer options in order, WITHOUT their letters/numbers; [] when there are none.",
  "- givenAnswer: an answer or solution printed on the page for this question (answer key, worked solution, marked choice); null if none.",
  "- figure: if the question depends on a figure, graph, diagram or table, describe it precisely (labels, values, units, axes); else null.",
  "- Copy numbers and symbols exactly as printed. Do NOT solve anything and do NOT correct anything.",
  "- A matching exercise (two columns, a labeled diagram to match, a word bank) is ONE question: put both columns/labels in the stem. A fill-in-the-blank or crossword clue keeps each blank as ___ in the stem.",
  '- A page with no questions (pure explanation, a title slide, a blank page) → {"questions":[]}.',
].join("\n");

export const BUILD_SYSTEM_PROMPT = [
  "You turn course material into entries for a college student's personal question bank.",
  'Return ONE JSON object: {"questions":[{"type":"free|mcq|code_output|code_write|matching|fill_blank","topic":"...","subtopic":"... or null","difficulty":1,"stem":"...","choices":["..."],"answer":"...","solutionSteps":["..."],"tags":["..."]}]}',
  "Rules:",
  `- ${MATH_RULES}`,
  ...STRUCTURED_TYPE_RULES,
  "- Only genuine questions/exercises that are present in the source. Never invent new ones. If there are none, return {\"questions\":[]}. At most 30.",
  "- stem: keep the source wording and numbers exactly (fix only obvious OCR spacing). If a figure description is given, append it to the stem as a final line starting with `*Figure:*`.",
  "- type: matching for a match-the-columns / labeled-diagram matching item; fill_blank for fill-in-the-blank items and crossword/vocabulary clue lists; mcq when there are answer choices; code_output when it asks what a program prints/outputs; code_write when it asks to write code; otherwise free.",
  "- choices: only for mcq, without letters. answer for mcq = the exact text of the correct choice.",
  "- answer: the final answer in markdown (for code_output: the exact program output; for code_write: a correct reference solution in a fenced block). Use a given answer from the source when it is right; otherwise solve it yourself carefully.",
  "- solutionSteps: a concise worked solution, one step per array entry, each a single line with LaTeX.",
  "- topic: a short course-level topic name (e.g. \"Integration by parts\", \"Pointers\", \"Related rates\"). Reuse one of the EXISTING TOPICS listed in the user turn when it fits.",
  "- difficulty: 1 (recall) … 5 (hard multi-step). tags: 1–5 short lowercase keywords.",
].join("\n");

export interface BuildContext {
  className?: string | null;
  existingTopics?: string[];
}

const contextLines = (ctx: BuildContext) =>
  [ctx.className ? `CLASS: ${ctx.className}` : "", `EXISTING TOPICS: ${ctx.existingTopics?.length ? ctx.existingTopics.slice(0, 60).join("; ") : "(none yet)"}`]
    .filter(Boolean)
    .join("\n");

/** Raw model questions (unvalidated). The caller runs them through `toDraft`. */
export async function buildQuestionsFromText(source: string, ctx: BuildContext, spend: Spend, signal?: AbortSignal): Promise<any[]> {
  const out = await textJson(BUILD_SYSTEM_PROMPT, `${contextLines(ctx)}\n\nSOURCE:\n${source.slice(0, 40_000)}`, spend, { signal, maxTokens: 16_000 });
  return Array.isArray(out?.questions) ? out.questions.slice(0, 30) : [];
}

/** One page image → its transcribed questions (vision) → bank entries (text). */
export async function buildQuestionsFromImage(png: Buffer, ctx: BuildContext, spend: Spend, signal?: AbortSignal): Promise<any[]> {
  const raw = await visionCall(png, "image/png", EXTRACT_VISION_PROMPT, spend, { signal, json: true });
  const read = parseJsonLoose(raw);
  const list = Array.isArray(read?.questions) ? read.questions : [];
  if (!list.length) return [];
  const source = list
    .slice(0, 30)
    .map((q: any, i: number) => {
      const parts = [`[Question ${i + 1}]`, String(q?.stem ?? "")];
      if (Array.isArray(q?.choices) && q.choices.length) q.choices.forEach((c: unknown, j: number) => parts.push(`${String.fromCharCode(65 + j)}) ${String(c)}`));
      if (q?.figure) parts.push(`[Figure] ${String(q.figure)}`);
      if (q?.givenAnswer) parts.push(`[Given answer] ${String(q.givenAnswer)}`);
      return parts.join("\n");
    })
    .join("\n\n");
  return buildQuestionsFromText(source, ctx, spend, signal);
}

// ─── reading handwriting ────────────────────────────────────────────────────────────────

export const INK_READ_PROMPT = [
  "Transcribe the handwritten student work in this image exactly, line by line, as LaTeX.",
  "One output line per written line, each wrapped in $…$ (plain words stay plain text).",
  "Keep every mistake exactly as written — do NOT correct, complete, simplify or solve anything, and do not add lines.",
  "Output only the transcription, no preamble. If nothing is written, output exactly: (empty)",
].join("\n");

/**
 * Handwriting-read budget. HARD cap `deadlineMs` on the whole read (both models); the first
 * model gets at most `attemptMs`, the fallback whatever is left. Low reasoning effort: a
 * verbatim transcription needs none, and it roughly halves latency (measured 2026-10-05:
 * gpt-6.1-sol ~12 s default → ~5.5–9 s low on a 1022×440 page). Mutable for tests only.
 */
export const INK_READ = { deadlineMs: 30_000, attemptMs: 20_000, reasoning: { effort: "low" } as Record<string, unknown> };

export class ReadTimeoutError extends Error {
  code = "READ_TIMEOUT";
  constructor() {
    super("Reading the handwriting took too long — try again");
  }
}

export async function readInk(png: Buffer, mime: string, spend: Spend, signal?: AbortSignal): Promise<string> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  // The race is the hard cap even if a model call ignores the abort.
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
      reject(new ReadTimeoutError());
    }, INK_READ.deadlineMs);
  });
  cap.catch(() => {});
  try {
    const call = visionCall(png, mime, INK_READ_PROMPT, spend, {
      signal: ac.signal,
      timeoutMs: INK_READ.attemptMs,
      deadlineMs: INK_READ.deadlineMs,
      reasoning: INK_READ.reasoning,
    });
    call.catch(() => {});
    const raw = (await Promise.race([call, cap])).trim();
    return /^\(empty\)$/i.test(raw) ? "" : raw.slice(0, 8000);
  } catch (e: any) {
    if (!signal?.aborted && (timedOut || e?.timedOut === true)) throw new ReadTimeoutError();
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ─── grading ────────────────────────────────────────────────────────────────────────────

/**
 * One step of the student's work. `index` is 1-based and sequential, assigned server-side (never
 * the model's numbering). `text` = the step as prose; `latex` only when the step has math, else null.
 */
export interface VerdictStep {
  index: number;
  text: string;
  latex: string | null;
  ok: boolean;
  note: string;
}
export interface Verdict {
  result: AttemptResult;
  steps: VerdictStep[];
  firstErrorStep: number | null;
  hint: string | null;
  solution: string | null;
}

export const GRADE_SYSTEM_PROMPT = [
  "You grade a college student's work on ONE question against the reference answer and solution.",
  'Return ONE JSON object: {"result":"right|partial|wrong","steps":[{"text":"...","latex":"... or null","ok":true,"note":""}],"hint":"...","solution":"... or null"}',
  "Rules:",
  `- ${MATH_RULES}`,
  "- steps: the student's work split into its steps, in order (do not number them). text = that step exactly as the student wrote it, as readable prose with any math inline as $LaTeX$ (do not fix it). latex = the step's math as LaTeX, exactly as written, ONLY when the step contains math (an equation, expression, formula or quantity); null for a step that is plain words or code. ok = the step is valid and follows from the previous ones. note = one short sentence on what is wrong (\"\" when ok).",
  "- result: right = final answer correct (equivalent forms and sensible rounding accepted) with no real error; partial = sound approach but a slip, an unfinished answer, or a missing unit/sign; wrong = otherwise, or no real attempt.",
  "- The reference may be missing; then solve the question yourself first.",
  "- hint: one sentence that nudges toward the FIRST error without giving the answer away; \"\" when right.",
  "- solution: a full worked solution ONLY when the user turn says SOLUTION: yes; otherwise null.",
  "- For code: judge correctness of the program for the task (compile errors, logic, edge cases); steps = the problematic lines/sections.",
].join("\n");

export function buildGradeTurn(q: IStudyQuestion, work: string, wantSolution: boolean): string {
  const parts = [`QUESTION (${q.type}):\n${q.stem}`];
  if (q.choices?.length) parts.push(`CHOICES:\n${q.choices.map((c, i) => `${String.fromCharCode(65 + i)}) ${c}`).join("\n")}`);
  parts.push(q.answer ? `REFERENCE ANSWER:\n${q.answer}` : "REFERENCE ANSWER: (none)");
  if (q.solutionSteps?.length) parts.push(`REFERENCE SOLUTION:\n${q.solutionSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  parts.push(`STUDENT WORK:\n${work.slice(0, 20_000)}`);
  parts.push(`SOLUTION: ${wantSolution ? "yes" : "no"}`);
  return parts.join("\n\n");
}

/** The stored reference as a markdown solution (what `reveal` shows when one exists). */
export function composeSolution(q: Pick<IStudyQuestion, "answer" | "solutionSteps">): string | null {
  const steps = (q.solutionSteps ?? []).filter(Boolean);
  if (!q.answer && !steps.length) return null;
  const lines: string[] = [];
  if (steps.length) lines.push(...steps.map((s, i) => `${i + 1}. ${s}`), "");
  if (q.answer) lines.push(`**Answer:** ${q.answer}`);
  return lines.join("\n").trim();
}

const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");

/**
 * Does this string hold math? `$`, a LaTeX command, a relation / power / math symbol, or an
 * arithmetic operator between operands. Plain prose ("a pointer-to-const", "it's 2 steps") is not.
 */
export function hasMath(t: string): boolean {
  return (
    /\$|\\[a-zA-Z]+|[=^<>≤≥≠±√∫∑∏π∞]/.test(t) ||
    /\d\s*[-+*/×÷]\s*[\d(a-zA-Z]/.test(t) ||
    /(^|[^a-zA-Z])[a-zA-Z]\s*[-+*/]\s*([\d(]|[a-zA-Z](?![a-zA-Z]))/.test(t)
  );
}

/**
 * One model step → contract step, tolerating the old `{line, latex}` shape (prose in `latex`):
 * `text` falls back to `latex`; `latex` is kept only when it holds math. A step with neither is dropped.
 */
export function normalizeStep(st: any): Omit<VerdictStep, "index"> | null {
  const rawLatex = s(st?.latex, 2000);
  const text = s(st?.text, 2000) || rawLatex;
  if (!text && !rawLatex) return null;
  return { text, latex: rawLatex && hasMath(rawLatex) ? rawLatex : null, ok: st?.ok !== false, note: s(st?.note, 1000) };
}

/** Model reply → contract verdict. `index` and `firstErrorStep` are derived here, never trusted. */
export function settleVerdict(raw: any, opts: { reveal: boolean; fallbackSolution: string | null }): Verdict {
  const result: AttemptResult = raw?.result === "right" || raw?.result === "partial" ? raw.result : "wrong";
  const steps: VerdictStep[] = (Array.isArray(raw?.steps) ? raw.steps : [])
    .slice(0, 60)
    .map(normalizeStep)
    .filter((st: Omit<VerdictStep, "index"> | null): st is Omit<VerdictStep, "index"> => st !== null)
    .map((st: Omit<VerdictStep, "index">, i: number) => ({ index: i + 1, ...st }));
  const firstBad = steps.find((st) => !st.ok);
  const hint = result === "right" ? null : s(raw?.hint, 1000) || null;
  return {
    result,
    steps,
    firstErrorStep: result === "right" ? null : (firstBad?.index ?? null),
    hint,
    solution: opts.reveal ? opts.fallbackSolution ?? (s(raw?.solution, 20_000) || null) : null,
  };
}

export async function gradeWithModel(q: IStudyQuestion, work: string, reveal: boolean, spend: Spend, signal?: AbortSignal): Promise<Verdict> {
  const stored = composeSolution(q);
  const raw = await textJson(GRADE_SYSTEM_PROMPT, buildGradeTurn(q, work, reveal && !stored), spend, { signal });
  if (!raw) throw new Error("grader returned no JSON");
  return settleVerdict(raw, { reveal, fallbackSolution: stored });
}

// ─── deterministic graders ──────────────────────────────────────────────────────────────

const normChoice = (t: string) =>
  String(t ?? "")
    .toLowerCase()
    .replace(/\$|\\[a-z]+|[{}\s.,;:()*_`]/g, "")
    .trim();

/** Index of the stored correct choice: the answer text itself, a letter (B, "(b)", "b)") or a 1-based number. */
export function correctChoiceIndex(q: Pick<IStudyQuestion, "choices" | "answer">): number | null {
  const choices = q.choices ?? [];
  const a = String(q.answer ?? "").trim();
  if (!choices.length || !a) return null;
  const byText = choices.findIndex((c) => normChoice(c) === normChoice(a));
  if (byText >= 0) return byText;
  const letter = a.match(/^\(?([a-hA-H])\)?[.)]?(\s|$)/);
  if (letter) {
    const i = letter[1].toLowerCase().charCodeAt(0) - 97;
    if (i < choices.length) return i;
  }
  const num = a.match(/^\(?(\d{1,2})\)?[.)]?$/);
  if (num && Number(num[1]) >= 1 && Number(num[1]) <= choices.length) return Number(num[1]) - 1;
  return null;
}

/** Student's `choice`: a 0-based index (number), the choice text, or a letter. */
export function studentChoiceIndex(q: Pick<IStudyQuestion, "choices">, choice: unknown): number | null {
  const choices = q.choices ?? [];
  if (typeof choice === "number" && Number.isInteger(choice)) return choice >= 0 && choice < choices.length ? choice : null;
  if (typeof choice !== "string" || !choice.trim()) return null;
  const t = choice.trim();
  const byText = choices.findIndex((c) => normChoice(c) === normChoice(t));
  if (byText >= 0) return byText;
  if (/^[a-hA-H]$/.test(t)) {
    const i = t.toLowerCase().charCodeAt(0) - 97;
    return i < choices.length ? i : null;
  }
  return null;
}

export function gradeChoice(q: IStudyQuestion, choice: unknown, reveal: boolean): Verdict | null {
  const want = correctChoiceIndex(q);
  if (want === null) return null;
  const got = studentChoiceIndex(q, choice);
  const right = got === want;
  return {
    result: right ? "right" : "wrong",
    steps: [],
    firstErrorStep: null,
    hint: right ? null : q.solutionSteps?.[0] ? `Start here: ${q.solutionSteps[0]}` : null,
    solution: reveal ? composeSolution(q) : null,
  };
}

const stripFence = (t: string) => {
  const m = String(t ?? "").match(/```[^\n]*\n([\s\S]*?)```/);
  return m ? m[1] : String(t ?? "");
};
export const normOutput = (t: string) =>
  stripFence(t)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");

/** code_output: the predicted output vs the stored output, whitespace at line ends ignored. */
export function gradeCodeOutput(q: IStudyQuestion, predicted: string, reveal: boolean): Verdict {
  const right = normOutput(predicted) === normOutput(q.answer);
  const looseRight = !right && normOutput(predicted).replace(/\s+/g, "") === normOutput(q.answer).replace(/\s+/g, "");
  return {
    result: right ? "right" : looseRight ? "partial" : "wrong",
    steps: [],
    firstErrorStep: null,
    hint: right ? null : looseRight ? "The values are right but the spacing/line breaks differ." : "Trace the program line by line and track each variable.",
    solution: reveal ? composeSolution(q) : null,
  };
}

// ─── similar ────────────────────────────────────────────────────────────────────────────

export const SIMILAR_SYSTEM_PROMPT = [
  "You write fresh practice questions for a college student, modelled on one original question.",
  'Return ONE JSON object: {"questions":[{"type":"...","topic":"...","subtopic":"... or null","difficulty":1,"stem":"...","choices":["..."],"answer":"...","solutionSteps":["..."],"tags":["..."]}]}',
  "Rules:",
  `- ${MATH_RULES}`,
  "- Exactly the requested number of questions. Same type, topic, skill and difficulty as the original; NEW numbers/values (and a different context where natural). Never copy the original.",
  "- Each question must be self-contained and solvable; solve it yourself and make sure answer and solutionSteps are correct.",
  "- mcq: 4 choices without letters, exactly one correct; answer = the exact text of the correct choice. code_output: answer = the exact program output.",
  ...STRUCTURED_TYPE_RULES,
  "- If the user turn gives a TYPE, write the new questions as that type (same topic and level as the original) instead of the original's type.",
  "- solutionSteps: one step per entry, a single line with LaTeX.",
].join("\n");

export async function generateSimilar(q: IStudyQuestion, count: number, spend: Spend, signal?: AbortSignal, targetType?: string): Promise<any[]> {
  const orig = {
    type: q.type,
    topic: q.topic,
    subtopic: q.subtopic,
    difficulty: q.difficulty,
    stem: q.stem,
    choices: q.choices,
    ...(q.pairs?.length ? { pairs: q.pairs.map((p) => ({ left: p.left, right: p.right })) } : {}),
    answer: q.answer,
    solutionSteps: q.solutionSteps,
  };
  const typeLine = targetType && targetType !== q.type ? `TYPE: ${targetType}\n` : "";
  const out = await textJson(SIMILAR_SYSTEM_PROMPT, `${typeLine}COUNT: ${count}\n\nORIGINAL:\n${JSON.stringify(orig, null, 2)}`, spend, { signal });
  return Array.isArray(out?.questions) ? out.questions.slice(0, count) : [];
}

// ─── transcripts: summary + key points (P3) ─────────────────────────────────────────────

export const SUMMARY_SYSTEM_PROMPT = [
  "You summarise the transcript of a college lecture or course video for the student who will study from it.",
  'Return ONE JSON object: {"summary":"...","keyPoints":["..."]}',
  "Rules:",
  `- ${MATH_RULES}`,
  "- summary: 1–3 short paragraphs of markdown: what the lesson covers and how the ideas connect.",
  "- keyPoints: 4–10 entries, each one line: a definition, formula, theorem, procedure, worked-example takeaway or exam-relevant fact.",
  "- Only what the transcript actually says (fix obvious speech-recognition slips in math terms). No filler, no \"the instructor says\".",
].join("\n");

export const SUMMARY_REDUCE_PROMPT = [
  "You merge partial summaries of CONSECUTIVE parts of one college lecture/video into one study summary.",
  'Return ONE JSON object: {"summary":"...","keyPoints":["..."]}',
  "Rules:",
  `- ${MATH_RULES}`,
  "- summary: 1–3 short paragraphs covering the whole lesson in order.",
  "- keyPoints: 6–12 entries, one line each, duplicates merged, most important first.",
].join("\n");

const cleanSummary = (raw: any) => ({
  summary: typeof raw?.summary === "string" && raw.summary.trim() ? raw.summary.trim().slice(0, 8000) : null,
  keyPoints: (Array.isArray(raw?.keyPoints) ? raw.keyPoints : [])
    .map((k: unknown) => (typeof k === "string" ? k.trim().slice(0, 600) : ""))
    .filter(Boolean)
    .slice(0, 15) as string[],
});

export const SUMMARY_CHUNK_CHARS = 24_000;
const SUMMARY_MAX_CHUNKS = 12;

/** Split on whitespace into pieces of at most `max` chars. */
export function splitText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.6) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.6) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Map-reduce: one call for a short transcript; per-part summaries + one merge call for a long one. */
export async function summariseTranscript(text: string, spend: Spend, signal?: AbortSignal): Promise<{ summary: string | null; keyPoints: string[] }> {
  const parts = splitText(text, SUMMARY_CHUNK_CHARS).slice(0, SUMMARY_MAX_CHUNKS);
  if (!parts.length) return { summary: null, keyPoints: [] };
  if (parts.length === 1) return cleanSummary(await textJson(SUMMARY_SYSTEM_PROMPT, `TRANSCRIPT:\n${parts[0]}`, spend, { signal }));
  const partials = [];
  for (let i = 0; i < parts.length; i++) {
    partials.push(cleanSummary(await textJson(SUMMARY_SYSTEM_PROMPT, `PART ${i + 1} OF ${parts.length}\n\nTRANSCRIPT:\n${parts[i]}`, spend, { signal })));
  }
  const merged = partials.map((p, i) => `PART ${i + 1}\nSummary: ${p.summary ?? ""}\nKey points:\n${p.keyPoints.map((k) => `- ${k}`).join("\n")}`).join("\n\n");
  return cleanSummary(await textJson(SUMMARY_REDUCE_PROMPT, merged, spend, { signal }));
}

// ─── flashcards (P3) ────────────────────────────────────────────────────────────────────

export const FLASHCARDS_SYSTEM_PROMPT = [
  "You write flashcards for a college student from one piece of course material (a lecture/video transcript, a page, or notes).",
  'Return ONE JSON object: {"questions":[{"type":"free","topic":"...","subtopic":"... or null","difficulty":1,"stem":"...","answer":"...","solutionSteps":[],"tags":["..."]}]}',
  "Rules:",
  `- ${MATH_RULES}`,
  "- Exactly the requested number of cards (fewer only if the material is too thin). Each covers ONE idea from the material: a definition, formula, theorem condition, procedure step, or a short concept check.",
  "- stem: a short self-contained question (front of the card). answer: the short answer (back of the card), 1–3 lines.",
  "- type is always free. solutionSteps: [] unless a 2–4 step derivation helps.",
  "- topic: a short course-level topic name; reuse one of the EXISTING TOPICS listed in the user turn when it fits. difficulty 1–3. tags: 1–3 short lowercase keywords.",
  "- Only facts the material states or directly implies. No trivia about the instructor or logistics.",
].join("\n");

export async function generateFlashcards(source: string, count: number, ctx: BuildContext, spend: Spend, signal?: AbortSignal): Promise<any[]> {
  const out = await textJson(FLASHCARDS_SYSTEM_PROMPT, `${contextLines(ctx)}\nCOUNT: ${count}\n\nMATERIAL:\n${source.slice(0, 60_000)}`, spend, { signal, maxTokens: 12_000 });
  return Array.isArray(out?.questions) ? out.questions.slice(0, count) : [];
}

// ─── class guide (P-CM) ─────────────────────────────────────────────────────────────────

/**
 * Every AI call of a class gets that class's guide as system context: wrap the call site in
 * `withClassGuide(userId, classId, fn)` (implementation: ./class-guide, applied in `textJson`).
 */
export { withClassGuide, guidedSystem, runWithGuide } from "./class-guide";
