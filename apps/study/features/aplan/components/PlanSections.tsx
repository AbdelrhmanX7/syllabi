import type {
  AnnouncementDigest,
  APlan,
  APlanAction,
  APlanRequirement,
  APlanRisk,
  DeadlineChange,
  PolicyStatus,
  SyllabusPolicy,
} from '../types';
import type { ReactNode } from 'react';

import { useEffect, useState } from 'react';
import { cn } from '@repo/ui';
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronRight,
  ListChecks,
  Mail,
  Megaphone,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';

import { MaybeItemLink, REQUIREMENT_META, SyllabusLine } from './shared';

import { itemHref } from '@/components/items/ItemRow';
import { Badge, SectionTitle, Surface } from '@/components/ui/primitives';
import { formatDate, formatDateTime, formatDue, formatRelative } from '@/lib/format';

/* ------------------------------------------------------------------ conflicts */

export function ConflictsBanner({ conflicts }: { conflicts: APlan['conflicts'] }) {
  if (conflicts.length === 0) return null;

  return (
    <div className='rounded-st border-st-warn/40 bg-st-warn/10 flex gap-3 border px-4 py-3' role='status'>
      <AlertTriangle aria-hidden className='text-st-warn mt-0.5 h-5 w-5 shrink-0' />
      <div className='flex flex-col gap-1'>
        <p className='text-st-fg text-sm font-semibold'>
          {conflicts.every((conflict) => conflict.otherSource === 'owner')
            ? 'Your rule and the syllabus disagree'
            : 'The syllabus and Canvas disagree'}{' '}
          — confirm with your instructor
        </p>
        {conflicts.map((conflict) => (
          <p key={conflict.text} className='text-st-fg text-sm leading-relaxed'>
            {conflict.text}
          </p>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ this week */

const DONE_KEY = 'study_aplan_done';

function readDone(): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(DONE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

const actionKey = (classId: string, action: APlanAction) => `${classId}:${action.itemId ?? ''}:${action.text}`;

export function ThisWeek({ classId, actions }: { classId: string; actions: APlanAction[] }) {
  // Ticks are a personal checklist only (Canvas submission state is the real truth on the item page).
  const [done, setDone] = useState<Set<string>>(() => new Set());

  useEffect(() => setDone(readDone()), []);

  const toggle = (key: string) =>
    setDone((prev) => {
      const next = new Set(prev);

      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(DONE_KEY, JSON.stringify([...next]));
      } catch {
        // checklist stays in memory
      }

      return next;
    });

  return (
    <section>
      <SectionTitle count={actions.length}>
        <ListChecks className='text-st-muted mr-1 inline h-4 w-4' /> This week
      </SectionTitle>
      <Surface className='overflow-hidden'>
        {actions.length === 0 ? (
          <p className='text-st-muted px-4 py-5 text-sm'>Nothing extra this week — keep up with what&apos;s due.</p>
        ) : (
          <ul>
            {actions.map((action) => {
              const key = actionKey(classId, action);
              const checked = done.has(key);

              return (
                <li key={key} className='border-st-line flex items-stretch border-b last:border-b-0'>
                  <button
                    aria-label={checked ? `Mark "${action.text}" not done` : `Mark "${action.text}" done`}
                    aria-pressed={checked}
                    className='flex w-14 shrink-0 items-center justify-center'
                    type='button'
                    onClick={() => toggle(key)}
                  >
                    <span
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded-md border-2 transition-colors',
                        checked ? 'border-st-ok bg-st-ok text-st-bg' : 'border-st-line',
                      )}
                    >
                      {checked && <Check className='h-4 w-4' strokeWidth={3} />}
                    </span>
                  </button>
                  <MaybeItemLink
                    className='flex min-h-14 min-w-0 flex-1 items-center gap-3 py-3 pr-4'
                    itemId={action.itemId}
                  >
                    <div className='min-w-0 flex-1'>
                      <p className={cn('text-sm font-medium', checked ? 'text-st-muted line-through' : 'text-st-fg')}>
                        {action.text}
                      </p>
                      <p className='text-st-muted mt-0.5 text-xs'>{action.why}</p>
                    </div>
                    {action.dueAt && (
                      <span className='text-st-muted shrink-0 text-xs tabular-nums'>{formatDue(action.dueAt)}</span>
                    )}
                    {action.itemId && <ChevronRight aria-hidden className='text-st-muted h-4 w-4 shrink-0' />}
                  </MaybeItemLink>
                </li>
              );
            })}
          </ul>
        )}
      </Surface>
    </section>
  );
}

/* ------------------------------------------------------------------ risks + requirements */

const SEVERITY_TONE = { high: 'danger', medium: 'warn', low: 'neutral' } as const;

export function Risks({ risks, requirements }: { risks: APlanRisk[]; requirements: APlanRequirement[] }) {
  return (
    <section>
      <SectionTitle count={risks.length}>
        <ShieldAlert className='text-st-muted mr-1 inline h-4 w-4' /> Risks
      </SectionTitle>
      <Surface className='flex flex-col gap-4 p-4'>
        {risks.length === 0 ? (
          <p className='text-st-muted text-sm'>No risks spotted.</p>
        ) : (
          <ul className='flex flex-col gap-3'>
            {risks.map((risk) => (
              <li key={risk.text} className='flex flex-col gap-1.5'>
                <div className='flex items-start gap-2'>
                  <Badge className='mt-0.5 shrink-0 capitalize' tone={SEVERITY_TONE[risk.severity]}>
                    {risk.severity}
                  </Badge>
                  <p className='text-st-fg text-sm leading-relaxed'>{risk.text}</p>
                </div>
                {risk.itemIds.length > 0 && (
                  <div className='flex flex-wrap gap-1.5 pl-1'>
                    {risk.itemIds.map((itemId, index) => (
                      <Link
                        key={itemId}
                        className='text-st-accent rounded-full px-2 py-1 text-xs font-medium underline-offset-2 hover:underline'
                        href={itemHref({ id: itemId })}
                      >
                        Open item {index + 1}
                      </Link>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {requirements.length > 0 && (
          <div className='border-st-line border-t pt-3'>
            <p className='text-st-muted pb-2 text-xs font-semibold uppercase tracking-wide'>What the goal requires</p>
            <ul className='flex flex-col gap-2'>
              {requirements.map((requirement) => {
                const meta = REQUIREMENT_META[requirement.status];

                return (
                  <li key={requirement.text} className='flex items-start gap-3'>
                    <Badge className='mt-0.5 w-20 shrink-0 justify-center' tone={meta.tone}>
                      {meta.label}
                    </Badge>
                    <div className='min-w-0'>
                      <p className='text-st-fg text-sm'>{requirement.text}</p>
                      <p className='text-st-muted text-xs'>{requirement.evidence}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Surface>
    </section>
  );
}

/* ------------------------------------------------------------------ announcements */

const DEADLINE_OUTCOME: Record<DeadlineChange['outcome'], string> = {
  applied: 'Due date moved',
  already_in_canvas: 'Already in Canvas',
  low_confidence: 'Not applied — unsure which item',
  no_date: 'Not applied — no date given',
  canvas_moved: 'Not applied — Canvas changed it since',
};

/** "Quiz 4 → Fri, Oct 9 · Due date moved". Only `applied` moved the item's effective due date. */
export function DeadlineChanges({ changes }: { changes: DeadlineChange[] }) {
  if (changes.length === 0) return null;

  return (
    <ul className='flex flex-col gap-1'>
      {changes.map((change) => (
        <li
          key={`${change.itemTitle}:${change.newDueAt ?? ''}`}
          className='flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs'
        >
          <CalendarClock
            aria-hidden
            className={cn('h-3.5 w-3.5 shrink-0', change.outcome === 'applied' ? 'text-st-warn' : 'text-st-muted')}
          />
          <span className='text-st-fg font-medium'>{change.itemTitle}</span>
          {change.newDueAt && <span className='text-st-fg tabular-nums'>→ {formatDateTime(change.newDueAt)}</span>}
          <span className={change.outcome === 'applied' ? 'text-st-warn font-medium' : 'text-st-muted'}>
            · {DEADLINE_OUTCOME[change.outcome]}
          </span>
        </li>
      ))}
    </ul>
  );
}

const postedTime = (announcement: AnnouncementDigest) => announcement.postedAt ?? '';

export function AnnouncementsDigest({ announcements }: { announcements: AnnouncementDigest[] }) {
  const sorted = [...announcements].sort((a, b) =>
    a.importance === b.importance ? postedTime(b).localeCompare(postedTime(a)) : a.importance === 'high' ? -1 : 1,
  );

  return (
    <section>
      <SectionTitle count={announcements.length}>
        <Megaphone className='text-st-muted mr-1 inline h-4 w-4' /> Announcements
      </SectionTitle>
      <Surface className='overflow-hidden'>
        {sorted.length === 0 ? (
          <p className='text-st-muted px-4 py-5 text-sm'>No announcements yet.</p>
        ) : (
          <ul>
            {sorted.map((announcement) => (
              <li key={announcement.itemId} className='border-st-line border-b last:border-b-0'>
                <Link
                  className={cn(
                    'hover:bg-st-raised flex flex-col gap-2 px-4 py-3 transition-colors',
                    announcement.importance === 'high' && 'border-l-st-accent border-l-4 pl-3',
                  )}
                  href={itemHref({ id: announcement.itemId })}
                >
                  <div className='flex flex-wrap items-center gap-1.5'>
                    {announcement.importance === 'high' && <Badge tone='accent'>Important</Badge>}
                    {announcement.tags.map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                    {announcement.postedAt && (
                      <span className='text-st-muted ml-auto text-xs'>{formatRelative(announcement.postedAt)}</span>
                    )}
                  </div>
                  {announcement.title && <p className='text-st-fg text-sm font-semibold'>{announcement.title}</p>}
                  <p className='text-st-fg text-sm leading-relaxed'>{announcement.summary}</p>
                  <DeadlineChanges changes={announcement.deadlineChanges ?? []} />
                  {announcement.actions.length > 0 && (
                    <ul className='flex flex-col gap-1'>
                      {announcement.actions.map((action) => (
                        <li key={action.text} className='text-st-fg flex items-center gap-2 text-sm'>
                          <ChevronRight aria-hidden className='text-st-accent h-3.5 w-3.5 shrink-0' />
                          <span className='min-w-0 flex-1'>{action.text}</span>
                          {action.dueAt && (
                            <span className='text-st-muted shrink-0 text-xs tabular-nums'>
                              {formatDue(action.dueAt)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </section>
  );
}

/* ------------------------------------------------------------------ syllabus essentials */

function Essential({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-1'>
      <dt className='text-st-muted text-xs font-semibold uppercase tracking-wide'>{label}</dt>
      <dd className='text-st-fg text-sm leading-relaxed'>{children}</dd>
    </div>
  );
}

const POLICY_STATUS_TEXT: Record<string, string> = {
  no_syllabus: 'No syllabus found in this Canvas course yet.',
  error: 'The syllabus was found but could not be read. Try Refresh later.',
  no_text_layer: 'The syllabus is a scanned PDF with no text, so it could not be read.',
};

/** Syllabus dates are mostly calendar days ("2026-09-30"): read at UTC midnight they show the day before in the Americas. */
const formatPolicyDate = (date: string) =>
  date.length === 10 ? formatDate(`${date}T12:00:00Z`) : formatDateTime(date);

export function SyllabusEssentials({
  policy,
  policyStatus,
}: {
  policy: SyllabusPolicy | null;
  policyStatus?: PolicyStatus;
}) {
  if (!policy) {
    return (
      <section>
        <SectionTitle>
          <BookOpen className='text-st-muted mr-1 inline h-4 w-4' /> Syllabus essentials
        </SectionTitle>
        <Surface className='p-4'>
          <p className='text-st-muted text-sm'>
            {POLICY_STATUS_TEXT[policyStatus ?? ''] ?? 'The syllabus has not been read yet.'}
          </p>
        </Surface>
      </section>
    );
  }

  const quote = (field: string) => policy.quotes.find((row) => row.field === field) ?? null;
  const keyDates = [...policy.keyDates].sort((a, b) => a.date.localeCompare(b.date));
  const syllabus = policy.syllabus;
  const emphasis = policy.emphasis ?? [];
  const line = (field: keyof SyllabusPolicy, text: string | null) =>
    text ? <SyllabusLine quote={quote(field)} text={text} /> : <span className='text-st-muted'>Not stated</span>;

  return (
    <section>
      <SectionTitle
        action={
          syllabus?.itemId ? (
            <Link
              className='text-st-accent inline-flex min-h-9 items-center gap-1 text-xs font-medium underline-offset-2 hover:underline'
              href={itemHref({ id: syllabus.itemId })}
            >
              {syllabus.title ?? 'Open syllabus'} <ChevronRight aria-hidden className='h-3.5 w-3.5' />
            </Link>
          ) : undefined
        }
      >
        <BookOpen className='text-st-muted mr-1 inline h-4 w-4' /> Syllabus essentials
      </SectionTitle>
      <Surface className='flex flex-col gap-5 p-4 sm:p-5'>
        {syllabus?.note && POLICY_STATUS_TEXT[syllabus.note] && (
          <p className='text-st-muted text-xs'>{POLICY_STATUS_TEXT[syllabus.note]}</p>
        )}
        <dl className='grid gap-5 sm:grid-cols-2'>
          <Essential label='Late work'>{line('lateWork', policy.lateWork)}</Essential>
          <Essential label='Make-ups & revisions'>{line('makeupAndRevisions', policy.makeupAndRevisions)}</Essential>
          <Essential label='Drops'>{line('drops', policy.drops)}</Essential>
          <Essential label='Attendance'>{line('attendance', policy.attendance)}</Essential>
          {policy.extraCredit && <Essential label='Extra credit'>{line('extraCredit', policy.extraCredit)}</Essential>}
          <Essential label='Instructor'>
            <span className='block font-medium'>{policy.instructor.name ?? 'Not stated'}</span>
            {policy.instructor.email && (
              <a
                className='text-st-accent inline-flex min-h-9 items-center gap-1.5 underline-offset-2 hover:underline'
                href={`mailto:${policy.instructor.email}`}
              >
                <Mail className='h-3.5 w-3.5' /> {policy.instructor.email}
              </a>
            )}
            {policy.instructor.officeHours && (
              <span className='text-st-muted block'>{policy.instructor.officeHours}</span>
            )}
          </Essential>
        </dl>

        {policy.exams.length > 0 && (
          <div className='border-st-line border-t pt-4'>
            <p className='text-st-muted pb-2 text-xs font-semibold uppercase tracking-wide'>Exams</p>
            <ul className='grid gap-3 sm:grid-cols-2'>
              {policy.exams.map((exam) => (
                <li key={exam.name} className='rounded-st bg-st-raised/60 flex flex-col gap-1 p-3'>
                  <div className='flex items-baseline justify-between gap-2'>
                    <span className='text-st-fg text-sm font-semibold'>{exam.name}</span>
                    <span className='text-st-muted text-xs'>{exam.date ? formatPolicyDate(exam.date) : exam.week}</span>
                  </div>
                  {exam.topics && <p className='text-st-fg text-sm'>{exam.topics}</p>}
                  {exam.format && <p className='text-st-muted text-xs'>{exam.format}</p>}
                  {exam.allowed && (
                    <p className='text-st-fg text-xs'>
                      <span className='text-st-muted'>Allowed: </span>
                      {exam.allowed}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {quote('exams') && (
              <div className='mt-2'>
                <SyllabusLine quote={quote('exams')} text='Exam rules come straight from the syllabus.' />
              </div>
            )}
          </div>
        )}

        {emphasis.length > 0 && (
          <div className='border-st-line border-t pt-4'>
            <p className='text-st-muted pb-2 text-xs font-semibold uppercase tracking-wide'>
              <Sparkles className='mr-1 inline h-3.5 w-3.5' /> Know for the exam
            </p>
            <ul className='flex flex-col gap-1.5'>
              {emphasis.map((row) => (
                <li key={`${row.itemId}:${row.text}`}>
                  <Link
                    className='hover:bg-st-raised rounded-st -mx-2 flex items-baseline gap-2 px-2 py-1 text-sm transition-colors'
                    href={itemHref({ id: row.itemId })}
                  >
                    <span className='text-st-fg min-w-0 flex-1'>{row.text}</span>
                    {row.exam && <Badge className='shrink-0'>{row.exam}</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {keyDates.length > 0 && (
          <div className='border-st-line border-t pt-4'>
            <p className='text-st-muted pb-2 text-xs font-semibold uppercase tracking-wide'>
              <CalendarDays className='mr-1 inline h-3.5 w-3.5' /> Key dates
            </p>
            <ul className='flex flex-col'>
              {keyDates.map((row) => (
                <li key={`${row.label}:${row.date}`} className='flex items-center justify-between gap-3 py-1.5 text-sm'>
                  <span className='text-st-fg'>{row.label}</span>
                  <span className='text-st-muted tabular-nums'>
                    {formatPolicyDate(row.date)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {policy.requiredMaterials.length > 0 && (
          <div className='border-st-line border-t pt-4'>
            <p className='text-st-muted pb-2 text-xs font-semibold uppercase tracking-wide'>Required materials</p>
            <ul className='text-st-fg list-disc pl-5 text-sm'>
              {policy.requiredMaterials.map((material) => (
                <li key={material}>{material}</li>
              ))}
            </ul>
          </div>
        )}
      </Surface>
    </section>
  );
}
