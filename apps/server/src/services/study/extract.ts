import { Types } from "mongoose";
import { StudyQuestion, IStudyQuestion } from "@/models/study/question";
import { QuestionDraft, saveQuestion, toDraft } from "./questions";
import { buildQuestionsFromText, generateFlashcards, splitText } from "./ai";
import { Spend } from "./ai-models";

/**
 * The extract pipeline's save step, shared by `POST /study/questions/extract`, the lecture job
 * and `/study/ai/flashcards`: model entries → `toDraft` (a malformed entry is skipped, never
 * fatal) → `saveQuestion` (near-duplicates merge) → `onSaved` once per distinct saved question.
 */
export async function saveModelQuestions(
  userId: Types.ObjectId,
  classId: Types.ObjectId,
  raws: any[],
  source: QuestionDraft["source"],
  emitted: Set<string>,
  onSaved: (doc: IStudyQuestion) => void,
  opts: { signal?: AbortSignal; forceType?: QuestionDraft["type"]; tags?: string[] } = {}
): Promise<void> {
  for (const raw of raws) {
    if (opts.signal?.aborted) return;
    let draft: QuestionDraft;
    try {
      const { classId: _c, source: _s, ...rest } = raw ?? {};
      draft = toDraft(opts.forceType ? { ...rest, type: opts.forceType, choices: [] } : rest, { classId, source });
      draft.source = source;
      if (opts.tags?.length) draft.tags = [...new Set([...draft.tags, ...opts.tags])];
    } catch {
      continue;
    }
    const { doc } = await saveQuestion(userId, draft);
    if (emitted.has(String(doc._id))) continue;
    emitted.add(String(doc._id));
    onSaved(doc);
  }
}

export const existingTopics = async (userId: Types.ObjectId, classId: Types.ObjectId): Promise<string[]> =>
  (await StudyQuestion.distinct("topic", { userId, classId })).slice(0, 60);

export const TRANSCRIPT_EXTRACT_CHUNK = 35_000;
const TRANSCRIPT_EXTRACT_MAX_PARTS = 4;
const TRANSCRIPT_HEADER =
  "[SOURCE TYPE: transcript of a spoken lecture/video. Problems and examples the instructor states or works through count as exercises — the stated problem is the stem, the instructor's spoken solution is the given answer. Ignore logistics and small talk.]";

/** Questions from a transcript: up to 4 parts of 35k chars, each through the text extract step. */
export async function extractFromTranscript(
  userId: Types.ObjectId,
  cls: { _id: Types.ObjectId; name?: string | null },
  text: string,
  source: QuestionDraft["source"],
  spend: Spend,
  onSaved: (doc: IStudyQuestion) => void,
  signal?: AbortSignal
): Promise<number> {
  const emitted = new Set<string>();
  const ctx = { className: cls.name ?? null, existingTopics: await existingTopics(userId, cls._id) };
  for (const part of splitText(text, TRANSCRIPT_EXTRACT_CHUNK).slice(0, TRANSCRIPT_EXTRACT_MAX_PARTS)) {
    if (signal?.aborted) break;
    const raws = await buildQuestionsFromText(`${TRANSCRIPT_HEADER}\n\n${part}`, ctx, spend, signal);
    await saveModelQuestions(userId, cls._id, raws, source, emitted, onSaved, { signal });
  }
  return emitted.size;
}

/** Flashcards (type 'free') from any text source. */
export async function flashcardsFromText(
  userId: Types.ObjectId,
  cls: { _id: Types.ObjectId; name?: string | null },
  text: string,
  count: number,
  source: QuestionDraft["source"],
  spend: Spend,
  onSaved: (doc: IStudyQuestion) => void,
  signal?: AbortSignal
): Promise<number> {
  const emitted = new Set<string>();
  const ctx = { className: cls.name ?? null, existingTopics: await existingTopics(userId, cls._id) };
  const raws = await generateFlashcards(text, count, ctx, spend, signal);
  await saveModelQuestions(userId, cls._id, raws, source, emitted, onSaved, { signal, forceType: "free", tags: ["flashcard"] });
  return emitted.size;
}
