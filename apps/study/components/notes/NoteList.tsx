import type { Page } from '@/lib/api/types';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { NotebookPen, Trash2 } from 'lucide-react';
import Link from 'next/link';

import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { ActionButton, ErrorNote } from '@/components/ui/primitives';
import { notebookHref } from '@/features/lecturenotes/hooks';
import { describeError } from '@/lib/api/errors';
import { formatRelative } from '@/lib/format';
import { deleteNotePage } from '@/lib/offline/jobs';

/** One-line notebook rows with a delete button (confirmed in a modal). */
export function NoteList({ pages, labelFor }: { pages: Page[]; labelFor?: (page: Page) => string | undefined }) {
  const queryClient = useQueryClient();
  const [toDelete, setToDelete] = useState<Page | null>(null);
  const remove = useMutation({
    mutationFn: (page: Page) => deleteNotePage(page.id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['study', 'pages'] }),
  });

  return (
    <>
      {remove.error && <ErrorNote message={describeError(remove.error)} />}
      <ul className='flex flex-col gap-1'>
        {pages.map((page) => {
          const label = labelFor?.(page);

          return (
            <li key={page.id} className='flex items-center gap-1'>
              <Link
                className='rounded-st hover:bg-st-raised flex min-h-12 min-w-0 flex-1 items-center gap-3 px-2 py-2'
                href={notebookHref(page)}
                title={page.title}
              >
                <span className='border-st-line bg-st-raised text-st-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border'>
                  <NotebookPen className='h-4 w-4' />
                </span>
                <span className='min-w-0 flex-1'>
                  <span className='text-st-fg block truncate text-sm font-medium'>{page.title}</span>
                  <span className='text-st-muted block truncate text-xs'>
                    {label ? `${label} · ` : ''}
                    {formatRelative(page.updatedAt)}
                  </span>
                </span>
              </Link>
              <ActionButton
                aria-label={`Delete ${page.title}`}
                className='h-10 w-10 shrink-0 px-0'
                title='Delete notebook'
                variant='ghost'
                onClick={() => setToDelete(page)}
              >
                <Trash2 className='text-st-muted h-4 w-4' />
              </ActionButton>
            </li>
          );
        })}
      </ul>

      {toDelete && (
        <ConfirmSheet
          danger
          confirmLabel='Delete notebook'
          title='Delete this notebook?'
          onClose={() => setToDelete(null)}
          onConfirm={() => remove.mutate(toDelete)}
        >
          <p>
            «<span className='text-st-fg font-semibold'>{toDelete.title}</span>» and all its pages and writing will be
            deleted on every device. This can’t be undone.
          </p>
        </ConfirmSheet>
      )}
    </>
  );
}
