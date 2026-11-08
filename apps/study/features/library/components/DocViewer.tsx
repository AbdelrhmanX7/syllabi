import type { LibraryDoc } from '@/lib/api/types';

import { useMemo, useState } from 'react';
import { ArrowLeft, Download, FileText, NotebookPen } from 'lucide-react';
import dynamic from 'next/dynamic';

import { useLibraryDoc } from '../hooks';
import { prepareNoteMarkdown } from '../lib/library';

import { LibraryAiButton } from './LibraryAiButton';

import { ActionButton, Badge, ErrorNote, INPUT_CLASS, LoadingRows, Surface } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';
import { formatBytes, formatRelative } from '@/lib/format';

// The bank's renderer: markdown + KaTeX (client-only).
const Markdown = dynamic(() => import('@/features/bank').then((mod) => mod.Markdown), {
  ssr: false,
  loading: () => <LoadingRows rows={4} />,
});

/**
 * One library doc: a note as rendered markdown, a stored PDF (open as a notebook, or download), an
 * image; a text-only PDF (the textbook) says so — its text still feeds questions and search. The AI
 * actions sit on top: «Make questions» and «Flashcards» into the bank.
 */
export interface DocViewerProps {
  classId: string;
  doc: LibraryDoc;
  onBack: () => void;
  onOpenNotebook: () => void;
}

export function DocViewer({ classId, doc, onBack, onOpenNotebook }: DocViewerProps) {
  const detail = useLibraryDoc(doc.id);
  const data = detail.data;
  const [pageRange, setPageRange] = useState('');
  const markdown = useMemo(() => (data?.markdown ? prepareNoteMarkdown(data.markdown) : null), [data?.markdown]);
  const isPdf = doc.kind === 'pdf';

  return (
    <div className='flex flex-col gap-3'>
      <header className='flex flex-wrap items-center gap-2'>
        <ActionButton className='min-h-10 px-3' variant='ghost' onClick={onBack}>
          <ArrowLeft className='h-4 w-4' /> Library
        </ActionButton>
        <div className='min-w-0 flex-1'>
          <h2 className='text-st-fg truncate text-base font-semibold'>{doc.title}</h2>
          <p className='text-st-muted truncate text-xs'>
            {doc.week !== null ? `Week ${doc.week} · ` : ''}
            {doc.path}
            {data?.pages ? ` · ${data.pages} ${isPdf ? 'pages' : 'sections'}` : ''}
            {doc.updatedAt ? ` · updated ${formatRelative(doc.updatedAt)}` : ''}
          </p>
        </div>
      </header>

      <Surface className='flex flex-wrap items-end gap-3 p-3'>
        <LibraryAiButton classId={classId} libraryId={doc.id} mode='questions' pageRange={pageRange} />
        <LibraryAiButton classId={classId} libraryId={doc.id} mode='flashcards' />
        {isPdf && (
          <label className='text-st-muted flex flex-col gap-1 text-xs'>
            Pages (optional)
            <input
              className={`${INPUT_CLASS} min-h-10 w-28`}
              placeholder='e.g. 3-5'
              value={pageRange}
              onChange={(event) => setPageRange(event.target.value)}
            />
          </label>
        )}
        {isPdf && data?.url && (
          <>
            <ActionButton className='min-h-10 px-3' onClick={onOpenNotebook}>
              <NotebookPen className='h-4 w-4' /> Open in notebook
            </ActionButton>
            <a
              className='rounded-st border-st-clay-edge bg-st-surface shadow-clay text-st-fg hover:bg-st-accent-soft inline-flex min-h-10 items-center gap-2 border-2 px-3 text-sm font-semibold transition-transform active:translate-y-[3px] active:shadow-none'
              href={data.url}
              rel='noreferrer'
              target='_blank'
            >
              <Download className='h-4 w-4' /> PDF{data.size ? ` · ${formatBytes(data.size)}` : ''}
            </a>
          </>
        )}
      </Surface>

      {detail.isLoading && <LoadingRows rows={6} />}
      {detail.error && <ErrorNote message={describeError(detail.error)} onRetry={() => void detail.refetch()} />}

      {data && doc.kind === 'note' && (
        <Surface className='p-5'>
          {markdown ? <Markdown text={markdown} /> : <p className='text-st-muted text-sm'>This note is empty.</p>}
        </Surface>
      )}

      {data && doc.kind === 'image' && data.url && (
        <div className='rounded-st overflow-hidden border border-st-clay-edge bg-st-shadow'>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt={doc.title} className='max-h-[75vh] w-full object-contain' src={data.url} />
        </div>
      )}

      {data && isPdf && !data.fileStored && (
        <Surface className='flex items-start gap-3 p-4'>
          <FileText className='text-st-muted mt-0.5 h-5 w-5 shrink-0' />
          <div className='text-sm'>
            <p className='text-st-fg font-medium'>
              Text only <Badge className='ml-1'>{data.pages ?? '?'} pages</Badge>
            </p>
            <p className='text-st-muted mt-1'>
              The file is too big to keep, so only its text was imported. It still answers library search, and «Make
              questions» / «Flashcards» work from that text — give a page range to stay on one chapter.
            </p>
          </div>
        </Surface>
      )}

      {/* No inline <iframe>: Android WebViews do not render PDFs — the notebook does (pdf.js). */}
      {data && isPdf && data.url && (
        <button
          className='rounded-st border-st-line bg-st-surface hover:bg-st-raised flex min-h-32 flex-col items-center justify-center gap-2 border border-dashed p-6 text-center'
          type='button'
          onClick={onOpenNotebook}
        >
          <NotebookPen className='text-st-muted h-6 w-6' />
          <span className='text-st-fg text-sm font-medium'>Open in notebook</span>
          <span className='text-st-muted text-xs'>Read it and write on the pages with the pen.</span>
        </button>
      )}
    </div>
  );
}
