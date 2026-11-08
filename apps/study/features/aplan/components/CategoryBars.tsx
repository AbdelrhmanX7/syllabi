import type { ExamPath } from '../lib/grade-math';
import type { GradePlan, GradePlanGroup, PolicyCategory, RemainingItem } from '../types';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { categoryOf, examPath, isStrict, remainingKey } from '../lib/grade-math';
import { pct, unitLabel } from '../lib/headline';

import { MaybeItemLink, PctBar, STATUS_META, StatusPill } from './shared';

import { Badge, SectionTitle, Surface } from '@/components/ui/primitives';
import { formatDue } from '@/lib/format';

const fmt = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, ''));

function weightedNeedLine(plan: GradePlan, group: GradePlanGroup, needed: number | null | undefined, path: ExamPath) {
  const isExamGroup = plan.required?.examGroupId === group.id;

  if (isExamGroup && path.source === 'estimate')
    return `The way to the ${plan.target.letter}: average ${pct(path.neededPct, 1)} on ${path.exams.length} more exams (estimated — exam schedule pending).`;
  if (needed === null || needed === undefined) return 'Nothing left in Canvas for this category.';
  if (needed > 100) return `Not reachable through this category alone (would need ${pct(needed, 1)}).`;
  if (needed === 0) return `Safe for the ${plan.target.letter} whatever happens on what's left.`;

  return `Needs ${pct(needed, 1)} average on the ${group.remaining.length} left.`;
}

function RemainingList({
  group,
  items,
  need,
  unit,
}: {
  group: GradePlanGroup;
  items: RemainingItem[];
  need: number | null | undefined;
  unit: string;
}) {
  return (
    <ul className='bg-st-raised/40 border-st-line border-t'>
      {items.map((item) => (
        <li key={remainingKey(group.id, item)}>
          <MaybeItemLink className='flex min-h-11 items-center gap-3 px-4 py-2 text-sm' itemId={item.itemId}>
            <span className='text-st-fg min-w-0 flex-1 truncate'>
              {item.title}
              {item.estimated && (
                <span className='text-st-muted ml-1.5 text-xs'>
                  (~{item.points} {unit}, estimated)
                </span>
              )}
            </span>
            {item.dueAt && <span className='text-st-muted hidden text-xs sm:inline'>{formatDue(item.dueAt)}</span>}
            {need !== undefined && need !== null && need > 0 && need <= 100 && (
              <span className='text-st-fg w-28 text-right text-xs tabular-nums'>
                need {pct(need, 1)} · {fmt(Math.ceil((need / 100) * item.points * 10) / 10)} {unit}
              </span>
            )}
          </MaybeItemLink>
        </li>
      ))}
    </ul>
  );
}

function ExpandToggle({ open, onToggle, count }: { open: boolean; onToggle: () => void; count: number }) {
  return (
    <button
      aria-expanded={open}
      className='text-st-muted hover:text-st-fg -ml-1 inline-flex min-h-9 items-center gap-1 self-start rounded px-1 text-xs font-medium'
      type='button'
      onClick={onToggle}
    >
      {open ? <ChevronDown className='h-3.5 w-3.5' /> : <ChevronRight className='h-3.5 w-3.5' />}
      {open ? 'Hide' : 'Show'} what&apos;s left ({count})
    </button>
  );
}

function WeightedRow({ plan, group, path }: { plan: GradePlan; group: GradePlanGroup; path: ExamPath }) {
  const [open, setOpen] = useState(false);
  const needed = plan.required?.byGroup.find((row) => row.groupId === group.id)?.neededPct;
  const isExamGroup = plan.required?.examGroupId === group.id;
  const marker = isExamGroup && path.source === 'estimate' ? path.neededPct : needed;
  const items: RemainingItem[] =
    isExamGroup && path.source === 'estimate'
      ? path.exams.map((exam) => ({
          itemId: exam.itemId,
          title: exam.title,
          points: exam.points ?? 0,
          dueAt: exam.dueAt ?? null,
          estimated: exam.estimated,
        }))
      : group.remaining;
  const listNeed = isExamGroup && path.source !== 'none' ? path.neededPct : needed;
  const drops = [
    group.dropLowest > 0 ? `lowest ${group.dropLowest} dropped` : null,
    group.dropHighest > 0 ? `highest ${group.dropHighest} dropped` : null,
  ].filter(Boolean);

  return (
    <li className='border-st-line border-b last:border-b-0'>
      <div className='flex flex-col gap-2 px-4 py-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-st-fg flex-1 text-sm font-semibold'>{group.name}</span>
          {plan.weighted && group.weight > 0 && (
            <span className='text-st-muted text-xs tabular-nums'>{group.weight}% of grade</span>
          )}
          {isExamGroup && <Badge tone='accent'>Exam path</Badge>}
        </div>
        <div className='flex items-center gap-3'>
          <div className='flex-1'>
            <PctBar
              label={`${group.name} ${pct(group.effectivePct, 1)}`}
              marker={marker !== null && marker !== undefined && marker <= 100 ? marker : null}
              value={group.effectivePct}
            />
          </div>
          <span className='text-st-fg w-16 text-right text-sm font-semibold tabular-nums'>
            {pct(group.effectivePct, 1)}
          </span>
        </div>
        <p className='text-st-muted text-xs'>
          {fmt(group.earned)} / {fmt(group.possible)} pts{drops.length ? ` · ${drops.join(', ')}` : ''} ·{' '}
          {group.gradedCount} graded
          {group.dropped?.length ? ` · dropped: ${group.dropped.map((row) => row.title).join(', ')}` : ''}
        </p>
        <p className='text-st-fg text-sm'>{weightedNeedLine(plan, group, needed, path)}</p>
        {items.length > 0 && (
          <ExpandToggle count={items.length} open={open} onToggle={() => setOpen((value) => !value)} />
        )}
      </div>
      {open && <RemainingList group={group} items={items} need={listNeed} unit='pts' />}
    </li>
  );
}

