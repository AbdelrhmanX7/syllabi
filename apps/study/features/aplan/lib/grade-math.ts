// Pure grade math for the A plan, mirroring the backend's Canvas port (services/study/grade-calc.ts):
// weighted groups with Canvas' optimal drop set (never_drop kept), total points, and the
// "≥ min of the SEMESTER total in every category" policy. Used for what-if, the client-side exam
// estimate while no exam schedule exists, and the mock. No React, no I/O.
import type {
  ExamNeed,
  GradePlan,
  GradePlanGroup,
  GradeRequired,
  GroupStatus,
  PolicyCategory,
  RemainingItem,
  SchemeEntry,
} from '../types';

export interface CalcItem {
  id: string;
  points: number;
  /** null = not graded yet (ignored by the current grade; filled in by a projection). */
  score: number | null;
  /**
   * Points that can still be won back on graded work (assessment questions not yet Successful). Such
   * an item has `points: 0` — its possible points are already in the graded rows — and a projection
   * fills its score up to this.
   */
  recoverMax?: number;
}

export interface CalcGroup {
  id: string;
  name: string;
  weight: number;
  dropLowest: number;
  dropHighest: number;
  neverDrop?: string[];
  items: CalcItem[];
}

export interface GroupResult {
  id: string;
  earned: number;
  possible: number;
  /** Percent, null when nothing in the group counts yet. */
  pct: number | null;
  droppedIds: string[];
}

/** Half-up to 2 dp, nudged past binary error — the backend's `round2` (Ruby BigDecimal#round(2)). */
export const roundScore = (x: number) => Math.round(x * 100 + (x >= 0 ? 1e-7 : -1e-7)) / 100;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/* ------------------------------------------------------------------ drops */

/**
 * Keeps `keep` of `items` (plus every `fixed` item) so the kept ratio is as high (`highest`) or as low
 * as possible — Canvas' bisection over q in F(q) = Σ(score − q·points). With unequal point values this
 * is NOT "drop the lowest percentages": a 1/2 can outrank a 6/10.
 */
function pickKept(items: CalcItem[], fixed: CalcItem[], keep: number, highest: boolean): CalcItem[] {
  if (keep >= items.length) return items;
  if (keep <= 0) return [];
  const sign = highest ? 1 : -1;
  const rate = (item: CalcItem, q: number) => item.score! - q * item.points;
  const ranked = (q: number) => [...items].sort((a, b) => sign * (rate(b, q) - rate(a, q))).slice(0, keep);
  const value = (q: number) =>
    sign * (sum(ranked(q).map((item) => rate(item, q))) + sum(fixed.map((item) => rate(item, q))));
  const ratios = [...items, ...fixed].filter((item) => item.points > 0).map((item) => item.score! / item.points);
  let lo = Math.min(0, ...ratios);
  let hi = Math.max(1, ...ratios);

  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;

    // highest: value(q) ≥ 0 ⇔ some kept set reaches ratio q. lowest: value(q) ≥ 0 ⇔ some set stays ≤ q.
    if (value(mid) >= 0 === highest) lo = mid;
    else hi = mid;
  }

  return ranked(highest ? lo : hi);
}

/** Canvas order: drop the lowest, then the highest of what is left. never_drop items always stay. */
export function applyDrops(
  items: CalcItem[],
  dropLowest: number,
  dropHighest: number,
  neverDrop: string[] = [],
): { kept: CalcItem[]; dropped: CalcItem[] } {
  const graded = items.filter((item) => item.score !== null);
  const pinned = new Set(neverDrop);
  // Zero-point items (extra credit, recoveries) and never_drop items are never dropped.
  const fixed = graded.filter((item) => item.points <= 0 || pinned.has(item.id));
  const droppable = graded.filter((item) => item.points > 0 && !pinned.has(item.id));
  const afterLow = pickKept(droppable, fixed, Math.max(1, droppable.length - Math.max(0, dropLowest)), true);
  const afterHigh = pickKept(afterLow, fixed, Math.max(1, afterLow.length - Math.max(0, dropHighest)), false);
  const keptIds = new Set(afterHigh.map((item) => item.id));

  return { kept: [...afterHigh, ...fixed], dropped: droppable.filter((item) => !keptIds.has(item.id)) };
}

export function groupResult(group: CalcGroup): GroupResult {
  const { kept, dropped } = applyDrops(group.items, group.dropLowest, group.dropHighest, group.neverDrop);
  const earned = sum(kept.map((item) => item.score ?? 0));
  const possible = sum(kept.map((item) => item.points));

  return {
    id: group.id,
    earned,
    possible,
    pct: possible > 0 ? (earned / possible) * 100 : null,
    droppedIds: dropped.map((item) => item.id),
  };
}

