import { Types } from "mongoose";
import { IStudyClass } from "@/models/study/class";
import { IStudyConceptMap, NotesDigest, StudyConceptMap } from "@/models/study/concept-map";
import { IStudyItem, StudyItem } from "@/models/study/item";
import { IStudyLecture, StudyLecture } from "@/models/study/lecture";
import { IStudyPage, StudyPage } from "@/models/study/page";
import { IStudyPageRead, StudyPageRead } from "@/models/study/page-read";
import { IStudyTranscript, StudyTranscript } from "@/models/study/transcript";
import { logger } from "@/services/logger.service";
import { Spend } from "./ai-models";
import { CM_CONTEXT_BUDGET, cmTextJson } from "./cm-text";
import { buildNotesDigestTurn, packNotesPages, NOTES_LIBRARY_MAX, notesContext, notesHash, NotesPageTimeout, NOTES_DIGEST_SYSTEM_PROMPT, parseNotesDigest, readNotesPage } from "./concept-map-notes";
import { htmlToText, pdfText } from "./extract-sources";
import { hitsAsContext, retrieveLibrary } from "./library";
import { createPageRasterizer, PageRasterizer } from "./page-raster";
import { getStudyObject } from "./storage";
import { transcriptText } from "./transcribe";
import { DEFAULT_MEETING_TZ, resolveMeetings } from "./views";

/**
 * Lecture-scoped grounding for the concept-map text steps. A map is one lecture: its Canvas
 * assignment sits in that week's module, and it is due at the end of that class meeting. From
 * those two facts this module gathers, lecture-first: the module's files (slides) and pages, the
 * lecture's recordings and video transcripts, the owner's notes pages for that date, then the
 * textbook library and the professor's model answer — and packs them into one bounded context,
 * returning the list of sources that made it in.
 */

export const CM_SOURCE_KINDS = ["slides", "page", "transcript", "notes", "textbook", "model_answer", "past_maps", "image"] as const;
export type CmSourceKind = (typeof CM_SOURCE_KINDS)[number];
export interface CmSource {
  kind: CmSourceKind;
  title: string;
  itemId?: string;
}
export interface CmBlock extends CmSource {
  text: string;
}

/** Total context budget (chars) on the first link of the chain; the DeepSeek fallback re-packs to CM_CONTEXT_BUDGET.deepseek. */
export const CM_CONTEXT_MAX_CHARS = CM_CONTEXT_BUDGET.openrouter;
/** Library hits per reference / grade context — enough for the relevant textbook chapter section to come through. */
export const CM_LIBRARY_LIMIT = 40;
export const CM_LIBRARY_HIT_CHARS = 4000;
/** One block never takes more than this; a block that would get less than BLOCK_MIN is dropped, not stubbed. */
export const CM_BLOCK_MAX_CHARS = 60_000;
const BLOCK_MIN = 300;
/** The model answer is the professor's own wording — first in line for the budget, up to this. */
const MODEL_ANSWER_MAX = 20_000;

const LABEL: Record<CmSourceKind, string> = {
  slides: "Lecture slides",
  page: "Canvas page",
  transcript: "Lecture transcript",
  notes: "The student's own lecture notes (the professor's wording wins where they differ)",
  textbook: "Textbook",
  model_answer: "Professor's model answer for these terms",
  past_maps: "The professor's past concept maps in this class",
  image: "What the student's pictures from the lecture show (slides, a textbook page, the board)",
};
/** Who keeps their room when the total overflows: earlier = kept first. */
export const CM_PRIORITY: readonly CmSourceKind[] = ["model_answer", "notes", "image", "transcript", "slides", "page", "past_maps", "textbook"];
/**
 * Output order: the class-wide material first (the same for every map of the class, so the
 * provider's automatic prompt-prefix cache — OpenAI via OpenRouter, no cache_control needed —
 * can reuse it), then what is specific to this map.
 */
export const CM_OUTPUT_ORDER: readonly CmSourceKind[] = ["past_maps", "textbook", "slides", "page", "transcript", "notes", "image", "model_answer"];
const source = (b: CmBlock): CmSource => ({ kind: b.kind, title: b.title, ...(b.itemId ? { itemId: b.itemId } : {}) });

