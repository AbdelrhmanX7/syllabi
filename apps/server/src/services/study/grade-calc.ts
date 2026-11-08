/**
 * Canvas grade calculation, ported from Canvas's server-side `GradeCalculator`
 * (app/models/grade_calculator.rb — the code that writes `computed_current_score`) and its JS
 * twin (ui/shared/grading/AssignmentGroupGradeCalculator.js / CourseGradeCalculator.js).
 * Pure: no I/O, every rule is unit-tested (tests/services/study-grade-calc.test.ts).
 *
 * "Current score" semantics only:
 *  - a submission counts only when the student can SEE a score (`score` is a number). Ungraded,
 *    future, and unposted (score hidden from the student) work is left out;
 *  - excused submissions, `omit_from_final_grade` assignments, unpublished and `not_graded`
 *    assignments are left out;
 *  - drop rules pick the kept set that MAXIMISES the group's percentage (drop_lowest) and then
 *    MINIMISES it (drop_highest), with never_drop always kept — Canvas's bisection over q in
 *    F(q) = max Σ(score − q·total), not "drop the lowest percentages";
 *  - weighted: groups with no counted points are left out and the remaining weights renormalise
 *    to 100 (a total weight of 0 → no score, like Canvas); unweighted: total points.
 */

export type CalcAssignment = {
  id: number;
  name: string;
  points: number | null;
  omit: boolean;
  published: boolean;
  gradingType: string | null;
  dueAt: Date | null;
  score: number | null;
  excused: boolean;
};

export type CalcGroup = {
  id: number;
  name: string;
  weight: number;
  rules: { dropLowest: number; dropHighest: number; neverDrop: number[] };
  assignments: CalcAssignment[];
};

type Sub = { id: number; score: number; total: number };

export type GroupResult = {
  id: number;
  score: number;
  possible: number;
  /** 0..1, null when nothing counted. */
  pct: number | null;
  kept: number[];
  dropped: number[];
};

/** Counts toward the grade at all (graded or not). */
export const countsTowardGrade = (a: CalcAssignment) => !a.omit && a.published !== false && a.gradingType !== "not_graded";

/** Graded and visible to the student — "current score" input. */
export const isCounted = (a: CalcAssignment) => countsTowardGrade(a) && !a.excused && typeof a.score === "number";

/** Not graded yet (and not excused) — what's still ahead. */
export const isRemaining = (a: CalcAssignment) => countsTowardGrade(a) && !a.excused && typeof a.score !== "number";

/** Ruby `BigDecimal#round(2)` is half-up; nudge past binary representation error first. */
export const round2 = (x: number) => Math.round(x * 100 + (x >= 0 ? 1e-7 : -1e-7)) / 100;

// ─── drop rules (grade_calculator.rb #drop_assignments) ─────────────────────────────────

type Pair = [number, Sub];

function bigF(q: number, subs: Sub[], cantDrop: Sub[], keep: number, best: boolean): [number, Sub[]] {
  const rated: Pair[] = subs.map((s) => [s.score - q * s.total, s]);
  rated.sort(best ? (a, b) => b[0] - a[0] : (a, b) => a[0] - b[0]);
  const kept = rated.slice(0, keep);
  const qKept = kept.reduce((t, [r]) => t + r, 0);
  const qCantDrop = cantDrop.reduce((t, s) => t + (s.score - q * s.total), 0);
  return [qKept + qCantDrop, kept.map(([, s]) => s)];
}

function estimateQHigh(pointed: Sub[], unpointed: Sub[], grades: number[]): number {
  if (!unpointed.length) return grades[grades.length - 1];
  const pointsPossible = pointed.reduce((t, s) => t + s.total, 0);
  const bestPointedScore = Math.max(pointsPossible, pointed.reduce((t, s) => t + s.score, 0));
  const unpointedScore = unpointed.reduce((t, s) => t + s.score, 0);
  return (bestPointedScore + unpointedScore) / pointsPossible;
}

function keepHelper(subs: Sub[], cantDrop: Sub[], keep: number, maxTotal: number, best: boolean): Sub[] {
  if (subs.length <= keep) return subs;
  const all = [...subs, ...cantDrop];
  const unpointed = all.filter((s) => s.total === 0);
  const pointed = all.filter((s) => s.total !== 0);
  const grades = pointed.map((s) => s.score / s.total).sort((a, b) => a - b);
  let qHigh = estimateQHigh(pointed, unpointed, grades);
  let qLow = grades[0];
  let qMid = (qLow + qHigh) / 2;
  let [x, kept] = bigF(qMid, subs, cantDrop, keep, best);
  const threshold = 1 / (2 * keep * maxTotal ** 2);
  while (!(qHigh - qLow < threshold)) {
    if (x < 0) qHigh = qMid;
    else qLow = qMid;
    qMid = (qLow + qHigh) / 2;
    if (qMid === qHigh || qMid === qLow) break; // floating-point precision reached
    [x, kept] = bigF(qMid, subs, cantDrop, keep, best);
  }
  return kept;
}