/** Canvas weighted total: groups with nothing counted are left out and the rest re-normalised. */
export function weightedTotal(groups: CalcGroup[]): number | null {
  const counted = groups
    .map((group) => ({ group, result: groupResult(group) }))
    .filter(({ result }) => result.pct !== null);
  const weight = sum(counted.map(({ group }) => group.weight));

  if (counted.length === 0 || weight <= 0) return null;

  return sum(counted.map(({ group, result }) => group.weight * result.pct!)) / weight;
}

/** Unweighted course: total points over total points (drops still apply per group). */
export function pointsTotal(groups: CalcGroup[]): number | null {
  const results = groups.map(groupResult);
  const possible = sum(results.map((result) => result.possible));

  return possible > 0 ? (sum(results.map((result) => result.earned)) / possible) * 100 : null;
}

export function letterFor(score: number | null, scheme: SchemeEntry[]): string | null {
  if (score === null) return null;
  const rounded = roundScore(score);
  const sorted = [...scheme].sort((a, b) => b.min - a.min);

  return sorted.find((entry) => rounded >= entry.min)?.name ?? sorted[sorted.length - 1]?.name ?? null;
}

/* ------------------------------------------------------------------ plan → calc */

export const isStrict = (plan: Pick<GradePlan, 'policy'>) => plan.policy.kind === 'all_categories_min';

/** Stable what-if key for a remaining item (estimated exams have no item id). */
export const remainingKey = (groupId: string, item: Pick<RemainingItem, 'itemId' | 'assignmentId' | 'title'>) =>
  item.itemId ?? (item.assignmentId ? `a:${item.assignmentId}` : `${groupId}:${item.title}`);

/** Synthetic what-if keys for a policy category's not-yet-published work and its retry-able questions. */
export const futureKey = (groupId: string) => `${groupId}:future`;
export const retryKey = (groupId: string) => `${groupId}:retry`;

export function categoryOf(plan: Pick<GradePlan, 'categories'>, group: Pick<GradePlanGroup, 'id' | 'name'>) {
  return plan.categories?.find((row) => (row.groupId ? row.groupId === group.id : row.name === group.name)) ?? null;
}

/** Group ids the strict policy is over (the backend's `policy.categories`, else the categories' ids). */
export function policyGroupIds(plan: Pick<GradePlan, 'policy' | 'categories' | 'groups'>): string[] {
  if (plan.policy.categories.length) return plan.policy.categories.map(String);
  const fromCategories = (plan.categories ?? []).flatMap((row) => (row.groupId ? [row.groupId] : []));

  return fromCategories.length ? fromCategories : plan.groups.map((group) => group.id);
}

/**
 * A wire group as calc items. Under the strict policy the category's estimated future work and its
 * not-yet-Successful questions are added, so a projection is over the SEMESTER total.
 */
export function toCalcGroup(plan: Pick<GradePlan, 'categories'>, group: GradePlanGroup): CalcGroup {
  const category = categoryOf(plan, group);
  const items: CalcItem[] = [
    ...group.graded.map((item, index) => ({
      id: item.itemId ?? (item.assignmentId ? `a:${item.assignmentId}` : `${group.id}:graded:${index}`),
      points: item.possible,
      score: item.score,
    })),
    ...group.remaining.map((item) => ({ id: remainingKey(group.id, item), points: item.points, score: null })),
  ];

  if (category && category.estimatedRemaining > 0)
    items.push({ id: futureKey(group.id), points: category.estimatedRemaining, score: null });
  if (category?.notYetSuccessful)
    items.push({ id: retryKey(group.id), points: 0, score: null, recoverMax: category.notYetSuccessful });

  return {
    id: group.id,
    name: group.name,
    weight: group.weight,
    dropLowest: group.dropLowest,
    dropHighest: group.dropHighest,
    neverDrop: group.neverDrop,
    items,
  };
}

/** Percent assumed per remaining item: an item override beats a group slider beats "same as now". */
export interface WhatIf {
  groups?: Record<string, number>;
  items?: Record<string, number>;
}

export interface Projection {
  score: number | null;
  letter: string | null;
  /** Strict: every policy category clears the bar (over the semester total). Weighted: score ≥ target. */
  meetsTarget: boolean;
  groups: GroupResult[];
}

/** Sliders go to 100; the solver may look past it (a "103% needed" answer means not reachable). */
const SOLVE_CAP = 1000;
const clampPct = (pct: number) => Math.min(SOLVE_CAP, Math.max(0, pct));

