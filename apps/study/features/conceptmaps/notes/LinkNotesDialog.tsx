import type { NoteLink } from './links';

import { useMemo, useRef, useState } from 'react';
import { BookOpen, Check, FileText, FileUp, NotebookPen, X } from 'lucide-react';

import { linkKey } from './links';
import { pageFromLibraryPdf, pageFromPickedPdf } from './sources';

import { ActionButton, EmptyState, ErrorNote, FilterChip, INPUT_CLASS, LoadingRows } from '@/components/ui/primitives';
import { useClassLibrary } from '@/features/library/hooks';
import { usePages } from '@/lib/api/hooks';
import { describeError } from '@/lib/api/errors';
import { formatRelative } from '@/lib/format';
import { fileToPdf, isImageFile, isPdfFile, PICKER_ACCEPT, pdfNameFor, photosToPdf } from '@/lib/notebooks/to-pdf';

/**
 * «Link lecture notes» — a notebook page he already wrote, files from the tablet (his Samsung Notes
 * PDF exports, or photos — converted to PDF here; photos picked together become one PDF), or a
 * class library document. PDFs become notebook pages through the same import the
 * library uses, so he can annotate them and the backend's page-id list covers every source.
 */
type Source = 'pages' | 'device' | 'library';

export interface LinkNotesDialogProps {
  classId: string;
  linked: NoteLink[];
  week?: number | null;
  onLink: (link: NoteLink) => void;
  onClose: () => void;
}

