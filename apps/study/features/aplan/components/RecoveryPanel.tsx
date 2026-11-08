import type { APlan, ClassMeetings, GradePlan, PlanGroup, RecoveryPlan } from '../types';

import { useEffect, useState } from 'react';
import { cn } from '@repo/ui';
import { CalendarClock, FileClock, RotateCw, UserCheck } from 'lucide-react';

import { categoryOf } from '../lib/grade-math';
import { unitLabel } from '../lib/headline';
import { attemptSlots, countdown, nextMeeting } from '../lib/schedule';

import { MaybeItemLink } from './shared';

import { Badge, LinkButton, SectionTitle, Surface } from '@/components/ui/primitives';
import { itemHref } from '@/components/items/ItemRow';
import { formatDateTime } from '@/lib/format';

/** Re-renders every `intervalMs` so countdowns stay honest on a tablet left open. */
function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);

    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}

const WARN_AHEAD_MS = 36 * 3_600_000;

/**
 * The evening before (and morning of) a class day: "be there — N misses left". Only for syllabi where
 * attendance earns credits (`meetings.engagementGroupId`).
 */
export function EngagementWarning({ meetings, gradePlan }: { meetings: ClassMeetings; gradePlan: GradePlan }) {
  const now = useNow();
  const group = gradePlan.groups.find((row) => row.id === meetings.engagementGroupId);
  const next = nextMeeting(meetings.slots, meetings.timeZone, now);

  const category = group ? categoryOf(gradePlan, group) : null;

  if (!group || !category || !next || next.start - now > WARN_AHEAD_MS) return null;
  const spare = category.maxMissesAllowed;
  const unit = unitLabel(category.unit, 2);
  const credits = meetings.creditsPerMeeting;
  const oneClassTooMany = credits !== null && spare < credits;

  return (
    <div
      className={cn(
        'rounded-st flex items-start gap-3 border px-4 py-3',
        oneClassTooMany ? 'border-st-danger/40 bg-st-danger/10' : 'border-st-warn/40 bg-st-warn/10',
      )}
      role='status'
    >
      <UserCheck
        aria-hidden
        className={cn('mt-0.5 h-5 w-5 shrink-0', oneClassTooMany ? 'text-st-danger' : 'text-st-warn')}
      />
      <div className='text-sm'>
        <p className='text-st-fg font-semibold'>
          Class {formatDateTime(next.start)} — be there
          {credits !== null ? `: it is worth ${credits} ${category.name.toLowerCase()}` : ` (${category.name})`}
        </p>
        <p className='text-st-fg mt-0.5'>
          {spare === 0
            ? `No ${unit} to spare in ${category.name} for the rest of the semester.`
            : `${spare} ${unit} to spare for the rest of the semester${oneClassTooMany ? ' — missing this class would cost the A' : ''}.`}
        </p>
      </div>
    </div>
  );
}

function RevisionCountdowns({ revisions, now }: { revisions: RecoveryPlan['revisions']; now: number }) {
  const open = revisions
    .map((revision) => ({ revision, left: countdown(revision.dueAt, now) }))
    .filter(({ left }) => !left.overdue)
    .sort((a, b) => a.revision.dueAt.localeCompare(b.revision.dueAt));

  if (open.length === 0) return null;

  return (
    <ul className='flex flex-col gap-2'>
      {open.map(({ revision, left }) => (
        <li key={`${revision.title}:${revision.dueAt}`}>
          <MaybeItemLink
            className={cn(
              'rounded-st flex min-h-12 items-center gap-3 border px-3 py-2',
              left.urgent ? 'border-st-danger/40 bg-st-danger/5' : 'border-st-line',
            )}
            itemId={revision.itemId}
          >
            <FileClock
              aria-hidden
              className={cn('h-5 w-5 shrink-0', left.urgent ? 'text-st-danger' : 'text-st-muted')}
            />
            <div className='min-w-0 flex-1'>
              <p className='text-st-fg text-sm font-medium'>{revision.title}</p>
              <p className='text-st-muted text-xs'>Due {formatDateTime(revision.dueAt)}</p>
            </div>
            <span
              className={cn(
                'shrink-0 text-sm font-semibold tabular-nums',
                left.urgent ? 'text-st-danger' : 'text-st-fg',
              )}
            >
              {left.text}
            </span>
          </MaybeItemLink>
        </li>
      ))}
    </ul>
  );
}

