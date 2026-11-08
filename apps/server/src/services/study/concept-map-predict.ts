import { Types } from "mongoose";
import { IStudyClass } from "@/models/study/class";
import { IStudyConceptMap, StudyConceptMap } from "@/models/study/concept-map";
import { IStudyItem, StudyItem } from "@/models/study/item";
import { IStudyModule, StudyModule } from "@/models/study/module";
import { IStudyClassGuide, StudyClassGuide } from "@/models/study/library";
import { Spend } from "./ai-models";
import { cmTextJson } from "./cm-text";
import {
  CM_CONTEXT_MAX_CHARS,
  CM_LIBRARY_HIT_CHARS,
  CmBlock,
  CmSource,
  dedupeSources,
  hitTitle,
  lectureMaterial,
  lectureScope,
  LectureScope,
  localDate,
  meetingDays,
  packContext,
  shiftDate,
  snapToMeeting,
} from "./concept-map-context";
import { CM_PREDICT_SYSTEM_PROMPT, examFocus, parsePredictions, Prediction } from "./concept-maps";
import { lectureOfTitle, resolveLectureScope, weekOfName } from "./lecture-material";
import { retrieveLibrary } from "./library";
import { DEFAULT_MEETING_TZ, resolveMeetings } from "./views";

/**
 * Concept-map prediction (POST /study/concept-maps/predict, and the leave-one-out backtest in
 * tests/harness/study-cm-predict-backtest.ts — both call predictConceptMap, so the backtest
 * measures the real code). A concept map is one lecture, so the method is lecture-first:
 *   1. a lecture timeline from Canvas: every "Lecture N" module item, dated by the lecture's own
 *      assignments ("Lecture Activity N" is due at the end of that meeting), with the readings
 *      that run up to its "Lecture N" marker in the week's module;
 *   2. each past map → its lecture by date (lectureScope: the assignment's due date snapped to a
 *      meeting day), else by its module + number;
 *   3. the next lecture = the first one after the last map's date (an explicit lecture / week wins);
 *   4. the turn = every past map (its lecture's readings, terms, term count, model answer) + that
 *      next lecture's own readings, overview and supporting videos; the textbook comes last.
 */

// ─── lecture timeline ───────────────────────────────────────────────────────────────────

export interface TimelineLecture {
  number: number;
  /** "Lecture 11: Cell Division (Part II); Meiosis" — the readings when known. */
  title: string;
  readings: string[];
  /** Class-local meeting date (YYYY-MM-DD) from the lecture's dated items, null when none is dated. */
  date: string | null;
  week: number | null;
  moduleId: Types.ObjectId | null;
}

export type TimelineItem = Pick<IStudyItem, "title" | "type" | "moduleId" | "modulePosition" | "dueAt" | "effectiveDueAt">;

const READING = /\breading\b/i;
/** "📚 Reading - 5.4 Cell Division (Part I)" → "5.4 Cell Division (Part I)". */
export const readingTitle = (t: string) =>
  t
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/^reading\s*[-–:.]?\s*/i, "")
    .trim();
const lectureTitle = (n: number, readings: string[]) => (readings.length ? `Lecture ${n}: ${readings.join("; ")}` : `Lecture ${n}`).slice(0, 300);

/**
 * Module items → the class's lectures, by number. Lecture N = every item titled with it (the
 * "Lecture N. Supporting videos" page, the "Lecture Activity N" assignment…): its module is the
 * first non-assignment one's, its date the earliest live due date among them (class-local, snapped
 * to a meeting day). Its readings = the "Reading" items after the previous lecture marker in the
 * module, up to its own. Its week = the module's name, else a "Week N" item title in the module.
 */
