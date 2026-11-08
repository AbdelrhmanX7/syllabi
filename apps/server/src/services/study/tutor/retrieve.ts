import { Types } from "mongoose";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyPage, IStudyPage } from "@/models/study/page";
import { StudyLecture, IStudyLecture } from "@/models/study/lecture";
import { StudyTranscript, IStudyTranscript, TranscriptSegment } from "@/models/study/transcript";
import { StudyQuestion, IStudyQuestion } from "@/models/study/question";
import type { TutorSource } from "@/models/study/conversation";
import { htmlToText } from "../extract-sources";
import { ClassRef, searchConceptMaps, searchLibrary } from "./deps";
import { anyTermRx, bestWindow, clip, overlap } from "./text";

/**
 * Tutor retrieval (RAG without vectors). Candidates come from Mongo with a regex pre-filter on
 * the query terms, every query scoped to the caller's `userId` (and the class when there is
 * one); each candidate is scored by distinct-term overlap (+ title boost), cut to the window
 * around its densest hits, and the top K fill a character budget. Context the student is
 * looking at (`itemId`, `pageId`, `lectureId`, `videoAt`) is PINNED: always in, ranked first.
 */
export const TOP_K = 8;
export const CHAR_BUDGET = 7000;
export const SNIPPET_CHARS = 900;
/** `videoAt` pulls the transcript within ±this many seconds of `t`. */
export const VIDEO_WINDOW_S = 60;
const SOURCE_SNIPPET = 240;
/** Transcript rows pulled per question (class-wide: every video item + lecture is in scope; this caps the read). */
const TRANSCRIPT_ROWS = 40;
/** Best windows kept per transcript. */
const WINDOWS_PER_TRANSCRIPT = 2;

export interface Snippet {
  source: TutorSource;
  /** What the model sees. */
  text: string;
  score: number;
  pinned: boolean;
}

export interface RetrieveInput {
  userId: Types.ObjectId;
  classId: Types.ObjectId | null;
  cls: ClassRef | null;
  terms: string[];
  itemId?: Types.ObjectId | null;
  pageId?: Types.ObjectId | null;
  lectureId?: Types.ObjectId | null;
  videoAt?: { itemId: Types.ObjectId; t: number } | null;
}

export interface Retrieved {
  snippets: Snippet[];
  /** Related bank questions (prompt context only; never cited as a source). */
  questions: Array<Pick<IStudyQuestion, "_id" | "stem" | "answer" | "topic">>;
}

const mk = (kind: TutorSource["kind"], id: unknown, title: string, text: string, score: number, pinned: boolean, extra: Partial<TutorSource> = {}): Snippet => ({
  source: { kind, id: String(id), title: title || kind, snippet: clip(text, SOURCE_SNIPPET), ...extra },
  text,
  score,
  pinned,
});

/** The segments within ±VIDEO_WINDOW_S of `t`, as one passage, and where it starts. */
export function segmentsAround(segments: TranscriptSegment[], t: number, windowS = VIDEO_WINDOW_S): { text: string; start: number } | null {
  const hit = (segments ?? []).filter((s) => Number(s.end ?? s.start) >= t - windowS && Number(s.start) <= t + windowS);
  if (!hit.length) return null;
  return { text: hit.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim(), start: hit[0].start };
}

/** Consecutive ~60 s buckets of a transcript, scored; the best `n` that hit any term. */
export function bestTranscriptWindows(segments: TranscriptSegment[], terms: string[], n = 2, bucketS = 60): Array<{ text: string; start: number; score: number }> {
  const buckets: Array<{ text: string; start: number }> = [];
  for (const s of segments ?? []) {
    const last = buckets[buckets.length - 1];
    if (!last || s.start - last.start >= bucketS) buckets.push({ text: s.text, start: s.start });
    else last.text += ` ${s.text}`;
  }
  return buckets
    .map((b) => ({ ...b, score: overlap(b.text, terms) }))
    .filter((b) => b.score > 0)
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, n);
}

