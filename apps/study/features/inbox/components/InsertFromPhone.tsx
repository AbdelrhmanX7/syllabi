import type { InboxItem } from '../types';

import { useState } from 'react';
import { cn } from '@repo/ui';
import { Smartphone } from 'lucide-react';
import Link from 'next/link';

import { boardCandidates } from '../lib/reducer';
import { loadInboxFile, markItemUsed, useInbox } from '../store';

import { InboxThumb } from './InboxThumb';
import { Sheet } from './Sheet';

import { BOARD_CHIP, ErrorNote } from '@/components/ui/primitives';
import { formatRelative } from '@/lib/format';

/**
 * «Insert from phone» for a board: a chip that opens a sheet of recent inbox images (and PDFs when the
 * host passes `onInsertPdf`). A tap downloads the file and hands it over — an image goes to the
 * editor's `pendingImageImport` (viewport centre, one object, one undo step), a PDF to its
 * `pendingPdfImport` (pages appended after the import sheet) — then marks the item used.
 */
export function InsertFromPhoneButton({
  onInsert,
  onInsertPdf,
  className,
}: {
  /** The file, and the inbox item it came from (the host records it as a phone photo on the page). */
  onInsert: (file: File, item: InboxItem) => void;
  /** A PDF from the phone: its pages are appended to the board. Without it the sheet lists images only. */
  onInsertPdf?: (file: File, item: InboxItem) => void;
  className?: string;
}) {
  const inbox = useInbox();
  const [open, setOpen] = useState(false);
  const fresh = boardCandidates(inbox.items, { pdfs: !!onInsertPdf }).filter((item) => !item.usedAt).length;

  return (
    <>
      <button
        aria-label='Insert from phone'
        className={cn(
          BOARD_CHIP,
          className,
        )}
        title='Insert a photo from your phone'
        type='button'
        onClick={() => setOpen(true)}
      >
        <Smartphone className='h-4 w-4' />
        <span data-chip-label>
          From phone
        </span>
        {fresh > 0 && (
          <span className='bg-st-accent text-st-bg ml-0.5 rounded-sm px-1.5 text-[10px] font-bold leading-4'>
            {fresh}
          </span>
        )}
      </button>
      {open && <InsertFromPhoneSheet onClose={() => setOpen(false)} onInsert={onInsert} onInsertPdf={onInsertPdf} />}
    </>
  );
}

export function InsertFromPhoneSheet({
  onInsert,
  onInsertPdf,
  onClose,
}: {
  onInsert: (file: File, item: InboxItem) => void;
  onInsertPdf?: (file: File, item: InboxItem) => void;
  onClose: () => void;
}) {
  const inbox = useInbox();
  const items = boardCandidates(inbox.items, { pdfs: !!onInsertPdf }).slice(0, 24);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (item: InboxItem) => {
    setBusy(item.id);
    setError(null);
    try {
      const file = await loadInboxFile(item);

      // A PDF is marked used by the board once its pages are imported (the sheet can still be cancelled).
      if (item.kind === 'pdf') {
        onInsertPdf?.(file, item);
      } else {
        onInsert(file, item);
        void markItemUsed(item.id);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      wide
      subtitle={
        onInsertPdf
          ? 'A photo goes in the middle of the page; a PDF adds its pages to this note.'
          : 'Tap one to place it in the middle of the page. Undo removes it.'
      }
      title='Insert from phone'
      onClose={onClose}
    >
      {error && (
        <div className='mb-3'>
          <ErrorNote message={error} />
        </div>
      )}
      {items.length === 0 ? (
        <div className='text-st-muted flex flex-col items-center gap-2 py-10 text-center text-sm'>
          <Smartphone className='h-8 w-8' strokeWidth={1.5} />
          <p className='text-st-fg font-medium'>Nothing from your phone yet</p>
          <p>
            Set up the iPhone in{' '}
            <Link className='text-st-accent underline underline-offset-2' href='/settings/'>
              Settings → Phone inbox
            </Link>
            , then send a photo. It appears here live.
          </p>
        </div>
      ) : (
        <ul className='grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4'>
          {items.map((item) => (
            <li key={item.id}>
              <button
                className={cn(
                  'rounded-st border-st-line hover:border-st-accent focus-visible:border-st-accent group relative block w-full overflow-hidden border text-left transition-colors',
                  busy === item.id && 'animate-pulse',
                )}
                disabled={busy !== null}
                type='button'
                onClick={() => void pick(item)}
              >
                <InboxThumb className='aspect-[4/3] w-full' item={item} />
                <span className='bg-st-surface/95 text-st-fg absolute inset-x-0 bottom-0 flex items-center gap-1.5 px-2 py-1 text-[11px]'>
                  {item.kind === 'pdf' && <span className='text-st-muted shrink-0 font-semibold'>PDF</span>}
                  <span className='min-w-0 flex-1 truncate'>{item.note ?? formatRelative(item.createdAt)}</span>
                  {item.usedAt ? (
                    <span className='text-st-muted shrink-0'>used</span>
                  ) : (
                    <span className='bg-st-accent h-1.5 w-1.5 shrink-0 rounded-full' />
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
