import type { ExamResultInput, ExamResultRow, ExamResultSection } from '../types';

import React, { useMemo, useState } from 'react';
import { Award, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { DatePicker } from '@repo/ui';

import { useResults, useSaveResult } from '../api';
import { resultPercent, resultTrend, splitList } from '../lib/schedule';
import { confirmDiscard, useUnsavedGuard } from '../lib/useUnsavedGuard';

import { formatDay } from './ScheduleEditor';

import {
  ActionButton,
  EmptyState,
  ErrorNote,
  Field,
  INPUT_CLASS,
  LoadingRows,
  Surface,
  TrendIcon,
} from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';

/** Real exam results of a class: list with % and trend, add (POST) / edit (PATCH) inline. */
export function ExamResults({ classId }: { classId: string }) {
  const results = useResults(classId);
  const rows = useMemo(() => results.data ?? [], [results.data]);
  const trend = useMemo(() => resultTrend(rows), [rows]);
  // null = closed, 'new' = add form, else the id being edited
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Surface as='section' className='p-4 sm:p-5'>
      <div className='mb-3 flex items-center gap-3'>
        <h2 className='text-st-fg flex flex-1 items-center gap-2 text-base font-semibold'>
          <Award className='h-4 w-4' /> Exam results
        </h2>
        {open === null ? (
          <ActionButton disabled={results.isLoading || results.isError} onClick={() => setOpen('new')}>
            <Plus className='h-4 w-4' /> Add result
          </ActionButton>
        ) : null}
      </div>

      {results.isLoading ? <LoadingRows rows={2} /> : null}
      {results.isError ? (
        <ErrorNote message={describeError(results.error)} onRetry={() => void results.refetch()} />
      ) : null}

      {open === 'new' ? <ResultForm classId={classId} onDone={() => setOpen(null)} /> : null}

      {results.data && !rows.length && open !== 'new' ? (
        <EmptyState hint='Add a graded exam to track your trend.' icon={Award} title='No results yet' />
      ) : null}

      <ul className='flex flex-col gap-2'>
        {[...rows.entries()].reverse().map(([i, row]) =>
          open === row.id ? (
            <li key={row.id}>
              <ResultForm classId={classId} initial={row} onDone={() => setOpen(null)} />
            </li>
          ) : (
            <li key={row.id}>
              <ResultRowView
                delta={trend[i] ?? null}
                row={row}
                onEdit={open === null ? () => setOpen(row.id) : undefined}
              />
            </li>
          ),
        )}
      </ul>
    </Surface>
  );
}

