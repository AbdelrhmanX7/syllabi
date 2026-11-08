import { DateTime } from "luxon";
import type { IStudyItem } from "@/models/study/item";
import type { ClassPolicy, PolicySlot } from "@/models/study/class-policy";
import type { CanvasClient } from "../canvas-client";
import { assignmentIdentity } from "../canvas-mapping";
import type { CanvasGroups } from "./canvas";

/**
 * Mastery-grading context (Calc: Successful / Revise / Retry per question, New Attempts, 3-day
 * revisions, engagement credits per meeting). Everything here is DERIVED from the syllabus policy
 * and Canvas — when a fact is missing it stays null / [] and nothing is invented.
 */

const ZONE = "America/Los_Angeles";
type Json = Record<string, any>;
const DAY_IDX: Record<PolicySlot["day"], number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The student's own submissions with comments + rubric assessments + the assignment. One call. */
export async function fetchSubmissions(client: CanvasClient, courseId: number): Promise<Json[]> {
  return client.getAll<Json>(
    `/api/v1/courses/${courseId}/students/submissions?student_ids[]=self&include[]=submission_comments&include[]=rubric_assessment&include[]=assignment&per_page=100`
  );
}

// ─── per-question marks ─────────────────────────────────────────────────────────────────

export type QuestionMark = { label: string; status: "revise" | "retry" };
const LABEL_RE = /\b[PQ]?\d{1,2}(?:\.\d{1,2})?[a-z]?\b/g;
const isLabel = (t: string) => /^[PQ]\d|^\d{1,2}\.\d/.test(t);

/**
 * Question labels marked Revise / Retry in instructor comments. A sentence that names labels and
 * says "marked Revise"/"Revise" (without a negation) → revise; a comment that says Retry and names
 * labels in a "not marked Revise"/"Retry" sentence → retry. Only labels shaped like P2.2 / Q3 / 4.1 (a bare number is never a question label).
 */
export function parseQuestionMarks(comments: string[]): QuestionMark[] {
  const out = new Map<string, QuestionMark["status"]>();
  for (const c of comments) {
    const sentences = String(c ?? "").split(/(?<=[.!?])\s+|\n+/);
    const mentionsRetry = /\bretry\b/i.test(c);
    for (const s of sentences) {
      const labels = (s.match(LABEL_RE) ?? []).filter(isLabel);
      if (!labels.length) continue;
      const negated = /\bnot\b|n't/i.test(s);
      let status: QuestionMark["status"] | null = null;
      if (/\bretry\b/i.test(s) && !negated) status = "retry";
      else if (/\brevise\b/i.test(s) && !negated) status = "revise";
      else if (/\brevise\b/i.test(s) && negated && mentionsRetry) status = "retry";
      if (status) for (const l of labels) out.set(l, status);
    }
  }
  return [...out].map(([label, status]) => ({ label, status }));
}

/** Rubric criteria rated Revise / Retry (when the assessment uses a rubric). */
export function rubricMarks(sub: Json): QuestionMark[] {
  const rubric: Json[] = Array.isArray(sub?.assignment?.rubric) ? sub.assignment.rubric : [];
  const ra: Json = sub?.rubric_assessment ?? {};
  const out: QuestionMark[] = [];
  for (const crit of rubric) {
    const r = ra[crit.id];
    if (!r) continue;
    const rating = (crit.ratings ?? []).find((x: Json) => x.id === r.rating_id);
    const desc = `${rating?.description ?? ""} ${r.comments ?? ""}`;
    if (/\bretry\b/i.test(desc)) out.push({ label: String(crit.description ?? crit.id), status: "retry" });
    else if (/\brevise\b/i.test(desc)) out.push({ label: String(crit.description ?? crit.id), status: "revise" });
  }
  return out;
}

// ─── groups ─────────────────────────────────────────────────────────────────────────────

export interface Recoverable {
  itemId: string;
  title: string;
  /** Points still recoverable; null for a single question when the per-question value is unknown. */
  points: number | null;
  /** null = only the score shows points were lost (no comment / rubric says which mark). */
  status: "revise" | "retry" | null;
  source: "rubric" | "comments" | "score";
}

export interface GroupContext {
  canvasGroupId: number;
  name: string;
  weight: number | null;
  unit: "credits" | "questions" | "points" | null;
  recoverable: Recoverable[];
}

const commentsOf = (s: Json | undefined) => (s?.submission_comments ?? []).map((c: Json) => String(c.comment ?? ""));
const keyOfSub = (s: Json) => {
  const id = assignmentIdentity(s.assignment ?? { id: s.assignment_id });
  return `${id.canvasType}/${id.canvasId}`;
};

export function revisionWindowEnd(returnedAt: Date, days: number, dayOne: boolean, zone: string | null): Date {
  const local = DateTime.fromJSDate(returnedAt, { zone: zone || ZONE }).startOf("day");
  return local.plus({ days: dayOne ? days - 1 : days }).set({ hour: 23, minute: 59 }).toJSDate();
}

