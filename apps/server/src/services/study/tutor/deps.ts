import { Types } from "mongoose";
import { loadClassGuide } from "../class-guide";
import { retrieveLibrary } from "../library";
import { StudyConceptMap, IStudyConceptMap } from "@/models/study/concept-map";
import { bestWindow, overlap } from "./text";

/**
 * The tutor's view of the P-CM data (#575): the class guide, the library and concept maps.
 * Thin wrappers over the real services so the tutor's retrieval keeps one snippet shape:
 *   loadGuide          → loadClassGuide (services/study/class-guide.ts)
 *   searchLibrary      → retrieveLibrary (services/study/library.ts), re-scored by distinct-term
 *                        overlap so its hits rank on the same scale as the tutor's other sources
 *   searchConceptMaps  → StudyConceptMap (models/study/concept-map.ts)
 * Every read degrades to null / [] on failure: the tutor still answers from items, transcripts,
 * pages and questions.
 *
 * The guide reaches the model ONCE per call: `runAsk` runs inside `runWithGuide(guide, …)`, so
 * every `textJson` call (quiz grading / generation, bank grading via attempt-grading, the
 * summary) gets it from `guidedSystem`; only the `textStream` calls (explain answer, quiz
 * feedback), which P-CM does not guide, add it themselves via `guidedSystem(system, guide)`.
 */

export interface ClassRef {
  _id: Types.ObjectId;
  canvasCourseId: number;
}

export interface LibrarySnippet {
  /** `library` = a library doc chunk; `concept_map` = a concept map's prompt/model answer. */
  origin: "library" | "concept_map";
  id: string;
  title: string;
  text: string;
  week: number | null;
  score: number;
}

/** The class guide markdown (system context for every class AI call), or null. */
export async function loadGuide(userId: Types.ObjectId, cls: ClassRef | null): Promise<string | null> {
  if (!cls) return null;
  return loadClassGuide(userId, cls._id).catch(() => null);
}

/** Library chunks of this class matching the terms, best first. */
export async function searchLibrary(userId: Types.ObjectId, cls: ClassRef | null, terms: string[], limit = 6, windowChars = 900): Promise<LibrarySnippet[]> {
  if (!cls || !terms.length) return [];
  try {
    const hits = await retrieveLibrary({ userId, canvasCourseId: cls.canvasCourseId, query: terms.join(" "), limit: limit * 2, maxChars: 20_000 });
    return hits
      .map((h) => ({
        origin: "library" as const,
        id: h.docId,
        title: h.page ? `${h.title || "Library"} (p. ${h.page})` : h.title || "Library",
        text: bestWindow(h.text, terms, windowChars),
        week: h.week ?? null,
        score: overlap(h.text, terms) + 2 * overlap(h.title, terms),
      }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** Concept maps of this class whose terms / lecture / model answer match. */
export async function searchConceptMaps(userId: Types.ObjectId, cls: ClassRef | null, terms: string[], limit = 3, windowChars = 700): Promise<LibrarySnippet[]> {
  if (!cls || !terms.length) return [];
  try {
    const rows = await StudyConceptMap.find({ userId, canvasCourseId: cls.canvasCourseId }, { number: 1, week: 1, lecture: 1, promptTerms: 1, instructor: 1 })
      .limit(100)
      .lean<IStudyConceptMap[]>();
    return rows
      .map((m) => {
        const termsText = (m.promptTerms ?? []).join(", ");
        const body = [m.lecture ? `Lecture: ${m.lecture}` : "", termsText ? `Terms: ${termsText}` : "", m.instructor?.modelAnswer ? `Model answer: ${m.instructor.modelAnswer}` : "", m.instructor?.comment ? `Instructor: ${m.instructor.comment}` : ""]
          .filter(Boolean)
          .join("\n");
        const title = `Concept map${m.number ? ` ${m.number}` : ""}${m.lecture ? ` — ${m.lecture}` : ""}`;
        return { origin: "concept_map" as const, id: String(m._id), title, text: bestWindow(body, terms, windowChars), week: m.week ?? null, score: overlap(body, terms) + overlap(title, terms) };
      })
      .filter((s) => s.score > 0 && s.text)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch {
    return [];
  }
}
