// One-sentence "what it takes" line for the status header and the goal card.
import type { GradePlan } from '../types';

import { examPath, isStrict, overallStatus } from './grade-math';

export const pct = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined
    ? '—'
    : `${(Math.ceil(value * 10 ** digits - 1e-9) / 10 ** digits).toFixed(digits)}%`;

const UNIT_PLURAL: Record<string, string> = { credit: 'credits', question: 'questions', point: 'pts' };

export const unitLabel = (unit: string | undefined, count: number) =>
  count === 1 ? (unit === 'point' || !unit ? 'pt' : unit) : (UNIT_PLURAL[unit ?? 'point'] ?? `${unit}s`);

function listTitles(titles: string[]): string {
  if (titles.length <= 1) return titles[0] ?? '';

  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

export interface Headline {
  tone: 'ok' | 'warn' | 'danger';
  text: string;
  /** Second line, e.g. why the letter is what it is. */
  detail?: string;
}

/** `futureExamTitles`: syllabus names for exams not on Canvas yet (the estimate's labels). */
export function aPlanHeadline(plan: GradePlan, futureExamTitles?: string[]): Headline {
  const letter = plan.target.letter;
  const status = overallStatus(plan);

  if (isStrict(plan)) {
    const categories = plan.categories ?? [];
    const weakest = [...categories].filter((row) => row.pct !== null).sort((a, b) => a.pct! - b.pct!)[0];
    const detail =
      plan.current.basis === 'lowest_category' && weakest
        ? `Your grade is limited by your weakest category — ${weakest.name} at ${weakest.pct!.toFixed(weakest.pct! % 1 ? 2 : 0)}%.`
        : undefined;
    const below = categories.filter((row) => row.status === 'below');

    if (below.length)
      return {
        tone: 'danger',
        text: `${listTitles(below.map((row) => `${row.name} (best ${row.maxPct ?? '—'}%)`))} can't reach ${plan.target.min}% of the semester total.`,
        detail,
      };
    const tight = categories
      .filter((row) => row.status !== 'on_track')
      .sort((a, b) => a.maxMissesAllowed - b.maxMissesAllowed)
      .map((row) =>
        row.maxMissesAllowed === 0
          ? `${row.name} has no misses left`
          : `${row.name} ${row.maxMissesAllowed} ${unitLabel(row.unit, row.maxMissesAllowed)} to spare`,
      );

    if (tight.length === 0)
      return { tone: 'ok', text: `Every category is on pace for ${plan.target.min}% of the semester total.`, detail };

    return {
      tone: 'warn',
      text: `Every category needs ${plan.target.min}% of the semester total — ${tight.join(', ')}.`,
      detail,
    };
  }

  const path = examPath(plan, futureExamTitles);

  if (path.exams.length) {
    const titles = listTitles(path.exams.map((exam) => exam.title));
    const estimated = path.source === 'estimate' ? ' (estimated — exam schedule pending)' : '';
    const need = path.neededPct;

    if (need === null || need > 100)
      return { tone: 'danger', text: `An ${letter} is out of reach even with 100% on ${titles}${estimated}.` };
    if (need === 0) return { tone: 'ok', text: `The ${letter} is safe whatever happens on ${titles}.` };

    return {
      tone: status === 'on_track' ? 'ok' : 'warn',
      text: `Average ${pct(need, 1)} on ${titles} for the ${letter}${estimated}.`,
    };
  }
  if (status === 'on_track')
    return { tone: 'ok', text: `On pace for the ${letter} — keep every category where it is.` };
  if (status === 'below')
    return { tone: 'danger', text: `An ${letter} is not reachable with the work left in Canvas.` };

  return {
    tone: 'warn',
    text: `${pct(plan.target.min - (plan.current.score ?? 0), 2)} short of the ${letter} — see the categories below.`,
  };
}
