import type { IStudyQuestion } from "@/models/study/question";
import { toPng } from "./extract-sources";
import type { Spend } from "./ai-models";
import { gradeFillBlank, gradeMatching, validBlanks, validMatches } from "./structured-questions";
import { correctChoiceIndex, gradeChoice, gradeCodeOutput, gradeWithModel, readInk, studentChoiceIndex, Verdict } from "./ai";

/**
 * The grading step of one question attempt, shared by `POST /study/questions/:id/attempt` and
 * the mock-exam submit: pick a grader from what the student sent (deterministic MCQ / code
 * output, else the model over typed work or a handwriting read), run it, and return the verdict.
 * Stats / mastery / FSRS bookkeeping is `recordAttempt` (./questions) — callers pair the two.
 */

/** Handwriting is downscaled to this long side before the read (fewer image tokens, faster). */
const INK_MAX_PX = 1600;

export class AttemptInputError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export type AttemptPlan = { kind: "verdict"; verdict: Verdict } | { kind: "model"; work: string } | { kind: "ink"; png: Buffer };

export interface AttemptInput {
  typed?: unknown;
  choice?: unknown;
  code?: unknown;
  ink?: Buffer | null;
  /** matching: `{left: chosenRight}`. */
  matches?: unknown;
  /** fill_blank: one string per blank, in stem order. */
  blanks?: unknown;
  reveal?: boolean;
  /** Flashcards: the student grades himself (1 Again, 2 Hard, 3 Good, 4 Easy) — no grader runs. */
  selfRating?: unknown;
}

/** A valid flashcard self-grade, else null. */
export function selfRatingOf(v: unknown): 1 | 2 | 3 | 4 | null {
  return v === 1 || v === 2 || v === 3 || v === 4 ? v : null;
}

/** Throws AttemptInputError (400 / 409) when the input cannot be graded. */
export function planAttempt(q: IStudyQuestion, input: AttemptInput): AttemptPlan {
  const { typed, choice, code, ink } = input;
  const reveal = input.reveal === true;
  const self = selfRatingOf(input.selfRating);
  if (self !== null) {
    const result = self === 1 ? "wrong" : self === 2 ? "partial" : "right";
    return { kind: "verdict", verdict: { result, steps: [], firstErrorStep: null, hint: null, solution: reveal ? q.answer ?? null : null } };
  }
  // matching / fill_blank are graded deterministically only — never by a model.
  if (q.type === "matching") {
    if (!validMatches(input.matches)) throw new AttemptInputError(400, "VALIDATION_ERROR", "matching needs matches: an object {left: right}");
    return { kind: "verdict", verdict: gradeMatching(q, input.matches, reveal) };
  }
  if (q.type === "fill_blank") {
    if (!validBlanks(input.blanks)) throw new AttemptInputError(400, "VALIDATION_ERROR", "fill_blank needs blanks: an array of strings, one per blank");
    return { kind: "verdict", verdict: gradeFillBlank(q, input.blanks, reveal) };
  }
  if (choice !== undefined && choice !== null && q.type === "mcq") {
    if (correctChoiceIndex(q) === null) throw new AttemptInputError(409, "ANSWER_NOT_A_CHOICE", "This question's stored answer does not match any of its choices — edit the question first");
    if (studentChoiceIndex(q, choice) === null) throw new AttemptInputError(400, "VALIDATION_ERROR", "choice must be a choice index, letter or text");
    return { kind: "verdict", verdict: gradeChoice(q, choice, reveal)! };
  }
  const codeOrTyped = code ?? typed;
  if (q.type === "code_output" && typeof codeOrTyped === "string" && codeOrTyped.trim()) {
    return { kind: "verdict", verdict: gradeCodeOutput(q, codeOrTyped, reveal) };
  }
  if (typeof code === "string" && code.trim()) return { kind: "model", work: `\`\`\`\n${code}\n\`\`\`` };
  if (typeof typed === "string" && typed.trim()) return { kind: "model", work: typed };
  if (ink) return { kind: "ink", png: ink };
  throw new AttemptInputError(400, "VALIDATION_ERROR", "Send one of inkPngB64, typed, choice or code");
}

/** Runs the plan. `nothingRead` = the handwriting image held no text (no verdict). */
export async function runPlan(
  q: IStudyQuestion,
  plan: AttemptPlan,
  reveal: boolean,
  spend: Spend,
  signal?: AbortSignal,
  onReading?: (text: string) => void
): Promise<{ verdict: Verdict } | { nothingRead: true } | { aborted: true }> {
  if (plan.kind === "verdict") return { verdict: plan.verdict };
  let work: string;
  if (plan.kind === "ink") {
    work = await readInk(await toPng(plan.png, INK_MAX_PX), "image/png", spend, signal);
    if (signal?.aborted) return { aborted: true };
    if (!work.trim()) return { nothingRead: true };
    onReading?.(work);
  } else work = plan.work;
  const verdict = await gradeWithModel(q, work, reveal, spend, signal);
  if (signal?.aborted) return { aborted: true };
  return { verdict };
}