export function projectGroups(plan: GradePlan, whatIf: WhatIf = {}): CalcGroup[] {
  return plan.groups.map((wire) => {
    const group = toCalcGroup(plan, wire);
    const current = groupResult(group).pct;
    const assumed = whatIf.groups?.[wire.id] ?? current ?? 100;

    return {
      ...group,
      items: group.items.map((item) => {
        if (item.score !== null) return item;
        const pct = clampPct(whatIf.items?.[item.id] ?? assumed);

        return { ...item, score: (pct / 100) * (item.recoverMax ?? item.points) };
      }),
    };
  });
}

export function scoreGroups(plan: GradePlan, groups: CalcGroup[]): Projection {
  const results = groups.map(groupResult);

  if (isStrict(plan)) {
    const ids = new Set(policyGroupIds(plan));
    const scoped = results.filter((result) => (ids.size ? ids.has(result.id) : true) && result.pct !== null);
    const weakest = scoped.length ? Math.min(...scoped.map((result) => result.pct!)) : null;

    return {
      score: weakest,
      letter: letterFor(weakest, plan.scheme),
      meetsTarget: weakest !== null && roundScore(weakest) >= plan.target.min,
      groups: results,
    };
  }
  const score = plan.weighted ? weightedTotal(groups) : pointsTotal(groups);

  return {
    score,
    letter: letterFor(score, plan.scheme),
    meetsTarget: score !== null && roundScore(score) >= plan.target.min,
    groups: results,
  };
}

/** Where the grade stands now (ungraded work ignored). Strict: weakest category on graded work. */
export const currentProjection = (plan: GradePlan) =>
  scoreGroups(
    plan,
    plan.groups.map((group) => toCalcGroup(plan, group)),
  );

/** The grade if remaining work goes the way `whatIf` says (default: same as each group's current %). */
export const project = (plan: GradePlan, whatIf: WhatIf = {}) => scoreGroups(plan, projectGroups(plan, whatIf));

/* ------------------------------------------------------------------ needed % */

/**
 * Smallest p (percent, up to 1000) with `ok(p)`, rounded UP to 2 dp like the backend.
 * 0 = already there; null = never.
 */
function solveMinPct(ok: (pct: number) => boolean): number | null {
  if (ok(0)) return 0;
  if (!ok(SOLVE_CAP)) return null;
  let lo = 0;
  let hi = SOLVE_CAP;

  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;

    if (ok(mid)) hi = mid;
    else lo = mid;
  }

  return Math.ceil(hi * 100 - 1e-6) / 100;
}

const hasRemaining = (plan: GradePlan, groupIds: string[]) =>
  plan.groups.some((group) => groupIds.includes(group.id) && group.remaining.some((item) => item.points > 0));

/**
 * Uniform % on the remaining work of `groupIds` (everything else held as it is now) that reaches the
 * target. May exceed 100 (= not reachable that way); null = nothing remains there.
 */
export function neededUniformPct(plan: GradePlan, groupIds: string[], whatIf: WhatIf = {}): number | null {
  if (!hasRemaining(plan, groupIds)) return null;

  return solveMinPct(
    (pct) =>
      project(plan, { ...whatIf, groups: { ...whatIf.groups, ...Object.fromEntries(groupIds.map((id) => [id, pct])) } })
        .meetsTarget,
  );
}

const EXAM_GROUP_RE = /exam|midterm|final/i;

/** The backend's pick: the only name-matched group, else the heaviest (ties: most points). */
export function pickExamGroup<T extends Pick<GradePlanGroup, 'name' | 'weight' | 'possible' | 'remaining'>>(
  groups: T[],
): T | null {
  const points = (group: T) => group.possible + sum(group.remaining.map((item) => item.points));
  const heaviest = (list: T[]) => [...list].sort((a, b) => b.weight - a.weight || points(b) - points(a))[0] ?? null;
  const named = groups.filter((group) => EXAM_GROUP_RE.test(group.name));

  return named.length === 1 ? named[0] : heaviest(named.length ? named : groups);
}

export const DEFAULT_FUTURE_EXAMS = ['Next exam', 'Final exam'];

/** Adds unscheduled future exams (points = the first graded exam's) to the exam group. */
export function withEstimatedExams(plan: GradePlan, titles: string[]): GradePlan {
  const examGroupId = plan.required?.examGroupId;
  const group = plan.groups.find((row) => row.id === examGroupId);
  const points = group?.graded[0]?.possible ?? group?.remaining[0]?.points ?? 0;

  if (!group || points <= 0 || titles.length === 0) return plan;
  const extra: RemainingItem[] = titles.map((title) => ({
    itemId: null,
    assignmentId: null,
    title,
    points,
    dueAt: null,
    estimated: true,
  }));

  return {
    ...plan,
    groups: plan.groups.map((row) => (row === group ? { ...row, remaining: [...row.remaining, ...extra] } : row)),
  };
}

export interface ExamPath {
  /** server: the backend solved it from the exam schedule; estimate: ours, labelled estimated. */
  source: 'server' | 'estimate' | 'none';
  neededPct: number | null;
  exams: ExamNeed[];
}

