import type { GlyphSample } from '@repo/whiteboard-react';

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Crosshair } from 'lucide-react';

import {
  cellSampleCount,
  cellsOnPage,
  nextPageWithMissing,
  pageCount,
  readSavedPage,
  savePage,
  sheetCells,
  sheetProgress,
} from '../lib/sheet';
import { hwNumber, hwT } from '../lib/strings';
import { useGlyphBank } from '../store';

import { InkCell } from './InkCell';

import { ActionButton, Badge, LoadingRows } from '@/components/ui/primitives';

/** Sync state, one muted line. */
export function RemoteLine({ remote }: { remote: ReturnType<typeof useGlyphBank>['remote'] }) {
  const key =
    remote === 'synced'
      ? 'remoteSynced'
      : remote === 'syncing'
        ? 'remoteSyncing'
        : remote === 'local-only'
          ? 'remoteLocalOnly'
          : remote === 'error'
            ? 'remoteError'
            : 'remoteIdle';

  return (
    <span className='text-st-muted text-xs' data-remote-status={remote}>
      {hwT(key)}
    </span>
  );
}

/**
 * The sheet: one page of cells at a time, previous / next, and a jump to the next page that still has
 * an unwritten cell. Progress IS the bank (a cell with a sample is done), so leaving and coming back
 * resumes on the saved page with every accepted letter in place.
 */
export function CalibrationSheet() {
  const { status, bank, remote, store } = useGlyphBank();
  const cells = sheetCells();
  const pages = pageCount(cells);
  const [page, setPage] = useState(0);

  // `router.query`-style: the saved page is client state, applied after mount.
  useEffect(() => setPage(Math.min(readSavedPage(), pages - 1)), [pages]);
  const progress = useMemo(() => sheetProgress(bank, cells), [bank, cells]);
  const visible = cellsOnPage(page, cells);
  const missingAhead = nextPageWithMissing(progress, page, cells);
  const goTo = (next: number) => {
    const clamped = Math.min(Math.max(0, next), pages - 1);

    setPage(clamped);
    savePage(clamped);
  };
  const accept = (key: string) => (sample: GlyphSample) => {
    void store?.addSample(key, sample);
  };

  if (status === 'loading' || !store) return <LoadingRows rows={4} />;

  return (
    <div data-calibration-sheet className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <Badge tone={progress.percent === 100 ? 'ok' : 'accent'}>
            {hwT('coverage', { percent: hwNumber(progress.percent) })}
          </Badge>
          <span
            className='text-st-muted text-xs tabular-nums'
            data-sheet-progress={`${progress.done}/${progress.total}`}
          >
            {hwT('coverageCount', { done: hwNumber(progress.done), total: hwNumber(progress.total) })}
          </span>
          <RemoteLine remote={remote} />
        </div>
        <div className='flex items-center gap-1'>
          <ActionButton
            aria-label={hwT('prevPage')}
            className='min-h-9 w-9 px-0'
            disabled={page === 0}
            onClick={() => goTo(page - 1)}
          >
            <ChevronLeft className='h-4 w-4' />
          </ActionButton>
          <span className='text-st-fg min-w-24 text-center text-xs font-medium tabular-nums' data-sheet-page={page + 1}>
            {hwT('page', { page: hwNumber(page + 1), total: hwNumber(pages) })}
          </span>
          <ActionButton
            aria-label={hwT('nextPage')}
            className='min-h-9 w-9 px-0'
            disabled={page >= pages - 1}
            onClick={() => goTo(page + 1)}
          >
            <ChevronRight className='h-4 w-4' />
          </ActionButton>
          {missingAhead !== null && missingAhead !== page ? (
            <ActionButton className='min-h-9 px-3 text-xs' onClick={() => goTo(missingAhead)}>
              <Crosshair className='h-3.5 w-3.5' /> {hwT('jumpMissing')}
            </ActionButton>
          ) : (
            progress.missing.length === 0 && <Badge tone='ok'>{hwT('allDone')}</Badge>
          )}
        </div>
      </div>
      <p className='text-st-muted text-xs'>{hwT('penOnly')}</p>
      <div className='grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4'>
        {visible.map((cell) => (
          <InkCell key={cell.key} cell={cell} count={cellSampleCount(bank, cell.key)} onAccept={accept(cell.key)} />
        ))}
      </div>
    </div>
  );
}
