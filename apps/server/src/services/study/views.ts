import { Types } from "mongoose";
import { StudyClass, IStudyClass } from "@/models/study/class";
import { StudyClassPolicy } from "@/models/study/class-policy";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { signedGetUrl } from "./storage";
import { todayReview } from "./questions";
import { policyWarnings } from "./grade-plan";
import { latestExamResults } from "./library";
import { aPlanTodayExtras } from "./a-plan/today";

/**
 * DTOs (contract shapes) + the Today / counts rules. One definition of each rule is shared
 * by `/today`, `Class.counts` and the tests, so they can never drift apart.
 */

export const DUE_WINDOW_MS = 7 * 24 * 3600 * 1000;
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Effective due date = `effectiveDueAt ?? dueAt` (an announcement can move a deadline). */
export const effectiveDueIn = (range: object) => ({ $or: [{ effectiveDueAt: range }, { effectiveDueAt: null, dueAt: range }] });
const effectiveDue = (d: Pick<IStudyItem, "dueAt" | "effectiveDueAt">) => d.effectiveDueAt ?? d.dueAt ?? null;
const byEffectiveDue = (dir: 1 | -1) => (a: IStudyItem, b: IStudyItem) => dir * ((effectiveDue(a)?.getTime() ?? 0) - (effectiveDue(b)?.getTime() ?? 0));

export const todayRules = (now: Date) => ({
  /** Due in the next 7 days and not yet handed in. */
  due: {
    ...effectiveDueIn({ $gte: now, $lte: new Date(now.getTime() + DUE_WINDOW_MS) }),
    "submission.state": { $nin: ["submitted", "graded", "late"] },
  },
  /**
   * Past due and not handed in. Work that is never submitted online (on paper / no
   * submission) only counts when Canvas itself flags it missing — otherwise every paper
   * worksheet would sit in "overdue" forever.
   */
  overdue: {
    $and: [
      effectiveDueIn({ $lt: now }),
      {
        $or: [
          { "submission.state": "missing" },
          { "submission.state": "unsubmitted", submittable: true },
          { submission: null, submittable: true, type: { $in: ["assignment", "quiz"] } },
        ],
      },
    ],
  },
  /** New since the owner last opened it. Announcements have their own list. */
  unseen: { seenAt: null, type: { $ne: "announcement" } },
  announcements: { seenAt: null, type: "announcement" },
});

export const LIST_PROJECTION = { html: 0 } as const;

export async function itemDto(doc: IStudyItem, opts: { withHtml?: boolean } = {}) {
  const out: Record<string, unknown> = {
    id: String(doc._id),
    classId: String(doc.classId),
    moduleId: doc.moduleId ? String(doc.moduleId) : null,
    type: doc.type,
    title: doc.title,
    canvasUrl: doc.canvasUrl ?? null,
    updatedAt: iso(doc.canvasUpdatedAt ?? doc.updatedAt),
    seenAt: iso(doc.seenAt),
    dueAt: iso(doc.dueAt),
    effectiveDueAt: iso(doc.effectiveDueAt ?? doc.dueAt),
    dueChangedBy: doc.dueChangedBy
      ? { announcementItemId: String(doc.dueChangedBy.announcementItemId), postedAt: iso(doc.dueChangedBy.postedAt), text: doc.dueChangedBy.text }
      : null,
    points: doc.points ?? null,
    submission: doc.submission ? { state: doc.submission.state, score: doc.submission.score ?? null } : null,
    external: doc.external?.tool ? { tool: doc.external.tool } : null,
  };
  if (doc.type === "file") {
    out.file = doc.file?.storageKey
      ? { mime: doc.file.mime, size: doc.file.size, version: doc.file.version, ...(await signedGetUrl(doc.file.storageKey)) }
      : null;
  }
  if (doc.type === "video" && doc.video) {
    out.video = {
      provider: doc.video.provider,
      videoId: doc.video.videoId,
      durationSec: doc.video.durationSec ?? null,
      transcriptStatus: doc.video.transcriptStatus ?? "none",
    };
    out.parentItemId = doc.parentItemId ? String(doc.parentItemId) : null;
  }
  if (opts.withHtml && ["page", "announcement", "assignment", "quiz"].includes(doc.type)) out.html = doc.html ?? "";
  return out;
}

export const itemsDto = (docs: IStudyItem[]) => Promise.all(docs.map((d) => itemDto(d)));

type Counts = { due: number; overdue: number; unseen: number };

export async function countsByClass(userId: Types.ObjectId, classIds: Types.ObjectId[], now: Date) {
  const r = todayRules(now);
  const facet = (match: object) => [{ $match: match }, { $group: { _id: "$classId", n: { $sum: 1 } } }];
  const [agg] = await StudyItem.aggregate([
    { $match: { userId, classId: { $in: classIds } } },
    { $facet: { due: facet(r.due), overdue: facet(r.overdue), unseen: facet(r.unseen) } },
  ]);
  const out = new Map<string, Counts>();
  for (const id of classIds) out.set(String(id), { due: 0, overdue: 0, unseen: 0 });
  for (const k of ["due", "overdue", "unseen"] as const) for (const row of agg?.[k] ?? []) out.get(String(row._id))![k] = row.n;
  return out;
}

type ExamResultsSummary = { latest: { name: string; date: string | null; score: number; maxScore: number; percent: number | null }; count: number } | null;