/** Returns the kept submissions (never_drop included). Input = counted submissions only. */
export function dropAssignments(input: Sub[], rules: CalcGroup["rules"]): Sub[] {
  let dropLowest = rules.dropLowest || 0;
  let dropHighest = rules.dropHighest || 0;
  if (!dropLowest && !dropHighest) return input;
  const never = new Set((rules.neverDrop ?? []).map(Number));
  const cantDrop = input.filter((s) => never.has(s.id));
  const subs = input.filter((s) => !never.has(s.id));
  if (!subs.length) return cantDrop;
  if (dropLowest >= subs.length) dropLowest = subs.length - 1;
  if (dropLowest + dropHighest >= subs.length) dropHighest = 0;
  const keepHighest = subs.length - dropLowest;
  const keepLowest = keepHighest - dropHighest;
  subs.sort((a, b) => a.id - b.id);
  let kept: Sub[];
  if (subs.some((s) => s.total > 0)) {
    const maxTotal = Math.max(...[...subs, ...cantDrop].map((s) => s.total));
    const high = keepHelper(subs, cantDrop, keepHighest, maxTotal, true);
    kept = keepHelper(high, cantDrop, keepLowest, maxTotal, false);
  } else {
    kept = [...subs].sort((a, b) => a.score - b.score).slice(-keepHighest).slice(0, keepLowest);
  }
  return [...kept, ...cantDrop];
}

// ─── groups & course ────────────────────────────────────────────────────────────────────

/**
 * `extra` adds hypothetical graded scores (assignment id → score) on top of the real ones — the
 * `required` solver uses it to project remaining work through the exact same rules.
 */
export function groupScore(g: CalcGroup, extra?: Map<number, number>): GroupResult {
  const subs: Sub[] = [];
  for (const a of g.assignments) {
    if (!countsTowardGrade(a) || a.excused) continue;
    const score = typeof a.score === "number" ? a.score : extra?.get(a.id);
    if (typeof score !== "number") continue;
    subs.push({ id: a.id, score, total: a.points ?? 0 });
  }
  const kept = dropAssignments(subs, g.rules);
  const keptIds = new Set(kept.map((s) => s.id));
  const score = kept.reduce((t, s) => t + s.score, 0);
  const possible = kept.reduce((t, s) => t + s.total, 0);
  return {
    id: g.id,
    score,
    possible,
    pct: possible > 0 ? score / possible : null,
    kept: kept.map((s) => s.id),
    dropped: subs.filter((s) => !keptIds.has(s.id)).map((s) => s.id),
  };
}

/** Course score on 0..100, UNROUNDED (null = Canvas shows no score). */
export function courseScoreRaw(groups: CalcGroup[], weighted: boolean, extra?: Map<number, number>): number | null {
  const sums = groups.map((g) => ({ g, r: groupScore(g, extra) }));
  if (weighted) {
    const relevant = sums.filter(({ r }) => r.possible > 0);
    const fullWeight = relevant.reduce((t, { g }) => t + (g.weight || 0), 0);
    if (fullWeight === 0) return null;
    let grade = relevant.reduce((t, { g, r }) => t + (r.score / r.possible) * (g.weight || 0), 0);
    if (fullWeight < 100) grade *= 100 / fullWeight;
    return grade;
  }
  const score = sums.reduce((t, { r }) => t + r.score, 0);
  const possible = sums.reduce((t, { r }) => t + r.possible, 0);
  return possible > 0 ? (score / possible) * 100 : null;
}

export const courseScore = (groups: CalcGroup[], weighted: boolean, extra?: Map<number, number>) => {
  const raw = courseScoreRaw(groups, weighted, extra);
  return raw === null ? null : round2(raw);
};

// ─── required-% solver ──────────────────────────────────────────────────────────────────

const SOLVE_CAP = 10; // search up to 1000 % — beyond that the target is treated as unreachable

