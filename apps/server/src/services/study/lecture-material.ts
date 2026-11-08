import { Types } from "mongoose";
import { IStudyClass } from "@/models/study/class";
import { IStudyItem, StudyItem } from "@/models/study/item";
import { IStudyModule, StudyModule } from "@/models/study/module";
import { IStudyPage, StudyPage } from "@/models/study/page";
import { CmBlock, CmSource, CmSourceKind, dedupeSources, lectureMaterial, LectureScope, localDate } from "./concept-map-context";
import { DEFAULT_MEETING_TZ, resolveMeetings } from "./views";

/**
 * One lecture's material for the MCP (`get_lecture_material`, and the module link of
 * `create_lecture_pdf`), found from what the caller knows about the lecture — its number, its
 * client key ("L8" / "W8" / a date), its date, or just the week — instead of a concept map.
 * The scope it resolves is the concept-map LectureScope, so the material itself comes from the
 * same lectureMaterial() the concept-map steps use: the week module's slides and pages, the
 * lecture's video transcripts and the recordings of that day. Notes pages are matched on the
 * pages' own lecture/week fields and read from their stored OCR text (no vision read here).
 */

export interface LectureQuery {
  lecture?: { number?: number | null; key?: string; date?: string };
  week?: number;
}

export interface ResolvedLectureScope extends LectureScope {
  key: string | null;
  moduleName: string | null;
}

