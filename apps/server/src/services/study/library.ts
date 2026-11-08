import path from "path";
import { Types } from "mongoose";
import {
  IStudyLibraryChunk,
  IStudyLibraryDoc,
  StudyClassGuide,
  StudyExamResult,
  StudyLabSpecimen,
  StudyLibraryChunk,
  StudyLibraryDoc,
  IStudyExamResult,
} from "@/models/study/library";
import { StudyConceptMap } from "@/models/study/concept-map";
import { StudyClass } from "@/models/study/class";
import type { QuestionDraft } from "./questions";
import type { TextSource } from "./text-sources";
import { signedGetUrl } from "./storage";

/**
 * Class library reads (P-CM): pending → attach, DTOs, markdown image-ref rewriting, keyword
 * retrieval (the "RAG" for extract / flashcards / concept maps — no vector index) and the
 * `{libraryId}` text source.
 */

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Every collection the import writes pending rows into. */
const PENDING_MODELS = [StudyLibraryDoc, StudyLibraryChunk, StudyClassGuide, StudyLabSpecimen, StudyExamResult, StudyConceptMap] as const;

/**
 * Attach every pending import row of `canvasUserId` to `userId`. Idempotent (only `userId: null`
 * rows move) and scoped: rows imported for another Canvas user are never touched.
 */
export async function attachPendingImports(userId: Types.ObjectId, canvasUserId: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!Number.isFinite(canvasUserId)) return out;
  for (const M of PENDING_MODELS) {
    const r = await (M as any).updateMany({ canvasUserId, userId: null }, { $set: { userId } });
    out[(M as any).collection.collectionName] = r.modifiedCount ?? 0;
  }
  return out;
}

export const libraryListDto = (d: IStudyLibraryDoc) => ({
  id: String(d._id),
  title: d.title,
  kind: d.kind,
  week: d.week ?? null,
  path: d.relPath,
  updatedAt: iso(d.updatedAt),
});

const MD_REF = /(!?\[[^\]]*\])\((<[^>]+>|[^)\s]+)(\s+"[^"]*")?\)/g;

/**
 * Markdown links/images whose target is a relative path to an imported file → `resolve(relPath)`.
 * Absolute urls, anchors and unknown paths are left as written.
 */
