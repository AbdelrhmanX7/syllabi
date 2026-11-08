import type { PageAnnotation } from '@/lib/api/endpoints';

import { useCallback, useEffect, useState } from 'react';
import { Sparkles, Trash2 } from 'lucide-react';

import { ActionButton, BOARD_CHIP_OVERRIDE } from '@/components/ui/primitives';
import { Markdown } from '@/features/bank/components/Markdown';
import { Sheet } from '@/features/inbox/components/Sheet';
import { deletePageAnnotation, listPageAnnotations } from '@/lib/api/endpoints';

/**
 * Feedback Claude left on this notebook through the Study MCP (`annotate_notebook_page` — grading,
 * corrections, hints). A chip in the board's top cluster while there is any; it opens the list, per
 * board page. Refetched when the app comes back to the foreground (the feedback is written from
 * claude.ai while the board is often still open on the tablet).
 */
export function ClaudeFeedback({ pageId, className }: { pageId: string; className?: string }) {
  const [items, setItems] = useState<PageAnnotation[]>([]);
  const [open, setOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PageAnnotation | null>(null);

  const refresh = useCallback(() => {
    listPageAnnotations(pageId)
      .then((next) => setItems(Array.isArray(next) ? next : []))
      // A backend without the route, offline, sample mode: no chip.
      .catch(() => undefined);
  }, [pageId]);

  useEffect(() => {
    refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  const confirmDelete = useCallback(async () => {
    const target = pendingDelete;

    if (!target) return;
    setPendingDelete(null);
    setItems((current) => current.filter((item) => item.id !== target.id));
    await deletePageAnnotation(pageId, target.id).catch(() => refresh());
  }, [pageId, pendingDelete, refresh]);

  if (items.length === 0) return null;

  return (
    <>
      <ActionButton
        className={`${BOARD_CHIP_OVERRIDE} ${className ?? ''}`}
        variant='secondary'
        title="Claude's feedback on this notebook"
        onClick={() => setOpen(true)}
      >
        <Sparkles className='text-st-accent h-3.5 w-3.5' /> <span data-chip-label>Claude</span>
        <span className='bg-st-accent text-st-accent-fg rounded-sm px-1.5 text-[10px] font-semibold leading-4'>
          {items.length}
        </span>
      </ActionButton>
      {open && (
        <Sheet
          subtitle='Written by Claude from the Study connector'
          title="Claude's feedback"
          onClose={() => setOpen(false)}
        >
          <ul className='flex flex-col gap-2'>
            {items.map((item) => (
              <li key={item.id} className='border-st-line rounded-st border px-3 py-2'>
                <div className='text-st-muted mb-1 flex items-center gap-2 text-xs'>
                  <span className='text-st-fg font-semibold'>Page {item.page}</span>
                  <span>{new Date(item.createdAt).toLocaleString()}</span>
                  <button
                    aria-label='Delete this feedback'
                    className='hover:bg-st-raised text-st-muted ml-auto flex h-8 w-8 items-center justify-center rounded-full'
                    type='button'
                    onClick={() => setPendingDelete(item)}
                  >
                    <Trash2 className='h-4 w-4' />
                  </button>
                </div>
                <Markdown text={item.markdown} />
              </li>
            ))}
          </ul>
        </Sheet>
      )}
      {pendingDelete && (
        <Sheet
          footer={
            <div className='flex justify-end gap-3'>
              <ActionButton variant='ghost' onClick={() => setPendingDelete(null)}>
                Cancel
              </ActionButton>
              <ActionButton variant='danger' onClick={() => void confirmDelete()}>
                Delete
              </ActionButton>
            </div>
          }
          title='Delete this feedback?'
          onClose={() => setPendingDelete(null)}
        >
          <p className='text-st-muted text-sm'>Claude&apos;s note on page {pendingDelete.page} will be removed.</p>
        </Sheet>
      )}
    </>
  );
}
