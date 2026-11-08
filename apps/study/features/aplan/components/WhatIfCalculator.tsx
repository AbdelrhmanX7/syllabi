import type { GradePlan } from '../types';

import { useMemo, useState } from 'react';
import { cn } from '@repo/ui';
import { ChevronDown, ChevronRight, RotateCcw, SlidersHorizontal } from 'lucide-react';

import { useGradePlan } from '../api';
import {
  categoryOf,
  currentProjection,
  DEFAULT_FUTURE_EXAMS,
  examPath,
  futureKey,
  isStrict,
  project,
  remainingKey,
  retryKey,
  withEstimatedExams,
} from '../lib/grade-math';
import { unitLabel } from '../lib/headline';

import { PctBar } from './shared';

import { ActionButton, Badge, ErrorNote, LoadingRows, SectionTitle, Surface } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';

const startPct = (value: number | null) => Math.round(value ?? 100);

function Slider({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  hint?: string;
}) {
  return (
    <div className='flex flex-col gap-1'>
      <div className='flex items-baseline justify-between gap-3'>
        <label className='text-st-fg text-sm' htmlFor={id}>
          {label}
          {hint && <span className='text-st-muted ml-1.5 text-xs'>{hint}</span>}
        </label>
        <span className='text-st-fg w-12 text-right text-sm font-semibold tabular-nums'>{value}%</span>
      </div>
      <input
        className='accent-st-accent h-8 w-full cursor-pointer touch-pan-y'
        id={id}
        max={100}
        min={0}
        step={1}
        type='range'
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

interface Entry {
  id: string;
  title: string;
  hint: string;
}

/** Everything a group's slider moves: published work, estimated exams/future work, retry-able questions. */
function entriesOf(plan: GradePlan, groupId: string): Entry[] {
  const group = plan.groups.find((row) => row.id === groupId)!;
  const category = categoryOf(plan, group);
  const unit = category?.unit ?? 'point';
  const out: Entry[] = group.remaining.map((item) => ({
    id: remainingKey(group.id, item),
    title: item.title,
    hint: `${item.estimated ? '~' : ''}${item.points} ${unitLabel(unit, item.points)}${item.estimated ? ', estimated' : ''}`,
  }));

  if (category && category.estimatedRemaining > 0)
    out.push({
      id: futureKey(group.id),
      title: 'Not in Canvas yet',
      hint: `~${category.estimatedRemaining} ${unitLabel(unit, category.estimatedRemaining)}, estimated`,
    });
  if (category?.notYetSuccessful)
    out.push({
      id: retryKey(group.id),
      title: 'Retakes that land',
      hint: `${category.notYetSuccessful} ${unitLabel(unit, category.notYetSuccessful)}`,
    });

  return out;
}

export function WhatIfPanel({ plan: wirePlan, futureExamTitles }: { plan: GradePlan; futureExamTitles?: string[] }) {
  const [groups, setGroups] = useState<Record<string, number>>({});
  const [items, setItems] = useState<Record<string, number>>({});
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  // While no exam schedule exists, the exams not in Canvas yet are added as estimated items to slide.
  const plan = useMemo(
    () =>
      examPath(wirePlan, futureExamTitles).source === 'estimate'
        ? withEstimatedExams(wirePlan, futureExamTitles ?? DEFAULT_FUTURE_EXAMS)
        : wirePlan,
    [wirePlan, futureExamTitles],
  );
  const movable = plan.groups.filter((group) => entriesOf(plan, group.id).length > 0);
  const projection = useMemo(() => project(plan, { groups, items }), [plan, groups, items]);
  const now = useMemo(() => currentProjection(wirePlan), [wirePlan]);
  const strict = isStrict(plan);
  const delta = projection.score !== null && now.score !== null ? projection.score - now.score : null;
  const touched = Object.keys(groups).length + Object.keys(items).length > 0;

  if (movable.length === 0)
    return <p className='text-st-muted text-sm'>Everything is graded — nothing left to play with.</p>;

  return (
    <div className='grid gap-6 lg:grid-cols-[1fr_minmax(220px,280px)]'>
      <div className='flex flex-col gap-5'>
        {movable.map((group) => {
          const groupValue = groups[group.id] ?? startPct(group.effectivePct);
          const entries = entriesOf(plan, group.id);
          const perItem = entries.length <= 6 || plan.required?.examGroupId === group.id || strict;
          const expanded = openGroup === group.id;

          return (
            <div key={group.id} className='flex flex-col gap-2'>
              <Slider
                hint={`${entries.length} to set`}
                id={`whatif-${group.id}`}
                label={group.name}
                value={groupValue}
                onChange={(value) => {
                  setGroups((prev) => ({ ...prev, [group.id]: value }));
                  // The group slider resets its items so one gesture moves them all.
                  setItems((prev) =>
                    Object.fromEntries(
                      Object.entries(prev).filter(([id]) => !entries.some((entry) => entry.id === id)),
                    ),
                  );
                }}
              />
              {perItem && entries.length > 1 && (
                <button
                  aria-expanded={expanded}
                  className='text-st-muted hover:text-st-fg -ml-1 inline-flex min-h-9 items-center gap-1 self-start rounded px-1 text-xs font-medium'
                  type='button'
                  onClick={() => setOpenGroup(expanded ? null : group.id)}
                >
                  {expanded ? <ChevronDown className='h-3.5 w-3.5' /> : <ChevronRight className='h-3.5 w-3.5' />}
                  Set each one
                </button>
              )}
              {expanded && (
                <div className='border-st-line ml-1 flex flex-col gap-3 border-l pl-4'>
                  {entries.map((entry) => (
                    <Slider
                      key={entry.id}
                      hint={entry.hint}
                      id={`whatif-${entry.id}`}
                      label={entry.title}
                      value={items[entry.id] ?? groupValue}
                      onChange={(value) => setItems((prev) => ({ ...prev, [entry.id]: value }))}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className='rounded-st-lg bg-st-raised/60 flex flex-col gap-3 self-start p-4 lg:sticky lg:top-4'>
        <p className='text-st-muted text-xs font-semibold uppercase tracking-wide'>Projected</p>
        <div className='flex items-baseline gap-2'>
          <span
            className={cn('text-4xl font-semibold tabular-nums', projection.meetsTarget ? 'text-st-ok' : 'text-st-fg')}
          >
            {projection.letter ?? '—'}
          </span>
          <span className='text-st-fg text-lg font-medium tabular-nums'>
            {projection.score === null ? '—' : `${projection.score.toFixed(2)}%`}
          </span>
        </div>
        {delta !== null && Math.abs(delta) >= 0.005 && (
          <p className={cn('text-sm tabular-nums', delta > 0 ? 'text-st-ok' : 'text-st-danger')}>
            {delta > 0 ? '+' : ''}
            {delta.toFixed(2)} vs now
          </p>
        )}
        <Badge tone={projection.meetsTarget ? 'ok' : 'warn'}>
          {projection.meetsTarget ? `${plan.target.letter} reached` : `Short of the ${plan.target.letter}`}
        </Badge>
        {strict && (
          <ul className='flex flex-col gap-2 pt-1'>
            {projection.groups.map((result) => {
              const group = plan.groups.find((row) => row.id === result.id);

              return (
                <li key={result.id} className='flex flex-col gap-1'>
                  <div className='flex justify-between text-xs'>
                    <span className='text-st-muted'>{group?.name}</span>
                    <span
                      className={cn(
                        'font-semibold tabular-nums',
                        (result.pct ?? 0) >= plan.target.min ? 'text-st-ok' : 'text-st-danger',
                      )}
                    >
                      {result.pct === null ? '—' : `${result.pct.toFixed(1)}%`}
                    </span>
                  </div>
                  <PctBar
                    label={group?.name ?? result.id}
                    marker={plan.target.min}
                    tone={(result.pct ?? 0) >= plan.target.min ? 'bg-st-ok' : 'bg-st-danger'}
                    value={result.pct}
                  />
                </li>
              );
            })}
          </ul>
        )}
        {touched && (
          <ActionButton
            className='min-h-9 self-start px-3 text-xs'
            variant='ghost'
            onClick={() => {
              setGroups({});
              setItems({});
            }}
          >
            <RotateCcw className='h-3.5 w-3.5' /> Reset
          </ActionButton>
        )}
        <p className='text-st-muted text-xs leading-relaxed'>
          Sliders set the average on work not graded yet. Drop rules are re-applied, so a low score can be dropped.
        </p>
      </div>
    </div>
  );
}

/** "What if" sliders over a class's remaining work. Pass `plan` when the caller already has it. */
export function WhatIfCalculator({
  classId,
  plan,
  futureExamTitles,
}: {
  classId: string;
  plan?: GradePlan;
  futureExamTitles?: string[];
}) {
  const query = useGradePlan(classId, !plan);
  const data = plan ?? query.data;

  return (
    <section>
      <SectionTitle>
        <SlidersHorizontal className='text-st-muted mr-1 inline h-4 w-4' /> What if
      </SectionTitle>
      <Surface className='p-4 sm:p-5'>
        {data ? (
          <WhatIfPanel
            key={`${data.target.letter}:${data.current.score}`}
            futureExamTitles={futureExamTitles}
            plan={data}
          />
        ) : query.isError ? (
          <ErrorNote message={describeError(query.error)} onRetry={() => void query.refetch()} />
        ) : (
          <LoadingRows rows={3} />
        )}
      </Surface>
    </section>
  );
}