export function buildGroups(
  policy: ClassPolicy | null,
  groups: CanvasGroups | null,
  items: IStudyItem[],
  subs: Json[],
  opts: { now: Date; zone: string | null }
): GroupContext[] {
  if (!groups) return [];
  const itemByKey = new Map(items.map((i) => [`${i.canvasType}/${i.canvasId}`, i]));
  const subByName = new Map(subs.map((s) => [String(s.assignment?.name ?? "").trim().toLowerCase(), s]));
  const rec = policy?.recovery ?? null;
  return groups.groups.map((g) => {
    const cat = policy?.gradingCategories.find((c) => c.canvasGroupId === g.id) ?? null;
    const unit = cat?.unit ?? null;
    const recoverable: Recoverable[] = [];
    // Only under a syllabus re-earning system — a "questions" unit alone is not a promise of retries.
    if (unit === "questions" && rec) {
      for (const s of subs.filter((x) => Number(x.assignment?.assignment_group_id) === g.id)) {
        const pts = Number(s.assignment?.points_possible);
        if (!(pts > 0) || typeof s.score !== "number" || s.score >= pts || s.workflow_state !== "graded") continue;
        const item = itemByKey.get(keyOfSub(s));
        if (!item) continue;
        const name = String(s.assignment?.name ?? item.title);
        const isFinal = /\bfinal\b/i.test(name);
        const revSub = subByName.get(`${name.toLowerCase()} revisions`);
        const returned = s.posted_at ? new Date(s.posted_at) : null;
        const revisionOpen =
          !!returned && rec?.revisionDays ? revisionWindowEnd(returned, rec.revisionDays, rec.revisionReturnDayIsDayOne ?? true, opts.zone).getTime() >= opts.now.getTime() : false;
        const fromRubric = rubricMarks(s);
        const marks = fromRubric.length ? fromRubric : parseQuestionMarks([...commentsOf(s), ...commentsOf(revSub)]);
        const source = fromRubric.length ? "rubric" : "comments";
        const usable = marks.filter((m) => (m.status === "retry" ? !isFinal : revisionOpen));
        if (marks.length) {
          for (const m of usable) recoverable.push({ itemId: String(item._id), title: `${name} — ${m.label}`, points: null, status: m.status, source });
        } else if (!isFinal || revisionOpen) {
          recoverable.push({ itemId: String(item._id), title: name, points: Math.round((pts - s.score) * 100) / 100, status: null, source: "score" });
        }
      }
    }
    return { canvasGroupId: g.id, name: g.name, weight: g.weight, unit, recoverable };
  });
}

// ─── recovery + meetings ────────────────────────────────────────────────────────────────

export interface Recovery {
  newAttempts: {
    perWeek: number | null;
    formLeadHours: number | null;
    formItemId: string | null;
    slots: PolicySlot[];
    closedDates: string[];
    questions: string[];
  } | null;
  revisions: { title: string; itemId: string | null; dueAt: string }[];
  rules: string[];
}

export function buildRecovery(policy: ClassPolicy | null, groupsCtx: GroupContext[], items: IStudyItem[], subs: Json[], opts: { zone: string | null }): Recovery | null {
  const rec = policy?.recovery;
  if (!rec) return null;
  const titleRe = (name: string | null, fallback: RegExp) => (name ? new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "i") : fallback);
  const formRe = titleRe(rec.newAttempts?.formName ?? null, /new\s+attempt/i);
  const form = items.find((i) => formRe.test(i.title) && i.type !== "announcement") ?? items.find((i) => /new\s+attempt/i.test(i.title) && i.type !== "announcement");
  const questionGroupIds = new Set(groupsCtx.filter((g) => g.unit === "questions").map((g) => g.canvasGroupId));
  const itemByKey = new Map(items.map((i) => [`${i.canvasType}/${i.canvasId}`, i]));
  const revisions: Recovery["revisions"] = [];
  if (rec.revisionDays) {
    for (const s of subs) {
      if (!questionGroupIds.has(Number(s.assignment?.assignment_group_id)) || !s.posted_at || s.workflow_state !== "graded") continue;
      const name = String(s.assignment?.name ?? "");
      if (/revision|new attempt/i.test(name) || !(Number(s.assignment?.points_possible) > 0)) continue;
      const revItem = items.find((i) => i.title.trim().toLowerCase() === `${name.toLowerCase()} revisions`);
      revisions.push({
        title: `${name} Revisions`,
        itemId: revItem ? String(revItem._id) : itemByKey.get(keyOfSub(s)) ? String(itemByKey.get(keyOfSub(s))!._id) : null,
        dueAt: revisionWindowEnd(new Date(s.posted_at), rec.revisionDays, rec.revisionReturnDayIsDayOne ?? true, opts.zone).toISOString(),
      });
    }
  }
  return {
    newAttempts: rec.newAttempts
      ? {
          perWeek: rec.newAttempts.perWeek,
          formLeadHours: rec.newAttempts.formLeadHours,
          formItemId: form ? String(form._id) : null,
          slots: rec.newAttempts.slots,
          closedDates: policy?.closedDates ?? [],
          questions: groupsCtx.flatMap((g) => g.recoverable.filter((r) => r.status === "retry").map((r) => r.title)),
        }
      : null,
    revisions,
    rules: rec.rules,
  };
}

