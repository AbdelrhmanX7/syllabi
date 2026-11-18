import type { Page } from '@/lib/api/types';

import { useEffect, useState } from 'react';
import { addToast, ClayButton } from '@repo/ui';
import { Mic, Pause, Play, Square } from 'lucide-react';

import {
  notebookRecordingElapsedMs,
  startNotebookRecording,
  stopNotebookRecording,
  toggleNotebookRecordingPause,
  useNotebookRecording,
} from './lib/notebookRecording';
import { formatClock } from './lib/transcript';

import { ActionButton } from '@/components/ui/primitives';
import { Sheet } from '@/features/inbox/components/Sheet';
import { useClasses } from '@/lib/api/hooks';

function savedToast() {
  addToast({
    title: 'Recording saved',
    description: 'The words will be ready under Lectures in a few minutes.',
    color: 'success',
    timeout: 6000,
  });
}

/**
 * Ends the notebook's recording when the notebook itself closes (never when only the top bar
 * re-mounts). Mount once per notebook screen.
 */
export function useStopRecordingOnLeave(pageId: string | undefined) {
  useEffect(() => {
    return () => {
      void stopNotebookRecording().then((saved) => saved && savedToast());
    };
  }, [pageId]);
}

/**
 * The round red «Record» button in the notebook's bottom tool bar: records the class through the mic while you
 * keep writing. The recording itself lives in `lib/notebookRecording` so this button can re-mount freely.
 */
export function NotebookRecordButton({ page }: { page: Page }) {
  const recording = useNotebookRecording();
  const [picking, setPicking] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(notebookRecordingElapsedMs());
  const classes = useClasses();
  const active = recording.phase === 'live' || recording.phase === 'stopping';

  useEffect(() => {
    if (recording.phase !== 'live') return;
    setElapsedMs(notebookRecordingElapsedMs());
    const timer = window.setInterval(() => setElapsedMs(notebookRecordingElapsedMs()), 500);

    return () => window.clearInterval(timer);
  }, [recording.phase]);

  const start = async (classId: string) => {
    setPicking(false);
    const result = await startNotebookRecording({ classId, pageId: page.id, title: `${page.title || 'Notebook'} · recording` });

    if (result !== 'ok') {
      addToast({
        title: 'Could not start recording',
        description:
          result === 'mic-denied'
            ? 'The app is not allowed to use the microphone. Allow it in the tablet settings and try again.'
            : 'Check your internet and try again.',
        color: 'danger',
        timeout: 8000,
      });
    }
  };

  const stop = async () => {
    setControlsOpen(false);
    if (await stopNotebookRecording()) savedToast();
  };

  const paused = recording.paused;
  const classList = classes.data ?? [];

  return (
    // First in the board's bottom tool bar (never over the page; the bar scrolls, so it always has room):
    // a small round red button; while recording, a red timer pill that opens Pause / Stop and save.
    <div className='pointer-events-auto flex items-center' data-testid='notebook-record'>
      {active ? (
        <ClayButton
          className='!flex h-9 min-w-[4.5rem] items-center justify-center gap-1.5 !rounded-full !border-2 !px-3 !py-0 !text-xs'
          color='danger'
          size='sm'
          onPress={() => setControlsOpen(true)}
        >
          <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full bg-white ${paused ? 'opacity-60' : 'animate-pulse'}`} />
          <span className='font-mono tabular-nums'>{formatClock(elapsedMs / 1000)}</span>
          <span className='sr-only'>{paused ? 'Recording paused: open controls' : 'Recording: open controls'}</span>
        </ClayButton>
      ) : (
        <ClayButton
          className='!flex h-9 w-9 items-center justify-center !rounded-full !border-2 !p-0'
          color='danger'
          isDisabled={recording.phase === 'starting'}
          size='sm'
          onPress={() => (page.classId ? void start(page.classId) : setPicking(true))}
        >
          <Mic aria-hidden className='h-4 w-4' />
          <span className='sr-only'>Record the class</span>
        </ClayButton>
      )}
      {controlsOpen && active && (
        <Sheet title={paused ? 'Recording paused' : 'Recording'} onClose={() => setControlsOpen(false)}>
          <div className='flex flex-wrap items-center gap-3'>
            <span className='inline-flex items-center gap-2 font-mono text-sm tabular-nums'>{formatClock(elapsedMs / 1000)}</span>
            <ActionButton disabled={recording.phase !== 'live'} variant='secondary' onClick={toggleNotebookRecordingPause}>
              {paused ? <Play className='h-4 w-4' /> : <Pause className='h-4 w-4' />}
              {paused ? 'Resume' : 'Pause'}
            </ActionButton>
            <ActionButton disabled={recording.phase !== 'live'} variant='primary' onClick={() => void stop()}>
              <Square className='h-4 w-4' />
              {recording.phase === 'stopping' ? 'Saving…' : 'Stop and save'}
            </ActionButton>
          </div>
        </Sheet>
      )}
      {picking && (
        <Sheet title='Which class is this?' onClose={() => setPicking(false)}>
          <div className='flex flex-col'>
            {classList.length === 0 ? (
              <p className='text-st-muted text-sm'>Add a class first, then record.</p>
            ) : (
              classList.map((cls) => (
                <button
                  key={cls.id}
                  className='hover:bg-st-accent-soft flex min-h-11 items-center gap-2 rounded-st px-2 text-left text-sm'
                  type='button'
                  onClick={() => void start(cls.id)}
                >
                  <span aria-hidden className='h-2.5 w-2.5 shrink-0 rounded-sm' style={{ backgroundColor: cls.color }} />
                  <span className='min-w-0 truncate'>{cls.name}</span>
                </button>
              ))
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}

export default NotebookRecordButton;
