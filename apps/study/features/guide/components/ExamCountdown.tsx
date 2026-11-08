import type { ResolvedExam } from '../lib/schedule';
import type { StudyClass } from '@/lib/api/types';

import React, { useMemo } from 'react';
import { CalendarClock, ListChecks, Target } from 'lucide-react';
import Link from 'next/link';

import { useSchedule, useSchedules } from '../api';
import {
  daysLabel,
  daysUntil,
  drillHref,
  examTopics,
  localIso,
  mockExamHref,
  nextExam,
  termStartFor,
  upcomingExams,
} from '../lib/schedule';

import { formatDay } from './ScheduleEditor';

import { Badge, LinkButton, LoadingRows, SectionTitle, Surface } from '@/components/ui/primitives';
import { useClasses } from '@/lib/api/hooks';
import { IfAi } from '@/components/ui/AiOff';

/**
 * Next exam per class from `/classes/:id/exams-schedule`. With `classId`: that class's next exam,
 * its chapters/topics and the mock-exam / drill links, then the rest of the term. Without: a compact
 * Today list across all classes, nearest first.
 */
export function ExamCountdown({ classId, className }: { classId?: string; className?: string }) {
  return classId ? (
    <ClassCountdown classId={classId} className={className} />
  ) : (
    <AllClassesCountdown className={className} />
  );
}

const termStartOf = (cls: StudyClass | undefined) =>
  cls ? termStartFor(cls as unknown as { term: string } & Record<string, unknown>) : null;

function ClassCountdown({ classId, className }: { classId: string; className?: string }) {
  const classes = useClasses();
  const cls = classes.data?.find((c) => c.id === classId);
  const schedule = useSchedule(classId);
  const termStart = termStartOf(cls);
  const today = localIso();
  const upcoming = useMemo(
    () => upcomingExams(schedule.data ?? [], termStart, today),
    [schedule.data, termStart, today],
  );
  const next = upcoming.find((e) => e.when) ?? null;

  if (schedule.isLoading) return <LoadingRows className={className} rows={2} />;
  if (schedule.isError || !upcoming.length) return null;

  return (
    <Surface as='section' className={`p-4 sm:p-5 ${className ?? ''}`}>
      {next ? <NextExamBlock classId={classId} exam={next} today={today} /> : null}
      {upcoming.filter((e) => e !== next).length ? (
        <ul className='border-st-line mt-4 flex flex-col gap-1.5 border-t pt-3'>
          {upcoming
            .filter((e) => e !== next)
            .map((e, i) => (
              <li key={`${e.name}-${i}`} className='text-st-muted flex items-center gap-2 text-sm'>
                <span className='text-st-fg flex-1 font-medium'>{e.name}</span>
                {e.when ? `${formatDay(e.when)}${e.approx ? ' (approx)' : ''} · ` : ''}
                {daysLabel(daysUntil(e, today), e.approx)}
              </li>
            ))}
        </ul>
      ) : null}
    </Surface>
  );
}

function NextExamBlock({ classId, exam, today }: { classId: string; exam: ResolvedExam; today: string }) {
  const days = daysUntil(exam, today);
  const topics = examTopics(exam);

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex items-start gap-4'>
        <div className='bg-st-raised rounded-st flex min-w-20 flex-col items-center px-3 py-2'>
          <span className='text-st-fg text-3xl font-semibold tabular-nums'>
            {days === null ? '—' : `${exam.approx ? '~' : ''}${days}`}
          </span>
          <span className='text-st-muted text-xs'>{days === 1 ? 'day' : 'days'}</span>
        </div>
        <div className='min-w-0 flex-1'>
          <p className='text-st-muted flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide'>
            <CalendarClock className='h-3.5 w-3.5' /> Next exam
          </p>
          <p className='text-st-fg text-lg font-semibold'>{exam.name}</p>
          <p className='text-st-muted text-sm'>
            {exam.when ? formatDay(exam.when) : ''}
            {exam.approx ? ` · week ${exam.week}, approx` : ''}
            {days !== null ? ` · ${daysLabel(days, exam.approx)}` : ''}
          </p>
        </div>
      </div>
      {exam.chapters.length || exam.topics.length ? (
        <div className='flex flex-wrap gap-1.5'>
          {exam.chapters.map((c) => (
            <Badge key={`c-${c}`}>{c}</Badge>
          ))}
          {exam.topics.map((t) => (
            <Badge key={`t-${t}`} tone='accent'>
              {t}
            </Badge>
          ))}
        </div>
      ) : null}
      <div className='flex flex-wrap gap-2'>
        <IfAi>
          <LinkButton href={mockExamHref(classId, topics)} variant='primary'>
            <ListChecks className='h-4 w-4' /> {topics.length ? 'Start mock exam on these topics' : 'Start mock exam'}
          </LinkButton>
        </IfAi>
        <LinkButton href={drillHref(classId)}>
          <Target className='h-4 w-4' /> Drill weak topics
        </LinkButton>
      </div>
    </div>
  );
}

function AllClassesCountdown({ className }: { className?: string }) {
  const classes = useClasses();
  const list = useMemo(() => (classes.data ?? []).filter((c) => !c.hidden), [classes.data]);
  const schedules = useSchedules(list.map((c) => c.id));
  const today = localIso();
  const rows = useMemo(
    () =>
      list
        .map((cls, i) => {
          const exam = nextExam(schedules[i]?.data ?? [], termStartOf(cls), today);

          return exam ? { cls, exam, days: daysUntil(exam, today) ?? Number.MAX_SAFE_INTEGER } : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => a.days - b.days),
    [list, schedules, today],
  );

  if (classes.isLoading) return <LoadingRows className={className} rows={2} />;
  if (!rows.length) return null;

  return (
    <section className={className}>
      <SectionTitle count={rows.length}>Upcoming exams</SectionTitle>
      <ul className='flex flex-col gap-3'>
        {rows.map(({ cls, exam, days }) => {
          const topics = examTopics(exam);

          return (
            <li key={cls.id}>
              <Surface className='flex flex-wrap items-center gap-3 p-3'>
                <span aria-hidden className='h-2.5 w-2.5 shrink-0 rounded-full' style={{ background: cls.color }} />
                <div className='min-w-0 flex-1'>
                  <p className='text-st-fg truncate text-sm font-medium'>
                    {cls.code || cls.name} · {exam.name}
                  </p>
                  <p className='text-st-muted truncate text-xs'>
                    {exam.when ? formatDay(exam.when) : ''}
                    {exam.approx ? ' (approx)' : ''}
                    {topics.length ? ` · ${topics.slice(0, 4).join(', ')}${topics.length > 4 ? '…' : ''}` : ''}
                  </p>
                </div>
                <Badge tone={days <= 7 ? 'warn' : 'accent'}>{daysLabel(days, exam.approx)}</Badge>
                <IfAi>
                  <Link
                    className='text-st-accent text-sm font-medium underline-offset-2 hover:underline'
                    href={mockExamHref(cls.id, topics)}
                  >
                    Mock exam
                  </Link>
                </IfAi>
              </Surface>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