export function rewriteMarkdownRefs(markdown: string, docRelPath: string, resolve: (relPath: string) => string | null): string {
  const dir = path.posix.dirname(docRelPath);
  return markdown.replace(MD_REF, (all, text: string, target: string, title = "") => {
    const t = target.replace(/^<|>$/g, "");
    if (/^([a-z]+:|#|\/)/i.test(t)) return all;
    let rel: string;
    try {
      rel = path.posix.normalize(path.posix.join(dir, decodeURI(t)));
    } catch {
      rel = path.posix.normalize(path.posix.join(dir, t));
    }
    const url = resolve(rel);
    return url ? `${text}(<${url}>${title})` : all;
  });
}

/** Relative refs a note points at (images and file links), normalised to course-relative paths. */
export function markdownRefs(markdown: string, docRelPath: string): string[] {
  const out = new Set<string>();
  rewriteMarkdownRefs(markdown, docRelPath, (rel) => {
    out.add(rel);
    return null;
  });
  return [...out];
}

export async function libraryDetailDto(d: IStudyLibraryDoc) {
  const base: Record<string, unknown> = { ...libraryListDto(d), pages: d.pages ?? null, fileStored: !!d.file?.storageKey };
  if (d.file?.storageKey) {
    const s = await signedGetUrl(d.file.storageKey, { contentType: d.file.mime });
    base.url = s.url;
    base.urlExpiresAt = s.expiresAt;
    base.mime = d.file.mime;
    base.size = d.file.size;
  }
  if (d.kind === "note" && d.markdown != null) {
    const refs = markdownRefs(d.markdown, d.relPath);
    const linked = refs.length
      ? await StudyLibraryDoc.find({ canvasUserId: d.canvasUserId, canvasCourseId: d.canvasCourseId, relPath: { $in: refs }, file: { $ne: null } }, { relPath: 1, file: 1 }).lean<IStudyLibraryDoc[]>()
      : [];
    const urls = new Map<string, string>();
    for (const l of linked) urls.set(l.relPath, (await signedGetUrl(l.file!.storageKey, { contentType: l.file!.mime })).url);
    base.markdown = rewriteMarkdownRefs(d.markdown, d.relPath, (rel) => urls.get(rel) ?? null);
    base.assets = Object.fromEntries(urls);
  }
  return base;
}

// ─── retrieval ──────────────────────────────────────────────────────────────────────────

const STOP = new Set("the a an and or of to in on for with by is are was were be as at from that this it its into than then their there which what how why".split(" "));
export const keywords = (q: string) => [...new Set(q.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 20);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface LibraryHit {
  docId: string;
  title: string;
  kind: string;
  week: number | null;
  page: number;
  score: number;
  text: string;
}

/**
 * Keyword retrieval over a class's library chunks: regex prefilter on the query terms, then
 * term-frequency scoring (+ a bonus for the requested week). `week` alone (no query) returns
 * that week's chunks in order.
 */
export async function retrieveLibrary(o: { userId: Types.ObjectId; canvasCourseId: number; query?: string; week?: number | null; limit?: number; maxChars?: number }): Promise<LibraryHit[]> {
  const limit = Math.min(Math.max(o.limit ?? 8, 1), 50);
  const words = keywords(o.query ?? "");
  const filter: Record<string, unknown> = { userId: o.userId, canvasCourseId: o.canvasCourseId };
  if (words.length) filter.text = { $regex: words.map(esc).join("|"), $options: "i" };
  else if (o.week != null) filter.week = o.week;
  else return [];
  const rows = await StudyLibraryChunk.find(filter, { docId: 1, page: 1, week: 1, text: 1 }).limit(4000).lean<IStudyLibraryChunk[]>();
  const scored = rows.map((r) => {
    const low = r.text.toLowerCase();
    let score = 0;
    for (const w of words) score += Math.min(10, low.split(w).length - 1);
    if (o.week != null && r.week === o.week) score += words.length ? 5 : 1;
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score || String(a.r.docId).localeCompare(String(b.r.docId)) || a.r.page - b.r.page);
  const top = scored.slice(0, limit);
  const docs = new Map(
    (await StudyLibraryDoc.find({ _id: { $in: top.map((t) => t.r.docId) } }, { title: 1, kind: 1, week: 1 }).lean<IStudyLibraryDoc[]>()).map((d) => [String(d._id), d])
  );
  const max = o.maxChars ?? 3000;
  return top.map(({ r, score }) => {
    const d = docs.get(String(r.docId));
    return { docId: String(r.docId), title: d?.title ?? "", kind: d?.kind ?? "note", week: r.week ?? null, page: r.page, score, text: r.text.slice(0, max) };
  });
}

/** Retrieved chunks as one prompt block. */
export const hitsAsContext = (hits: LibraryHit[]) =>
  hits.map((h) => `[${h.title}${h.kind === "pdf" ? ` p.${h.page}` : ""}${h.week != null ? ` · week ${h.week}` : ""}]\n${h.text}`).join("\n\n");

// ─── text source for extract / flashcards ───────────────────────────────────────────────

export const LIBRARY_TEXT_MAX = 60_000;

/**
 * A library doc as a text source. `classId` = the caller's class with that canvasCourseId (null
 * when the class has not synced yet). Pages: optional 1-based range for big PDFs.
 */
export async function libraryTextSource(userId: Types.ObjectId, libraryId: string, opts: { first?: number; last?: number } = {}): Promise<TextSource> {
  const d = await StudyLibraryDoc.findOne({ _id: libraryId, userId }, { title: 1, kind: 1, canvasCourseId: 1 }).lean<IStudyLibraryDoc>();
  if (!d) return { kind: "missing", what: "Library doc" };
  const cls = await StudyClass.findOne({ userId, canvasCourseId: d.canvasCourseId }, { _id: 1 }).lean<{ _id: Types.ObjectId }>();
  const classId = cls?._id ?? null;
  const pageFilter = opts.first ? { page: { $gte: opts.first, $lte: opts.last ?? opts.first } } : {};
  const chunks = await StudyLibraryChunk.find({ docId: d._id, ...pageFilter }, { text: 1, page: 1 }).sort({ page: 1 }).lean<IStudyLibraryChunk[]>();
  let text = "";
  for (const c of chunks) {
    if (text.length >= LIBRARY_TEXT_MAX) break;
    text += `${c.text}\n\n`;
  }
  text = text.trim().slice(0, LIBRARY_TEXT_MAX);
  const source: QuestionDraft["source"] = { kind: d.kind === "pdf" ? "pdf" : "manual", itemId: null, pageId: null, lectureId: null, ref: `library:${d._id}` };
  if (text.length < 40) return { kind: "error", message: d.kind === "image" ? "This library doc is an image — extract questions from it instead" : "This library doc has no text", code: "EMPTY_SOURCE", classId };
  return { kind: "text", text: `${d.title}\n\n${text}`, source, classId };
}

// ─── exam results summary ───────────────────────────────────────────────────────────────

export const examResultDto = (r: IStudyExamResult) => ({
  id: String(r._id),
  name: r.name,
  date: r.date ?? null,
  score: r.score,
  maxScore: r.maxScore,
  percent: r.maxScore > 0 ? Math.round((r.score / r.maxScore) * 1000) / 10 : null,
  chapters: r.chapters ?? [],
  sections: r.sections?.length ? r.sections : undefined,
  notes: r.notes ?? undefined,
});

/** Latest result per canvasCourseId (for the Class DTO / Today), keyed by course id. */
export async function latestExamResults(userId: Types.ObjectId, canvasCourseIds: number[]) {
  const out = new Map<number, { latest: { name: string; date: string | null; score: number; maxScore: number; percent: number | null }; count: number }>();
  if (!canvasCourseIds.length) return out;
  const rows = await StudyExamResult.find({ userId, canvasCourseId: { $in: canvasCourseIds } }).sort({ date: -1, createdAt: -1 }).lean<IStudyExamResult[]>();
  for (const r of rows) {
    const cur = out.get(r.canvasCourseId);
    if (cur) cur.count++;
    else {
      const d = examResultDto(r);
      out.set(r.canvasCourseId, { latest: { name: d.name, date: d.date, score: d.score, maxScore: d.maxScore, percent: d.percent }, count: 1 });
    }
  }
  return out;
}
