// Blueprint («real exam format») exams: group questions into sections and tally results per section.
// The BE may send `sections[{name, questionIds}]`, a `section` on each question, or neither.

import type { ExamDetail, ExamQuestion, ExamSummary, GradedFrame } from '../api';
import type { AttemptResult } from '@/lib/api/types';

import { scoreFraction } from './exam';

export interface SectionGroup {
  name: string;
  bonus: boolean;
  questions: ExamQuestion[];
}

/** A question's section label: `{name, bonus?}` on the wire, a bare name from older payloads. */
export function sectionOf(q: Pick<ExamQuestion, 'section'>): { name: string; bonus: boolean } | null {
  const s = q.section;

  if (!s) return null;
  if (typeof s === 'string') return { name: s, bonus: false };

  return s.name ? { name: s.name, bonus: Boolean(s.bonus) } : null;
}

/**
 * Sections in paper order, or null when the exam is not sectioned (one group would add nothing).
 * `sections[].questionIds` wins; else consecutive runs of `question.section`. Questions a section
 * list misses land in «Other».
 */
export function examSections(exam: Pick<ExamDetail, 'questions' | 'sections'>): SectionGroup[] | null {
  const byId = new Map(exam.questions.map((q) => [q.id, q]));
  let groups: SectionGroup[] = [];

  if (exam.sections?.some((s) => s.questionIds?.length)) {
    const seen = new Set<string>();

    for (const s of exam.sections) {
      const questions = (s.questionIds ?? []).map((id) => byId.get(id)).filter((q): q is ExamQuestion => Boolean(q));

      questions.forEach((q) => seen.add(q.id));
      if (questions.length) groups.push({ name: s.name, bonus: Boolean(s.bonus), questions });
    }
    const rest = exam.questions.filter((q) => !seen.has(q.id));

    if (rest.length) groups.push({ name: 'Other', bonus: false, questions: rest });
  } else if (exam.questions.some((q) => sectionOf(q))) {
    const bonusNames = new Set((exam.sections ?? []).filter((s) => s.bonus).map((s) => s.name));

    for (const q of exam.questions) {
      const section = sectionOf(q);
      const name = section?.name || 'Other';
      const last = groups[groups.length - 1];

      if (last && last.name === name) last.questions.push(q);
      else
        groups.push({
          name,
          bonus: Boolean(section?.bonus) || bonusNames.has(name) || /bonus/i.test(name),
          questions: [q],
        });
    }
  } else {
    return null;
  }
  groups = groups.filter((g) => g.questions.length);

  return groups.length > 1 ? groups : null;
}

/** Section name per question index, for the runner's «Section» header. */
export function sectionAt(groups: SectionGroup[] | null, questionId: string): SectionGroup | null {
  return groups?.find((g) => g.questions.some((q) => q.id === questionId)) ?? null;
}

export interface SectionTally {
  name: string;
  bonus: boolean;
  right: number;
  partial: number;
  wrong: number;
  total: number;
  /** 0..1: right = 1, partial = 0.5, weighted by `points` when every question has them. */
  score: number;
}

const CREDIT: Record<AttemptResult, number> = { right: 1, partial: 0.5, wrong: 0 };

export function sectionTallies(groups: SectionGroup[], graded: Map<string, GradedFrame>): SectionTally[] {
  return groups.map((g) => {
    const t = { right: 0, partial: 0, wrong: 0 };
    const weighted = g.questions.every((q) => typeof q.points === 'number' && q.points > 0);
    let earned = 0;
    let possible = 0;

    for (const q of g.questions) {
      const result = graded.get(q.id)?.result ?? 'wrong';
      const weight = weighted ? (q.points as number) : 1;

      t[result] += 1;
      earned += CREDIT[result] * weight;
      possible += weight;
    }

    return { name: g.name, bonus: g.bonus, ...t, total: g.questions.length, score: possible ? earned / possible : 0 };
  });
}

/**
 * The BE's `bySection` scores win over the local tally when present (its partial credit and points
 * are authoritative); counts come from the local tally of the same name, else 0. Without
 * `bySection` the local tally stands. Null when neither exists.
 */
export function withBySection(
  tallies: SectionTally[] | null,
  bySection: ExamSummary['bySection'] | null | undefined,
): SectionTally[] | null {
  if (!bySection?.length) return tallies;
  const local = new Map((tallies ?? []).map((t) => [t.name, t]));

  return bySection.map((row) => {
    const t = local.get(row.section);

    return {
      name: row.section,
      bonus: t?.bonus ?? /bonus/i.test(row.section),
      right: t?.right ?? 0,
      partial: t?.partial ?? 0,
      wrong: t?.wrong ?? 0,
      total: t?.total ?? 0,
      score: scoreFraction(row.score),
    };
  });
}
