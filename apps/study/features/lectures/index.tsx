import type { Lecture, StudyClass } from '@/lib/api/types';
import type { LectureDto } from './lib/api';
import type { LectureRef } from '@/features/lecturenotes/lib/lectures';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { isNoSpeech, LecturePlayback, LECTURE_STATUS_LABEL } from './LecturePlayback';
import { LectureRecorder, liveLectureIds } from './LectureRecorder';
import { listClasses, listLectures } from './lib/api';
import { getLectureQueue, useLectureQueueStatus } from './lib/queueInstance';
import { formatClock } from './lib/transcript';

import { attachPageToLecture } from '@/features/lecturenotes/hooks';

export { LecturePlayback } from './LecturePlayback';
export { LectureRecorder } from './LectureRecorder';
export { VideoStudy } from './VideoStudy';

export interface LecturesHomeProps {
  /** Pre-select / filter to one class. */
  classId?: string;
  /** Open straight into a lecture's playback. */
  lectureId?: string;
  /** …at this second (`?t=`, a tutor transcript chip). */
  startAtSec?: number;
  /** Start recording right away (Today → «Record + notes»), the page filed under `note`'s lecture. */
  record?: { title: string; note: LectureRef | null } | null;
}

type View = { kind: 'list' } | { kind: 'record'; classId: string; title: string } | { kind: 'play'; lectureId: string };

const STATUS_TONE: Record<Lecture['status'], string> = {
  recording: 'bg-st-danger/10 text-st-danger',
  uploading: 'bg-st-accent/10 text-st-accent',
  processing: 'bg-st-warn/10 text-st-warn',
  ready: 'bg-st-ok/10 text-st-ok',
  failed: 'bg-st-raised text-st-fg',
};