function NewAttempts({
  attempts,
  timeZone,
  now,
  notYetSuccessful,
}: {
  attempts: NonNullable<RecoveryPlan['newAttempts']>;
  timeZone: string;
  now: number;
  /** From the live grade-plan's question category when present (wins over the a-plan's). */
  notYetSuccessful: number | null;
}) {
  const slots = attemptSlots(attempts, timeZone, now)
    .filter((slot) => slot.bookable)
    .slice(0, 3);
  const count = notYetSuccessful ?? attempts.notYetSuccessful;

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex items-baseline justify-between gap-3'>
        <p className='text-st-fg text-sm font-semibold'>Use your {attempts.perWeek ?? ''} retakes this week</p>
        {count !== null && (
          <Badge tone={count ? 'accent' : 'ok'}>{count ? `${count} not yet mastered` : 'All mastered'}</Badge>
        )}
      </div>
      {count ? (
        <p className='text-st-fg text-sm'>
          {count} {count === 1 ? 'question is' : 'questions are'} not yet mastered — request retakes. Canvas only shows
          totals, so check the graded assessment for which ones.
        </p>
      ) : null}
      {slots.length > 0 && (
        <div>
          <p className='text-st-muted pb-1 text-xs font-semibold uppercase tracking-wide'>
            Next office hours you can still book
          </p>
          <ul className='flex flex-col gap-1'>
            {slots.map((slot) => {
              const formLeft = countdown(slot.formDeadline, now);

              return (
                <li key={slot.start} className='flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm'>
                  <CalendarClock aria-hidden className='text-st-muted h-4 w-4' />
                  <span className='text-st-fg'>
                    {formatDateTime(slot.start)}
                    {slot.slot.place ? ` · ${slot.slot.place}` : ''}
                  </span>
                  <span className={cn('text-xs', formLeft.urgent ? 'text-st-danger font-medium' : 'text-st-muted')}>
                    form by {formatDateTime(slot.formDeadline)} ({formLeft.text})
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {attempts.questions && attempts.questions.length > 0 && (
        <p className='text-st-muted text-xs'>Not yet mastered: {attempts.questions.join(', ')}</p>
      )}
      {attempts.formItemId && (
        <LinkButton className='self-start' href={itemHref({ id: attempts.formItemId })} variant='primary'>
          Open the retake request
        </LinkButton>
      )}
    </div>
  );
}

/** Graded work with points still to win back (rubric / comments say Revise or Retry, or the score shows a loss). */
function Recoverable({ groups }: { groups: PlanGroup[] }) {
  const rows = groups.flatMap((group) => group.recoverable.map((item) => ({ group, item })));

  if (rows.length === 0) return null;

  return (
    <div className='flex flex-col gap-1'>
      <p className='text-st-muted text-xs font-semibold uppercase tracking-wide'>Points you can still win back</p>
      <ul className='flex flex-col'>
        {rows.map(({ group, item }) => (
          // One assignment can list several questions (Assessment 1 — P2.2, — P3): the title tells them apart.
          <li key={`${group.canvasGroupId}:${item.itemId}:${item.title}`}>
            <MaybeItemLink
              className='rounded-st -mx-2 flex min-h-10 items-center gap-2 px-2 text-sm'
              itemId={item.itemId}
            >
              <span className='text-st-fg min-w-0 flex-1 truncate'>{item.title}</span>
              {item.status && <Badge tone={item.status === 'revise' ? 'warn' : 'accent'}>{item.status}</Badge>}
              <span className='text-st-muted shrink-0 text-xs tabular-nums'>
                {item.points !== null ? `${item.points} ${group.unit ?? 'pts'}` : group.name}
              </span>
            </MaybeItemLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Mastery-graded classes: correction countdowns, retakes to spend, and the rules behind them. */
export function RecoveryPanel({ plan, gradePlan }: { plan: APlan; gradePlan: GradePlan }) {
  const now = useNow();
  const recovery = plan.recovery;
  const groups = plan.groups ?? [];

  if (!recovery && !groups.some((group) => group.recoverable.length > 0)) return null;
  const questions = gradePlan.categories?.find((row) => row.unit === 'question');
  const timeZone = plan.meetings?.timeZone ?? 'America/Los_Angeles';

  return (
    <section>
      <SectionTitle>
        <RotateCw className='text-st-muted mr-1 inline h-4 w-4' /> Win points back
      </SectionTitle>
      <Surface className='flex flex-col gap-4 p-4'>
        {recovery && <RevisionCountdowns now={now} revisions={recovery.revisions} />}
        {recovery?.newAttempts && (
          <NewAttempts
            attempts={recovery.newAttempts}
            notYetSuccessful={questions?.notYetSuccessful ?? null}
            now={now}
            timeZone={timeZone}
          />
        )}
        <Recoverable groups={groups} />
        {recovery && recovery.rules.length > 0 && (
          <details className='border-st-line border-t pt-3'>
            <summary className='text-st-muted min-h-9 cursor-pointer text-xs font-semibold uppercase tracking-wide'>
              The rules
            </summary>
            <ul className='text-st-fg mt-1 list-disc pl-5 text-sm'>
              {recovery.rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </details>
        )}
      </Surface>
    </section>
  );
}
