import type { InboxItem } from '../types';
import type { Page } from '@/lib/api/types';

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@repo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NotebookPen, Plus, Search } from 'lucide-react';
import { useRouter } from 'next/router';

import { inboxItemToPage } from '../api';
import { markItemUsed } from '../store';

import { Sheet } from './Sheet';

import { ActionButton, ErrorNote, INPUT_CLASS, LoadingRows } from '@/components/ui/primitives';
import { createPage, listPages } from '@/lib/api/endpoints';
import { describeError } from '@/lib/api/errors';
import { studyKeys, useClasses } from '@/lib/api/hooks';
import { formatRelative } from '@/lib/format';
import { takesInboxItems } from '@/lib/notebooks/my-notes';
import { rememberPages } from '@/lib/notebooks/pages-cache';

const TITLE_MAX = 200;

/** `/notebook/?id=<page>&inbox=<item>` — the notebook offers this photo (or PDF) once its board is up. */
export function notebookInsertHref(pageId: string, itemId: string, makeMap = false): string {
  return `/notebook/?id=${encodeURIComponent(pageId)}&inbox=${encodeURIComponent(itemId)}${makeMap ? '&map=1' : ''}`;
}

/**
 * «Add to notes» for any inbox item: a NEW note (class + title), or one of the existing notes (the
 * item's class first). A photo is placed on the page when it opens; a PDF's pages are appended to an
 * existing note, or become a PDF page of their own when it is new.
 */
