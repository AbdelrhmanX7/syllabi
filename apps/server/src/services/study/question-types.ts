// Per-class «question types» (owner setting, PATCH /classes/:id {questionTypes}): which kinds of
// questions the class should have. Every generator and every practice pool honours it — a type the
// class does not use is never made, converted on save, and kept out of drills, mock exams and quizzes.
import type { Types } from "mongoose";
import type { QuestionDraft } from "./questions";

import { StudyClass } from "../../models/study/class";
import { STUDY_QUESTION_TYPES, type StudyQuestionType } from "../../models/study/question";

/** null = every type (the default). */
export type AllowedTypes = ReadonlySet<StudyQuestionType> | null;

export function parseQuestionTypes(raw: unknown): { value: StudyQuestionType[] | null } | { error: string } {
  if (raw === null) return { value: null };
  if (!Array.isArray(raw)) return { error: "questionTypes must be an array of question types or null" };
  const out: StudyQuestionType[] = [];
  for (const t of raw) {
    if (!(STUDY_QUESTION_TYPES as readonly string[]).includes(t)) return { error: `questionTypes: unknown type ${String(t)}` };
    if (!out.includes(t)) out.push(t);
  }
  if (!out.length) return { error: "questionTypes needs at least one type (null = all)" };
  return { value: out.length === STUDY_QUESTION_TYPES.length ? null : out };
}

export const allowedOf = (cls: { questionTypes?: StudyQuestionType[] | null } | null | undefined): AllowedTypes =>
  cls?.questionTypes?.length ? new Set(cls.questionTypes) : null;

export async function allowedForClass(userId: Types.ObjectId, classId: Types.ObjectId | string | null): Promise<AllowedTypes> {
  if (!classId) return null;
  const cls = await StudyClass.findOne({ _id: classId, userId }, { questionTypes: 1 }).lean<{ questionTypes?: StudyQuestionType[] | null }>();
  return allowedOf(cls);
}

export const isAllowed = (allowed: AllowedTypes, type: string) => !allowed || allowed.has(type as StudyQuestionType);

/** The type a generator should write instead of `type` (written questions when the type is off). */
export const typeFor = (allowed: AllowedTypes, type: StudyQuestionType): StudyQuestionType =>
  isAllowed(allowed, type) ? type : allowed!.has("free") ? "free" : [...allowed!][0];

/**
 * Mongo filter fragment that keeps out the question types each class has switched off.
 * `{}` when no class restricts anything (the common case).
 */
export async function typeExclusion(userId: Types.ObjectId, classId?: Types.ObjectId | string | null): Promise<Record<string, unknown>> {
  const rows = await StudyClass.find(
    { userId, ...(classId ? { _id: classId } : {}), "questionTypes.0": { $exists: true } },
    { questionTypes: 1 }
  ).lean<{ _id: Types.ObjectId; questionTypes: StudyQuestionType[] }[]>();
  const nor = rows.map((c) => ({ classId: c._id, type: { $nin: c.questionTypes } }));
  return nor.length ? { $nor: nor } : {};
}

/**
 * A draft of a type the class does not use becomes a written (free) question with the same content:
 * choices / match pairs / blanks fold into the stem and answer, so nothing is lost.
 */
export function fitDraftToTypes(draft: QuestionDraft, allowed: AllowedTypes): QuestionDraft {
  if (isAllowed(allowed, draft.type)) return draft;
  let stem = draft.stem;
  let answer = draft.answer;
  if (draft.type === "matching" && draft.pairs?.length) {
    stem = `${stem}\n\n${draft.pairs.map((p) => `- ${p.left}`).join("\n")}`;
    answer = draft.pairs.map((p) => `${p.left} → ${p.right}`).join("\n");
  } else if (draft.type === "fill_blank") {
    try {
      const blanks = JSON.parse(answer);
      if (Array.isArray(blanks)) answer = blanks.map((b: unknown) => String(b).split("|")[0]).join(", ");
    } catch {
      // already plain text
    }
  }
  return { ...draft, type: "free", stem, answer, choices: [], pairs: [] };
}