export interface Meetings {
  slots: { day: PolicySlot["day"]; start: string; end: string | null }[];
  timeZone: string;
  engagementGroupId: number | null;
  creditsPerMeeting: number | null;
}

export function buildMeetings(policy: ClassPolicy | null, groupsCtx: GroupContext[], zone: string | null): Meetings | null {
  const m = policy?.meetings;
  if (!m?.slots.length) return null;
  const engagement = groupsCtx.find((g) => /engagement|participation|attendance/i.test(g.name));
  return { slots: m.slots.map((s) => ({ day: s.day, start: s.start, end: s.end })), timeZone: zone || ZONE, engagementGroupId: engagement?.canvasGroupId ?? null, creditsPerMeeting: m.creditsPerMeeting };
}

/** Next class meeting at/after `from` (skipping syllabus closed dates). */
export function nextMeeting(meetings: Meetings, from: Date, closed: string[] = []): DateTime | null {
  const start = DateTime.fromJSDate(from, { zone: meetings.timeZone });
  for (let d = 0; d < 14; d++) {
    const day = start.plus({ days: d });
    if (closed.includes(day.toISODate()!)) continue;
    for (const s of [...meetings.slots].sort((a, b) => a.start.localeCompare(b.start))) {
      if (DAY_IDX[s.day] !== day.weekday) continue;
      const [h, mi] = s.start.split(":").map(Number);
      const at = day.set({ hour: h, minute: mi, second: 0, millisecond: 0 });
      if (at.toMillis() >= from.getTime()) return at;
    }
  }
  return null;
}

/** "Class tomorrow" warning: only on the day before a class day. */
export function engagementAlert(meetings: Meetings | null, now: Date, closed: string[] = []): string | null {
  if (!meetings) return null;
  const tomorrow = DateTime.fromJSDate(now, { zone: meetings.timeZone }).plus({ days: 1 }).startOf("day");
  const next = nextMeeting(meetings, tomorrow.toJSDate(), closed);
  if (!next || next.toISODate() !== tomorrow.toISODate()) return null;
  const credits = meetings.creditsPerMeeting ? `${meetings.creditsPerMeeting} Engagement Credits` : "Engagement Credits";
  return `Class tomorrow (${next.toFormat("ccc h:mm a")}) — ${credits} are earned in class only.`;
}

/** Deterministic mastery actions for thisWeek: new attempts, open revision windows, next class. */
export function masteryActions(recovery: Recovery | null, meetings: Meetings | null, now: Date, closed: string[] = []) {
  type A = { text: string; dueAt: string | null; itemId: string | null; why: string };
  const out: A[] = [];
  const later: A[] = [];
  for (const r of recovery?.revisions ?? []) {
    const due = new Date(r.dueAt).getTime();
    if (due < now.getTime()) continue;
    const daysLeft = Math.ceil((due - now.getTime()) / 86400e3);
    out.push({ text: `Submit ${r.title} (${daysLeft} day${daysLeft === 1 ? "" : "s"} left)`, dueAt: r.dueAt, itemId: r.itemId, why: "Revision window from the syllabus, counted from the day the assessment was returned." });
  }
  const na = recovery?.newAttempts;
  if (na && na.questions.length) {
    out.push({
      text: `Use your ${na.perWeek ?? ""} New Attempts this week`.replace("  ", " ") + `: ${na.questions.join(", ")}`,
      dueAt: null,
      itemId: na.formItemId,
      why: `Questions not yet Successful.${na.formLeadHours ? ` Request each attempt at least ${na.formLeadHours} h ahead.` : ""}${na.perWeek ? " Unused attempts do not roll over." : ""}`,
    });
  }
  if (meetings) {
    const next = nextMeeting(meetings, now, closed);
    if (next && next.toMillis() - now.getTime() < 7 * 86400e3) {
      later.push({
        text: `Attend class ${next.toFormat("ccc M/d h:mm a")}`,
        dueAt: next.toUTC().toISO(),
        itemId: null,
        why: meetings.creditsPerMeeting ? `${meetings.creditsPerMeeting} Engagement Credits per meeting, earned in class only.` : "Engagement Credits are earned in class.",
      });
    }
  }
  return { first: out, later };
}