export function NotebookPickerSheet({
  item,
  makeMap = false,
  onClose,
}: {
  item: InboxItem;
  /** «Concept map»: the photo is placed on the chosen note and its concept map drawn beside it. */
  makeMap?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const pages = useQuery({ queryKey: studyKeys.pages(), queryFn: () => listPages() });
  const { data: classes } = useClasses();
  const isPdf = item.kind === 'pdf';
  const [q, setQ] = useState('');
  const [classId, setClassId] = useState(item.classId ?? '');
  const [title, setTitle] = useState((item.note ?? '').slice(0, TITLE_MAX));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orderedClasses = useMemo(
    () => [...(classes ?? [])].sort((a, b) => Number(b.id === item.classId) - Number(a.id === item.classId)),
    [classes, item.classId],
  );
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // Pages that open on `/notebook/` (notes, and PDF notebooks of their own such as a shared copy); a
    // class item / Library PDF, a lecture or a solve page opens on its own screen.
    const rows = (pages.data ?? [])
      .filter((page) => takesInboxItems(page) && (!needle || page.title.toLowerCase().includes(needle)))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const byClass = new Map<string, Page[]>();

    for (const page of rows) {
      const key = page.classId ?? '';

      byClass.set(key, [...(byClass.get(key) ?? []), page]);
    }

    return Array.from(byClass.entries())
      .map(([groupClassId, list]) => ({
        classId: groupClassId,
        name: classes?.find((cls) => cls.id === groupClassId)?.code ?? (groupClassId ? 'Class' : 'No class'),
        color: classes?.find((cls) => cls.id === groupClassId)?.color ?? null,
        list,
      }))
      .sort((a, b) => Number(b.classId === item.classId) - Number(a.classId === item.classId));
  }, [classes, item.classId, pages.data, q]);

  useEffect(() => {
    if (isPdf && !classId && classes?.length === 1) setClassId(classes[0].id);
  }, [classId, classes, isPdf]);

  const createNote = async () => {
    setBusy(true);
    setError(null);
    try {
      const name = title.trim() || undefined;

      if (isPdf) {
        // The backend files the PDF as a class item + a PDF page; it opens straight on that item's
        // annotation board (`annotate=1`), not on the item card, so the PDF is what he lands on.
        const result = await inboxItemToPage(item.id, { classId, title: name });

        void markItemUsed(item.id);
        void queryClient.invalidateQueries({ queryKey: ['study', 'pages'] });
        void router.push(`/item/?id=${encodeURIComponent(result.itemId)}&annotate=1`);
      } else {
        const page = await createPage({ classId: classId || null, title: name ?? 'Photo from phone', kind: 'note' });

        rememberPages([page]);
        void queryClient.invalidateQueries({ queryKey: ['study', 'pages'] });
        void router.push(notebookInsertHref(page.id, item.id, makeMap));
      }
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <Sheet
      subtitle={
        isPdf
          ? 'A new note, or add its pages to a note you have.'
          : makeMap
            ? 'The photo is placed on the page and its concept map drawn beside it.'
            : 'The photo is placed on the page when it opens.'
      }
      title={makeMap ? 'Concept map on a note' : 'Add to notes'}
      onClose={onClose}
    >
      <section className='rounded-st border-st-line mb-4 flex flex-col gap-2 border p-3'>
        <div className='flex gap-2'>
          <input
            aria-label='New note title'
            className={`${INPUT_CLASS} min-w-0 flex-1`}
            disabled={busy}
            maxLength={TITLE_MAX}
            placeholder={isPdf ? 'New note title (optional)' : 'New note title'}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <ActionButton disabled={isPdf && !classId} loading={busy} variant='primary' onClick={() => void createNote()}>
            <Plus className='h-4 w-4' /> New note
          </ActionButton>
        </div>
        <div className='flex flex-wrap gap-1.5'>
          {!isPdf && (
            <button
              aria-pressed={!classId}
              className={cn(
                'inline-flex min-h-8 items-center gap-2 rounded-sm border px-3 text-xs font-medium',
                !classId
                  ? 'bg-st-accent text-st-accent-fg border-st-accent-lip'
                  : 'border-st-line text-st-fg hover:bg-st-raised',
              )}
              disabled={busy}
              type='button'
              onClick={() => setClassId('')}
            >
              No class
            </button>
          )}
          {orderedClasses.map((cls) => (
            <button
              key={cls.id}
              aria-pressed={classId === cls.id}
              className={cn(
                'inline-flex min-h-8 items-center gap-2 rounded-sm border px-3 text-xs font-medium',
                classId === cls.id
                  ? 'bg-st-accent text-st-accent-fg border-st-accent-lip'
                  : 'border-st-line text-st-fg hover:bg-st-raised',
              )}
              disabled={busy}
              type='button'
              onClick={() => setClassId(cls.id)}
            >
              <span className='h-2 w-2 rounded-sm' style={{ backgroundColor: cls.color }} />
              {cls.code || cls.name}
            </button>
          ))}
        </div>
        {error && <ErrorNote message={error} />}
      </section>
      <label className='relative mb-3 block'>
        <Search className='text-st-muted absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2' />
        <input
          className={`${INPUT_CLASS} pl-9`}
          placeholder='Or find a note you have'
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
      </label>
      {pages.isLoading && <LoadingRows rows={4} />}
      {pages.error && <ErrorNote message={describeError(pages.error)} onRetry={() => void pages.refetch()} />}
      {pages.data && groups.length === 0 && (
        <p className='text-st-muted py-6 text-center text-sm'>No notes{q ? ' match' : ' yet'}.</p>
      )}
      <div className='flex flex-col gap-4'>
        {groups.map((group) => (
          <section key={group.classId}>
            <h3 className='text-st-muted mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide'>
              {group.color && <span className='h-2 w-2 rounded-sm' style={{ backgroundColor: group.color }} />}
              {group.name}
            </h3>
            <ul className='flex flex-col'>
              {group.list.map((page) => (
                <li key={page.id}>
                  <button
                    className='rounded-st hover:bg-st-raised flex min-h-11 w-full items-center gap-3 px-2 text-left text-sm'
                    disabled={busy}
                    type='button'
                    onClick={() => {
                      void router.push(notebookInsertHref(page.id, item.id, makeMap));
                      onClose();
                    }}
                  >
                    <NotebookPen className='text-st-muted h-4 w-4 shrink-0' />
                    <span className='text-st-fg min-w-0 flex-1 truncate'>{page.title}</span>
                    <span className='text-st-muted shrink-0 text-xs'>{formatRelative(page.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Sheet>
  );
}