function ResultRowView({ row, delta, onEdit }: { row: ExamResultRow; delta: number | null; onEdit?: () => void }) {
  const percent = resultPercent(row);
  const tone =
    percent === null ? 'text-st-muted' : percent >= 90 ? 'text-st-ok' : percent >= 75 ? 'text-st-fg' : 'text-st-warn';

  return (
    <div className='rounded-st border-st-line border p-3'>
      <div className='flex flex-wrap items-center gap-3'>
        <div className='min-w-0 flex-1'>
          <p className='text-st-fg text-sm font-medium'>{row.name}</p>
          <p className='text-st-muted text-xs'>
            {row.date ? formatDay(row.date) : 'No date'}
            {row.chapters.length ? ` · ${row.chapters.join(', ')}` : ''}
          </p>
        </div>
        <span className='text-st-muted text-sm tabular-nums'>
          {row.score}/{row.maxScore}
        </span>
        <span className={`text-lg font-semibold tabular-nums ${tone}`}>{percent === null ? '—' : `${percent}%`}</span>
        {delta !== null ? (
          <span className='text-st-muted inline-flex items-center gap-0.5 text-xs tabular-nums'>
            <TrendIcon trend={delta > 0 ? 1 : delta < 0 ? -1 : 0} />
            {delta > 0 ? '+' : ''}
            {delta}
          </span>
        ) : null}
        {onEdit ? (
          <ActionButton aria-label={`Edit ${row.name}`} variant='ghost' onClick={onEdit}>
            <Pencil className='h-4 w-4' />
          </ActionButton>
        ) : null}
      </div>
      {row.sections?.length ? (
        <div className='mt-2 grid gap-1.5 sm:grid-cols-2'>
          {row.sections.map((s) => {
            const value = s.max ? Math.min(1, s.score / s.max) : 0;

            return (
              <div key={s.name} className='text-xs'>
                <div className='text-st-muted flex justify-between'>
                  <span className='truncate'>{s.name}</span>
                  <span className='tabular-nums'>
                    {s.score}/{s.max}
                  </span>
                </div>
                <div className='bg-st-raised mt-0.5 h-1.5 overflow-hidden rounded-full'>
                  <div
                    className={`h-full rounded-full ${value >= 0.75 ? 'bg-st-ok' : value >= 0.5 ? 'bg-st-warn' : 'bg-st-danger'}`}
                    style={{ width: `${Math.round(value * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {row.notes ? <p className='text-st-muted mt-2 whitespace-pre-wrap text-xs'>{row.notes}</p> : null}
    </div>
  );
}

interface SectionDraft {
  key: number;
  name: string;
  score: string;
  max: string;
}

let sectionKey = 1;

function ResultForm({ classId, initial, onDone }: { classId: string; initial?: ExamResultRow; onDone: () => void }) {
  const save = useSaveResult(classId);
  const [name, setName] = useState(initial?.name ?? '');
  const [date, setDate] = useState(initial?.date ?? '');
  const [score, setScore] = useState(initial ? String(initial.score) : '');
  const [max, setMax] = useState(initial ? String(initial.maxScore) : '');
  const [chapters, setChapters] = useState(initial?.chapters.join(', ') ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [sections, setSections] = useState<SectionDraft[]>(
    () =>
      initial?.sections?.map((s) => ({
        key: sectionKey++,
        name: s.name,
        score: String(s.score),
        max: String(s.max),
      })) ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useUnsavedGuard(touched && !save.isSuccess);

  const touch =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setTouched(true);
      set(v);
    };

  const build = (): ExamResultInput | string => {
    const s = Number(score);
    const m = Number(max);

    if (!name.trim()) return 'Give the exam a name.';
    if (score.trim() === '' || !Number.isFinite(s) || s < 0) return 'Score must be a number ≥ 0.';
    if (!Number.isFinite(m) || m <= 0) return 'Max score must be more than 0.';
    const cleanSections: ExamResultSection[] = [];

    for (const sec of sections) {
      if (!sec.name.trim() && !sec.score && !sec.max) continue;
      const ss = Number(sec.score);
      const sm = Number(sec.max);

      if (!sec.name.trim() || !Number.isFinite(ss) || ss < 0 || !Number.isFinite(sm) || sm <= 0)
        return 'Each section needs a name, a score and a max above 0.';
      cleanSections.push({ name: sec.name.trim(), score: ss, max: sm });
    }

    return {
      name: name.trim(),
      date: date || null,
      score: s,
      maxScore: m,
      chapters: splitList(chapters),
      sections: cleanSections,
      notes: notes.trim() ? notes.trim() : null,
    };
  };

  const submit = () => {
    const body = build();

    if (typeof body === 'string') {
      setError(body);

      return;
    }
    setError(null);
    save.mutate({ id: initial?.id, body }, { onSuccess: onDone });
  };

  const preview = Number(max) > 0 && score.trim() !== '' ? Math.round((Number(score) / Number(max)) * 1000) / 10 : null;

  return (
    <form
      className='rounded-st border-st-accent/40 bg-st-raised/40 mb-2 flex flex-col gap-3 border p-3'
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_11.5rem]'>
        <Field label='Exam'>
          <input
            className={INPUT_CLASS}
            maxLength={120}
            placeholder='Exam 1'
            value={name}
            onChange={(e) => touch(setName)(e.target.value)}
          />
        </Field>
        <Field label='Date'>
          <DatePicker aria-label='Date' isClearable value={date} onChange={(next) => touch(setDate)(next)} />
        </Field>
      </div>
      <div className='grid grid-cols-[1fr_1fr_auto] items-end gap-3'>
        <Field label='Score'>
          <input
            className={INPUT_CLASS}
            inputMode='decimal'
            min={0}
            step='any'
            type='number'
            value={score}
            onChange={(e) => touch(setScore)(e.target.value)}
          />
        </Field>
        <Field label='Out of'>
          <input
            className={INPUT_CLASS}
            inputMode='decimal'
            min={0}
            step='any'
            type='number'
            value={max}
            onChange={(e) => touch(setMax)(e.target.value)}
          />
        </Field>
        <span className='text-st-fg min-h-11 min-w-16 pb-2.5 text-end text-lg font-semibold tabular-nums'>
          {preview === null || !Number.isFinite(preview) ? '' : `${preview}%`}
        </span>
      </div>
      <Field hint='Comma separated' label='Chapters'>
        <input className={INPUT_CLASS} value={chapters} onChange={(e) => touch(setChapters)(e.target.value)} />
      </Field>

      <div className='flex flex-col gap-2'>
        <span className='text-st-fg text-sm font-medium'>Sections (optional)</span>
        {sections.map((sec) => (
          <div key={sec.key} className='grid grid-cols-[2fr_1fr_1fr_auto] gap-2'>
            <input
              aria-label='Section name'
              className={INPUT_CLASS}
              placeholder='Volcanoes'
              value={sec.name}
              onChange={(e) =>
                touch(setSections)(sections.map((s) => (s.key === sec.key ? { ...s, name: e.target.value } : s)))
              }
            />
            <input
              aria-label='Section score'
              className={INPUT_CLASS}
              inputMode='decimal'
              placeholder='Score'
              type='number'
              value={sec.score}
              onChange={(e) =>
                touch(setSections)(sections.map((s) => (s.key === sec.key ? { ...s, score: e.target.value } : s)))
              }
            />
            <input
              aria-label='Section max'
              className={INPUT_CLASS}
              inputMode='decimal'
              placeholder='Max'
              type='number'
              value={sec.max}
              onChange={(e) =>
                touch(setSections)(sections.map((s) => (s.key === sec.key ? { ...s, max: e.target.value } : s)))
              }
            />
            <ActionButton
              aria-label='Remove section'
              variant='ghost'
              onClick={() => touch(setSections)(sections.filter((s) => s.key !== sec.key))}
            >
              <Trash2 className='h-4 w-4' />
            </ActionButton>
          </div>
        ))}
        <ActionButton
          className='self-start'
          disabled={sections.length >= 30}
          variant='ghost'
          onClick={() => touch(setSections)([...sections, { key: sectionKey++, name: '', score: '', max: '' }])}
        >
          <Plus className='h-4 w-4' /> Add section
        </ActionButton>
      </div>

      <Field label='Notes'>
        <textarea
          className={`${INPUT_CLASS} min-h-20 py-2`}
          maxLength={5000}
          value={notes}
          onChange={(e) => touch(setNotes)(e.target.value)}
        />
      </Field>

      {error ? <ErrorNote message={error} /> : null}
      {save.isError ? <ErrorNote message={describeError(save.error)} /> : null}

      <div className='flex justify-end gap-2'>
        <ActionButton
          variant='ghost'
          onClick={() => {
            if (confirmDiscard(touched)) onDone();
          }}
        >
          <X className='h-4 w-4' /> Cancel
        </ActionButton>
        <ActionButton loading={save.isPending} type='submit' variant='primary'>
          <Save className='h-4 w-4' /> {initial ? 'Save changes' : 'Add result'}
        </ActionButton>
      </div>
    </form>
  );
}