/**
 * Blocks → one prompt block + the sources it contains. Deterministic. Room is handed out in
 * CM_PRIORITY order (input order within a kind): each block gets min(its cap, what is left) —
 * the block that crosses the limit is cut to fit, and once under BLOCK_MIN is left everything
 * after it is dropped (never stubbed). Only an overflow uses the priority; the
 * kept blocks are then written in CM_OUTPUT_ORDER (input order within a kind), sources likewise.
 */
const head = (b: Pick<CmBlock, "kind" | "title">) => `[${LABEL[b.kind]}${b.kind === "model_answer" ? "" : `: ${b.title}`}]\n`;
const cap = (b: Pick<CmBlock, "kind">) => (b.kind === "model_answer" ? MODEL_ANSWER_MAX : CM_BLOCK_MAX_CHARS);
/** What a block takes of the budget when packContext keeps it whole (capped). */
export const blockCost = (b: CmBlock) => head(b).length + Math.min(b.text.trim().length, cap(b)) + 2;
/** Kinds that outrank slides in packContext's priority — the room slides can never take. */
const ABOVE_SLIDES = new Set(CM_PRIORITY.slice(0, CM_PRIORITY.indexOf("slides")));
export const reservedAboveSlides = (blocks: CmBlock[]) => blocks.filter((b) => ABOVE_SLIDES.has(b.kind)).reduce((n, b) => n + blockCost(b), 0);

export function packContext(blocks: CmBlock[], maxChars: number = CM_CONTEXT_MAX_CHARS): { context: string; sources: CmSource[] } {
  const all = blocks.map((b, i) => ({ b: { ...b, text: b.text.trim() }, i })).filter(({ b }) => b.text);
  const byPriority = [...all].sort((x, y) => CM_PRIORITY.indexOf(x.b.kind) - CM_PRIORITY.indexOf(y.b.kind) || x.i - y.i);
  let left = maxChars;
  const kept: Array<{ b: CmBlock; i: number }> = [];
  for (const { b, i } of byPriority) {
    const room = Math.min(cap(b), left - head(b).length - 2);
    if (room < BLOCK_MIN) break;
    const text = b.text.slice(0, room);
    kept.push({ b: { ...b, text }, i });
    left -= head(b).length + text.length + 2;
  }
  kept.sort((x, y) => CM_OUTPUT_ORDER.indexOf(x.b.kind) - CM_OUTPUT_ORDER.indexOf(y.b.kind) || x.i - y.i);
  return { context: kept.map(({ b }) => head(b) + b.text).join("\n\n"), sources: dedupeSources(kept.map(({ b }) => source(b))) };
}

/**
 * Every other (non-practice) concept map of the class as ONE block: number, lecture, prompt
 * terms and the professor's model answer, in map-number order. `excludeId` = the map being
 * worked on — its own answer is the separate model_answer block, never a "past" map.
 */
export async function pastMapsBlock(userId: Types.ObjectId, canvasCourseId: number, excludeId: Types.ObjectId | string | null): Promise<CmBlock | null> {
  const maps = await StudyConceptMap.find(
    { userId, canvasCourseId, source: { $ne: "practice" }, "promptTerms.0": { $exists: true }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) },
    { number: 1, week: 1, lecture: 1, promptTerms: 1, "instructor.modelAnswer": 1 }
  )
    .sort({ number: 1, _id: 1 })
    .lean<IStudyConceptMap[]>();
  if (!maps.length) return null;
  return { kind: "past_maps", title: `Past concept maps (${maps.length})`, text: pastMapsText(maps) };
}