export function buildLectureTimeline(items: TimelineItem[], modules: Array<Pick<IStudyModule, "_id" | "name">>, o: { timeZone: string; days: Set<string> }): TimelineLecture[] {
  const byNo = new Map<number, TimelineLecture>();
  const mods = new Map(modules.map((m) => [String(m._id), m]));
  const ordered = [...items].sort((a, b) => Number(a.type === "assignment") - Number(b.type === "assignment"));
  for (const it of ordered) {
    const n = lectureOfTitle(it.title);
    if (n == null) continue;
    const l = byNo.get(n) ?? { number: n, title: `Lecture ${n}`, readings: [], date: null, week: null, moduleId: null };
    l.moduleId ??= it.moduleId ?? null;
    const due = it.effectiveDueAt ?? it.dueAt;
    if (due) {
      const d = snapToMeeting(localDate(new Date(due), o.timeZone), o.days);
      if (!l.date || d < l.date) l.date = d;
    }
    byNo.set(n, l);
  }
  const byModule = new Map<string, TimelineItem[]>();
  for (const it of items) if (it.moduleId && it.type !== "assignment") byModule.set(String(it.moduleId), [...(byModule.get(String(it.moduleId)) ?? []), it]);
  for (const [mid, list] of byModule) {
    list.sort((a, b) => (a.modulePosition ?? 1e9) - (b.modulePosition ?? 1e9));
    const week = weekOfName(mods.get(mid)?.name) ?? list.map((it) => weekOfName(it.title)).find((w) => w != null) ?? null;
    let run: string[] = [];
    for (const it of list) {
      const n = lectureOfTitle(it.title);
      if (n == null) {
        if (READING.test(it.title)) run.push(readingTitle(it.title));
        continue;
      }
      const l = byNo.get(n);
      if (l && String(l.moduleId) === mid && !l.readings.length) l.readings = run;
      run = [];
    }
    for (const l of byNo.values()) if (String(l.moduleId) === mid) l.week ??= week;
  }
  for (const l of byNo.values()) l.title = lectureTitle(l.number, l.readings);
  return [...byNo.values()].sort((a, b) => a.number - b.number);
}

/** The class's lecture timeline + its meeting time zone and days. */
export async function loadLectureTimeline(userId: Types.ObjectId, cls: IStudyClass): Promise<{ timeline: TimelineLecture[]; timeZone: string; days: Set<string> }> {
  const [items, modules, meetings] = await Promise.all([
    StudyItem.find({ userId, classId: cls._id, moduleId: { $ne: null }, type: { $in: ["page", "file", "video", "assignment", "quiz"] } }, { title: 1, type: 1, moduleId: 1, modulePosition: 1, dueAt: 1, effectiveDueAt: 1 }).lean<
      IStudyItem[]
    >(),
    StudyModule.find({ userId, classId: cls._id }, { name: 1, position: 1 }).sort({ position: 1, _id: 1 }).lean<IStudyModule[]>(),
    resolveMeetings(userId, [cls]).then((r) => r.get(String(cls._id))?.meetings ?? null),
  ]);
  const timeZone = meetings?.timeZone ?? DEFAULT_MEETING_TZ;
  const days = meetingDays(meetings);
  return { timeline: buildLectureTimeline(items, modules, { timeZone, days }), timeZone, days };
}

/** A past map's lecture: the timeline lecture on its date, else the one in its module with its number (or the module's only one). */
export function lectureOfMap(timeline: TimelineLecture[], scope: Pick<LectureScope, "date" | "moduleId" | "number">): TimelineLecture | null {
  if (scope.date) {
    const onDate = timeline.find((l) => l.date === scope.date);
    if (onDate) return onDate;
  }
  if (scope.moduleId) {
    const inModule = timeline.filter((l) => l.moduleId && String(l.moduleId) === String(scope.moduleId));
    return inModule.find((l) => l.number === scope.number) ?? (inModule.length === 1 ? inModule[0] : null);
  }
  return null;
}

/**
 * The lecture after `after` (the last past map): the lowest-numbered lecture that comes later —
 * by date when both are dated, else by number. `after` null = the first lecture.
 */
export function nextLecture(timeline: TimelineLecture[], after: { date: string | null; number: number | null } | null): TimelineLecture | null {
  if (!after) return timeline[0] ?? null;
  const later = timeline.filter((l) => (after.date && l.date ? l.date > after.date : after.number != null && l.number > after.number));
  return later.sort((a, b) => a.number - b.number)[0] ?? null;
}

