// Assembles a GradePlan in the LIVE backend's shape (#573) from raw gradebook rows: post-drop
// earned/possible, dropped items, policy categories over the semester total, current grade and
// `required`. The mock uses it; tests use it to check the math end to end.
import type { GradedItem, GradePlan, GradePlanGroup, GradePolicy, RemainingItem, SchemeEntry } from '../types';

import {
  buildRequired,
  categoryStatus,
  currentProjection,
  groupResult,
  letterFor,
  roundScore,
  toCalcGroup,
} from './grade-math';

export interface RawGroup {
  id: string;
  name: string;
  weight: number;
  dropLowest?: number;
  dropHighest?: number;
  graded: GradedItem[];
  remaining: RemainingItem[];
  /** Strict policy: unit and the estimate of work not in Canvas yet (from the course calendar). */
  unit?: 'credit' | 'question' | 'point';
  estimatedFuture?: number;
  estimateBasis?: string;
}

export interface RawCourse {
  scheme: SchemeEntry[];
  weighted: boolean;
  /** Wire policy: `min` is a fraction, categories are group ids. */
  policy: GradePolicy;
  targetLetter: string;
  /** Canvas's own current score (null when the course hides totals, like Calc). */
  canvasScore: number | null;
  groups: RawGroup[];
}

export const DEFAULT_SCHEME: SchemeEntry[] = [
  { name: 'A', min: 90 },
  { name: 'B', min: 80 },
  { name: 'C', min: 70 },
  { name: 'D', min: 60 },
  { name: 'F', min: 0 },
];

export function targetMin(scheme: SchemeEntry[], letter: string): number {
  return scheme.find((entry) => entry.name === letter)?.min ?? scheme[0]?.min ?? 90;
}

export function buildGradePlan(course: RawCourse): GradePlan {
  const strict = course.policy.kind === 'all_categories_min';
  const minFraction = course.policy.min ?? 0.9;
  const groups: GradePlanGroup[] = course.groups.map((raw) => {
    const base: GradePlanGroup = {
      id: raw.id,
      name: raw.name,
      weight: raw.weight,
      dropLowest: raw.dropLowest ?? 0,
      dropHighest: raw.dropHighest ?? 0,
      neverDrop: [],
      earned: 0,
      possible: 0,
      effectivePct: null,
      gradedCount: raw.graded.length,
      graded: raw.graded,
      dropped: [],
      remaining: raw.remaining,
    };
    const result = groupResult(toCalcGroup({}, base));
    const titleOf = new Map(raw.graded.map((item) => [item.itemId, item.title]));

    return {
      ...base,
      earned: roundScore(result.earned),
      possible: roundScore(result.possible),
      effectivePct: result.pct === null ? null : roundScore(result.pct),
      dropped: result.droppedIds.map((id) => ({ itemId: id, title: titleOf.get(id) ?? '' })),
    };
  });
  const categories = strict
    ? course.policy.categories.flatMap((groupId) => {
        const raw = course.groups.find((row) => row.id === groupId);
        const group = groups.find((row) => row.id === groupId);

        if (!raw || !group) return [];
        const status = categoryStatus(group, minFraction, raw.estimatedFuture ?? 0);
        const unit = raw.unit ?? 'point';

        return [
          {
            groupId,
            name: raw.name,
            unit,
            ...status,
            estimateBasis: raw.estimateBasis ?? 'published_only',
            ...(unit === 'question'
              ? {
                  notYetSuccessful: Math.max(0, status.possible - status.earned),
                  pendingRevisions: null,
                  questionDetail: 'totals_only' as const,
                }
              : {}),
          },
        ];
      })
    : undefined;
  const target = {
    letter: course.targetLetter,
    min: strict ? roundScore(minFraction * 100) : targetMin(course.scheme, course.targetLetter),
  };
  const draft: GradePlan = {
    scheme: course.scheme,
    weighted: course.weighted,
    policy: course.policy,
    current: {
      score: null,
      letter: null,
      canvasScore: course.canvasScore,
      basis: strict ? 'lowest_category' : 'canvas',
    },
    groups,
    ...(categories ? { categories } : {}),
    target,
    required: null,
  };

  if (strict) {
    const pcts = (categories ?? []).flatMap((row) => (row.pct === null ? [] : [row.pct]));
    const lowest = pcts.length ? Math.min(...pcts) : null;

    return {
      ...draft,
      current: {
        ...draft.current,
        score: course.canvasScore,
        letter: letterFor(lowest, course.scheme),
        lowestCategoryPct: lowest,
      },
    };
  }
  const now = currentProjection(draft);

  return {
    ...draft,
    current: { ...draft.current, score: now.score === null ? null : roundScore(now.score), letter: now.letter },
    required: buildRequired(draft),
  };
}
