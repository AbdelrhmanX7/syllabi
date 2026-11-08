import type { APlanState } from '../api';
import type { APlan, GradePlan } from '../types';

import { cn } from '@repo/ui';
import { ArrowRight, RefreshCw } from 'lucide-react';

import { useSetTargetLetter } from '../api';
import { isStrict, overallStatus } from '../lib/grade-math';
import { aPlanHeadline } from '../lib/headline';

import { StatusPill, SyllabusLine } from './shared';

import { ActionButton, Badge, Surface } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';
import { isSampleData } from '@/lib/api/sample';
import { formatRelative } from '@/lib/format';

const HEADLINE_TONE = {
  ok: 'border-st-ok/30 bg-st-ok/5',
  warn: 'border-st-warn/30 bg-st-warn/5',
  danger: 'border-st-danger/30 bg-st-danger/5',
} as const;

function RefreshButton({ state, generatedAt }: { state: APlanState; generatedAt: string | null }) {
  return (
    <ActionButton
      aria-label='Re-read syllabus and announcements'
      className='min-h-9 px-3 text-xs'
      loading={state.refreshing}
      variant='ghost'
      onClick={state.refresh}
    >
      {!state.refreshing && <RefreshCw className='h-3.5 w-3.5' />}
      {state.refreshing ? 'Updating…' : generatedAt ? `Updated ${formatRelative(generatedAt)}` : 'Refresh'}
    </ActionButton>
  );
}

/**
 * Grade now → goal, status and the one-line "what it takes". `grade` is the live grade-plan; `aPlan`
 * (syllabus extract) adds the quoted policy line; `planState` drives the refresh button.
 */
export function StatusHeader({
  classId,
  grade,
  aPlan,
  planState,
  futureExamTitles,
}: {
  classId: string;
  grade: GradePlan;
  aPlan?: APlan | null;
  planState?: APlanState;
  futureExamTitles?: string[];
}) {
  const setTarget = useSetTargetLetter(classId);
  const headline = aPlanHeadline(grade, futureExamTitles);
  const quote = aPlan?.policy?.quotes.find((row) => row.field === 'aRequirement') ?? null;
  const letters = grade.scheme.filter((entry) => entry.min > 0);
  const strict = isStrict(grade);
  const policyText =
    aPlan?.policy?.aRequirement?.text ??
    (strict
      ? `An ${grade.target.letter} needs at least ${grade.target.min}% of the semester total in every category.`
      : `${grade.target.letter} = ${grade.target.min}% or higher of the ${grade.weighted ? 'weighted' : 'total-points'} course grade.`);
  const scoreLine =
    grade.current.score !== null
      ? `${grade.current.score.toFixed(2)}%`
      : grade.current.basis === 'lowest_category' && grade.current.lowestCategoryPct != null
        ? `weakest category ${grade.current.lowestCategoryPct}%`
        : 'No grades yet';

  return (
    <Surface as='section' className='p-5 sm:p-6'>
      <div className='flex flex-wrap items-start justify-between gap-4'>
        <div className='flex items-center gap-4 sm:gap-6'>
          <div>
            <p className='text-st-muted text-xs font-semibold uppercase tracking-wide'>Now</p>
            <p className='text-st-fg text-4xl font-semibold tabular-nums sm:text-5xl'>{grade.current.letter ?? '—'}</p>
            <p className='text-st-muted text-sm tabular-nums'>{scoreLine}</p>
          </div>
          <ArrowRight aria-hidden className='text-st-muted h-6 w-6' />
          <div>
            <label
              className='text-st-muted text-xs font-semibold uppercase tracking-wide'
              htmlFor={`target-${classId}`}
            >
              Goal
            </label>
            <div className='relative'>
              <select
                className='text-st-accent hover:bg-st-raised rounded-st -ml-1 cursor-pointer appearance-none bg-transparent px-1 text-4xl font-semibold sm:text-5xl'
                disabled={setTarget.isPending}
                id={`target-${classId}`}
                value={grade.target.letter}
                onChange={(event) => setTarget.mutate(event.target.value)}
              >
                {letters.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </div>
            <p className='text-st-muted text-sm tabular-nums'>≥ {grade.target.min}%</p>
          </div>
        </div>
        <div className='flex flex-col items-end gap-2'>
          <div className='flex items-center gap-1.5'>
            {isSampleData(grade) && <Badge>Sample</Badge>}
            <StatusPill status={overallStatus(grade)} />
          </div>
          {planState && planState.phase !== 'building' && (
            <RefreshButton generatedAt={aPlan?.generatedAt ?? null} state={planState} />
          )}
          {planState?.phase === 'stale' && <span className='text-st-muted text-xs'>Updating in the background…</span>}
        </div>
      </div>
      {setTarget.isError && (
        <p className='text-st-danger mt-3 text-sm'>{describeError(setTarget.error, 'Could not change the goal')}</p>
      )}

      <div className={cn('rounded-st mt-5 border px-4 py-3', HEADLINE_TONE[headline.tone])}>
        <p className='text-st-fg text-base font-medium leading-snug'>{headline.text}</p>
        {headline.detail && <p className='text-st-muted mt-1 text-sm'>{headline.detail}</p>}
      </div>

      <div className='mt-4'>
        <SyllabusLine quote={quote} text={policyText} />
      </div>
    </Surface>
  );
}