/** «Week 6: Exam 1», «🥼 Week 1 — Intro», «wk 6» → 6 (same rule as the FE lecture list). */
export const weekOfName = (name: string | null | undefined): number | null => {
  const m = /\b(?:week|wk)[\s_#-]*0*(\d{1,2})\b/i.exec(name ?? "");
  return m ? Number(m[1]) : null;
};

/** «Lecture 8», «Lecture Activity 8», «Lec 8» → 8. */
export const lectureOfTitle = (title: string | null | undefined): number | null => {
  const m = /\b(?:lecture|lec)(?:\s+activity)?[\s_#.-]*0*(\d{1,3})\b/i.exec(title ?? "");
  return m ? Number(m[1]) : null;
};

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const shiftDate = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 86400e3).toISOString().slice(0, 10);
const validWeek = (n: number | null | undefined): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 30;

/**
 * {lecture number | key | date, week} → the lecture's scope. A key "L8" means lecture 8, "W8"
 * week 8, a YYYY-MM-DD key that date. A date is snapped back to the class's latest meeting day
 * (≤ 6 days); a dated lecture borrows its number/week from notes pages stamped with that date,
 * else its week from the term start. The module is the one holding an item titled with the
 * lecture number, else the module named for the week, else (when no module names a week at all)
 * the week-th module by position.
 */
export async function resolveLectureScope(userId: Types.ObjectId, cls: IStudyClass, q: LectureQuery): Promise<ResolvedLectureScope> {
  const key = q.lecture?.key?.trim() || null;
  let number = q.lecture?.number ?? (key && /^L\d{1,3}$/i.test(key) ? Number(key.slice(1)) : null);
  let week = q.week ?? (key && /^W\d{1,2}$/i.test(key) ? Number(key.slice(1)) : null);
  let date = q.lecture?.date ?? (key && /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null);

  const meetings = (await resolveMeetings(userId, [cls])).get(String(cls._id))?.meetings ?? null;
  const timeZone = meetings?.timeZone ?? DEFAULT_MEETING_TZ;
  if (date) {
    const days = new Set((meetings?.slots ?? []).map((s) => s.day.slice(0, 3).toLowerCase()));
    if (days.size)
      for (let back = 0; back <= 6; back++) {
        const d = shiftDate(date, -back);
        if (days.has(DAYS[new Date(`${d}T12:00:00Z`).getUTCDay()])) {
          date = d;
          break;
        }
      }
    if (number == null || week == null) {
      const stamped = await StudyPage.findOne({ userId, classId: cls._id, deletedAt: null, "lecture.date": date }, { lecture: 1, week: 1 }).sort({ createdAt: 1 }).lean<IStudyPage>();
      number ??= stamped?.lecture?.number ?? null;
      week ??= stamped?.week ?? null;
    }
    if (week == null && cls.term?.startAt) {
      const w = Math.floor((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${localDate(new Date(cls.term.startAt), timeZone)}T12:00:00Z`)) / (7 * 86400e3)) + 1;
      if (validWeek(w)) week = w;
    }
  }

  const modules = await StudyModule.find({ userId, classId: cls._id }, { name: 1, position: 1 }).sort({ position: 1, _id: 1 }).lean<IStudyModule[]>();
  let mod: IStudyModule | null = null;
  if (number != null) {
    const titled = await StudyItem.find({ userId, classId: cls._id, moduleId: { $ne: null }, title: { $regex: "\\b(lecture|lec)", $options: "i" } }, { title: 1, moduleId: 1 }).lean<IStudyItem[]>();
    const hit = titled.find((it) => lectureOfTitle(it.title) === number);
    mod = (hit && modules.find((m) => String(m._id) === String(hit.moduleId))) || null;
  }
  if (!mod && week != null) {
    mod = modules.find((m) => weekOfName(m.name) === week) ?? null;
    if (!mod && !modules.some((m) => weekOfName(m.name) != null)) mod = modules[week - 1] ?? null;
  }
  if (mod && week == null) week = weekOfName(mod.name);
  return { date, timeZone, moduleId: mod?._id ?? null, number, week, key, moduleName: mod?.name ?? null };
}

/** The owner's notes pages for the lecture (by key, date or number; by week only when none of those is known), with text. */
export async function lectureScopeNotes(userId: Types.ObjectId, cls: IStudyClass, scope: ResolvedLectureScope): Promise<IStudyPage[]> {
  const or: Record<string, unknown>[] = [];
  // a "W8" key selects the week, not a lecture: the week's notes carry lecture keys like "L15"
  const weekKey = !!scope.key && /^w\d+$/i.test(scope.key);
  if (scope.key && !weekKey) or.push({ "lecture.key": scope.key });
  if (scope.date) or.push({ "lecture.date": scope.date });
  if (scope.number != null) or.push({ "lecture.number": scope.number });
  if ((!or.length || weekKey) && scope.week != null) or.push({ week: scope.week });
  if (!or.length) return [];
  return StudyPage.find({ userId, classId: cls._id, deletedAt: null, ocrText: { $nin: [null, ""] }, $or: or }, { title: 1, ocrText: 1, lecture: 1, week: 1 })
    .sort({ createdAt: 1, _id: 1 })
    .limit(30)
    .lean<IStudyPage[]>();
}

// ─── packing ────────────────────────────────────────────────────────────────────────────

export const LECTURE_MATERIAL_MAX_CHARS = 200_000;
/** Every block gets up to this much before any block gets more, so a long deck never crowds out the notes. */
export const LECTURE_MATERIAL_BLOCK_FLOOR = 6000;

const ORDER: CmSourceKind[] = ["slides", "page", "transcript", "notes"];
const LABEL: Partial<Record<CmSourceKind, string>> = { slides: "Lecture slides", page: "Canvas page", transcript: "Lecture transcript", notes: "The student's own notes" };

/**
 * Blocks → one text, slides first, then Canvas pages, transcripts, notes (input order within a
 * kind), within `maxChars`. Priority truncation in two passes: each block first gets a floor —
 * LECTURE_MATERIAL_BLOCK_FLOOR, lowered so that every block's floor fits the budget at once (so the
 * notes, sorted last, keep their share however many slide blocks come first) — then the leftover
 * budget extends blocks in that order. `sources` lists only the blocks that made it in; `truncated` = something was cut.
 */
export function packLectureMaterial(blocks: CmBlock[], maxChars = LECTURE_MATERIAL_MAX_CHARS): { text: string; sources: CmSource[]; truncated: boolean } {
  const ordered = blocks
    .map((b, i) => ({ b: { ...b, text: b.text.trim() }, i }))
    .filter(({ b }) => b.text && ORDER.includes(b.kind))
    .sort((x, y) => ORDER.indexOf(x.b.kind) - ORDER.indexOf(y.b.kind) || x.i - y.i)
    .map(({ b }) => b);
  const head = (b: CmBlock) => `[${LABEL[b.kind]}: ${b.title}]\n`;
  const grant = ordered.map(() => 0);
  let left = maxChars;
  const overheads = ordered.reduce((n, b) => n + head(b).length + 2, 0);
  const floor = ordered.length ? Math.max(0, Math.min(LECTURE_MATERIAL_BLOCK_FLOOR, Math.floor((maxChars - overheads) / ordered.length))) : 0;
  for (const pass of [floor, Infinity])
    ordered.forEach((b, i) => {
      const overhead = grant[i] ? 0 : head(b).length + 2;
      const want = Math.min(b.text.length, pass) - grant[i];
      if (want <= 0 || left - overhead <= 0) return;
      const give = Math.min(want, left - overhead);
      grant[i] += give;
      left -= give + overhead;
    });
  const kept = ordered.map((b, i) => ({ b, n: grant[i] })).filter((x) => x.n > 0);
  return {
    text: kept.map(({ b, n }) => head(b) + b.text.slice(0, n)).join("\n\n"),
    sources: dedupeSources(kept.map(({ b }) => ({ kind: b.kind, title: b.title, ...(b.itemId ? { itemId: b.itemId } : {}) }))),
    truncated: kept.length < ordered.length || kept.some(({ b, n }) => n < b.text.length),
  };
}

/** Scope + everything found for it, packed. */
export async function getLectureMaterial(userId: Types.ObjectId, cls: IStudyClass, q: LectureQuery, maxChars = LECTURE_MATERIAL_MAX_CHARS) {
  const scope = await resolveLectureScope(userId, cls, q);
  // no concept-map prefilter (packLectureMaterial gives each block its share), but extraction stays
  // bounded: decks stop parsing once their capped text passes 3× the output budget (~10 decks)
  const blocks = await lectureMaterial(userId, cls, scope, 0, LECTURE_MATERIAL_MAX_CHARS * 3);
  for (const p of await lectureScopeNotes(userId, cls, scope)) blocks.push({ kind: "notes", title: p.title || "Notes page", text: p.ocrText ?? "" });
  return { scope, ...packLectureMaterial(blocks, maxChars) };
}
