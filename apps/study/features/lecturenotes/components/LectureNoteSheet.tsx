import type { LecturePick, LectureRef } from '../lib/lectures';
import type { Page, StudyClass } from '@/lib/api/types';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, NotebookPen, X } from 'lucide-react';
import { useRouter } from 'next/router';

import {
  attachPageToLecture,
  createLectureNote,
  notebookHref,
  useClassLectures,
  useDefaultLecture,
  useLectureNotesOf,
} from '../hooks';
import { lectureLabel, lectureNoteTitle, notesForLecture } from '../lib/lectures';

import { ActionButton, ErrorNote, INPUT_CLASS, LoadingRows } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';

const REASON: Record<LecturePick['reason'], (date: string | null) => string> = {
  today: () => "Today's class",
  next: (date) =>
    date
      ? `Next class · ${new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))}`
      : 'Next class',
  last: () => 'Latest',
  first: () => '',
};

export interface LectureNoteSheetProps {
  cls: StudyClass | undefined;
  classId: string;
  /** Attach mode: this existing notebook gets the lecture (no new page). */
  page?: Pick<Page, 'id' | 'title'> | null;
  onClose: () => void;
  /** Filed (and maybe renamed): the page as the backend has it now. */
  onAttached?: (lecture: LectureRef, page: Pick<Page, 'id' | 'title'>) => void;
}

/**
 * «New lecture note» — pick the lecture (today's class by default), keep or edit the title, and a
 * lined page opens, linked to its week, module and concept map. With `page` it is «Attach to
 * lecture…» for a notebook that already exists.
 */