/** A retrieval candidate before scoring: what the model sees plus the text its score is measured on. */
interface Cand {
  snip: Snippet;
  /** Body text the terms are matched against. */
  hay: string;
  title: string;
  /** Title hits count this many times (items 3, pages 2, transcripts 3). */
  tw: number;
}
const cand = (snip: Snippet, hay: string, title: string, tw: number): Cand => ({ snip, hay, title, tw });

/**
 * IDF-ish weight per term over the candidate pool: a term in nearly every candidate ("video",
 * "professor") counts little, a rare proper noun ("melvin", "hanford") counts a lot; longer
 * terms get a small bonus. Floor keeps a ubiquitous term from scoring zero.
 */
export function termWeights(terms: string[], pool: string[]): Map<string, number> {
  const n = Math.max(pool.length, 1);
  const lower = pool.map((t) => t.toLowerCase());
  const w = new Map<string, number>();
  for (const term of terms) {
    const df = lower.reduce((c, t) => c + (t.includes(term) ? 1 : 0), 0);
    const idf = Math.max(0.25, Math.log(1 + n / (1 + df)));
    w.set(term, idf * (1 + Math.min(Math.max(term.length - 4, 0), 6) / 10));
  }
  return w;
}

export function weightedOverlap(text: string, terms: string[], weights: Map<string, number>): number {
  if (!text) return 0;
  const t = text.toLowerCase();
  let sum = 0;
  for (const term of terms) if (t.includes(term)) sum += weights.get(term) ?? 1;
  return sum;
}

/** Scores the whole pool with one set of weights; the title boost applies only to a candidate that hits the body. */
export function scoreCandidates(cands: Cand[], terms: string[]): Snippet[] {
  const weights = termWeights(terms, cands.map((c) => `${c.hay} ${c.title}`));
  return cands.map((c) => {
    const body = weightedOverlap(c.hay, terms, weights);
    return { ...c.snip, score: body > 0 ? body + c.tw * weightedOverlap(c.title, terms, weights) : 0 };
  });
}

/** Consecutive segments merged into windows of ~`targetS` seconds (never more than `maxS`). */
export function transcriptWindows(segments: TranscriptSegment[], targetS = 45, maxS = 60): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let cur: { text: string; start: number } | null = null;
  for (const s of segments ?? []) {
    if (cur && (s.start - cur.start >= targetS || s.start - cur.start >= maxS)) {
      out.push(cur);
      cur = null;
    }
    if (!cur) cur = { text: String(s.text ?? ""), start: s.start };
    else cur.text += ` ${s.text}`;
  }
  if (cur) out.push(cur);
  return out;
}

async function pinnedSnippets(input: RetrieveInput): Promise<Snippet[]> {
  const { userId, terms } = input;
  const out: Snippet[] = [];
  if (input.videoAt) {
    const [item, tr] = await Promise.all([
      StudyItem.findOne({ _id: input.videoAt.itemId, userId }, { title: 1 }).lean<IStudyItem>(),
      StudyTranscript.findOne({ userId, itemId: input.videoAt.itemId, status: "ready" }, { segments: 1 }).lean<IStudyTranscript>(),
    ]);
    const around = tr ? segmentsAround(tr.segments, input.videoAt.t) : null;
    if (item && around) out.push(mk("transcript", item._id, item.title, clip(around.text, SNIPPET_CHARS * 2), 1000, true, { t: around.start }));
  }
  if (input.itemId && !(input.videoAt && String(input.videoAt.itemId) === String(input.itemId))) {
    const item = await StudyItem.findOne({ _id: input.itemId, userId }, { title: 1, html: 1, type: 1 }).lean<IStudyItem>();
    if (item) {
      const body = htmlToText(item.html ?? "");
      if (body) out.push(mk("item", item._id, item.title, bestWindow(body, terms, SNIPPET_CHARS * 2), 900, true));
      else if (item.type === "video") {
        const tr = await StudyTranscript.findOne({ userId, itemId: item._id, status: "ready" }, { segments: 1 }).lean<IStudyTranscript>();
        const w = tr ? bestTranscriptWindows(tr.segments, terms, 1)[0] : null;
        if (w) out.push(mk("transcript", item._id, item.title, w.text, 900, true, { t: w.start }));
      }
    }
  }
  if (input.lectureId) {
    const [lec, tr] = await Promise.all([
      StudyLecture.findOne({ _id: input.lectureId, userId }, { title: 1 }).lean<IStudyLecture>(),
      StudyTranscript.findOne({ userId, lectureId: input.lectureId, status: "ready" }, { segments: 1 }).lean<IStudyTranscript>(),
    ]);
    const w = lec && tr ? (bestTranscriptWindows(tr.segments, terms, 1)[0] ?? (tr.segments.length ? { text: tr.segments.slice(-20).map((s) => s.text).join(" "), start: tr.segments[Math.max(0, tr.segments.length - 20)].start } : null)) : null;
    if (lec && w) out.push(mk("transcript", lec._id, lec.title, clip(w.text, SNIPPET_CHARS * 2), 800, true, { t: w.start }));
  }
  if (input.pageId) {
    const page = await StudyPage.findOne({ _id: input.pageId, userId, deletedAt: null }, { title: 1, ocrText: 1 }).lean<IStudyPage>();
    if (page?.ocrText?.trim()) out.push(mk("page", page._id, page.title || "Notebook page", bestWindow(page.ocrText, terms, SNIPPET_CHARS * 2), 800, true));
  }
  return out;
}

