import { useMemo, useState } from 'react';
import { PenLine, Trash2 } from 'lucide-react';

import { pickPreviewSamples } from '../lib/render';
import { sheetCells, sheetProgress } from '../lib/sheet';
import { hwNumber, hwT } from '../lib/strings';
import { useGlyphBank } from '../store';

import { RemoteLine } from './CalibrationSheet';
import { GlyphPreview } from './GlyphPreview';

import { ActionButton, Badge, LinkButton, LoadingRows, SectionTitle, Surface } from '@/components/ui/primitives';

export const HANDWRITING_ROUTE = '/handwriting/';

/**
 * Settings → My handwriting: how much of the sheet is written, the way in, a preview line of the owner's own
 * letters, and "clear" behind a confirm.
 */
export function HandwritingSection() {
  const { status, bank, remote, store } = useGlyphBank();
  const cells = sheetCells();
  const progress = useMemo(() => sheetProgress(bank, cells), [bank, cells]);
  const preview = useMemo(
    () =>
      pickPreviewSamples(
        bank.glyphs,
        cells.map((cell) => cell.key),
      ),
    [bank, cells],
  );
  const [confirming, setConfirming] = useState(false);
  const empty = progress.done === 0;

  return (
    <Surface className='p-5'>
      <SectionTitle
        action={
          <Badge tone={progress.percent === 100 ? 'ok' : empty ? 'neutral' : 'accent'}>
            {hwT('coverage', { percent: hwNumber(progress.percent) })}
          </Badge>
        }
      >
        <PenLine className='text-st-muted mr-1 inline h-4 w-4' /> {hwT('title')}
      </SectionTitle>
      <p className='text-st-muted text-xs'>{hwT('subtitle')}</p>

      {status === 'loading' ? (
        <LoadingRows className='mt-3' rows={1} />
      ) : (
        <>
          <div className='bg-st-raised mt-3 h-1.5 w-full overflow-hidden rounded-full'>
            <div className='bg-st-accent h-full rounded-full' style={{ width: `${progress.percent}%` }} />
          </div>
          <div className='mt-1 flex flex-wrap items-center justify-between gap-2'>
            <span className='text-st-muted text-xs tabular-nums'>
              {hwT('coverageCount', { done: hwNumber(progress.done), total: hwNumber(progress.total) })}
            </span>
            <RemoteLine remote={remote} />
          </div>

          <div data-preview-line className='mt-3 min-h-14 overflow-x-auto'>
            {preview.length === 0 ? (
              <p className='text-st-muted text-sm'>{hwT('previewEmpty')}</p>
            ) : (
              <GlyphPreview samples={preview} />
            )}
          </div>

          <div className='mt-3 flex flex-wrap items-center gap-2'>
            <LinkButton href={HANDWRITING_ROUTE} variant='primary'>
              <PenLine className='h-4 w-4' /> {hwT(empty ? 'startSheet' : 'continueSheet')}
            </LinkButton>
            {!empty &&
              (confirming ? (
                <span className='flex flex-wrap items-center gap-2'>
                  <span className='text-st-muted text-xs'>{hwT('clearConfirm')}</span>
                  <ActionButton
                    data-clear-confirm
                    className='min-h-9 px-3 text-xs'
                    variant='danger'
                    onClick={() => {
                      setConfirming(false);
                      void store?.clear();
                    }}
                  >
                    {hwT('confirm')}
                  </ActionButton>
                  <ActionButton className='min-h-9 px-3 text-xs' onClick={() => setConfirming(false)}>
                    {hwT('cancel')}
                  </ActionButton>
                </span>
              ) : (
                <ActionButton variant='danger' onClick={() => setConfirming(true)}>
                  <Trash2 className='h-4 w-4' /> {hwT('clearBank')}
                </ActionButton>
              ))}
          </div>
        </>
      )}
    </Surface>
  );
}