/**
 * Smallest uniform fraction x (applied to every item in `remaining` as score = x·points) that
 * lifts the ROUNDED course score to ≥ targetPct, everything else held at today's state.
 * Returns a percentage (may exceed 100 — the UI says "not reachable"), 0 when already met,
 * null when there is no remaining work or even 1000 % would not get there.
 */
export function solveNeededPct(
  groups: CalcGroup[],
  weighted: boolean,
  remaining: { id: number; points: number }[],
  targetPct: number
): number | null {
  const usable = remaining.filter((r) => r.points > 0);
  if (!usable.length) return null;
  const at = (x: number) => {
    const extra = new Map(usable.map((r) => [r.id, x * r.points]));
    const s = courseScore(groups, weighted, extra);
    return s !== null && s >= targetPct - 1e-9;
  };
  if (at(0)) return 0;
  if (!at(SOLVE_CAP)) return null;
  let lo = 0;
  let hi = SOLVE_CAP;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid)) hi = mid;
    else lo = mid;
  }
  // Round UP to 2 dp so "score this" is always enough.
  return Math.ceil(hi * 100 * 100 - 1e-6) / 100;
}

// ─── all-categories-min policy ──────────────────────────────────────────────────────────

export type CategoryStatus = "on_track" | "at_risk" | "below";

export type CategoryResult = {
  earned: number;
  possible: number;
  /** Today: earned / graded. */
  pct: number | null;
  gradedCount: number;
  /** Published in Canvas, not graded yet. */
  remainingCount: number;
  /** Not in Canvas yet, estimated for the rest of the semester (credits / questions / points). */
  estimatedRemaining: number;
  /** Semester total the min applies to: graded + published remaining + estimated. */
  total: number;
  estimated: boolean;
  /** Best case: everything left earned in full, over the semester total. */
  maxPct: number | null;
  /** floor((1 − min) × total) − already lost; negative is clamped to 0 (status says `below`). */
  maxMissesAllowed: number;
  status: CategoryStatus;
};

/**
 * One category of an "≥ min of the SEMESTER total in EVERY category" policy (e.g. ≥ 90 % of
 * all practice credits, all engagement credits, all assessment questions). Points are the unit
 * (1 credit = 1 point; an assessment's points = its question count). 0-point items are ignored,
 * excused items leave the total (Canvas semantics). `estimatedFuture` adds work not in Canvas
 * yet. maxMissesAllowed = floor((1 − min) × total) − lost.
 */
export function categoryStatus(g: CalcGroup, min: number, estimatedFuture = 0): CategoryResult {
  const items = g.assignments.filter((a) => countsTowardGrade(a) && !a.excused && (a.points ?? 0) > 0);
  const graded = items.filter((a) => typeof a.score === "number");
  const left = items.filter((a) => typeof a.score !== "number");
  const earned = graded.reduce((t, a) => t + a.score!, 0);
  const possible = graded.reduce((t, a) => t + a.points!, 0);
  const R = left.reduce((t, a) => t + a.points!, 0);
  const E = Math.max(0, estimatedFuture);
  const total = possible + R + E;
  const lost = Math.max(0, possible - earned);
  const allowed = total > 0 ? Math.floor((1 - min) * total + 1e-9) - lost : -1;
  const status: CategoryStatus = allowed < 0 ? "below" : allowed <= 1 ? "at_risk" : "on_track";
  return {
    earned,
    possible,
    pct: possible > 0 ? round2((earned / possible) * 100) : null,
    gradedCount: graded.length,
    remainingCount: left.length,
    estimatedRemaining: E,
    total,
    estimated: E > 0,
    maxPct: total > 0 ? round2(((earned + R + E) / total) * 100) : null,
    maxMissesAllowed: Math.max(0, round2(allowed)),
    status,
  };
}

// ─── meeting-schedule estimate ──────────────────────────────────────────────────────────

/** YYYY-MM-DD of an instant in `tz`. */
export const localDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/**
 * Class meetings strictly after `after` and up to `last` (YYYY-MM-DD, inclusive) on the given
 * weekdays (0 = Sun), minus `skip` dates.
 */
export function countMeetings(weekdays: number[], after: string, last: string, skip: string[] = []): number {
  const skipSet = new Set(skip);
  let n = 0;
  const d = new Date(`${after}T12:00:00Z`);
  const end = new Date(`${last}T12:00:00Z`).getTime();
  for (d.setUTCDate(d.getUTCDate() + 1); d.getTime() <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (weekdays.includes(d.getUTCDay()) && !skipSet.has(iso)) n++;
  }
  return n;
}