/**
 * The exam route to the target. The backend fills `required.exams` once an exam schedule exists;
 * until then we estimate the remaining exams (titles from the syllabus when known) ourselves.
 */
export function examPath(plan: GradePlan, futureTitles: string[] = DEFAULT_FUTURE_EXAMS): ExamPath {
  const required = plan.required;

  if (!required || isStrict(plan)) return { source: 'none', neededPct: null, exams: [] };
  if (required.exams.length) return { source: 'server', neededPct: required.exams[0].neededPct, exams: required.exams };
  if (!required.examGroupId || required.examScheduleAvailable) return { source: 'none', neededPct: null, exams: [] };
  const estimated = withEstimatedExams(plan, futureTitles);
  const neededPct = neededUniformPct(estimated, [required.examGroupId]);
  const group = estimated.groups.find((row) => row.id === required.examGroupId);
  const exams = (group?.remaining ?? []).map((item) => ({
    itemId: item.itemId,
    title: item.title,
    neededPct,
    estimated: item.estimated,
    points: item.points,
    dueAt: item.dueAt,
  }));

  return { source: exams.length ? 'estimate' : 'none', neededPct, exams };
}

/** `required` the way the backend builds it (mock + tests): each group alone; exams from the exam group. */
export function buildRequired(plan: GradePlan, examScheduleAvailable = false): GradeRequired {
  const examGroup = pickExamGroup(plan.groups);
  const byGroup = plan.groups.map((group) => ({ groupId: group.id, neededPct: neededUniformPct(plan, [group.id]) }));
  const examNeed = examGroup ? neededUniformPct(plan, [examGroup.id]) : null;
  const exams = (examGroup?.remaining ?? []).map((item) => ({
    itemId: item.itemId,
    title: item.title,
    neededPct: examNeed,
    ...(item.estimated ? { estimated: true } : {}),
    points: item.points,
    dueAt: item.dueAt,
  }));

  return { byGroup, exams, examGroupId: examGroup?.id ?? null, examScheduleAvailable };
}

/* ------------------------------------------------------------------ strict policy categories */

/**
 * The backend's `categoryStatus`: over the semester total (graded + published remaining + estimated
 * future). maxMissesAllowed = floor((1 − min)·total) − lost; < 0 → below, ≤ 1 → at risk.
 */
export function categoryStatus(
  group: Pick<GradePlanGroup, 'graded' | 'remaining'>,
  minFraction: number,
  estimatedFuture = 0,
): Omit<PolicyCategory, 'groupId' | 'name' | 'unit' | 'estimateBasis'> {
  const graded = group.graded.filter((item) => item.possible > 0);
  const left = group.remaining.filter((item) => item.points > 0);
  const earned = sum(graded.map((item) => item.score));
  const possible = sum(graded.map((item) => item.possible));
  const fresh = sum(left.map((item) => item.points));
  const future = Math.max(0, estimatedFuture);
  const total = possible + fresh + future;
  const lost = Math.max(0, possible - earned);
  const allowed = total > 0 ? Math.floor((1 - minFraction) * total + 1e-9) - lost : -1;

  return {
    earned,
    possible,
    pct: possible > 0 ? roundScore((earned / possible) * 100) : null,
    gradedCount: graded.length,
    remainingCount: left.length,
    estimatedRemaining: future,
    total,
    estimated: future > 0,
    maxPct: total > 0 ? roundScore(((earned + fresh + future) / total) * 100) : null,
    maxMissesAllowed: Math.max(0, roundScore(allowed)),
    status: allowed < 0 ? 'below' : allowed <= 1 ? 'at_risk' : 'on_track',
  };
}

/* ------------------------------------------------------------------ overall status */

const STATUS_RANK: Record<GroupStatus, number> = { on_track: 0, at_risk: 1, below: 2 };

/**
 * One status for the class. Strict: its worst category. Weighted: on track when the target is met
 * now; at risk while some route (the exam path, or any one category) can still reach it; else below.
 */
export function overallStatus(plan: GradePlan): GroupStatus {
  if (isStrict(plan)) {
    return (plan.categories ?? []).reduce<GroupStatus>(
      (worst, row) => (STATUS_RANK[row.status] > STATUS_RANK[worst] ? row.status : worst),
      'on_track',
    );
  }
  if (plan.current.score !== null && roundScore(plan.current.score) >= plan.target.min) return 'on_track';
  const path = examPath(plan);
  const reachable =
    (path.neededPct !== null && path.neededPct <= 100) ||
    (plan.required?.byGroup ?? []).some((row) => row.neededPct !== null && row.neededPct <= 100);

  return reachable ? 'at_risk' : 'below';
}
