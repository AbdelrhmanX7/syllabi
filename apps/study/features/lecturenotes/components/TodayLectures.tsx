import type { LectureRef } from '../lib/lectures';
import type { StudyClass } from '@/lib/api/types';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Mic, NotebookPen, Presentation } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import {
  createLectureNote,
  findLectureNote,
  notebookHref,
  todayIso,
  useClassLectures,
  useDefaultLecture,
  useLectureNotesOf,
  useMeetingDaysByClass,
} from '../hooks';
import { lectureLabel, lectureNoteTitle, weekdayOf } from '../lib/lectures';

import { ActionButton, BUTTON_VARIANT, SectionTitle, Surface } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';

/** `/lectures/?record=1…` — the recorder with its synced notebook page, filed under this lecture. */
export function recordHref(classId: string, lecture: LectureRef) {
  const query = new URLSearchParams({
    classId,
    record: '1',
    title: lectureNoteTitle(lecture),
    note: JSON.stringify(lecture),
  });

  return `/lectures/?${query.toString()}`;
}

function ClassLectureRow({ cls }: { cls: StudyClass }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { lectures } = useClassLectures(cls.id);
  // The class meets today: its lecture for today, else today's dated session note — never nothing.
  const lecture = useDefaultLecture(cls, lectures).pick.lecture;
  const { pages, metas } = useLectureNotesOf(cls.id);
  const existing = findLectureNote(pages, metas, lecture);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (!lecture) return;
    if (existing) {
      void router.push(notebookHref(existing));

      return;
    }
    setBusy(true);
    setError(null);
    try {
      const page = await createLectureNote(queryClient, { classId: cls.id, lecture, title: lectureNoteTitle(lecture) });

      void router.push(notebookHref(page));
    } catch (failure) {
      setError(describeError(failure, 'Could not start the note'));
      setBusy(false);
    }
  };

  return (
    <li className='flex flex-wrap items-center gap-3 px-3 py-2' data-testid='today-lecture'>
      <span className='h-2.5 w-2.5 shrink-0 rounded-sm' style={{ backgroundColor: cls.color }} />
      <span className='min-w-0 flex-1'>
        <span className='text-st-fg block truncate text-sm font-semibold'>{cls.code}</span>
        <span className='text-st-muted block truncate text-xs'>{lectureLabel(lecture)}</span>
        {error && <span className='text-st-danger block text-xs'>{error}</span>}
      </span>
      <>
        <ActionButton loading={busy} variant='primary' onClick={() => void start()}>
          <NotebookPen className='h-4 w-4' /> {existing ? 'Open notes' : "Start today's lecture"}
        </ActionButton>
        {!existing && (
          <Link
            className={`rounded-st inline-flex min-h-11 items-center gap-2 px-4 text-sm font-medium ${BUTTON_VARIANT.secondary}`}
            href={recordHref(cls.id, lecture)}
          >
            <Mic className='h-4 w-4' /> Record + notes
          </Link>
        )}
      </>
    </li>
  );
}

/**
 * Today: one row per class that meets today (Class.meetings, else the A plan; a class whose times are
 * unknown has no row), one tap into its lecture note.
 */
export function TodayLectures({ classes }: { classes: readonly StudyClass[] }) {
  const days = useMeetingDaysByClass(classes);
  const weekday = weekdayOf(todayIso());
  const meeting = classes.filter((cls) => !cls.hidden && (days.get(cls.id) ?? []).includes(weekday));

  if (meeting.length === 0) return null;

  return (
    <Surface className='mb-6 p-4'>
      <SectionTitle count={meeting.length}>
        <Presentation className='text-st-muted mr-1 inline h-4 w-4' /> Class today
      </SectionTitle>
      <ul className='flex flex-col'>
        {meeting.map((cls) => (
          <ClassLectureRow key={cls.id} cls={cls} />
        ))}
      </ul>
    </Surface>
  );
}
