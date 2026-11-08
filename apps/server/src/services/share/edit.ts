/**
 * Sharing, phase 2 part A: people the owner made "editor" change the ORIGINAL through the normal study
 * write routes. Each lookup here finds the row by id alone; the owner takes the old path unchanged,
 * anyone else needs `canAccess(..., 'write')` on that one resource, and the write then runs with the
 * owner's id, limited to that row. Strangers and viewers get the same 404 as a missing row.
 *
 * What an editor may change (the controllers enforce it):
 *   notebook    the page content (new versions, OCR text). Never rename / move / delete, renders, rulers.
 *   questions   stem, answer, choices, pairs, steps, subtopic, difficulty, type; add; delete. Never
 *   + cards     progress (stats, schedule), class, topic, the flashcard tag, image, source.
 *   conceptMap  promptTerms only. Never score, submission, notes pages or grade fields.
 */
import { Request } from "express";
import { Types } from "mongoose";
import { IEditedBy, Share } from "@/models/share";
import { StudyPage, IStudyPage } from "@/models/study/page";
import { StudyQuestion, IStudyQuestion } from "@/models/study/question";
import { StudyConceptMap, IStudyConceptMap } from "@/models/study/concept-map";
import { canAccess, loadCaller, NamedCaller } from "@/services/share/access";
import { FLASHCARD_TAG_RE } from "@/services/share/resources";

/** A row the caller may work on; `editor` is set when the caller is not the owner (an editor). */
export interface Scoped<T> {
  doc: T;
  editor: NamedCaller | null;
}

const callerId = (req: Request) => String(req.adminId);
const isOwner = (req: Request, ownerId: Types.ObjectId | null | undefined) => Boolean(ownerId) && String(ownerId) === callerId(req);

export const editedByOf = (c: Pick<NamedCaller, "userId" | "name">): IEditedBy => ({ userId: c.userId, name: c.name, at: new Date() });

/** "Edited by Maya" for a DTO: only when someone other than the owner made the last change. */
export const editedByDto = (e: IEditedBy | null | undefined, ownerId: Types.ObjectId | null | undefined) =>
  e && e.userId && String(e.userId) !== String(ownerId) ? { name: e.name || "Someone", at: e.at ? new Date(e.at).toISOString() : null } : null;

export const isCard = (tags: readonly string[] | null | undefined) => (tags ?? []).some((t) => FLASHCARD_TAG_RE.test(t));

// ─── notebook ───────────────────────────────────────────────────────────────────────────

/** The page by id: the owner, or an editor of it. Viewers keep the read-only share view. */
export async function scopedPage(req: Request, id: string, projection?: Record<string, 0 | 1>): Promise<Scoped<IStudyPage> | null> {
  return pageFor(req.adminId, id, projection);
}

/** `scopedPage` by account id (the live stream re-checks with it after the request is long gone). */
export async function pageFor(adminId: unknown, id: string, projection?: Record<string, 0 | 1>): Promise<Scoped<IStudyPage> | null> {
  // The owner id decides everything below: an inclusion projection always carries it (without it every
  // editor looked like a stranger, and the live stream's re-check ended their session).
  const proj = projection && Object.values(projection).includes(1) ? { ...projection, userId: 1 as const } : projection;
  const page = await StudyPage.findOne({ _id: id, deletedAt: null }, proj).lean<IStudyPage>();
  if (!page) return null;
  if (Boolean(page.userId) && String(page.userId) === String(adminId)) return { doc: page, editor: null };
  const caller = await loadCaller(adminId);
  if (!caller) return null;
  const ok = await canAccess(caller, { resourceType: "notebook", resourceId: page._id, topic: null, ownerId: page.userId }, "write");
  return ok ? { doc: page, editor: caller } : null;
}

/** Whether anyone besides the owner may edit this page (it is then a live page: pushes + the stream). */
export async function pageHasEditors(page: Pick<IStudyPage, "_id" | "userId">): Promise<boolean> {
  return Boolean(await Share.exists({ ownerId: page.userId, resourceType: "notebook", resourceId: page._id, "grants.role": "editor" }));
}

// ─── questions + cards ──────────────────────────────────────────────────────────────────

/** Whether a deck / question-set share of the owner's class covers a question with this topic and kind. */
export async function questionWritable(caller: NamedCaller, ownerId: Types.ObjectId, classId: Types.ObjectId, topic: string | null, card: boolean): Promise<boolean> {
  const base = { resourceType: card ? ("deck" as const) : ("questions" as const), resourceId: classId, ownerId };
  if (topic && (await canAccess(caller, { ...base, topic }, "write"))) return true;
  return canAccess(caller, { ...base, topic: null }, "write");
}

export async function scopedQuestion(req: Request, id: string, projection?: Record<string, 0 | 1>): Promise<Scoped<IStudyQuestion> | null> {
  const q = await StudyQuestion.findOne({ _id: id }, projection).lean<IStudyQuestion>();
  if (!q) return null;
  if (isOwner(req, q.userId)) return { doc: q, editor: null };
  const caller = await loadCaller(req.adminId);
  if (!caller) return null;
  return (await questionWritable(caller, q.userId, q.classId, q.topic, isCard(q.tags))) ? { doc: q, editor: caller } : null;
}

// ─── concept maps ───────────────────────────────────────────────────────────────────────

export async function scopedMap(req: Request, id: string): Promise<Scoped<IStudyConceptMap> | null> {
  const m = await StudyConceptMap.findOne({ _id: id }).lean<IStudyConceptMap>();
  if (!m || !m.userId) return null;
  if (isOwner(req, m.userId)) return { doc: m, editor: null };
  const caller = await loadCaller(req.adminId);
  if (!caller) return null;
  const ok = await canAccess(caller, { resourceType: "conceptMap", resourceId: m._id, topic: null, ownerId: m.userId }, "write");
  return ok ? { doc: m, editor: caller } : null;
}