/** Current course week from the exam schedule (any entry with both week + date anchors week 1). */
export function currentWeek(schedule: Array<{ week: number | null; date: string | null }>, now = new Date()): number | null {
  const a = schedule.find((e) => e.week && e.date);
  if (!a) return null;
  const week1 = new Date(`${a.date}T00:00:00Z`).getTime() - (a.week! - 1) * 7 * 86400e3;
  return Math.max(1, Math.floor((now.getTime() - week1) / (7 * 86400e3)) + 1);
}

// ─── few-shot ───────────────────────────────────────────────────────────────────────────

/** Share of the predict turn's budget the past maps may take, and the cap on each model answer in them. */
export const PREDICT_PAST_SHARE = 0.3;
export const PREDICT_ANSWER_MAX = 8000;

export type PastMap = Pick<IStudyConceptMap, "number" | "week" | "lecture" | "promptTerms" | "instructor"> & { readings?: string[] };

/**
 * Past maps (oldest first) → the PAST CONCEPT MAPS lines within `max` chars: each map's terms and
 * term count, its lecture's readings, and the professor's model answer (capped at
 * PREDICT_ANSWER_MAX). Over the limit, the oldest maps lose their model answer first, then (still
 * over) the oldest lines go entirely. `kept` = how many maps are still listed.
 */
export function packPastPrompts(maps: PastMap[], max: number): { text: string; kept: number } {
  const rows = maps.map((m) => ({
    line:
      `- Concept Map ${m.number ?? "?"} (week ${m.week ?? "?"}${m.lecture ? `, ${m.lecture}` : ""}): ${(m.promptTerms ?? []).join(", ")}  [${(m.promptTerms ?? []).length} term${(m.promptTerms ?? []).length === 1 ? "" : "s"}]` +
      (m.readings?.length ? `\n  Lecture readings: ${m.readings.join("; ")}` : ""),
    answer: m.instructor?.modelAnswer?.trim() ? `\n  Professor's model answer: ${m.instructor.modelAnswer.trim().slice(0, PREDICT_ANSWER_MAX).replace(/\n+/g, "\n  ")}` : "",
    keep: true,
  }));
  let size = rows.reduce((n, r) => n + r.line.length + r.answer.length + 1, 0);
  for (const r of rows) {
    if (size <= max) break;
    size -= r.answer.length;
    r.answer = "";
  }
  for (const r of rows) {
    if (size <= max) break;
    size -= r.line.length + 1;
    r.keep = false;
  }
  const kept = rows.filter((r) => r.keep);
  return { text: kept.map((r) => r.line + r.answer).join("\n"), kept: kept.length };
}

// ─── the prediction ─────────────────────────────────────────────────────────────────────

export interface PredictLecture {
  number: number | null;
  title: string | null;
  date: string | null;
  week: number | null;
}

export interface PredictResult {
  lecture: PredictLecture;
  /** null = the reply held no usable prompt. */
  prediction: Prediction | null;
  model: string;
  sources: CmSource[];
  /** The past maps the turn could see (for the backtest's leakage check and the log). */
  visible: Array<{ number: number | null; lecture: number | null }>;
  /** "posted" = a Canvas page/slide deck in the context lists the prompt (postedPrompt); "predicted" otherwise. */
  source: "posted" | "predicted";
  /** The page/slide blocks that list the prompt — what the live tool reports as "found in the posted …". */
  posted: CmSource[];
  /** Backtest only: blocks the leakage guard removed (they name a hidden map, or list a hidden map's terms). */
  dropped: CmSource[];
  /** The blocks the turn was packed from (after the guard), and the turn that answered — for --trace-leak. */
  blocks: CmBlock[];
  turn: string;
  raw: unknown;
}

// ─── posted prompts / leakage guard ─────────────────────────────────────────────────────

const NAMED = /\bconcept\s*maps?\s*#?\s*(\d{1,3})(?!\d)/gi;
/** The concept-map numbers a text names ("Concept Map 10", "concept map #7"). */
export const mapsNamed = (text: string) => new Set([...text.matchAll(NAMED)].map((m) => Number(m[1])));

const LIST_GAP_MAX = 40;
const LIST_SEP = /^[\s,;:\-–—•*·|/().\d]*(?:\b(?:and|or)\b|&)?[\s,;:\-–—•*·|/().\d]*$/i;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does `text` LIST these terms — a run of them separated only by commas, bullets, table bars,
 * numbering or "and" (≤ LIST_GAP_MAX chars apart)? Prose that merely uses the terms does not
 * count. A list holding all of a ≤ 3-term prompt, or ¾ of a longer one, counts.
 */