export function LectureNoteSheet({ cls, classId, page = null, onClose, onAttached }: LectureNoteSheetProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { lectures, isLoading } = useClassLectures(classId);
  const { pick, session } = useDefaultLecture(cls, lectures);
  // Today's dated session note is always on the list, above the lectures Canvas names.
  const options = useMemo(() => [session, ...lectures.filter((row) => row.key !== session.key)], [lectures, session]);
  const notes = useLectureNotesOf(classId);
  // Attach mode on a page already filed: start on its lecture.
  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    page ? (notes.metas[page.id]?.key ?? null) : null,
  );
  // Attach mode keeps the notebook's own title unless he takes the lecture's.
  const [title, setTitle] = useState(page?.title ?? '');
  const titleEdited = useRef(Boolean(page));
  // Renaming needs PATCH /pages/:id — hidden while a listing shows the backend has no page fields.
  const canRename = Boolean(page) && notes.supported !== false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const selected = options.find((row) => row.key === (selectedKey ?? pick.lecture.key)) ?? null;

  useEffect(() => {
    if (selected && !titleEdited.current) setTitle(lectureNoteTitle(selected));
  }, [selected]);

  // The default row scrolls into view once the list is in.
  useEffect(() => {
    listRef.current?.querySelector(`[data-lecture="${pick.lecture.key}"]`)?.scrollIntoView({ block: 'center' });
  }, [pick.lecture.key]);

  const weeks = useMemo(() => {
    const out: { key: string; week: number | null; label: string; rows: LectureRef[] }[] = [
      { key: 'session', week: null, label: 'Dated note', rows: [session] },
    ];

    for (const lecture of options.slice(1)) {
      const last = out[out.length - 1];

      if (last && last.key !== 'session' && last.week === lecture.week) last.rows.push(lecture);
      else
        out.push({
          key: `w${lecture.week ?? 'none'}`,
          week: lecture.week,
          label: lecture.week !== null ? `Week ${lecture.week}` : 'Not by week',
          rows: [lecture],
        });
    }

    return out;
  }, [options, session]);

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (page) {
        const filed = await attachPageToLecture(queryClient, classId, page, selected, canRename ? title : undefined);

        onAttached?.(selected, filed);
        onClose();
      } else {
        const created = await createLectureNote(queryClient, { classId, lecture: selected, title });

        void router.push(notebookHref(created));
      }
    } catch (failure) {
      setError(describeError(failure, page ? 'Could not attach the notebook' : 'Could not start the note'));
      setBusy(false);
    }
  };

  return (
    <div aria-modal className='fixed inset-0 z-[60] flex items-end justify-center sm:items-center' role='dialog'>
      <button aria-label='Close' className='absolute inset-0 bg-st-shadow/40' type='button' onClick={onClose} />
      <div
        className='rounded-st-lg bg-st-surface border-st-clay-edge shadow-clay border-2 relative flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden'
        data-testid='lecture-note-sheet'
      >
        <header className='border-st-line flex items-center gap-2 border-b px-5 py-3'>
          <NotebookPen className='text-st-accent h-5 w-5' />
          <h2 className='text-st-fg flex-1 text-base font-semibold'>
            {page ? 'Attach to lecture' : 'New lecture note'}
          </h2>
          <button
            aria-label='Close'
            className='text-st-muted hover:bg-st-raised rounded-st p-2'
            type='button'
            onClick={onClose}
          >
            <X className='h-5 w-5' />
          </button>
        </header>

        <div className='min-h-0 flex-1 overflow-y-auto px-3 py-3'>
          {isLoading && <LoadingRows rows={5} />}
          {!isLoading && lectures.length === 0 && (
            <p className='text-st-muted px-2 pb-2 text-xs'>
              Canvas names no lectures, lessons or labs for this class — the dated note is filed by its week and day.
            </p>
          )}
          <ul ref={listRef} className='flex flex-col gap-3'>
            {weeks.map((group) => (
              <li key={group.key}>
                <p className='text-st-muted px-2 pb-1 text-xs font-semibold uppercase tracking-wide'>{group.label}</p>
                <div className='flex flex-col'>
                  {group.rows.map((lecture) => {
                    const active = selected?.key === lecture.key;
                    const count = notesForLecture(notes.pages, notes.metas, lecture).length;
                    const reason = pick.lecture.key === lecture.key ? REASON[pick.reason](pick.date) : '';

                    return (
                      <button
                        key={lecture.key}
                        aria-pressed={active}
                        className={`rounded-st flex min-h-12 items-center gap-3 px-3 py-2 text-left ${
                          active ? 'bg-st-accent/10 ring-st-accent ring-1' : 'hover:bg-st-raised'
                        }`}
                        data-lecture={lecture.key}
                        type='button'
                        onClick={() => {
                          // A new note follows the lecture; attach keeps the notebook's title (Use «…» takes it).
                          if (!page) titleEdited.current = false;
                          setSelectedKey(lecture.key);
                        }}
                      >
                        <span
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                            active ? 'border-st-accent bg-st-accent text-st-accent-fg' : 'border-st-line'
                          }`}
                        >
                          {active && <Check className='h-3.5 w-3.5' strokeWidth={3} />}
                        </span>
                        <span className='text-st-fg min-w-0 flex-1 truncate text-sm font-medium'>
                          {lectureLabel(lecture)}
                        </span>
                        {reason && (
                          <span className='bg-st-accent/15 text-st-accent shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold'>
                            {reason}
                          </span>
                        )}
                        {count > 0 && (
                          <span className='text-st-muted shrink-0 text-xs'>
                            {count} note{count > 1 ? 's' : ''}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <footer className='border-st-line flex flex-col gap-3 border-t px-5 py-4'>
          {(!page || canRename) && (
            <label className='flex flex-col gap-1.5'>
              <span className='text-st-fg flex items-center gap-2 text-sm font-medium'>
                Title
                {page && selected && title !== lectureNoteTitle(selected) && (
                  <button
                    className='text-st-accent text-xs font-medium underline-offset-2 hover:underline'
                    type='button'
                    onClick={() => setTitle(lectureNoteTitle(selected))}
                  >
                    Use «{lectureNoteTitle(selected)}»
                  </button>
                )}
              </span>
              <input
                className={INPUT_CLASS}
                placeholder='Lecture notes'
                value={title}
                onChange={(event) => {
                  titleEdited.current = true;
                  setTitle(event.target.value);
                }}
                onKeyDown={(event) => event.key === 'Enter' && void submit()}
              />
            </label>
          )}
          {selected && (
            <p className='text-st-muted text-xs'>
              {page ? 'Filed under ' : 'Lined paper, filed under '}
              {selected.week !== null ? `week ${selected.week}` : 'this class'}
              {selected.mapId ? ', linked to its concept map.' : '.'}
            </p>
          )}
          {error && <ErrorNote message={error} />}
          <div className='flex justify-end gap-2'>
            <ActionButton variant='ghost' onClick={onClose}>
              Cancel
            </ActionButton>
            <ActionButton disabled={!selected} loading={busy} variant='primary' onClick={() => void submit()}>
              {page ? 'Attach' : 'Start note'}
            </ActionButton>
          </div>
        </footer>
      </div>
    </div>
  );
}
