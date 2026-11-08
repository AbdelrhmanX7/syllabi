import type { InboxItem } from '../types';

import { useState } from 'react';
import { FilePlus, ImagePlus, X } from 'lucide-react';

import { loadInboxFile, markItemUsed, useInbox } from '../store';

import { InboxThumb } from './InboxThumb';

/**
 * Shown on a notebook opened from Inbox → «Add to notes». The photo is placed (or the PDF's pages are
 * appended) on a TAP, once the board is up — the editor's inserts need its canvas, which does not
 * exist while it opens. `onPlace` gets the item so the host can tell a photo from a PDF.
 */
export function PlacePhoneImageChip({
  itemId,
  onPlace,
  onDismiss,
}: {
  itemId: string;
  onPlace: (file: File, item: InboxItem) => void;
  onDismiss: () => void;
}) {
  const inbox = useInbox();
  const item = inbox.items.find((candidate) => candidate.id === itemId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!item) return null;

  return (
    <div className='border-st-clay-edge bg-st-surface shadow-clay flex items-center gap-2 rounded-full border-2 py-1 pl-1 pr-2 text-xs'>
      <InboxThumb className='h-8 w-10 rounded-full' item={item} />
      <button
        className='text-st-fg inline-flex min-h-8 items-center gap-1.5 font-semibold disabled:opacity-60'
        disabled={busy}
        type='button'
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            onPlace(await loadInboxFile(item), item);
            // A PDF is marked used by the board once its pages are imported (the sheet can be cancelled).
            if (item.kind !== 'pdf') void markItemUsed(item.id);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setBusy(false);
          }
        }}
      >
        {item.kind === 'pdf' ? (
          <FilePlus className='text-st-accent h-4 w-4' />
        ) : (
          <ImagePlus className='text-st-accent h-4 w-4' />
        )}{' '}
        {error ? 'Retry' : busy ? 'Downloading…' : item.kind === 'pdf' ? 'Add the PDF pages' : 'Place photo from phone'}
      </button>
      <button aria-label='Dismiss' className='text-st-muted hover:text-st-fg' type='button' onClick={onDismiss}>
        <X className='h-4 w-4' />
      </button>
    </div>
  );
}
