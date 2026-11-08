import type { DraftSlot } from '../lib/meetings';
import type { StudyClass } from '@/lib/api/types';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TimePicker, cn } from '@repo/ui';
import { Clock, Plus, Trash2, X } from 'lucide-react';

import { DAY_NAMES, describeMeetings, draftToMeetings, meetingsToDraft } from '../lib/meetings';

import { ActionButton, ErrorNote, INPUT_CLASS, SectionTitle, Surface } from '@/components/ui/primitives';
import { patchClass } from '@/lib/api/endpoints';
import { describeError } from '@/lib/api/errors';
import { useClasses } from '@/lib/api/hooks';

/** Whether this backend sends (and so keeps) class meeting times at all. */
const hasMeetingsField = (cls: StudyClass) => 'meetings' in cls;

/** «Set by you» / «From the syllabus» / the nudge when neither knows the times. */
export function meetingsSourceText(cls: StudyClass): string {
  if (!hasMeetingsField(cls)) return 'Class times need the newer backend.';
  if (!cls.meetings) return 'Not in the syllabus — set your class times.';

  return cls.meetingsSource === 'manual' ? 'Set by you' : 'From the syllabus';
}

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
};

/** Edit one class's meeting times: rows of day + start + end, Save, and Clear (back to the syllabus). */
export function ClassTimesEditor({ cls, onDone }: { cls: StudyClass; onDone?: () => void }) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<DraftSlot[]>(() => {
    const draft = meetingsToDraft(cls.meetings);

    return draft.length > 0 ? draft : [{ day: 1, start: '', end: '' }];
  });
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = hasMeetingsField(cls);

  const update = (index: number, patch: Partial<DraftSlot>) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const send = async (kind: 'save' | 'clear') => {
    setError(null);
    let meetings = null;

    if (kind === 'save') {
      const draft = draftToMeetings(rows, cls.meetings?.timeZone ?? browserTimeZone());

      if (!draft.ok) {
        setError(draft.error);

        return;
      }
      meetings = draft.meetings;
    }
    setBusy(kind);
    try {
      await patchClass(cls.id, { meetings });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['study', 'classes'] }),
        queryClient.invalidateQueries({ queryKey: ['study', 'today'] }),
      ]);
      onDone?.();
    } catch (failure) {
      setError(describeError(failure, 'Could not save the class times'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className='flex flex-col gap-3' data-testid='class-times-editor'>
      {rows.map((row, index) => (
        <div key={index} className='flex flex-wrap items-center gap-2'>
          <select
            aria-label='Day'
            className={cn(INPUT_CLASS, 'w-24')}
            value={row.day}
            onChange={(event) => update(index, { day: Number(event.target.value) })}
          >
            {DAY_NAMES.map((name, day) => (
              <option key={name} value={day}>
                {name}
              </option>
            ))}
          </select>
          <TimePicker
            aria-label='Starts'
            className='w-32'
            fullWidth={false}
            value={row.start}
            onChange={(next) => update(index, { start: next })}
          />
          <span className='text-st-muted text-sm'>to</span>
          <TimePicker
            aria-label='Ends'
            className='w-32'
            fullWidth={false}
            value={row.end}
            onChange={(next) => update(index, { end: next })}
          />
          <button
            aria-label='Remove this time'
            className='text-st-muted hover:bg-st-raised rounded-st p-2'
            type='button'
            onClick={() => setRows((current) => current.filter((_, at) => at !== index))}
          >
            <Trash2 className='h-4 w-4' />
          </button>
        </div>
      ))}
      <button
        className='text-st-accent inline-flex items-center gap-1.5 self-start text-sm font-medium'
        type='button'
        onClick={() =>
          setRows((current) => {
            const last = current[current.length - 1];

            // Another day at the same times is the usual next row (Mon → Wed).
            return [...current, { day: last ? (last.day + 2) % 7 : 1, start: last?.start ?? '', end: last?.end ?? '' }];
          })
        }
      >
        <Plus className='h-4 w-4' /> Add a day
      </button>
      {error && <ErrorNote message={error} />}
      <div className='flex flex-wrap justify-end gap-2'>
        {cls.meetings && (
          <ActionButton
            disabled={!supported}
            loading={busy === 'clear'}
            variant='ghost'
            onClick={() => void send('clear')}
          >
            {cls.meetingsSource === 'manual' ? 'Use the syllabus times' : 'Clear'}
          </ActionButton>
        )}
        <ActionButton
          disabled={!supported}
          loading={busy === 'save'}
          variant='primary'
          onClick={() => void send('save')}
        >
          Save class times
        </ActionButton>
      </div>
    </div>
  );
}

function ClassTimesRow({ cls }: { cls: StudyClass }) {
  const [open, setOpen] = useState(false);
  const summary = describeMeetings(cls.meetings);

  return (
    <li className='flex flex-col gap-3 py-3' data-testid='class-times-row'>
      <div className='flex flex-wrap items-center gap-3'>
        <span className='h-2.5 w-2.5 shrink-0 rounded-sm' style={{ backgroundColor: cls.color }} />
        <span className='min-w-0 flex-1'>
          <span className='text-st-fg block text-sm font-semibold'>{cls.code}</span>
          <span className={`block text-xs ${cls.meetings ? 'text-st-muted' : 'text-st-warn'}`}>
            {summary ? `${summary} · ${meetingsSourceText(cls)}` : meetingsSourceText(cls)}
          </span>
        </span>
        <ActionButton className='min-h-9 px-3 text-xs' onClick={() => setOpen((value) => !value)}>
          {open ? 'Close' : summary ? 'Edit' : 'Set times'}
        </ActionButton>
      </div>
      {open && <ClassTimesEditor cls={cls} onDone={() => setOpen(false)} />}
    </li>
  );
}

/** Settings → Class times: when each class meets («Class today» and the lecture-note default use it). */
export function ClassTimesSection() {
  const { data: classes } = useClasses();
  const visible = (classes ?? []).filter((cls) => !cls.hidden);

  return (
    <Surface className='p-5'>
      <SectionTitle>Class times</SectionTitle>
      <p className='text-st-muted text-xs'>
        When each class meets. Today shows «Class today» for these days, and a new lecture note picks that day&apos;s
        lecture.
      </p>
      <ul className='divide-st-line divide-y'>
        {visible.map((cls) => (
          <ClassTimesRow key={cls.id} cls={cls} />
        ))}
      </ul>
    </Surface>
  );
}

/** Class page header: the class's times as a chip, opening the editor in a sheet. */
export function ClassTimesButton({ cls }: { cls: StudyClass }) {
  const [open, setOpen] = useState(false);
  const summary = describeMeetings(cls.meetings);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!hasMeetingsField(cls)) return null;

  return (
    <>
      <button
        className={`rounded-st border-st-clay-edge bg-st-surface shadow-clay hover:bg-st-accent-soft inline-flex min-h-11 items-center gap-2 border-2 px-4 text-sm font-semibold transition-transform active:translate-y-[3px] active:shadow-none ${
          summary ? 'text-st-fg' : 'text-st-warn'
        }`}
        data-testid='class-times-button'
        title={meetingsSourceText(cls)}
        type='button'
        onClick={() => setOpen(true)}
      >
        <Clock className='h-4 w-4' /> {summary ?? 'Set class times'}
      </button>
      {open && (
        <div aria-modal className='fixed inset-0 z-[60] flex items-end justify-center sm:items-center' role='dialog'>
          <button
            aria-label='Close'
            className='absolute inset-0 bg-st-shadow/40'
            type='button'
            onClick={() => setOpen(false)}
          />
          <div className='rounded-st-lg bg-st-surface border-st-clay-edge shadow-clay border-2 relative flex w-full max-w-xl flex-col gap-3 p-5'>
            <header className='flex items-center gap-2'>
              <Clock className='text-st-accent h-5 w-5' />
              <h2 className='text-st-fg flex-1 text-base font-semibold'>{cls.code} class times</h2>
              <button
                aria-label='Close'
                className='text-st-muted hover:bg-st-raised rounded-st p-2'
                type='button'
                onClick={() => setOpen(false)}
              >
                <X className='h-5 w-5' />
              </button>
            </header>
            <p className={`text-xs ${cls.meetings ? 'text-st-muted' : 'text-st-warn'}`}>{meetingsSourceText(cls)}</p>
            <ClassTimesEditor cls={cls} onDone={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