async function searchItems(input: RetrieveInput, rx: { $regex: string; $options: string }): Promise<Cand[]> {
  const scope = input.classId ? { userId: input.userId, classId: input.classId } : { userId: input.userId };
  const items = await StudyItem.find({ ...scope, $or: [{ title: rx }, { html: rx }] }, { title: 1, html: 1 }).limit(60).lean<IStudyItem[]>();
  // A title-only row (a video, a file) has nothing to quote — videos come in via transcripts.
  return items.filter((it) => htmlToText(it.html ?? "").length > 0).map((it) => {
    const body = htmlToText(it.html ?? "");
    return cand(mk("item", it._id, it.title, bestWindow(body || it.title, input.terms, SNIPPET_CHARS), 0, false), body, it.title, 3);
  });
}

async function searchTranscripts(input: RetrieveInput, rx: { $regex: string; $options: string }): Promise<Cand[]> {
  const { userId, classId, terms } = input;
  let scope: Record<string, unknown> = { userId };
  const titles = new Map<string, string>();
  if (classId) {
    const [videos, lectures] = await Promise.all([
      StudyItem.find({ userId, classId, type: "video" }, { title: 1 }).limit(1000).lean<IStudyItem[]>(),
      StudyLecture.find({ userId, classId }, { title: 1 }).limit(1000).lean<IStudyLecture[]>(),
    ]);
    for (const v of [...videos, ...lectures]) titles.set(String(v._id), v.title);
    if (!videos.length && !lectures.length) return [];
    scope = { userId, $or: [{ itemId: { $in: videos.map((v) => v._id) } }, { lectureId: { $in: lectures.map((l) => l._id) } }] };
  }
  const rows = await StudyTranscript.find({ ...scope, status: "ready", "segments.text": rx }, { itemId: 1, lectureId: 1, segments: 1 }).sort({ updatedAt: -1 }).limit(TRANSCRIPT_ROWS).lean<IStudyTranscript[]>();
  if (!classId) {
    const itemIds = rows.filter((r) => r.itemId).map((r) => r.itemId);
    const lectureIds = rows.filter((r) => r.lectureId).map((r) => r.lectureId);
    const [its, lecs] = await Promise.all([
      StudyItem.find({ _id: { $in: itemIds }, userId }, { title: 1 }).lean<IStudyItem[]>(),
      StudyLecture.find({ _id: { $in: lectureIds }, userId }, { title: 1 }).lean<IStudyLecture[]>(),
    ]);
    for (const v of [...its, ...lecs]) titles.set(String(v._id), v.title);
  }
  // Every ~45 s window of every matching transcript is a candidate; scoring (and the best-2 cut) is in retrieve().
  const out: Cand[] = [];
  for (const r of rows) {
    const id = String(r.itemId ?? r.lectureId);
    const title = titles.get(id) ?? "Transcript";
    for (const w of transcriptWindows(r.segments)) if (overlap(w.text, terms) > 0) out.push(cand(mk("transcript", id, title, clip(w.text, SNIPPET_CHARS), 0, false, { t: w.start }), w.text, title, 3));
  }
  return out;
}