export function listsTerms(text: string, terms: string[]): boolean {
  const ts = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (ts.length < 2) return false;
  const need = ts.length <= 3 ? ts.length : Math.ceil(0.75 * ts.length);
  const low = text.toLowerCase();
  const occ: Array<{ start: number; end: number; t: number }> = [];
  ts.forEach((t, i) => {
    for (const m of low.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escRe(t)}(?![\\p{L}\\p{N}])`, "gu"))) occ.push({ start: m.index!, end: m.index! + t.length, t: i });
  });
  occ.sort((a, b) => a.start - b.start || b.end - a.end);
  for (let i = 0; i < occ.length; i++) {
    const seen = new Set([occ[i].t]);
    let end = occ[i].end;
    for (let j = i + 1; j < occ.length && seen.size < need; j++) {
      if (occ[j].start < end) continue;
      const gap = low.slice(end, occ[j].start);
      if (gap.length > LIST_GAP_MAX || !LIST_SEP.test(gap)) break;
      seen.add(occ[j].t);
      end = occ[j].end;
    }
    if (seen.size >= need) return true;
  }
  return false;
}

/** What the professor posts on Canvas (not the textbook, not a recording). */
const POSTED_KINDS = new Set(["page", "slides"]);
const blockSource = (b: CmBlock): CmSource => ({ kind: b.kind, title: b.title, ...(b.itemId ? { itemId: b.itemId } : {}) });

/**
 * The posted-prompt rule, the same for live and backtest: a Canvas page or slide deck in the
 * lecture's context that lists the prompt's terms means the prompt was POSTED, not predicted.
 * Live checks the predicted prompt (the professor's page is legitimate context and is kept);
 * the backtest checks the hidden map's real terms against the context before its guard.
 */
export const postedIn = (blocks: CmBlock[], terms: string[]) => blocks.filter((b) => POSTED_KINDS.has(b.kind) && listsTerms(b.text, terms)).map(blockSource);

/** Backtest guard: a block that names a hidden map ("Concept Map n", n ≥ hideFrom) or lists a hidden map's terms is leakage. */
export const leaksHidden = (b: CmBlock, hidden: Array<{ number: number | null; promptTerms: string[] }>) => {
  const named = mapsNamed(`${b.title}\n${b.text}`);
  return hidden.some((h) => (h.number != null && named.has(h.number)) || listsTerms(b.text, h.promptTerms ?? []));
};

/** Textbook hits for the next lecture (its readings as the query, its week as a boost) — the lowest-priority block. */
const PREDICT_LIBRARY_LIMIT = 20;

/**
 * Predict the next concept map of `cls`. `override` = an explicit lecture number / week (the
 * request body). `hideFrom` (backtest) hides every map numbered ≥ it — their terms, answers and
 * dates — so "next" is the lecture after the last visible map and the exam focus is as of that
 * date. Lecture recordings and notes are never read: the lecture has not happened yet (and in a
 * backtest they would leak the answer).
 */
export async function predictConceptMap(o: {
  userId: Types.ObjectId;
  cls: IStudyClass;
  spend: Spend;
  signal: AbortSignal;
  override?: { lecture?: number | null; week?: number | null };
  hideFrom?: number | null;
  now?: Date;
}): Promise<PredictResult> {
  const { userId, cls } = o;
  const backtest = o.hideFrom != null;
  const [maps, { timeline, timeZone, days }, guide, hidden] = await Promise.all([
    StudyConceptMap.find({
      userId,
      canvasCourseId: cls.canvasCourseId,
      source: { $ne: "practice" },
      "promptTerms.0": { $exists: true },
      ...(backtest ? { number: { $lt: o.hideFrom } } : {}),
    })
      .sort({ number: 1, _id: 1 })
      .lean<IStudyConceptMap[]>(),
    loadLectureTimeline(userId, cls),
    StudyClassGuide.findOne({ userId, canvasCourseId: cls.canvasCourseId }, { examsSchedule: 1 }).lean<IStudyClassGuide>(),
    // backtest: the hidden maps, read ONLY by the leakage guard and the posted check — never by the turn
    backtest
      ? StudyConceptMap.find({ userId, canvasCourseId: cls.canvasCourseId, source: { $ne: "practice" }, number: { $gte: o.hideFrom } }, { number: 1, promptTerms: 1 }).lean<IStudyConceptMap[]>()
      : Promise.resolve([] as IStudyConceptMap[]),
  ]);

  // 2. past maps → their lectures
  const past: Array<{ m: IStudyConceptMap; scope: LectureScope; lecture: TimelineLecture | null }> = [];
  for (const m of maps) {
    const scope = await lectureScope(userId, cls, m);
    past.push({ m, scope, lecture: lectureOfMap(timeline, scope) });
  }
  // the latest map: by number (maps are numbered in class order), date only to break ties — an
  // undated newer map must not sort before every dated one and let its own lecture be re-predicted
  const last = [...past].sort((a, b) => (a.m.number ?? 0) - (b.m.number ?? 0) || String(a.scope.date ?? "").localeCompare(String(b.scope.date ?? ""))).pop() ?? null;
  const after = last ? { date: last.scope.date, number: last.lecture?.number ?? last.m.number ?? null } : null;
  const now = o.now ?? (backtest && last?.scope.date ? new Date(`${last.scope.date}T23:00:00Z`) : new Date());

  // 3. the next lecture
  let target: TimelineLecture | null = null;
  const week = o.override?.week ?? (o.override?.lecture == null && !after ? currentWeek(guide?.examsSchedule ?? [], now) : null);
  if (o.override?.lecture != null) target = timeline.find((l) => l.number === o.override!.lecture) ?? null;
  else if (week != null) {
    const inWeek = timeline.filter((l) => l.week === week);
    target = nextLecture(inWeek, after) ?? inWeek[0] ?? null;
  } else target = nextLecture(timeline, after);
  let scope: LectureScope;
  if (target) scope = { date: target.date, timeZone, moduleId: target.moduleId, number: target.number, week: target.week };
  else {
    // no "Lecture N" item for it: the next meeting after the last map, found like the MCP finds a lecture
    let date: string | null = null;
    if (after?.date && days.size)
      for (let k = 1; k <= 7 && !date; k++) {
        const d = shiftDate(after.date, k);
        if (snapToMeeting(d, days) === d) date = d;
      }
    const number = o.override?.lecture ?? (week == null && after?.number != null ? after.number + 1 : null);
    const r = await resolveLectureScope(userId, cls, { lecture: { number, ...(date && week == null ? { date } : {}) }, ...(week != null ? { week } : {}) });
    scope = { date: r.date, timeZone, moduleId: r.moduleId, number: r.number, week: r.week };
  }
  const lecture: PredictLecture = { number: scope.number, title: target?.title ?? (scope.number != null ? `Lecture ${scope.number}` : null), date: scope.date, week: scope.week };

  // 4. the next lecture's own material (no recordings: date null), then the textbook
  const found: CmBlock[] = scope.moduleId ? await lectureMaterial(userId, cls, { ...scope, date: null }, 0, CM_CONTEXT_MAX_CHARS, { ownLecture: true }) : [];
  const query = (target?.readings ?? []).map((r) => r.replace(/^\d+(\.\d+)*\s*/, "")).join(" ");
  const hits = query || scope.week != null ? await retrieveLibrary({ userId, canvasCourseId: cls.canvasCourseId, query, week: scope.week, limit: PREDICT_LIBRARY_LIMIT, maxChars: CM_LIBRARY_HIT_CHARS }) : [];
  for (const h of hits) found.push({ kind: "textbook", title: hitTitle(h), text: h.text });
  const blocks = backtest ? found.filter((b) => !leaksHidden(b, hidden)) : found;
  const dropped = found.filter((b) => !blocks.includes(b)).map(blockSource);
  // The concept map this lecture gets: the last map's number moved by as many lectures as the target is ahead.
  const mapNumber = backtest ? o.hideFrom! : last?.m.number != null ? last.m.number + (target && last.lecture ? target.number - last.lecture.number : 1) : null;
  const naming = mapNumber != null ? blocks.filter((b) => mapsNamed(`${b.title}\n${b.text}`).has(mapNumber)) : [];

  const focus = await examFocus(userId, cls.canvasCourseId, now);
  const counts = maps.map((m) => m.promptTerms.length);
  const pastMaps: PastMap[] = past.map(({ m, lecture: l }) => ({ ...m, readings: l?.readings ?? [] }));
  // The past maps lead (the class-wide, cacheable prefix): at most PREDICT_PAST_SHARE of the budget, the material gets the rest.
  const fixed = (max: number) => {
    const p = packPastPrompts(pastMaps, Math.floor(max * PREDICT_PAST_SHARE));
    const text = [
      "PAST CONCEPT MAPS (the professor's own prompts, oldest first):",
      p.text || "(none)",
      counts.length ? `HER TERM COUNTS: ${counts.join(", ")} (usual: ${[...counts].sort((a, b) => a - b)[Math.floor(counts.length / 2)]})` : "",
      [
        `NEXT LECTURE: ${lecture.title ?? "unknown"}`,
        lecture.date ? `date ${lecture.date}` : "",
        lecture.week != null ? `week ${lecture.week}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      target?.readings.length ? `ITS READINGS: ${target.readings.join("; ")}` : "",
      focus.next ? `NEXT EXAM: ${focus.next.name}${focus.next.date ? ` (${focus.next.date})` : ""} — ${[...focus.next.chapters, ...focus.next.topics].join(", ")}. Slightly prefer terms on it.` : "",
      !backtest && focus.weak.length ? `WEAK AREAS from real exam results: ${focus.weak.join(", ")}.` : "",
      naming.length ? `POSTED: ${naming.map((b) => `«${b.title}»`).join(", ")} names Concept Map ${mapNumber} — if it lists the prompt terms, those ARE the prompt: return them exactly, p 1.` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { text, kept: p.kept };
  };
  const packed = (max: number) => packContext(blocks, Math.max(0, max - fixed(max).text.length - 40));
  let turn = "";
  const { out: raw, model, maxChars } = await cmTextJson(CM_PREDICT_SYSTEM_PROMPT, (max) => (turn = `${fixed(max).text}\n\nNEXT LECTURE MATERIAL:\n${packed(max).context || "(none found)"}`), o.spend, {
    signal: o.signal,
    maxTokens: 16_000,
  });
  const answered = maxChars ?? CM_CONTEXT_MAX_CHARS;
  const pastKept = fixed(answered).kept;
  const prediction = parsePredictions(raw);
  // live: does a posted page list what we predicted? backtest: did one list the real terms (before the guard dropped it)?
  const posted = backtest ? postedIn(found, hidden.find((h) => h.number === o.hideFrom)?.promptTerms ?? []) : postedIn(blocks, prediction?.prompt ?? []);
  return {
    lecture,
    prediction,
    source: posted.length ? "posted" : "predicted",
    posted: dedupeSources(posted),
    dropped: dedupeSources(dropped),
    blocks,
    turn,
    model,
    sources: dedupeSources([...(pastKept ? [{ kind: "past_maps" as const, title: `Past concept maps (${pastKept})` }] : []), ...packed(answered).sources]),
    visible: past.map((p) => ({ number: p.m.number, lecture: p.lecture?.number ?? null })),
    raw,
  };
}

// ─── backtest scoring ───────────────────────────────────────────────────────────────────

/** A term for comparison: lowercase, no punctuation or leading article, plurals folded ("The Lava Flows" → "lava flow"). */
export const normTerm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/^\s*(the|a|an)\s+/, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w))
    .join(" ");

/** Predicted vs actual terms: how many of the actual ones match exactly (case-insensitive) and after normTerm. */
export function termOverlap(predicted: string[], actual: string[]): { exact: number; normalised: number; actual: number; predicted: number } {
  const exact = new Set(predicted.map((t) => t.trim().toLowerCase()));
  const norm = new Set(predicted.map(normTerm));
  return {
    exact: actual.filter((t) => exact.has(t.trim().toLowerCase())).length,
    normalised: actual.filter((t) => norm.has(normTerm(t))).length,
    actual: actual.length,
    predicted: predicted.length,
  };
}
