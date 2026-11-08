import type { UpdateState } from '@/lib/platform/app-update';

import { Download, X } from 'lucide-react';

import { ActionButton, Surface } from '@/components/ui/primitives';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import { canInstallInApp, snoozeUpdate, startUpdate } from '@/lib/platform/app-update';

const MB = 1024 * 1024;

export function releaseLabel(state: UpdateState): string {
  const feed = state.feed;

  if (!feed) return '';

  return `Syllabi ${feed.version}${feed.sha ? ` (build ${feed.sha})` : ''}`;
}

/** Download progress / install hand-off / failure — shared by the banner and Settings. */
export function UpdateProgress({ state }: { state: UpdateState }) {
  if (state.phase === 'idle') return null;

  if (state.phase === 'error') {
    return <p className='text-st-danger text-xs'>{state.installError}</p>;
  }

  if (state.phase === 'permission') {
    return (
      <p className='text-st-muted text-xs'>
        Turn on <span className='text-st-fg font-medium'>Allow from this source</span> for Study, then come back — the
        install continues on its own.
      </p>
    );
  }

  if (state.phase === 'installing') {
    return <p className='text-st-muted text-xs'>Confirm the install in the system dialog. Your notes stay.</p>;
  }

  const total = state.total || state.feed?.size || 0;
  const percent = total > 0 ? Math.min(100, Math.round((state.received / total) * 100)) : 0;

  return (
    <div className='flex flex-col gap-1'>
      <div
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className='bg-st-raised h-1.5 overflow-hidden rounded-full'
        role='progressbar'
      >
        <div className='bg-st-accent h-full transition-[width] duration-200' style={{ width: `${percent}%` }} />
      </div>
      <p className='text-st-muted text-xs tabular-nums'>
        {state.phase === 'verifying'
          ? 'Verifying download…'
          : `Downloading… ${(state.received / MB).toFixed(1)}${total ? ` / ${(total / MB).toFixed(1)}` : ''} MB`}
      </p>
    </div>
  );
}

/** Non-blocking corner card: "Update available — Study <version> (build <sha>)". */
export function UpdateBanner() {
  const state = useAppUpdate();

  if (!state.available || (state.snoozed && state.phase === 'idle')) return null;

  const busy = state.phase === 'downloading' || state.phase === 'verifying';

  return (
    <Surface className='fixed bottom-[calc(1rem+var(--st-nav-offset,0px))] right-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-3 p-4'>
      <div className='flex items-start gap-3'>
        <Download className='text-st-accent mt-0.5 h-5 w-5 shrink-0' />
        <div className='min-w-0 flex-1'>
          <p className='text-st-fg text-sm font-semibold'>Update available — {releaseLabel(state)}</p>
          {state.feed?.notes && <p className='text-st-muted mt-1 text-xs'>{state.feed.notes}</p>}
        </div>
        {!busy && (
          <button
            aria-label='Later'
            className='text-st-muted hover:text-st-fg -m-1 rounded p-1'
            type='button'
            onClick={snoozeUpdate}
          >
            <X className='h-4 w-4' />
          </button>
        )}
      </div>
      <UpdateProgress state={state} />
      {!busy && state.phase !== 'installing' && (
        <div className='flex justify-end gap-2'>
          <ActionButton className='min-h-9 px-3 text-xs' variant='ghost' onClick={snoozeUpdate}>
            Later
          </ActionButton>
          <ActionButton className='min-h-9 px-3 text-xs' variant='primary' onClick={startUpdate}>
            {state.phase === 'error' ? 'Try again' : canInstallInApp() ? 'Update now' : 'Download'}
          </ActionButton>
        </div>
      )}
    </Surface>
  );
}
