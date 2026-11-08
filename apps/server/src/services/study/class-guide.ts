import { AsyncLocalStorage } from "async_hooks";
import { Types } from "mongoose";
import { StudyClass, IStudyClass } from "@/models/study/class";
import { StudyClassGuide, IStudyClassGuide } from "@/models/study/library";

/**
 * Per-class guide as system context for EVERY study AI call of that class, implemented once:
 * a call site wraps its work in `withClassGuide(userId, classId, fn)`, and `textJson`
 * (./ai-models) appends the guide of the surrounding context to its system prompt via
 * `guidedSystem`. AsyncLocalStorage carries it through every await, so prompt builders and
 * services deep in the call need no new parameter. No guide (or no class) → prompts unchanged.
 */
export const GUIDE_MAX_CHARS = 8000;

const als = new AsyncLocalStorage<{ guide: string | null }>();

export async function loadClassGuide(userId: Types.ObjectId, classId: Types.ObjectId | string | null | undefined): Promise<string | null> {
  if (!classId) return null;
  const cls = await StudyClass.findOne({ _id: classId, userId }, { canvasCourseId: 1 }).lean<IStudyClass>();
  if (!cls) return null;
  const g = await StudyClassGuide.findOne({ userId, canvasCourseId: cls.canvasCourseId }, { markdown: 1 }).sort({ updatedAt: -1 }).lean<IStudyClassGuide>();
  const md = g?.markdown?.trim();
  return md ? md.slice(0, GUIDE_MAX_CHARS) : null;
}

/** Run `fn` with this class's guide as the system context of every text model call inside it. */
export async function withClassGuide<T>(userId: Types.ObjectId, classId: Types.ObjectId | string | null | undefined, fn: () => Promise<T>): Promise<T> {
  const guide = await loadClassGuide(userId, classId).catch(() => null);
  return als.run({ guide }, fn);
}

/** Same, with an already-loaded guide (tests; callers that loaded it themselves). */
export const runWithGuide = <T>(guide: string | null, fn: () => Promise<T>): Promise<T> => als.run({ guide }, fn);

export const currentGuide = (): string | null => als.getStore()?.guide ?? null;

/** The system prompt with the surrounding class guide appended (unchanged when there is none). */
export function guidedSystem(system: string, guide: string | null = currentGuide()): string {
  if (!guide) return system;
  return [
    system,
    "",
    "CLASS GUIDE (from the student; follow it — when the professor's wording differs from the textbook, use the professor's):",
    guide,
  ].join("\n");
}