export const pastMapsText = (maps: Array<Pick<IStudyConceptMap, "number" | "week" | "lecture" | "promptTerms" | "instructor">>) =>
  maps
    .map((m) =>
      [
        `## Concept Map ${m.number ?? "?"}${m.lecture ? ` — ${m.lecture}` : ""}${m.week != null ? ` (week ${m.week})` : ""}`,
        `Prompt terms: ${(m.promptTerms ?? []).join(", ")}`,
        m.instructor?.modelAnswer ? `Professor's model answer:\n${m.instructor.modelAnswer.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");

// ─── which lecture ──────────────────────────────────────────────────────────────────────

export interface LectureScope {
  /** Class-local date of the meeting (YYYY-MM-DD), null when the map has no due date. */
  date: string | null;
  timeZone: string;
  /** The week's Canvas module (from the linked assignment), null when unknown. */
  moduleId: Types.ObjectId | null;
  number: number | null;
  week: number | null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const localDate = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const shiftDate = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 86400e3).toISOString().slice(0, 10);

/** The class's meeting days as lowercase 3-letter names ("mon", "wed"); empty when unknown. */
export const meetingDays = (meetings: { slots?: Array<{ day: string }> } | null | undefined) => new Set((meetings?.slots ?? []).map((s) => s.day.slice(0, 3).toLowerCase()));

/** A class-local date snapped back to the latest meeting day (≤ 6 days back); unchanged when the days are unknown or none matches. */
export function snapToMeeting(ymd: string, days: Set<string>): string {
  if (!days.size) return ymd;
  for (let back = 0; back <= 6; back++) {
    const d = shiftDate(ymd, -back);
    if (days.has(DAYS[new Date(`${d}T12:00:00Z`).getUTCDay()].toLowerCase())) return d;
  }
  return ymd;
}

/**
 * The meeting a map belongs to: the linked assignment's due date (else the map's) in the class's
 * meeting time zone. When the class's meeting days are known and that date is not one of them,
 * the latest meeting day before it (≤ 6 days back) is the lecture.
 */
export async function lectureScope(userId: Types.ObjectId, cls: IStudyClass, m: IStudyConceptMap): Promise<LectureScope> {
  // A practice map carries no Canvas link of its own (score sync must never treat it as the Canvas
  // map): it is the lecture of the map it was made from.
  if (m.source === "practice" && m.baseMapId && !m.canvasItemId && !m.canvasAssignmentId) {
    const base = await StudyConceptMap.findOne({ _id: m.baseMapId, userId, source: { $ne: "practice" } }).lean<IStudyConceptMap>();
    if (base) return lectureScope(userId, cls, base);
  }
  const item =
    (m.canvasItemId ? await StudyItem.findOne({ _id: m.canvasItemId, userId }, { moduleId: 1, dueAt: 1, effectiveDueAt: 1 }).lean<IStudyItem>() : null) ??
    // not linked yet: the import's exact Canvas assignment id beats a title match (renamed assignments)
    (m.canvasAssignmentId
      ? await StudyItem.findOne({ userId, classId: cls._id, type: "assignment", canvasId: String(m.canvasAssignmentId) }, { moduleId: 1, dueAt: 1, effectiveDueAt: 1 }).lean<IStudyItem>()
      : null) ??
    (m.number != null
      ? await StudyItem.findOne({ userId, classId: cls._id, type: "assignment", title: { $regex: `concept\\s*map\\s*${m.number}(?!\\d)`, $options: "i" } }, { moduleId: 1, dueAt: 1, effectiveDueAt: 1 }).lean<IStudyItem>()
      : null);
  const meetings = (await resolveMeetings(userId, [cls])).get(String(cls._id))?.meetings ?? null;
  const timeZone = meetings?.timeZone ?? DEFAULT_MEETING_TZ;
  // The linked assignment's live (announcement-moved, else Canvas) due date wins over the map's snapshot (Canvas reschedules).
  // A midnight-UTC value is a date-only deadline (folder import): read it as that calendar day,
  // never shift it into the class zone (LA would turn a Monday into Sunday).
  // Only the imported snapshot is date-only; a Canvas deadline at 00:00Z is a real instant.
  const live = item?.effectiveDueAt ?? item?.dueAt ?? null;
  const due = live ?? m.dueAt ?? null;
  const dueDate = due ? new Date(due) : null;
  const dateOnly = !live && !!dueDate && dueDate.getUTCHours() === 0 && dueDate.getUTCMinutes() === 0 && dueDate.getUTCSeconds() === 0;
  let date = dueDate ? (dateOnly ? dueDate.toISOString().slice(0, 10) : localDate(dueDate, timeZone)) : null;
  if (date) date = snapToMeeting(date, meetingDays(meetings));
  return { date, timeZone, moduleId: item?.moduleId ?? null, number: m.number ?? null, week: m.week ?? null };
}

// ─── lecture material ───────────────────────────────────────────────────────────────────

const LECTURE_NO = /\blecture\s*#?\s*(\d+)/i;

/**
 * The module's file/page items for this lecture, in module order. A module holds a week (two
 * lectures); a page titled "Lecture N …" closes lecture N's run of items, so the items up to
 * and including the marker for this map's number come first, then the module's other items.
 * Items titled with ANOTHER lecture's number are left out.
 */
export function orderModuleItems<T extends Pick<IStudyItem, "title" | "modulePosition">>(items: T[], n: number | null): T[] {
  const sorted = [...items].sort((a, b) => (a.modulePosition ?? 1e9) - (b.modulePosition ?? 1e9));
  const lectureOf = (t: T) => (t.title.match(LECTURE_NO) ? Number(t.title.match(LECTURE_NO)![1]) : null);
  const kept = sorted.filter((t) => n == null || lectureOf(t) == null || lectureOf(t) === n);
  if (n == null) return kept;
  const markers = sorted.map((t, i) => ({ i, l: lectureOf(t) })).filter((x) => x.l != null);
  const mine = markers.find((x) => x.l === n);
  if (!mine) return kept;
  const prev = markers.filter((x) => x.i < mine.i).pop();
  const own = new Set(sorted.slice(prev ? prev.i + 1 : 0, mine.i + 1));
  return [...kept.filter((t) => own.has(t)), ...kept.filter((t) => !own.has(t))];
}

const WEEK_LEVEL = /\b(overview|objectives?)\b/i;

/**
 * Only lecture `n`'s own run of module items (the items after the previous "Lecture M" marker, up
 * to and including its own), plus the week's overview / objectives pages — never the other
 * lecture's readings. Without a marker for `n` it is the whole module (orderModuleItems).
 */
export function ownLectureItems<T extends Pick<IStudyItem, "title" | "modulePosition">>(items: T[], n: number | null): T[] {
  const sorted = [...items].sort((a, b) => (a.modulePosition ?? 1e9) - (b.modulePosition ?? 1e9));
  const lectureOf = (t: T) => (t.title.match(LECTURE_NO) ? Number(t.title.match(LECTURE_NO)![1]) : null);
  const markers = sorted.map((t, i) => ({ i, l: lectureOf(t) })).filter((x) => x.l != null);
  const mine = n == null ? undefined : markers.find((x) => x.l === n);
  if (!mine) return orderModuleItems(items, n);
  const prev = markers.filter((x) => x.i < mine.i).pop();
  const own = new Set(sorted.slice(prev ? prev.i + 1 : 0, mine.i + 1));
  return sorted.filter((t) => own.has(t) || (lectureOf(t) == null && WEEK_LEVEL.test(t.title)));
}

async function readyTranscriptText(userId: Types.ObjectId, key: { itemId: Types.ObjectId } | { lectureId: Types.ObjectId }): Promise<string> {
  const t = await StudyTranscript.findOne({ userId, ...key, status: "ready" }, { segments: 1 }).lean<IStudyTranscript>();
  return t?.segments?.length ? transcriptText(t.segments) : "";
}

/**
 * Canvas pages, transcripts and slides (module files with a text layer) for the lecture. The
 * pages and transcripts are gathered first; slide PDFs are parsed last, and only while one more
 * could still be kept: `reserved` (the caller's higher-priority blocks — model answer, notes) plus
 * the transcripts found here are what packContext serves before slides, so once the slides' capped
 * size reaches what that leaves of CM_CONTEXT_MAX_CHARS, the remaining PDFs are never downloaded.
 */
/** `slideBudget`: slide PDFs stop parsing once they can no longer fit it (the concept-map budget); Infinity loads them all. */
/** `ownLecture`: only the lecture's own run of module items + the week's overview (ownLectureItems), not the whole module. */
export async function lectureMaterial(
  userId: Types.ObjectId,
  cls: IStudyClass,
  scope: LectureScope,
  reserved = 0,
  slideBudget: number = CM_CONTEXT_MAX_CHARS,
  opts: { ownLecture?: boolean } = {}
): Promise<CmBlock[]> {
  const blocks: CmBlock[] = [];
  const pdfs: IStudyItem[] = [];
  if (scope.moduleId) {
    const items = await StudyItem.find(
      { userId, classId: cls._id, moduleId: scope.moduleId, type: { $in: ["file", "page", "video"] } },
      { title: 1, type: 1, html: 1, file: 1, modulePosition: 1 }
    ).lean<IStudyItem[]>();
    const ordered = opts.ownLecture ? ownLectureItems(items, scope.number) : orderModuleItems(items, scope.number);
    // Videos embedded in the lecture's pages ("Lecture N. Supporting videos") count as its transcripts.
    const embedded = await StudyItem.find({ userId, classId: cls._id, type: "video", parentItemId: { $in: ordered.filter((i) => i.type === "page").map((i) => i._id) } }, { title: 1, parentItemId: 1 }).lean<
      IStudyItem[]
    >();
    for (const it of ordered) {
      try {
        if (it.type === "file" && it.file?.storageKey && it.file.mime === "application/pdf") pdfs.push(it);
        else if (it.type === "page") {
          const text = htmlToText(it.html ?? "");
          if (text.length > 40) blocks.push({ kind: "page", title: it.title, itemId: String(it._id), text });
        }
        const videos = it.type === "video" ? [it] : embedded.filter((v) => String(v.parentItemId) === String(it._id));
        for (const v of videos) {
          const text = await readyTranscriptText(userId, { itemId: v._id });
          if (text) blocks.push({ kind: "transcript", title: v.title, itemId: String(v._id), text });
        }
      } catch (e) {
        await logger.warn("study concept-map context: item skipped", { itemId: String(it._id), error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }
  }
  if (scope.date) {
    // Recordings that started on the lecture's date (class-local); ±1 day covers any time zone.
    const from = new Date(Date.parse(`${scope.date}T00:00:00Z`) - 86400e3);
    const to = new Date(Date.parse(`${scope.date}T00:00:00Z`) + 2 * 86400e3);
    const lectures = await StudyLecture.find({ userId, classId: cls._id, status: "ready", startedAt: { $gte: from, $lt: to } }, { title: 1, startedAt: 1 })
      .sort({ startedAt: 1 })
      .lean<IStudyLecture[]>();
    for (const l of lectures.filter((x) => localDate(new Date(x.startedAt), scope.timeZone) === scope.date)) {
      const text = await readyTranscriptText(userId, { lectureId: l._id });
      if (text) blocks.push({ kind: "transcript", title: l.title || `Lecture recording ${scope.date}`, text });
    }
  }
  let left = slideBudget - reserved - reservedAboveSlides(blocks);
  for (const it of pdfs) {
    // the same rule packContext applies: under BLOCK_MIN of room, this slide and every later one is dropped
    if (left - head({ kind: "slides", title: it.title }).length - 2 < BLOCK_MIN) break;
    try {
      const text = await pdfText(await getStudyObject(it.file!.storageKey), 200);
      if (!text.trim()) continue;
      const b: CmBlock = { kind: "slides", title: it.title, itemId: String(it._id), text };
      blocks.push(b);
      left -= blockCost(b);
    } catch (e) {
      await logger.warn("study concept-map context: item skipped", { itemId: String(it._id), error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  return blocks;
}

/** The owner's notes pages for the lecture: the map's linked pages, in order, else pages stamped with the lecture's date (or week when the date is unknown). */
export async function lectureNotesPages(userId: Types.ObjectId, cls: IStudyClass, m: IStudyConceptMap, scope: LectureScope): Promise<IStudyPage[]> {
  const ids = (m.notesPageIds ?? []).map(String);
  if (ids.length) {
    const rows = await StudyPage.find({ _id: { $in: ids }, userId, deletedAt: null }).lean<IStudyPage[]>();
    return ids.map((id) => rows.find((p) => String(p._id) === id)).filter((p): p is IStudyPage => !!p);
  }
  const by = scope.date ? { "lecture.date": scope.date } : scope.week != null ? { week: scope.week } : null;
  if (!by) return [];
  return StudyPage.find({ userId, classId: cls._id, deletedAt: null, ...by }).sort({ createdAt: 1, _id: 1 }).limit(20).lean<IStudyPage[]>();
}

// ─── notes digest ───────────────────────────────────────────────────────────────────────

export type NotesPageFrame = { pageId: string; version: number; cached: boolean; error?: string };

export type NotesDigestResult =
  | { kind: "cached"; digest: NotesDigest; versions: Array<{ pageId: string; version: number }>; model: string | null; sources: CmSource[] }
  | { kind: "built"; digest: NotesDigest; model: string; texts: Array<{ title: string; text: string }>; sources: CmSource[] }
  | { kind: "nothing_read" }
  | { kind: "empty"; model: string; texts: Array<{ title: string; text: string }> }
  | { kind: "aborted" };

/**
 * The notes digest of `pages` for map `m` (POST /:id/notes-digest, and built on the fly by the
 * reference when missing). Cached on the map under notesHash — an unchanged re-run returns the
 * cache with no model call. Each page's CURRENT version is rasterised and vision-read once (cached
 * per (pageId, version) in `study_page_reads`); a page that times out or fails is skipped
 * (`error` on its frame) and the digest goes on, but is then not cached so the next run retries.
 */
export async function notesDigestFor(o: {
  userId: Types.ObjectId;
  m: IStudyConceptMap;
  pages: IStudyPage[];
  spend: Spend;
  signal: AbortSignal;
  onPage?: (f: NotesPageFrame) => void;
}): Promise<NotesDigestResult> {
  const { userId, m, pages, spend, signal } = o;
  const versions = pages.map((p) => ({ pageId: String(p._id), version: p.version ?? 0 }));
  const terms = m.promptTerms ?? [];
  const hash = notesHash(versions, m);
  if (m.notesDigest?.hash === hash && m.notesDigest.digest) {
    // A digest cached before sources were stored: name the pages that pack into a digest turn now.
    const cachedSources = (m.notesDigest.sources as CmSource[] | undefined) ?? notesSources(packNotesPages(await notesPageTexts(userId, pages)).kept);
    return { kind: "cached", digest: m.notesDigest.digest, versions, model: m.notesDigest.model ?? null, sources: cachedSources };
  }

  let raster: PageRasterizer | null = null;
  const texts: Array<{ title: string; text: string }> = [];
  const sources: CmSource[] = [];
  let complete = true;
  try {
    for (const p of pages) {
      if (signal.aborted) return { kind: "aborted" };
      const frame: NotesPageFrame = { pageId: String(p._id), version: p.version ?? 0, cached: false };
      const ocr = p.ocrText?.trim() || null;
      const add = (text: string) => texts.push({ title: p.title, text });
      const useOcr = () => {
        if (ocr) {
          add(ocr);
          complete = false; // OCR text can change without a new version → never cache a digest built on it
        } else frame.error = "EMPTY_PAGE";
      };
      try {
        if (!p.version || !p.contentKey) useOcr();
        else {
          const hit = await StudyPageRead.findOne({ userId, pageId: p._id, version: p.version }).lean<IStudyPageRead>();
          if (hit) {
            frame.cached = true;
            if (hit.text) add(hit.text);
            else frame.error = "EMPTY_PAGE";
          } else {
            raster ??= await createPageRasterizer();
            const tiles = await raster.render((await getStudyObject(p.contentKey)).toString("utf8"));
            if (!tiles.length) useOcr();
            else {
              const before = { n: spend.models.length, usd: spend.visionCostUsd };
              const text = await readNotesPage(tiles, ocr, spend, signal);
              await StudyPageRead.updateOne(
                { userId, pageId: p._id, version: p.version },
                { $setOnInsert: { text, tiles: tiles.length, models: spend.models.slice(before.n), costUsd: Number((spend.visionCostUsd - before.usd).toFixed(6)) } },
                { upsert: true }
              );
              if (text) add(text);
              else frame.error = "EMPTY_PAGE";
            }
          }
        }
      } catch (e) {
        if (signal.aborted) return { kind: "aborted" };
        complete = false;
        frame.error = e instanceof NotesPageTimeout ? "TIMEOUT" : "READ_FAILED";
        if (!(e instanceof NotesPageTimeout)) await logger.warn("study notes-digest: page read failed", { pageId: String(p._id), error: String((e as Error)?.message ?? e).slice(0, 300) });
      }
      o.onPage?.(frame);
    }
  } finally {
    if (raster) await (raster as PageRasterizer).close();
  }
  if (signal.aborted) return { kind: "aborted" };
  if (!texts.length) return { kind: "nothing_read" };

  const found = terms.length ? await retrieveLibrary({ userId, canvasCourseId: m.canvasCourseId, query: terms.join(" "), limit: 12, maxChars: CM_LIBRARY_HIT_CHARS }) : [];
  // whole hits within the digest turn's library limit, so `sources` names only what the model sees
  let room = NOTES_LIBRARY_MAX;
  const hits = found.filter((h) => {
    const n = hitsAsContext([h]).length + 2;
    if (n > room) return false;
    room -= n;
    return true;
  });
  // notes sources = the pages the digest turn keeps whole (packNotesPages cuts at page boundaries)
  const packedNotes = packNotesPages(texts);
  sources.push(...notesSources(packedNotes.kept));
  for (const h of hits) sources.push({ kind: "textbook", title: hitTitle(h) });
  if (m.instructor?.modelAnswer) sources.push({ kind: "model_answer", title: "Professor's model answer" });
  const turn = buildNotesDigestTurn({ terms, lecture: m.lecture, modelAnswer: m.instructor?.modelAnswer ?? null, comment: m.instructor?.comment ?? null, library: hitsAsContext(hits), pages: texts });
  const { out: raw, model } = await cmTextJson(NOTES_DIGEST_SYSTEM_PROMPT, turn, spend, { signal, maxTokens: 16_000 });
  if (signal.aborted) return { kind: "aborted" };
  if (!raw || typeof raw !== "object") return { kind: "empty", model, texts };
  // validated against the note BODIES the model actually saw: not the untruncated pages, not the generated "## Page n — title" headings
  const digest = parseNotesDigest(raw, terms, packedNotes.text.split("\n").filter((l) => !/^## Page \d+ — /.test(l)).join("\n"));
  const used = dedupeSources(sources);
  if (complete)
    await StudyConceptMap.updateOne(
      { _id: m._id, userId, notesPageIds: m.notesPageIds },
      { $set: { notesDigest: { hash, pages: versions, digest, model, sources: used, createdAt: new Date() } } },
      { timestamps: false }
    );
  return { kind: "built", digest, model, texts, sources: used };
}

const notesSources = (pages: Array<{ title: string }>): CmSource[] => pages.map((p) => ({ kind: "notes", title: p.title || "Notes page" }));

export const hitTitle = (h: { title: string; kind: string; page: number }) => `${h.title || "Library"}${h.kind === "pdf" ? ` p.${h.page}` : ""}`;

export const dedupeSources = (xs: CmSource[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.kind}|${x.title}|${x.itemId ?? ""}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
};

// ─── the whole context ──────────────────────────────────────────────────────────────────

/** What each notes page says without a model call: its cached vision read for the current version, else its OCR text. */
export async function notesPageTexts(userId: Types.ObjectId, pages: IStudyPage[]): Promise<Array<{ title: string; text: string }>> {
  const reads = pages.some((p) => p.version)
    ? await StudyPageRead.find({ userId, $or: pages.filter((p) => p.version).map((p) => ({ pageId: p._id, version: p.version })) }, { pageId: 1, version: 1, text: 1 }).lean<IStudyPageRead[]>()
    : [];
  return pages
    .map((p) => ({ title: p.title || "Lecture notes", text: reads.find((r) => String(r.pageId) === String(p._id) && r.version === p.version)?.text || p.ocrText?.trim() || "" }))
    .filter((t) => t.text);
}

export interface CmContext {
  /** The packed context + its sources at a budget (memoised) — the chain re-packs for its fallback. */
  pack(maxChars: number): { context: string; sources: CmSource[] };
  scope: LectureScope | null;
}

/**
 * Reference / grade context for `terms`, scoped to map `m`'s lecture when there is one:
 * every other concept map of the class (past_maps), the textbook library (CM_LIBRARY_LIMIT ×
 * CM_LIBRARY_HIT_CHARS), the lecture's module readings + pages, its transcripts, the owner's
 * notes for it, and its model answer. Nothing is cut here — `pack` fits it to a budget.
 * `notes`: "build" = the lecture's notes pages and their digest, built when missing (reference);
 * "none" = no notes (grade — its cached digest feeds suggestions only, never the score, and the
 * grade turn adds it itself). `onStatus` reports the slow step (reading notes pages).
 */
export async function conceptMapContext(o: {
  userId: Types.ObjectId;
  cls: IStudyClass;
  m: IStudyConceptMap | null;
  terms: string[];
  spend: Spend;
  signal: AbortSignal;
  notes: "build" | "none";
  onStatus?: (s: string) => void;
  /** Without a map: the lecture to ground in (resolved by the caller, e.g. from a notes page). */
  scope?: LectureScope | null;
  /** More notes pages (the page the request came from): added after the map's own, skipping any already among them. */
  notesPages?: IStudyPage[];
  /** Blocks the caller already has (the pictures' summaries). */
  extra?: CmBlock[];
}): Promise<CmContext> {
  const { userId, cls, m } = o;
  const blocks: CmBlock[] = [...(o.extra ?? [])];
  const past = await pastMapsBlock(userId, cls.canvasCourseId, m?._id ?? null);
  if (past) blocks.push(past);
  const scope = m ? await lectureScope(userId, cls, m) : (o.scope ?? null);
  const notesFrom = async (pages: IStudyPage[]) => {
    for (const t of await notesPageTexts(userId, pages)) blocks.push({ kind: "notes", title: t.title, text: t.text });
  };
  if (m && scope) {
    // Notes and the model answer are gathered before the lecture material, so slide parsing knows what they reserve.
    if (o.notes === "build") {
      const pages = await lectureNotesPages(userId, cls, m, scope);
      let digest = pages.length ? null : (m.notesDigest?.digest ?? null);
      let raw: Array<{ title: string; text: string }> = [];
      if (pages.length) {
        if (!(m.notesDigest?.hash === notesHash(pages.map((p) => ({ pageId: String(p._id), version: p.version ?? 0 })), m))) o.onStatus?.("Reading your lecture notes…");
        try {
          const r = await notesDigestFor({ userId, m, pages, spend: o.spend, signal: o.signal });
          if (r.kind === "cached" || r.kind === "built") digest = r.digest;
          if (r.kind === "built" || r.kind === "empty") raw = r.texts;
        } catch (e) {
          if (o.signal.aborted) throw e;
          await logger.warn("study concept-map context: notes digest failed", { mapId: String(m._id), error: String((e as Error)?.message ?? e).slice(0, 300) });
        }
        // The pages themselves too, not just the digest: the budget has room for the owner's own words.
        if (!raw.length) raw = await notesPageTexts(userId, pages);
      }
      if (digest) blocks.push({ kind: "notes", title: "Lecture notes digest", text: notesContext(digest) });
      for (const t of raw) blocks.push({ kind: "notes", title: t.title || "Lecture notes", text: t.text });
      const have = new Set(pages.map((p) => String(p._id)));
      await notesFrom((o.notesPages ?? []).filter((p) => !have.has(String(p._id))));
    }
    if (m.instructor?.modelAnswer) blocks.push({ kind: "model_answer", title: "Professor's model answer", text: m.instructor.modelAnswer });
    blocks.push(...(await lectureMaterial(userId, cls, scope, reservedAboveSlides(blocks))));
  } else if (o.notes === "build" && (o.notesPages?.length || scope)) {
    await notesFrom(o.notesPages ?? []);
    if (scope) blocks.push(...(await lectureMaterial(userId, cls, scope, reservedAboveSlides(blocks))));
  }
  const hits = o.terms.length ? await retrieveLibrary({ userId, canvasCourseId: cls.canvasCourseId, query: o.terms.join(" "), limit: CM_LIBRARY_LIMIT, maxChars: CM_LIBRARY_HIT_CHARS }) : [];
  for (const h of hits) blocks.push({ kind: "textbook", title: hitTitle(h), text: h.text });
  const memo = new Map<number, { context: string; sources: CmSource[] }>();
  return {
    pack: (maxChars) => {
      if (!memo.has(maxChars)) memo.set(maxChars, packContext(blocks, maxChars));
      return memo.get(maxChars)!;
    },
    scope,
  };
}