function CategoryRow({ plan, group, category }: { plan: GradePlan; group: GradePlanGroup; category: PolicyCategory }) {
  const [open, setOpen] = useState(false);
  const unit = category.unit;
  const spare = category.maxMissesAllowed;

  return (
    <li className='border-st-line border-b last:border-b-0'>
      <div className='flex flex-col gap-2 px-4 py-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-st-fg flex-1 text-sm font-semibold'>{category.name}</span>
          <Badge tone={category.status === 'below' ? 'danger' : spare <= 1 ? 'warn' : 'neutral'}>
            {category.status === 'below'
              ? 'Out of reach'
              : spare === 0
                ? 'No misses left'
                : `${fmt(spare)} ${unitLabel(unit, spare)} to spare`}
          </Badge>
          <StatusPill status={category.status} />
        </div>
        <div className='flex items-center gap-3'>
          <div className='flex-1'>
            <PctBar
              label={`${category.name} ${pct(category.pct, 1)}`}
              marker={plan.target.min}
              tone={STATUS_META[category.status].bar}
              value={category.pct}
            />
          </div>
          <span className='text-st-fg w-16 text-right text-sm font-semibold tabular-nums'>{pct(category.pct, 1)}</span>
        </div>
        <p className='text-st-muted text-xs'>
          {fmt(category.earned)} / {fmt(category.possible)} {unitLabel(unit, category.possible)} graded · semester total{' '}
          {category.estimated ? '~' : ''}
          {fmt(category.total)}
          {category.estimatedRemaining > 0
            ? ` (${fmt(category.estimatedRemaining)} not in Canvas yet, estimated)`
            : ''}{' '}
          · best case {category.maxPct === null ? '—' : `${category.maxPct}%`}
        </p>
        {category.notYetSuccessful ? (
          <p className='text-st-fg text-sm'>
            {category.notYetSuccessful} {unitLabel(unit, category.notYetSuccessful)} not yet mastered — request
            retakes. Each one that lands gives a miss back.
          </p>
        ) : null}
        {group.remaining.length > 0 && (
          <ExpandToggle count={group.remaining.length} open={open} onToggle={() => setOpen((value) => !value)} />
        )}
      </div>
      {open && <RemainingList group={group} items={group.remaining} need={null} unit={unitLabel(unit, 2)} />}
    </li>
  );
}

export function CategoryBars({ plan, futureExamTitles }: { plan: GradePlan; futureExamTitles?: string[] }) {
  const strict = isStrict(plan);
  const path = examPath(plan, futureExamTitles);
  const rows = strict
    ? plan.groups.flatMap((group) => {
        const category = categoryOf(plan, group);

        return category ? [{ group, category }] : [];
      })
    : [];

  return (
    <section>
      <SectionTitle count={strict ? rows.length : plan.groups.length}>Categories</SectionTitle>
      <Surface className='overflow-hidden'>
        <ul>
          {strict
            ? rows.map(({ group, category }) => (
                <CategoryRow key={group.id} category={category} group={group} plan={plan} />
              ))
            : plan.groups.map((group) => <WeightedRow key={group.id} group={group} path={path} plan={plan} />)}
        </ul>
      </Surface>
      <p className='text-st-muted mt-2 px-1 text-xs'>
        {strict
          ? `The tick marks ${plan.target.min}% — every category has to clear it on the SEMESTER total, so classes and assignments not in Canvas yet count.`
          : 'The tick marks the average a category needs on its remaining work, everything else held where it is.'}
      </p>
    </section>
  );
}
