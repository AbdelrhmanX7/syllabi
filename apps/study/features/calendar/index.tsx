import type { CalendarEvent, CalendarKind } from './lib/events';

import { useMemo, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, ClipboardList, GraduationCap, Repeat } from 'lucide-react';
import { cn } from '@repo/ui';
import Link from 'next/link';
import { useQueries, useQuery } from '@tanstack/react-query';

import { addDays, buildEvents, byDate, dateKey, monthGrid, startOfWeek } from './lib/events';
import { ActionButton, ErrorNote, FilterChip, LoadingRows } from '@/components/ui/primitives';
import { getExamsSchedule, listClassItems, listQuestions } from '@/lib/api/endpoints';
import { describeError } from '@/lib/api/errors';
import { studyKeys, useClasses } from '@/lib/api/hooks';

type View = 'week' | 'month';


const KIND_ICON: Record<CalendarKind, typeof BookOpen> = {
  class: BookOpen,
  due: ClipboardList,
  exam: GraduationCap,
  review: Repeat,
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** Everything dated, in one place: due dates, exams, class meetings and reviews (features/calendar/lib). */
export function CalendarView() {
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const today = dateKey(new Date());

  const days = useMemo(
    () => (view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i)) : monthGrid(anchor)),
    [anchor, view],
  );
  const from = dateKey(days[0]!);
  const to = dateKey(days[days.length - 1]!);

  const classes = useClasses();
  const list = classes.data ?? [];
  const items = useQueries({
    queries: list.map((c) => ({
      queryKey: studyKeys.items(c.id),
      queryFn: () => listClassItems(c.id),
      staleTime: 60_000,
    })),
  });
  const exams = useQueries({
    queries: list.map((c) => ({
      queryKey: ['study', 'exams-schedule', c.id] as const,
      queryFn: () => getExamsSchedule(c.id),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const questions = useQuery({
    queryKey: ['study', 'calendar', 'questions'] as const,
    queryFn: () => listQuestions({ limit: 500 }),
    staleTime: 60_000,
  });

  const events = useMemo(() => {
    const examMap: Record<string, Awaited<ReturnType<typeof getExamsSchedule>>> = {};

    list.forEach((c, i) => {
      const data = exams[i]?.data;

      if (Array.isArray(data)) examMap[c.id] = data;
    });

    return byDate(
      buildEvents(
        {
          classes: list,
          items: items.flatMap((q) => q.data ?? []),
          exams: examMap,
          questions: questions.data?.items ?? [],
        },
        from,
        to,
      ),
    );
    // The query result arrays are new each render; their data is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, items.map((q) => q.dataUpdatedAt).join(), exams.map((q) => q.dataUpdatedAt).join(), questions.data, from, to]);

  const step = (dir: -1 | 1) =>
    setAnchor((d) => (view === 'week' ? addDays(d, 7 * dir) : new Date(d.getFullYear(), d.getMonth() + dir, 1)));

  const title =
    view === 'month' ? MONTH.format(anchor) : `${DAY.format(days[0]!)} – ${DAY.format(days[6]!)}, ${days[6]!.getFullYear()}`;

  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <h2 className='text-st-fg font-display min-w-0 flex-1 basis-full text-lg font-bold sm:basis-0'>{title}</h2>
        <FilterChip active={view === 'week'} onClick={() => setView('week')}>
          Week
        </FilterChip>
        <FilterChip active={view === 'month'} onClick={() => setView('month')}>
          Month
        </FilterChip>
        <ActionButton aria-label='Previous' className='min-h-10 w-10 px-0' onClick={() => step(-1)}>
          <ChevronLeft className='h-4 w-4' />
        </ActionButton>
        <ActionButton className='min-h-10' onClick={() => setAnchor(new Date())}>
          Today
        </ActionButton>
        <ActionButton aria-label='Next' className='min-h-10 w-10 px-0' onClick={() => step(1)}>
          <ChevronRight className='h-4 w-4' />
        </ActionButton>
      </div>

      {classes.error && <ErrorNote message={describeError(classes.error)} onRetry={() => void classes.refetch()} />}
      {classes.isLoading && <LoadingRows rows={5} />}

      {!classes.isLoading &&
        (view === 'week' ? (
          <WeekGrid days={days} events={events} today={today} />
        ) : (
          <MonthGrid
            anchorMonth={anchor.getMonth()}
            days={days}
            events={events}
            today={today}
            onPickDay={(d) => {
              setAnchor(d);
              setView('week');
            }}
          />
        ))}

      <Legend />
    </div>
  );
}

function WeekGrid({ days, events, today }: { days: Date[]; events: Map<string, CalendarEvent[]>; today: string }) {
  return (
    // Flat columns on one clay surface; a day's list scrolls inside the page, never clipped.
    <div className='border-st-clay-edge bg-st-surface shadow-clay grid grid-cols-1 overflow-hidden rounded-st-lg border-2 sm:grid-cols-7'>
      {days.map((d, i) => {
        const key = dateKey(d);
        const list = events.get(key) ?? [];

        return (
          <div key={key} className={cn(
              // Phones: one row per day (stacked); sm and up: seven columns.
              'flex min-w-0 flex-col gap-1.5 p-1.5 sm:min-h-[14rem]',
              i > 0 && 'border-st-line border-t sm:border-s sm:border-t-0',
            )}>
            <div
              className={cn(
                'flex items-baseline justify-start gap-1 rounded-md px-2 py-1 text-xs font-semibold sm:justify-center sm:px-0',
                key === today ? 'bg-st-accent text-st-accent-fg' : 'text-st-muted',
              )}
            >
              <span>{WEEKDAYS[i]}</span>
              <span className={cn('text-sm', key === today ? '' : 'text-st-fg')}>{d.getDate()}</span>
            </div>
            {list.map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function EventRow({ event }: { event: CalendarEvent }) {
  const Icon = KIND_ICON[event.kind];
  const accent = event.color ?? 'rgb(var(--st-accent))';

  return (
    <Link
      className={cn(
        'group flex min-w-0 flex-col gap-0.5 rounded-md border-s-[3px] px-1.5 py-1 text-[11px] leading-tight transition-colors',
        event.kind === 'exam' ? 'bg-st-danger/10' : event.kind === 'review' ? 'bg-st-accent-soft' : 'bg-st-raised/60',
        'hover:bg-st-accent-soft',
      )}
      href={event.href}
      style={{ borderInlineStartColor: accent }}
      title={event.title}
    >
      <span className='text-st-muted flex min-w-0 flex-wrap items-center gap-x-1 font-semibold tabular-nums'>
        <Icon aria-hidden className='h-3 w-3 shrink-0' />
        {event.time ? (
          <>
            <span className='whitespace-nowrap'>{event.time}</span>
            {event.end && <span className='whitespace-nowrap'>–{event.end}</span>}
          </>
        ) : event.kind === 'due' ? (
          'Due'
        ) : event.kind === 'exam' ? (
          'Exam'
        ) : null}
      </span>
      <span className='text-st-fg font-semibold [overflow-wrap:anywhere]'>{event.title}</span>
    </Link>
  );
}

function MonthGrid({
  days,
  events,
  today,
  anchorMonth,
  onPickDay,
}: {
  days: Date[];
  events: Map<string, CalendarEvent[]>;
  today: string;
  anchorMonth: number;
  onPickDay: (d: Date) => void;
}) {
  return (
    <div className='border-st-clay-edge bg-st-surface shadow-clay overflow-hidden rounded-st-lg border-2'>
      <div className='border-st-line grid grid-cols-7 border-b'>
        {WEEKDAYS.map((w) => (
          <span key={w} className='text-st-muted py-1.5 text-center text-xs font-semibold'>
            {w}
          </span>
        ))}
      </div>
      <div className='grid grid-cols-7'>
        {days.map((d, i) => {
          const key = dateKey(d);
          const list = events.get(key) ?? [];
          const shown = list.filter((e) => e.kind !== 'class').slice(0, 3);
          const more = list.filter((e) => e.kind !== 'class').length - shown.length;

          return (
            <div
              key={key}
              className={cn(
                'flex min-h-[5.5rem] min-w-0 flex-col gap-0.5 p-1',
                i % 7 > 0 && 'border-st-line border-s',
                i >= 7 && 'border-st-line border-t',
                d.getMonth() !== anchorMonth && 'opacity-45',
              )}
            >
              <button
                aria-label={`Open the week of ${DAY.format(d)}`}
                className={cn(
                  'flex h-6 w-6 items-center justify-center self-end rounded-full text-xs font-semibold transition-colors',
                  key === today ? 'bg-st-accent text-st-accent-fg' : 'text-st-fg hover:bg-st-accent-soft',
                )}
                type='button'
                onClick={() => onPickDay(d)}
              >
                {d.getDate()}
              </button>
              {shown.map((e) => (
                <Link
                  key={e.id}
                  className='text-st-fg hover:text-st-accent flex min-w-0 items-center gap-1 text-[11px] leading-tight'
                  href={e.href}
                  title={e.title}
                >
                  <span aria-hidden className='h-2 w-2 shrink-0 rounded-full' style={{ background: e.color ?? 'rgb(var(--st-accent))' }} />
                  <span className='truncate'>{e.title}</span>
                </Link>
              ))}
              {more > 0 && (
                <button className='text-st-muted hover:text-st-accent self-start text-[11px] font-semibold' type='button' onClick={() => onPickDay(d)}>
                  +{more} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Legend() {
  const rows: [CalendarKind, string][] = [
    ['class', 'Class'],
    ['due', 'Due'],
    ['exam', 'Exam'],
    ['review', 'Reviews'],
  ];

  return (
    <div className='text-st-muted flex flex-wrap items-center gap-4 text-xs'>
      {rows.map(([kind, label]) => {
        const Icon = KIND_ICON[kind];

        return (
          <span key={kind} className='inline-flex items-center gap-1.5'>
            <Icon aria-hidden className='h-3.5 w-3.5' /> {label}
          </span>
        );
      })}
      <span>Bars and dots use the class colour.</span>
    </div>
  );
}
