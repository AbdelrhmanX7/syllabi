// Score maths for the overview and the live grade panel. Pure — unit-tested.
import type { ConceptMapRecord, Criterion } from '../types';

/** The rubric's five rows, in the order the professor lists them. */
export const CRITERIA = [
  'Key terms included',
  'Labeled arrows',
  'Accurate relationships',
  'Logical flow',
  'Effort & depth',
] as const;

export const MAX_SCORE = 10;

export function aggregateCriteria(criteria: Criterion[]): { score: number; max: number } {
  return criteria.reduce((sum, row) => ({ score: round1(sum.score + row.score), max: round1(sum.max + row.max) }), {
    score: 0,
    max: 0,
  });
}

export const round1 = (value: number): number => Math.round(value * 10) / 10;

export type ScoreTone = 'ok' | 'warn' | 'danger' | 'neutral';

/** ≥ 85 % green, ≥ 65 % amber, below red. */
export function scoreTone(score: number | null | undefined, max = MAX_SCORE): ScoreTone {
  if (score === null || score === undefined || max <= 0) return 'neutral';
  const ratio = score / max;

  if (ratio >= 0.85) return 'ok';
  if (ratio >= 0.65) return 'warn';

  return 'danger';
}

export function formatScore(score: number | null | undefined, max = MAX_SCORE): string {
  if (score === null || score === undefined) return `— / ${max}`;

  return `${Number.isInteger(score) ? score : score.toFixed(1)} / ${max}`;
}

/** Mean score (normalised to /10) over the graded maps; null when nothing is graded. */
export function averageScore(maps: Pick<ConceptMapRecord, 'score' | 'maxScore'>[]): number | null {
  const graded = maps.filter((map) => map.score !== null && map.maxScore > 0);

  if (graded.length === 0) return null;
  const total = graded.reduce((sum, map) => sum + (map.score! / map.maxScore) * MAX_SCORE, 0);

  return round1(total / graded.length);
}

/**
 * Direction of the last scores against the ones before them: the later half's mean vs the earlier
 * half's, in /10 units; a gap under 0.3 is "steady". Needs ≥ 2 scores.
 */
export function scoreTrend(scores: number[]): -1 | 0 | 1 {
  if (scores.length < 2) return 0;
  const half = Math.floor(scores.length / 2);
  const earlier = scores.slice(0, scores.length - half);
  const later = scores.slice(scores.length - half);
  const mean = (list: number[]) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const gap = mean(later) - mean(earlier);

  if (gap >= 0.3) return 1;
  if (gap <= -0.3) return -1;

  return 0;
}

/** Her score as he may enter it: 0–max in steps of 0.5 (what `PATCH /concept-maps/:id` accepts). */
export function isValidHerScore(value: number, max = MAX_SCORE): boolean {
  return Number.isFinite(value) && value >= 0 && value <= max && Number.isInteger(value * 2);
}

/** «from Canvas» / «entered by you» next to her grade; null when there is no score. */
export function scoreSourceLabel(map: Pick<ConceptMapRecord, 'score' | 'scoreSource'>): string | null {
  if (map.score === null) return null;
  if (map.scoreSource === 'canvas') return 'from Canvas';
  if (map.scoreSource === 'manual') return 'entered by you';

  return null;
}

/** Assigned order: by map number, unnumbered (custom practice) last. */
export const byNumber = (a: Pick<ConceptMapRecord, 'number'>, b: Pick<ConceptMapRecord, 'number'>): number =>
  (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER);

/** «Map 3 · Weathering», or whatever the record has («Concept map» for a bare custom practice map). */
export function mapTitle(map: Pick<ConceptMapRecord, 'number' | 'lecture' | 'source'>): string {
  if (map.lecture) return map.lecture;

  return map.number !== null ? `Concept map ${map.number}` : map.source === 'practice' ? 'Practice map' : 'Concept map';
}

/** Chronological (by number) scores of the graded, non-practice maps, normalised to /10. */
export function gradedScores(maps: ConceptMapRecord[]): number[] {
  return [...maps]
    .filter((map) => map.source !== 'practice' && map.score !== null && map.maxScore > 0)
    .sort(byNumber)
    .map((map) => round1((map.score! / map.maxScore) * MAX_SCORE));
}

export interface WeekGroup {
  week: number;
  maps: ConceptMapRecord[];
}

/** Maps grouped by week (no week → 0, shown last as «Other»), weeks ascending, maps by number within a week. */
export function groupByWeek(maps: ConceptMapRecord[]): WeekGroup[] {
  const groups = new Map<number, ConceptMapRecord[]>();

  for (const map of maps) {
    const week = map.week ?? 0;
    const list = groups.get(week) ?? [];

    list.push(map);
    groups.set(week, list);
  }

  return Array.from(groups.entries())
    .sort((a, b) => (a[0] || Number.MAX_SAFE_INTEGER) - (b[0] || Number.MAX_SAFE_INTEGER))
    .map(([week, list]) => ({ week, maps: [...list].sort(byNumber) }));
}

export type OverviewFilter = 'all' | 'exam' | 'ungraded' | 'practice';

export function applyOverviewFilter(maps: ConceptMapRecord[], filter: OverviewFilter): ConceptMapRecord[] {
  switch (filter) {
    case 'exam':
      return maps.filter((map) => map.examReview === true);
    case 'ungraded':
      return maps.filter((map) => map.source !== 'practice' && map.score === null);
    case 'practice':
      return maps.filter((map) => map.source === 'practice');
    default:
      return maps;
  }
}
