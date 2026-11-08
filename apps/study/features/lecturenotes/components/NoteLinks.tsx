import { BOARD_CHIP } from '@/components/ui/primitives';
import type { Page } from '@/lib/api/types';

import { useMemo, useState } from 'react';
import { Link2, NotebookPen } from 'lucide-react';
import Link from 'next/link';

import { notebookHref, useClassLectures, useLectureNotesOf } from '../hooks';
import { lectureOfTitle, metaLabel, notesByWeek } from '../lib/lectures';

import { LectureNoteSheet } from './LectureNoteSheet';

import { useClasses } from '@/lib/api/hooks';

function NoteChip({ page }: { page: Page }) {
  return (
    <Link
      className='border-st-line bg-st-surface text-st-fg hover:bg-st-raised inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border px-3 text-xs font-medium'
      href={notebookHref(page)}
    >
      <NotebookPen className='text-st-accent h-3.5 w-3.5 shrink-0' />
      <span className='truncate'>{page.title}</span>
    </Link>
  );
}

/** The lecture notes of one week, as chips (renders nothing when there are none). */
export function WeekNotes({
  classId,
  week,
  label = 'Your notes',
}: {
  classId: string;
  week: number | null;
  label?: string;
}) {
  const { lectures } = useClassLectures(classId);
  const { pages, metas } = useLectureNotesOf(classId);
  const rows = useMemo(
    () => (week === null ? [] : (notesByWeek(pages, metas, lectures).get(week) ?? [])),
    [lectures, metas, pages, week],
  );

  if (rows.length === 0) return null;

  return (
    <div className='flex flex-wrap items-center gap-1.5 px-3 py-2' data-testid='week-notes'>
      <span className='text-st-muted text-xs font-semibold'>{label}</span>
      {rows.map((page) => (
        <NoteChip key={page.id} page={page} />
      ))}
    </div>
  );
}

/** Weeks that hold at least one lecture note (the library shows a week for them even without documents). */
export function useLectureNoteWeeks(classId: string): number[] {
  const { lectures } = useClassLectures(classId);
  const { pages, metas } = useLectureNotesOf(classId);

  return useMemo(() => [...notesByWeek(pages, metas, lectures).keys()], [lectures, metas, pages]);
}

/** «Your Lecture 8 notes» on a concept map card: the pages linked to its lecture. */
export function MapLectureNotes({
  classId,
  mapId,
  lecture,
}: {
  classId: string;
  mapId: string;
  lecture: string | null;
}) {
  const { pages, metas } = useLectureNotesOf(classId);
  const number = lectureOfTitle(lecture);
  const rows = useMemo(
    () =>
      pages.filter((page) => {
        const meta = metas[page.id];

        if (meta) return meta.mapId === mapId || (number !== null && meta.lecture === number);

        return number !== null && lectureOfTitle(page.title) === number;
      }),
    [mapId, metas, number, pages],
  );

  if (rows.length === 0) return null;
  const head = number !== null ? `Your Lecture ${number} notes` : 'Your lecture notes';

  return (
    <div className='flex flex-col gap-1.5' data-testid='map-lecture-notes'>
      <span className='text-st-muted text-xs font-semibold'>{head}</span>
      <div className='flex flex-wrap gap-1.5'>
        {rows.map((page) => (
          <NoteChip key={page.id} page={page} />
        ))}
      </div>
    </div>
  );
}

/** Notebook header: «Attach to lecture…» for a free notebook (or the lecture it is filed under). */
export function AttachToLectureButton({
  classId,
  page,
  onFiled,
}: {
  classId: string;
  page: Pick<Page, 'id' | 'title'>;
  /** The page after filing — its title may have changed. */
  onFiled?: (page: Pick<Page, 'id' | 'title'>) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: classes } = useClasses('all');
  const { metas } = useLectureNotesOf(classId);
  const meta = metas[page.id];
  const label = meta ? metaLabel(meta) : 'Attach to lecture…';

  return (
    <>
      <button
        className={BOARD_CHIP}
        data-testid='attach-lecture'
        aria-label={label}
        title={meta ? 'Filed under this lecture — tap to change' : 'File this notebook under a lecture'}
        type='button'
        onClick={() => setOpen(true)}
      >
        <Link2 className='h-4 w-4 shrink-0' /> <span data-chip-label>{label}</span>
      </button>
      {open && (
        <LectureNoteSheet
          classId={classId}
          cls={classes?.find((row) => row.id === classId)}
          page={page}
          onAttached={(_lecture, filed) => onFiled?.(filed)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