export const DEFAULT_MEETING_TZ = "America/Los_Angeles";
export type MeetingsView = { slots: { day: string; start: string; end: string | null; place?: string | null }[]; timeZone: string; creditsPerMeeting?: number | null };
export type ClassMeetings = { meetings: MeetingsView | null; meetingsSource: "manual" | "syllabus" | null };

/** Override if set, else the latest A-plan policy row's extracted meetings, else null. */
export async function resolveMeetings(userId: Types.ObjectId, classes: IStudyClass[]): Promise<Map<string, ClassMeetings>> {
  const out = new Map<string, ClassMeetings>();
  const need = classes.filter((c) => !c.meetingsOverride?.slots?.length);
  const rows = need.length
    ? await StudyClassPolicy.find({ userId, classId: { $in: need.map((c) => c._id) } }, { classId: 1, timeZone: 1, "policy.meetings": 1, updatedAt: 1 }).sort({ updatedAt: 1 }).lean<any[]>()
    : [];
  const latest = new Map<string, any>();
  for (const r of rows) latest.set(String(r.classId), r); // ascending sort → the newest row wins
  for (const c of classes) {
    if (c.meetingsOverride?.slots?.length) {
      const o = c.meetingsOverride;
      out.set(String(c._id), { meetings: { slots: o.slots.map((x) => ({ day: x.day, start: x.start, end: x.end })), timeZone: o.timeZone }, meetingsSource: "manual" });
      continue;
    }
    const row = latest.get(String(c._id));
    const m = row?.policy?.meetings;
    out.set(
      String(c._id),
      m?.slots?.length
        ? { meetings: { slots: m.slots, timeZone: row.timeZone ?? DEFAULT_MEETING_TZ, creditsPerMeeting: m.creditsPerMeeting ?? null }, meetingsSource: "syllabus" }
        : { meetings: null, meetingsSource: null }
    );
  }
  return out;
}

/** `examResults` (P-CM, optional): latest real exam result of the class + how many are recorded; absent when the class has none. */
export const classDto = (c: IStudyClass, counts: Counts, examResults?: ExamResultsSummary, mt?: ClassMeetings) => ({
  id: String(c._id),
  source: c.source ?? "canvas",
  // A manual class's id is a negative sentinel, not a Canvas course — never hand it out.
  canvasCourseId: c.source === "manual" ? null : c.canvasCourseId,
  name: c.name,
  code: c.code,
  term: c.term?.name ?? null,
  color: c.userColor ?? c.canvasColor ?? null,
  grade: { score: c.grade?.score ?? null, letter: c.grade?.letter ?? null, trend: (c.grade?.trend ?? 0) as -1 | 0 | 1 },
  counts,
  hidden: !!c.hidden,
  meetings: mt?.meetings ?? null,
  meetingsSource: mt?.meetingsSource ?? null,
  ...(examResults ? { examResults } : {}),
});

/** Default listing: current term, not hidden. `all`: every class ever synced, hidden included. */
export const visibleClassFilter = (userId: Types.ObjectId, all = false) =>
  all ? { userId } : { userId, current: true, hidden: { $ne: true } };

export async function listClasses(userId: Types.ObjectId, all: boolean, now = new Date()) {
  const classes = await StudyClass.find(visibleClassFilter(userId, all)).sort({ name: 1 }).lean<IStudyClass[]>();
  const [counts, results, mts] = await Promise.all([
    countsByClass(userId, classes.map((c) => c._id), now),
    latestExamResults(userId, classes.map((c) => c.canvasCourseId)),
    resolveMeetings(userId, classes),
  ]);
  return classes.map((c) => classDto(c, counts.get(String(c._id))!, results.get(c.canvasCourseId), mts.get(String(c._id))));
}

export async function buildToday(userId: Types.ObjectId, now = new Date()) {
  const classes = await listClasses(userId, false, now);
  const classIds = classes.map((c) => new Types.ObjectId(c.id));
  const r = todayRules(now);
  const q = (match: object, sort: Record<string, 1 | -1>, limit = 500) =>
    StudyItem.find({ userId, classId: { $in: classIds }, ...match }, LIST_PROJECTION).sort(sort).limit(limit).lean<IStudyItem[]>();
  const [due, overdue, unseen, announcements, bank, warnings, aPlan] = await Promise.all([
    q(r.due, { dueAt: 1 }),
    q(r.overdue, { dueAt: -1 }),
    q(r.unseen, { canvasUpdatedAt: -1 }),
    q(r.announcements, { canvasUpdatedAt: -1 }),
    todayReview(userId, classIds, now),
    policyWarnings(userId, classIds, now),
    aPlanTodayExtras(userId, classIds, now),
  ]);
  return {
    due: await itemsDto(due.sort(byEffectiveDue(1))),
    overdue: await itemsDto(overdue.sort(byEffectiveDue(-1))),
    unseen: await itemsDto(unseen),
    announcements: await itemsDto(announcements),
    review: bank.review,
    weakTopics: bank.weakTopics,
    warnings,
    classes,
    // P-CM: latest real exam result per class (only classes that have one).
    examResults: classes.filter((c) => c.examResults).map((c) => ({ classId: c.id, ...c.examResults!.latest })),
    aPlan: aPlan.aPlan,
    highAnnouncements: aPlan.highAnnouncements,
  };
}