async function searchPages(input: RetrieveInput, rx: { $regex: string; $options: string }): Promise<Cand[]> {
  const scope = input.classId ? { userId: input.userId, classId: input.classId } : { userId: input.userId };
  const pages = await StudyPage.find({ ...scope, deletedAt: null, ocrText: rx }, { title: 1, ocrText: 1 }).limit(30).lean<IStudyPage[]>();
  return pages.map((p) => cand(mk("page", p._id, p.title || "Notebook page", bestWindow(p.ocrText ?? "", input.terms, SNIPPET_CHARS), 0, false), p.ocrText ?? "", p.title ?? "", 2));
}

async function searchQuestions(input: RetrieveInput, rx: { $regex: string; $options: string }) {
  const scope = input.classId ? { userId: input.userId, classId: input.classId } : { userId: input.userId };
  const rows = await StudyQuestion.find({ ...scope, $or: [{ stem: rx }, { topic: rx }] }, { stem: 1, answer: 1, topic: 1 }).limit(30).lean<IStudyQuestion[]>();
  return rows
    .map((q) => ({ q, s: overlap(q.stem, input.terms) + overlap(q.topic, input.terms) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map(({ q }) => ({ _id: q._id, stem: clip(q.stem, 500), answer: clip(q.answer ?? "", 300), topic: q.topic }));
}

/** Pinned first, then by score; dedupe by (kind,id,window); top K within the char budget. */
export function rank(snippets: Snippet[], k = TOP_K, budget = CHAR_BUDGET): Snippet[] {
  const seen = new Set<string>();
  const sorted = [...snippets].filter((s) => s.text.trim() && (s.pinned || s.score > 0)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score);
  const out: Snippet[] = [];
  let used = 0;
  for (const s of sorted) {
    const key = `${s.source.kind}:${s.source.id}:${s.source.t ?? ""}:${s.text.slice(0, 60)}`;
    if (seen.has(key)) continue;
    if (out.length >= k) break;
    const room = budget - used;
    if (room < 200 && out.length) break;
    const text = s.text.length > room ? clip(s.text, room) : s.text;
    seen.add(key);
    out.push({ ...s, text });
    used += text.length;
  }
  return out;
}

export async function retrieve(input: RetrieveInput): Promise<Retrieved> {
  const rx = anyTermRx(input.terms);
  const [pinned, items, transcripts, pages, questions, library, maps] = await Promise.all([
    pinnedSnippets(input),
    rx ? searchItems(input, rx) : [],
    rx ? searchTranscripts(input, rx) : [],
    rx ? searchPages(input, rx) : [],
    rx ? searchQuestions(input, rx) : [],
    searchLibrary(input.userId, input.cls, input.terms),
    searchConceptMaps(input.userId, input.cls, input.terms),
  ]);
  const lib = [...library, ...maps].map((l) => mk("library", l.id, l.title, l.text, l.score, false, { week: l.week }));
  // One IDF pool across items + transcript windows + pages, so a rare proper noun outweighs common words.
  const scored = scoreCandidates([...items, ...transcripts, ...pages], input.terms);
  const perTranscript = new Map<string, number>();
  const kept = scored
    .map((sn, i) => ({ sn, i }))
    .sort((a, b) => b.sn.score - a.sn.score || a.i - b.i)
    .filter(({ sn }) => {
      if (sn.source.kind !== "transcript") return true;
      const n = perTranscript.get(sn.source.id) ?? 0;
      perTranscript.set(sn.source.id, n + 1);
      return n < WINDOWS_PER_TRANSCRIPT;
    })
    .map(({ sn }) => sn);
  return { snippets: rank([...pinned, ...kept, ...lib]), questions };
}
