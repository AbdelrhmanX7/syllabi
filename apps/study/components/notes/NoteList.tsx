import type { Page } from '@/lib/api/types';

import { SlidersHorizontal, Trash2 } from 'lucide-react';
import Link from 'next/link';

import { NoteCover } from '@/components/notes/NoteCover';
import { useNoteActions } from '@/components/notes/useNoteActions';
import { ActionButton } from '@/components/ui/primitives';
import { notebookHref } from '@/features/lecturenotes/hooks';
import { formatRelative } from '@/lib/format';
import { noteRowLine } from '@/lib/notebooks/page-meta';

/**
 * Compact one-line notebook rows (inside a class page's panel): cover, name, tags + when; details and
 * delete (confirmed in a modal). The Notes page uses the cover grid (NoteGrid) instead.
 */
export function NoteList({ pages, labelFor }: { pages: Page[]; labelFor?: (page: Page) => string | undefined }) {
  const { openDetails, askDelete, overlays } = useNoteActions();

  return (
    <>
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
                <NoteCover page={page} />
                <span className='min-w-0 flex-1'>
                  <span className='text-st-fg block truncate text-sm font-medium'>{page.title}</span>
                  <span className='text-st-muted block truncate text-xs'>
                    {noteRowLine(page.tags, formatRelative(page.updatedAt), label)}
                  </span>
                </span>
              </Link>
              {!page.shared && (
                <ActionButton
                  aria-label={`Details of ${page.title}`}
                  className='h-10 w-10 shrink-0 px-0'
                  title='Notebook details'
                  variant='ghost'
                  onClick={() => openDetails(page)}
                >
                  <SlidersHorizontal className='text-st-muted h-4 w-4' />
                </ActionButton>
              )}
              <ActionButton
                aria-label={`Delete ${page.title}`}
                className='h-10 w-10 shrink-0 px-0'
                title='Delete notebook'
                variant='ghost'
                onClick={() => askDelete(page)}
              >
                <Trash2 className='text-st-muted h-4 w-4' />
              </ActionButton>
            </li>
          );
        })}
      </ul>

      {overlays}
    </>
  );
}
