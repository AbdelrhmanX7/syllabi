import type { ExamScheduleEntry } from '../types';

import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { DatePicker } from '@repo/ui';

import { useSaveSchedule, useSchedule } from '../api';
import { cleanSchedule, daysLabel, daysUntil, localIso, resolveExam, splitList } from '../lib/schedule';
import { confirmDiscard, useUnsavedGuard } from '../lib/useUnsavedGuard';

import {
  ActionButton,
  Badge,
  EmptyState,
  ErrorNote,
  INPUT_CLASS,
  LoadingRows,
  Surface,
} from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';

/** Editable copy of a row: chapter/topic lists as plain comma text while typing. */
interface RowDraft {
  key: number;
  name: string;
  week: string;
  date: string;
  chapters: string;
  topics: string;
}

let nextKey = 1;

const toDraft = (e: ExamScheduleEntry): RowDraft => ({
  key: nextKey++,
  name: e.name,
  week: e.week === null ? '' : String(e.week),
  date: e.date ?? '',
  chapters: e.chapters.join(', '),
  topics: e.topics.join(', '),
});

const fromDraft = (d: RowDraft): ExamScheduleEntry => ({
  name: d.name,
  week: d.week.trim() === '' ? null : Number(d.week),
  date: d.date || null,
  chapters: splitList(d.chapters),
  topics: splitList(d.topics),
});

export const formatDay = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/** The class exam schedule: read-only list with countdowns, or rows to edit (PUT on save). */
export function ScheduleEditor({ classId, termStart }: { classId: string; termStart: string | null }) {
  const schedule = useSchedule(classId);
  const save = useSaveSchedule(classId);
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<RowDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const saved = useMemo(() => schedule.data ?? [], [schedule.data]);
  const dirty = editing && JSON.stringify(rows.map(fromDraft)) !== JSON.stringify(saved);
  const today = localIso();

  useUnsavedGuard(dirty);

  useEffect(() => {
    if (!editing) setRows(saved.map(toDraft));
  }, [editing, saved]);

  const patch = (key: number, change: Partial<RowDraft>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const submit = () => {
    const clean = cleanSchedule(rows.map(fromDraft));

    if (typeof clean === 'string') {
      setError(clean);

      return;
    }
    setError(null);
    save.mutate(clean, { onSuccess: () => setEditing(false) });
  };

  return (
    <Surface as='section' className='p-4 sm:p-5'>
      <div className='mb-3 flex flex-wrap items-center gap-3'>
        <h2 className='text-st-fg flex flex-1 items-center gap-2 text-base font-semibold'>
          <CalendarDays className='h-4 w-4' /> Exam schedule
        </h2>
        {editing ? (
          <div className='flex gap-2'>
            <ActionButton
              variant='ghost'
              onClick={() => {
                if (!confirmDiscard(dirty)) return;
                setError(null);
                setEditing(false);
              }}
            >
              <X className='h-4 w-4' /> Cancel
            </ActionButton>
            <ActionButton disabled={!dirty} loading={save.isPending} variant='primary' onClick={submit}>
              <Save className='h-4 w-4' /> Save
            </ActionButton>
          </div>
        ) : (
          <ActionButton
            disabled={schedule.isLoading || schedule.isError}
            onClick={() => {
              save.reset();
              setRows(saved.map(toDraft));
              setEditing(true);
            }}
          >
            <Pencil className='h-4 w-4' /> Edit
          </ActionButton>
        )}
      </div>

      {schedule.isLoading ? <LoadingRows rows={3} /> : null}
      {schedule.isError ? (
        <ErrorNote message={describeError(schedule.error)} onRetry={() => void schedule.refetch()} />
      ) : null}
      {error ? <ErrorNote message={error} /> : null}
      {save.isError ? <ErrorNote message={describeError(save.error)} /> : null}

      {editing ? (
        <div className='flex flex-col gap-3'>
          {rows.map((row) => {
            const resolved = resolveExam(fromDraft(row), termStart);

            return (
              <div
                key={row.key}
                className='rounded-st border-st-line grid gap-2 border p-3 sm:grid-cols-[11.5rem_minmax(0,1fr)_4.5rem_auto]'
              >
                {/* sm+: name | week | remove, then date | chapters, then topics (the date needs its full width). */}
                <input
                  aria-label='Exam name'
                  className={`${INPUT_CLASS} sm:col-span-2`}
                  maxLength={120}
                  placeholder='Exam name'
                  value={row.name}
                  onChange={(e) => patch(row.key, { name: e.target.value })}
                />
                <input
                  aria-label='Week'
                  className={INPUT_CLASS}
                  inputMode='numeric'
                  max={60}
                  min={0}
                  placeholder='Week'
                  type='number'
                  value={row.week}
                  onChange={(e) => patch(row.key, { week: e.target.value })}
                />
                <DatePicker
                  isClearable
                  aria-label='Date'
                  className='sm:col-start-1'
                  value={row.date}
                  onChange={(next) => patch(row.key, { date: next })}
                />
                <ActionButton
                  aria-label={`Remove ${row.name || 'exam'}`}
                  className='sm:col-start-4 sm:row-start-1'
                  variant='ghost'
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                >
                  <Trash2 className='h-4 w-4' />
                </ActionButton>
                <input
                  aria-label='Chapters'
                  className={`${INPUT_CLASS} sm:col-span-3`}
                  placeholder='Chapters, comma separated'
                  value={row.chapters}
                  onChange={(e) => patch(row.key, { chapters: e.target.value })}
                />
                <input
                  aria-label='Topics'
                  className={`${INPUT_CLASS} sm:col-span-4`}
                  placeholder='Topics, comma separated'
                  value={row.topics}
                  onChange={(e) => patch(row.key, { topics: e.target.value })}
                />
                {resolved.approx && resolved.when ? (
                  <p className='text-st-muted text-xs sm:col-span-4'>
                    No date: counting down to week {row.week} ({formatDay(resolved.when)}, approx)
                  </p>
                ) : null}
              </div>
            );
          })}
          <ActionButton
            className='self-start'
            disabled={rows.length >= 20}
            onClick={() =>
              setRows((current) => [
                ...current,
                toDraft({ name: '', week: null, date: null, chapters: [], topics: [] }),
              ])
            }
          >
            <Plus className='h-4 w-4' /> Add exam
          </ActionButton>
        </div>
      ) : schedule.data ? (
        saved.length ? (
          <ul className='divide-st-line flex flex-col divide-y'>
            {saved.map((entry, i) => {
              const resolved = resolveExam(entry, termStart);
              const days = daysUntil(resolved, today);
              const past = days !== null && days < 0;

              return (
                <li
                  key={`${entry.name}-${i}`}
                  className={`flex flex-wrap items-center gap-2 py-2.5 ${past ? 'opacity-60' : ''}`}
                >
                  <span className='text-st-fg min-w-0 flex-1 text-sm font-medium'>
                    {entry.name}
                    <span className='text-st-muted ms-2 font-normal'>
                      {entry.week ? `Week ${entry.week}` : ''}
                      {resolved.when ? ` · ${formatDay(resolved.when)}${resolved.approx ? ' (approx)' : ''}` : ''}
                    </span>
                  </span>
                  {[...entry.chapters, ...entry.topics].map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                  <Badge tone={past ? 'neutral' : days !== null && days <= 7 ? 'warn' : 'accent'}>
                    {past ? 'Done' : daysLabel(days, resolved.approx)}
                  </Badge>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            hint='Add the exams with their week or date and chapters.'
            icon={CalendarDays}
            title='No exams scheduled'
          />
        )
      ) : null}
    </Surface>
  );
}