const defaultTitle = (studyClass: StudyClass | undefined) =>
  `${studyClass?.code ?? 'Lecture'} · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

export function LecturesHome({ classId, lectureId, startAtSec, record = null }: LecturesHomeProps) {
  const [view, setView] = useState<View>(lectureId ? { kind: 'play', lectureId } : { kind: 'list' });
  const queryClient = useQueryClient();
  const recordNote = record?.note ?? null;

  // A deep link that asks to record: straight into the recorder once the class is known.
  useEffect(() => {
    if (record && classId && !lectureId) setView({ kind: 'record', classId, title: record.title });
  }, [classId, record?.title]);
  const onPageCreated = useCallback(
    (page: { id: string; title: string }) => {
      if (recordNote && classId) void attachPageToLecture(queryClient, classId, page, recordNote);
    },
    [classId, queryClient, recordNote],
  );
  const [classes, setClasses] = useState<StudyClass[]>([]);
  const [lectures, setLectures] = useState<LectureDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(classId ?? null);
  const [formOpen, setFormOpen] = useState(false);
  const [formClassId, setFormClassId] = useState(classId ?? '');

  // The query string is empty on the first render of a static page; the class arrives a tick later.
  useEffect(() => {
    if (!classId) return;
    setFilter(classId);
    setFormClassId(classId);
  }, [classId]);

  // Same for a deep link to one lecture (`/lectures/?id=`): open its playback once the id is known.
  useEffect(() => {
    if (lectureId) setView({ kind: 'play', lectureId });
  }, [lectureId]);
  const [formTitle, setFormTitle] = useState('');
  const queueStatus = useLectureQueueStatus();

  const load = useCallback(async () => {
    try {
      const [classList, lectureList] = await Promise.all([listClasses(), listLectures(classId)]);

      setClasses(classList);
      setLectures(lectureList);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load lectures');
      setLectures((current) => current ?? []);
    }
  }, [classId]);

  useEffect(() => {
    if (view.kind === 'list') void load();
  }, [view.kind, load]);

  // Something is being transcribed: refresh the list until it settles.
  const anyProcessing = (lectures ?? []).some((lecture) => lecture.status === 'processing');

  useEffect(() => {
    if (view.kind !== 'list' || !anyProcessing) return;
    const timer = window.setInterval(() => void load(), 5_000);

    return () => window.clearInterval(timer);
  }, [view.kind, anyProcessing, load]);

  const classById = useMemo(() => new Map(classes.map((c) => [c.id, c])), [classes]);

  const groups = useMemo(() => {
    const byClass = new Map<string, LectureDto[]>();

    for (const lecture of lectures ?? []) {
      if (filter && lecture.classId !== filter) continue;
      const list = byClass.get(lecture.classId) ?? [];

      list.push(lecture);
      byClass.set(lecture.classId, list);
    }

    return Array.from(byClass.entries())
      .map(([id, list]) => ({ id, list: list.sort((a, b) => b.startedAt.localeCompare(a.startedAt)) }))
      .sort((a, b) => b.list[0].startedAt.localeCompare(a.list[0].startedAt));
  }, [lectures, filter]);

  const interrupted = (queueStatus?.sessions ?? []).filter(
    (session) => session.state === 'recording' && !liveLectureIds.has(session.lectureId),
  );
  const uploading = (queueStatus?.sessions ?? []).filter((session) => session.state === 'stopped' && !session.error);
  const parked = (queueStatus?.sessions ?? []).filter((session) => session.error);

  if (view.kind === 'record') {
    return (
      <LectureRecorder
        classId={view.classId}
        title={view.title}
        onCancel={() => setView({ kind: 'list' })}
        onDone={(id) => setView({ kind: 'play', lectureId: id })}
        onPageCreated={onPageCreated}
      />
    );
  }

  if (view.kind === 'play') {
    return (
      <LecturePlayback
        key={view.lectureId}
        lectureId={view.lectureId}
        startAtSec={view.lectureId === lectureId ? startAtSec : undefined}
        onBack={() => setView({ kind: 'list' })}
      />
    );
  }

  const openForm = () => {
    const initial = formClassId || filter || classes[0]?.id || '';

    setFormClassId(initial);
    setFormTitle(defaultTitle(classById.get(initial)));
    setFormOpen(true);
  };

  const startRecording = () => {
    if (!formClassId) return;
    setFormOpen(false);
    setView({
      kind: 'record',
      classId: formClassId,
      title: formTitle.trim() || defaultTitle(classById.get(formClassId)),
    });
  };

  return (
    <div className='h-full overflow-y-auto bg-st-bg text-st-fg'>
      <div className='mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6'>
        <header className='flex items-center gap-3'>
          <h1 className='flex-1 text-2xl font-semibold'>Lectures</h1>
          <button
            className='h-11 rounded-st border-2 border-st-danger-lip bg-st-danger px-5 text-sm font-semibold text-st-accent-fg hover:bg-st-danger/90 disabled:opacity-50 shadow-clay-danger transition-transform active:translate-y-[3px] active:shadow-none'
            disabled={classes.length === 0}
            type='button'
            onClick={openForm}
          >
            Record lecture
          </button>
        </header>

        {formOpen && (
          <section className='space-y-4 rounded-st-lg border-2 border-st-clay-edge bg-st-surface p-4 shadow-clay'>
            <div className='grid gap-4 sm:grid-cols-2'>
              <label className='space-y-1.5 text-sm'>
                <span className='font-medium'>Class</span>
                <select
                  className='h-11 w-full rounded-st border-2 border-st-control-edge bg-st-surface px-3'
                  value={formClassId}
                  onChange={(event) => {
                    setFormClassId(event.target.value);
                    setFormTitle(defaultTitle(classById.get(event.target.value)));
                  }}
                >
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className='space-y-1.5 text-sm'>
                <span className='font-medium'>Title</span>
                <input
                  className='h-11 w-full rounded-st border-2 border-st-control-edge bg-st-surface px-3'
                  value={formTitle}
                  onChange={(event) => setFormTitle(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && startRecording()}
                />
              </label>
            </div>
            <div className='flex justify-end gap-2'>
              <button
                className='h-11 rounded-md px-4 text-sm hover:bg-st-raised'
                type='button'
                onClick={() => setFormOpen(false)}
              >
                Cancel
              </button>
              <button
                className='h-11 rounded-st border-2 border-st-danger-lip bg-st-danger px-5 text-sm font-semibold text-st-accent-fg hover:bg-st-danger/90 disabled:opacity-50 shadow-clay-danger transition-transform active:translate-y-[3px] active:shadow-none'
                disabled={!formClassId}
                type='button'
                onClick={startRecording}
              >
                Start recording
              </button>
            </div>
          </section>
        )}

        {interrupted.map((session) => (
          <section
            key={session.lectureId}
            className='flex flex-wrap items-center gap-3 rounded-xl border border-st-warn/30 bg-st-warn/10 p-4 text-sm'
          >
            <p className='min-w-0 flex-1'>
              <span className='font-semibold'>{session.title}</span> was interrupted.{' '}
              {formatClock(session.durationMs / 1000)} of audio is saved on this tablet.
            </p>
            <button
              className='h-10 rounded-st border-2 border-st-accent-lip bg-st-accent px-4 font-medium text-st-accent-fg shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
              type='button'
              onClick={() => void getLectureQueue().stop(session.lectureId)}
            >
              Upload what was saved
            </button>
            <button
              className='h-10 rounded-md px-3 text-st-warn hover:bg-st-warn/10'
              type='button'
              onClick={() => void getLectureQueue().discard(session.lectureId)}
            >
              Discard
            </button>
          </section>
        ))}

        {parked.map((session) => (
          <section
            key={session.lectureId}
            className='flex flex-wrap items-center gap-3 rounded-xl border border-st-danger/30 bg-st-danger/10 p-4 text-sm text-st-danger'
          >
            <p className='min-w-0 flex-1'>
              <span className='font-semibold'>{session.title}</span> could not upload: {session.error?.message}
            </p>
            <button
              className='h-10 rounded-st border-2 border-st-accent-lip bg-st-accent px-4 font-medium text-st-accent-fg shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
              type='button'
              onClick={() => void getLectureQueue().retry(session.lectureId)}
            >
              Try again
            </button>
            <button
              className='h-10 rounded-md px-3 hover:bg-st-danger/10'
              type='button'
              onClick={() => void getLectureQueue().discard(session.lectureId)}
            >
              Discard
            </button>
          </section>
        ))}

        {uploading.length > 0 && (
          <section className='flex flex-wrap items-center gap-3 rounded-st-lg border-2 border-st-clay-edge bg-st-surface p-4 text-sm shadow-clay'>
            <p className='min-w-0 flex-1'>
              Uploading {uploading.length === 1 ? `“${uploading[0].title}”` : `${uploading.length} lectures`}
              {queueStatus && queueStatus.pendingChunks > 0 ? ` · ${queueStatus.pendingChunks} parts left` : ''}
              {queueStatus?.lastError ? ` · waiting for connection (${queueStatus.lastError})` : ''}
            </p>
            {queueStatus?.lastError && (
              <button
                className='h-10 rounded-st border-2 border-st-clay-edge bg-st-surface px-4 shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
                type='button'
                onClick={() => void getLectureQueue().pump()}
              >
                Retry now
              </button>
            )}
          </section>
        )}

        {classes.length > 1 && !classId && (
          <nav className='flex flex-wrap gap-2'>
            {[null, ...classes.map((c) => c.id)].map((id) => {
              const c = id ? classById.get(id) : undefined;
              const active = filter === id;

              return (
                <button
                  key={id ?? 'all'}
                  className={`h-9 rounded-md border px-4 text-sm ${
                    active
                      ? 'border-st-accent-lip bg-st-accent text-st-accent-fg'
                      : 'border-st-line text-st-fg hover:bg-st-raised'
                  }`}
                  type='button'
                  onClick={() => setFilter(id)}
                >
                  {c ? c.code : 'All classes'}
                </button>
              );
            })}
          </nav>
        )}

        {error && <p className='text-sm text-st-danger'>{error}</p>}
        {lectures === null && <p className='text-sm text-st-muted'>Loading…</p>}
        {lectures !== null && groups.length === 0 && (
          <p className='rounded-xl border border-dashed border-st-line p-8 text-center text-sm text-st-muted'>
            No lectures yet. Tap Record lecture when class starts. Your notes and the audio stay in sync.
          </p>
        )}

        {groups.map((group) => {
          const c = classById.get(group.id);

          return (
            <section key={group.id} className='space-y-2'>
              <h2 className='flex items-center gap-2 text-sm font-semibold text-st-muted'>
                <span
                  aria-hidden
                  className='h-2.5 w-2.5 rounded-full bg-st-muted'
                  style={c?.color ? { backgroundColor: c.color } : undefined}
                />
                {c ? `${c.code} — ${c.name}` : 'Unknown class'}
              </h2>
              <ul className='divide-y divide-st-line overflow-hidden rounded-st-lg border-2 border-st-clay-edge bg-st-surface shadow-clay'>
                {group.list.map((lecture) => (
                  <li key={lecture.id}>
                    <button
                      className='flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-st-raised'
                      type='button'
                      onClick={() => setView({ kind: 'play', lectureId: lecture.id })}
                    >
                      <div className='min-w-0 flex-1'>
                        <p className='truncate font-medium'>{lecture.title}</p>
                        <p className='text-xs text-st-muted'>
                          {new Date(lecture.startedAt).toLocaleString(undefined, {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}{' '}
                          · {formatClock(lecture.durationSec)}
                          {lecture.questionCount ? ` · ${lecture.questionCount} questions` : ''}
                          {isNoSpeech(lecture) ? ' · No speech detected' : ''}
                        </p>
                      </div>
                      <span className={`rounded-sm px-2.5 py-1 text-xs font-medium ${STATUS_TONE[lecture.status]}`}>
                        {LECTURE_STATUS_LABEL[lecture.status]}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default LecturesHome;