export function LinkNotesDialog({ classId, linked, week = null, onLink, onClose }: LinkNotesDialogProps) {
  const [source, setSource] = useState<Source>('pages');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pages = usePages({ classId });
  const library = useClassLibrary(classId);
  const linkedKeys = useMemo(() => new Set(linked.map(linkKey)), [linked]);
  const linkedLibrary = useMemo(
    () => new Set(linked.flatMap((row) => (row.libraryId ? [row.libraryId] : []))),
    [linked],
  );
  const needle = query.trim().toLowerCase();

  const pageRows = useMemo(
    () =>
      (pages.data ?? [])
        .filter((page) => page.kind !== 'solve')
        .filter((page) => !needle || page.title.toLowerCase().includes(needle))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [needle, pages.data],
  );
  const libraryRows = useMemo(
    () =>
      (library.data ?? [])
        .filter((doc) => doc.kind !== 'image')
        .filter((doc) => !needle || doc.title.toLowerCase().includes(needle))
        // This lecture's week first, then by week.
        .sort((a, b) => Number(b.week === week) - Number(a.week === week) || (a.week ?? 99) - (b.week ?? 99)),
    [library.data, needle, week],
  );

  const run = async (key: string, task: () => Promise<NoteLink>) => {
    setBusy(key);
    setError(null);
    try {
      onLink(await task());
      onClose();
    } catch (failure) {
      setError(describeError(failure, 'Could not link that note'));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Several files in one pick: each PDF becomes its own page; the photos become ONE PDF (pages of the
   * same handout), ordered by name — camera names are timestamps, and the picker's order is not
   * guaranteed. Pages that worked stay linked even when another file fails.
   */
  const importFiles = async (picked: File[]) => {
    const photos = picked.filter((file) => !isPdfFile(file) && isImageFile(file));
    const others = picked.filter((file) => !photos.includes(file));
    const jobs: { name: string; make: () => Promise<File> }[] = others.map((file) => ({
      name: file.name,
      make: () => fileToPdf(file),
    }));

    if (photos.length) {
      photos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const name = photos.length === 1 ? pdfNameFor(photos[0].name) : pdfNameFor(`Photos — ${photos[0].name}`);

      jobs.push({
        name: photos.length === 1 ? photos[0].name : `${photos.length} photos`,
        make: () => photosToPdf(photos, name),
      });
    }

    setBusy('device');
    setError(null);
    const failed: string[] = [];
    let linkedAny = false;

    for (const [index, job] of jobs.entries()) {
      setProgress(jobs.length > 1 ? `${index + 1}/${jobs.length}` : null);
      try {
        onLink(await pageFromPickedPdf(classId, await job.make()));
        linkedAny = true;
      } catch (failure) {
        failed.push(`${job.name}: ${describeError(failure, 'could not import')}`);
      }
    }

    setBusy(null);
    setProgress(null);
    if (!failed.length) onClose();
    else setError(`${linkedAny ? 'Some files were linked. ' : ''}Not imported — ${failed.join(' · ')}`);
  };

  return (
    <div aria-modal className='fixed inset-0 z-[60] flex items-end justify-center sm:items-center' role='dialog'>
      <button aria-label='Close' className='absolute inset-0 bg-st-shadow/40' type='button' onClick={onClose} />
      <div className='rounded-st-lg bg-st-surface border-st-clay-edge shadow-clay border-2 relative flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden'>
        <header className='border-st-line flex items-center gap-2 border-b px-5 py-3'>
          <h2 className='text-st-fg text-base font-semibold'>Link lecture notes</h2>
          <span className='flex-1' />
          <button
            aria-label='Close'
            className='text-st-muted hover:bg-st-raised flex h-10 w-10 items-center justify-center rounded-full'
            type='button'
            onClick={onClose}
          >
            <X className='h-5 w-5' />
          </button>
        </header>

        <div className='flex flex-col gap-3 px-5 pt-4'>
          <div className='flex flex-wrap gap-2'>
            <FilterChip active={source === 'pages'} onClick={() => setSource('pages')}>
              <NotebookPen className='h-4 w-4' /> Notebook
            </FilterChip>
            <FilterChip active={source === 'device'} onClick={() => setSource('device')}>
              <FileUp className='h-4 w-4' /> Files from tablet
            </FilterChip>
            <FilterChip active={source === 'library'} onClick={() => setSource('library')}>
              <BookOpen className='h-4 w-4' /> Library
            </FilterChip>
          </div>
          {source !== 'device' && (
            <input
              className={INPUT_CLASS}
              placeholder={source === 'pages' ? 'Search your notebook pages' : 'Search the class library'}
              type='search'
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          {error && <ErrorNote message={error} />}
        </div>

        <div className='flex-1 overflow-y-auto px-3 py-3'>
          {source === 'device' ? (
            <div className='flex flex-col items-center gap-3 px-4 py-8 text-center'>
              <FileText className='text-st-muted h-10 w-10' />
              <p className='text-st-fg max-w-sm text-sm'>
                Pick one or more PDFs, Word / PowerPoint files or photos (for example Samsung Notes exports). They are
                turned into PDFs; each opens beside the map, and you can write on it.
              </p>
              <input
                ref={fileRef}
                multiple
                accept={PICKER_ACCEPT}
                className='hidden'
                type='file'
                onChange={(event) => {
                  // Copy first: the FileList is live and clearing the input empties it.
                  const files = Array.from(event.target.files ?? []);

                  event.target.value = '';
                  if (files.length) void importFiles(files);
                }}
              />
              <ActionButton loading={busy === 'device'} variant='primary' onClick={() => fileRef.current?.click()}>
                <FileUp className='h-4 w-4' />{' '}
                {busy === 'device' ? `Importing${progress ? ` ${progress}` : ''}…` : 'Choose files'}
              </ActionButton>
            </div>
          ) : source === 'pages' ? (
            pages.isLoading ? (
              <LoadingRows rows={4} />
            ) : pageRows.length === 0 ? (
              <EmptyState hint='Write a page in class first, or import a PDF.' title='No notebook pages' />
            ) : (
              <ul className='flex flex-col gap-1'>
                {pageRows.map((page) => {
                  const on = linkedKeys.has(`page:${page.id}`);

                  return (
                    <li key={page.id}>
                      <Row
                        busy={busy === page.id}
                        disabled={on}
                        icon={page.kind === 'pdf' ? FileText : NotebookPen}
                        linked={on}
                        meta={formatRelative(page.updatedAt)}
                        title={page.title}
                        onPick={() =>
                          void run(page.id, async () => ({ kind: 'page', pageId: page.id, title: page.title }))
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )
          ) : library.isLoading ? (
            <LoadingRows rows={4} />
          ) : library.error ? (
            <ErrorNote message={describeError(library.error)} onRetry={() => void library.refetch()} />
          ) : libraryRows.length === 0 ? (
            <EmptyState hint='Import the class folder in Library first.' title='Nothing in the library' />
          ) : (
            <ul className='flex flex-col gap-1'>
              {libraryRows.map((doc) => {
                const on = linkedLibrary.has(doc.id) || linkedKeys.has(`library:${doc.id}`);

                return (
                  <li key={doc.id}>
                    <Row
                      busy={busy === doc.id}
                      disabled={on}
                      icon={doc.kind === 'pdf' ? FileText : BookOpen}
                      linked={on}
                      meta={`${doc.week !== null ? `Week ${doc.week} · ` : ''}${doc.kind === 'pdf' ? 'PDF' : 'Note'}`}
                      title={doc.title}
                      onPick={() =>
                        void run(doc.id, async () =>
                          doc.kind === 'pdf'
                            ? pageFromLibraryPdf(classId, doc)
                            : { kind: 'library', libraryId: doc.id, title: doc.title },
                        )
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  icon: Icon,
  title,
  meta,
  linked,
  busy,
  disabled,
  onPick,
}: {
  icon: typeof FileText;
  title: string;
  meta: string;
  linked: boolean;
  busy: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button
      className='rounded-st hover:bg-st-raised flex min-h-12 w-full items-center gap-3 px-3 text-left disabled:cursor-default disabled:opacity-60'
      disabled={disabled || busy}
      type='button'
      onClick={onPick}
    >
      <Icon className='text-st-muted h-4 w-4 shrink-0' />
      <span className='text-st-fg min-w-0 flex-1 truncate text-sm font-medium'>{title}</span>
      <span className='text-st-muted shrink-0 text-xs'>{meta}</span>
      {busy ? (
        <span className='h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent' />
      ) : linked ? (
        <Check className='text-st-ok h-4 w-4' />
      ) : null}
    </button>
  );
}
