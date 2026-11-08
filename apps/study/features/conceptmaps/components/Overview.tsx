import type { OverviewFilter } from '../lib/score';
import type { ConceptMapRecord } from '../types';

import { useMemo, useState } from 'react';
import { GraduationCap, ListChecks, Network, PenLine } from 'lucide-react';

import { applyOverviewFilter, averageScore, gradedScores, groupByWeek, scoreTrend } from '../lib/score';

import { MapCard } from './MapCard';

import {
  ActionButton,
  EmptyState,
  ErrorNote,
  FilterChip,
  LoadingRows,
  Surface,
  TrendIcon,
} from '@/components/ui/primitives';

/**
 * The class's maps by week, the exam short-answer drill on top (every exam short answer comes from
 * these maps), progress stats, and her exam picks one tap away.
 */
export interface OverviewProps {
  maps: ConceptMapRecord[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onPractice: (map: ConceptMapRecord) => void;
  onCompare: (map: ConceptMapRecord) => void;
  onQuestions: (map: ConceptMapRecord) => void;
  questionsBusyId: string | null;
  /** Practise the exam picks one after another. */
  onDrill: () => void;
  /** Short-answer questions for every exam pick, into the bank. */
  onExamQuestions: () => void;
  examQuestionsBusy: boolean;
}

const FILTERS: { id: OverviewFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'exam', label: 'For the exam' },
  { id: 'ungraded', label: 'Not graded yet' },
  { id: 'practice', label: 'Practice' },
];

function Stat({ label, value, extra }: { label: string; value: string; extra?: React.ReactNode }) {
  return (
    <Surface className='flex flex-col gap-0.5 px-4 py-3'>
      <span className='text-st-muted text-xs font-medium uppercase tracking-wide'>{label}</span>
      <span className='text-st-fg flex items-center gap-2 text-2xl font-semibold tabular-nums'>
        {value}
        {extra}
      </span>
    </Surface>
  );
}

export function Overview({
  maps,
  loading,
  error,
  onRetry,
  onPractice,
  onCompare,
  onQuestions,
  questionsBusyId,
  onDrill,
  onExamQuestions,
  examQuestionsBusy,
}: OverviewProps) {
  const [filter, setFilter] = useState<OverviewFilter>('all');
  const assigned = useMemo(() => maps.filter((map) => map.source !== 'practice'), [maps]);
  const scores = useMemo(() => gradedScores(maps), [maps]);
  const average = averageScore(assigned);
  const trend = scoreTrend(scores);
  const examCount = assigned.filter((map) => map.examReview).length;
  const visible = useMemo(() => applyOverviewFilter(maps, filter), [maps, filter]);
  const weeks = useMemo(() => groupByWeek(visible), [visible]);
  const counts = useMemo(
    () =>
      Object.fromEntries(FILTERS.map((item) => [item.id, applyOverviewFilter(maps, item.id).length])) as Record<
        OverviewFilter,
        number
      >,
    [maps],
  );

  if (loading && maps.length === 0) return <LoadingRows rows={6} />;
  if (error && maps.length === 0) return <ErrorNote message={error} onRetry={onRetry} />;
  const drillCount = examCount || assigned.length;

  return (
    <div className='flex flex-col gap-5'>
      <Surface className='flex flex-wrap items-center gap-3 p-4'>
        <div className='bg-st-accent/10 text-st-accent flex h-11 w-11 shrink-0 items-center justify-center rounded-full'>
          <GraduationCap className='h-5 w-5' />
        </div>
        <div className='min-w-0 flex-1 basis-64'>
          <h2 className='text-st-fg text-base font-semibold'>Exam short-answer drill</h2>
          <p className='text-st-muted text-sm'>
            {examCount > 0
              ? `${examCount} map${examCount === 1 ? '' : 's'} marked for review — redraw each from memory, then check your links.`
              : 'Redraw each map from memory, then check your links. None is marked for review, so the drill goes through all.'}
          </p>
        </div>
        <div className='flex shrink-0 flex-wrap gap-2'>
          <ActionButton className='min-h-11' disabled={drillCount === 0} variant='primary' onClick={onDrill}>
            <PenLine className='h-4 w-4' /> Start drill ({drillCount})
          </ActionButton>
          <ActionButton
            className='min-h-11'
            disabled={drillCount === 0}
            loading={examQuestionsBusy}
            title='Short-answer questions from every exam pick, into the bank'
            onClick={onExamQuestions}
          >
            <ListChecks className='h-4 w-4' /> Make exam questions
          </ActionButton>
        </div>
      </Surface>

      <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
        <Stat extra={<TrendIcon trend={trend} />} label='Average' value={average === null ? '—' : `${average} / 10`} />
        <Stat label='Graded' value={`${scores.length} / ${assigned.length}`} />
        <Stat label='Exam picks' value={String(examCount)} />
        <Stat label='Practice runs' value={String(maps.length - assigned.length)} />
      </div>

      <div className='flex flex-wrap gap-2'>
        {FILTERS.map((item) => (
          <FilterChip
            key={item.id}
            active={filter === item.id}
            count={counts[item.id]}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </FilterChip>
        ))}
      </div>

      {weeks.length === 0 ? (
        <EmptyState
          hint={filter === 'exam' ? 'No map is marked for the exam yet.' : 'Nothing here for this filter.'}
          icon={Network}
          title='No concept maps'
        />
      ) : (
        weeks.map((group) => (
          <section key={group.week}>
            <h2 className='text-st-muted mb-2 text-xs font-medium uppercase tracking-wide'>
              {group.week > 0 ? `Week ${group.week}` : 'No week'}
            </h2>
            <div className='grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3'>
              {group.maps.map((map) => (
                <MapCard
                  key={map.id}
                  map={map}
                  questionsBusy={questionsBusyId === map.id}
                  onCompare={onCompare}
                  onPractice={onPractice}
                  onQuestions={onQuestions}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
