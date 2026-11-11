import type { LibraryDoc, LibraryHit, LibraryKind } from '@/lib/api/types';

import { useEffect, useMemo, useState } from 'react';
import { Chip } from '@repo/ui';
import { FileText, Image as ImageIcon, Library, NotebookPen, NotebookText, Search } from 'lucide-react';

import { useClassLibrary, useLibrarySearch } from '../hooks';
import { filterDocs, groupByWeek } from '../lib/library';

import { LibraryUploadButton } from './LibraryUploadButton';

import { EmptyState, ErrorNote, FilterChip, INPUT_CLASS, LoadingRows, Surface } from '@/components/ui/primitives';
import { useLectureNoteWeeks, WeekNotes } from '@/features/lecturenotes/components/NoteLinks';
import { describeError } from '@/lib/api/errors';
import { usePages } from '@/lib/api/hooks';

/**
 * The class library by week: notes, slides/PDFs, images from the class folder. The box filters
 * titles as you type; two or more letters also search inside the documents (keyword retrieval over
 * PDF pages and note sections) and list the matching passages.
 */
export interface LibraryPanelProps {
  classId: string;
  onOpen: (doc: LibraryDoc) => void;
}

const KIND_ICON: Record<LibraryKind, typeof FileText> = { note: NotebookText, pdf: FileText, image: ImageIcon };
const KINDS: { id: LibraryKind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'note', label: 'Notes' },
  { id: 'pdf', label: 'PDFs' },
  { id: 'image', label: 'Images' },
];

function useDebounced(value: string, ms = 350): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);

    return () => window.clearTimeout(timer);
  }, [value, ms]);

  return debounced;
}

function DocRow({ doc, hasNotes, onOpen }: { doc: LibraryDoc; hasNotes: boolean; onOpen: (doc: LibraryDoc) => void }) {
  const Icon = KIND_ICON[doc.kind];

  return (
    <button
      className='rounded-st hover:bg-st-raised flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left'
      type='button'
      onClick={() => onOpen(doc)}
    >
      <span className='border-st-line bg-st-raised text-st-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border'>
        <Icon className='h-4 w-4' />
      </span>
      <span className='min-w-0 flex-1'>
        <span className='text-st-fg block truncate text-sm font-medium'>{doc.title}</span>
        <span className='text-st-muted block truncate text-xs'>{doc.path}</span>
      </span>
      {/* You wrote on this PDF: «Write on it» goes back to that notebook. */}
      {hasNotes && (
        <Chip
          aria-label='Your notes'
          className='shrink-0'
          color='primary'
          classNames={{ content: 'gap-1' }}
          size='sm'
          title='Your notes'
          variant='flat'
        >
          <NotebookPen aria-hidden className='h-3.5 w-3.5' />
          {/* Phone width: the icon alone, so the name keeps its room. */}
          <span className='hidden sm:inline'>Your notes</span>
        </Chip>
      )}
    </button>
  );
}

function HitRow({ hit, onOpen }: { hit: LibraryHit; onOpen: () => void }) {
  return (
    <button
      className='rounded-st hover:bg-st-raised flex w-full flex-col gap-1 px-3 py-2 text-left'
      type='button'
      onClick={onOpen}
    >
      <span className='text-st-fg text-sm font-medium'>
        {hit.title}
        <span className='text-st-muted ml-2 text-xs font-normal'>
          {hit.kind === 'pdf' ? `p. ${hit.page}` : ''}
          {hit.week !== null ? ` · week ${hit.week}` : ''}
        </span>
      </span>
      <span className='text-st-muted line-clamp-2 text-xs'>{hit.text.replace(/\s+/g, ' ').slice(0, 280)}</span>
    </button>
  );
}

export function LibraryPanel({ classId, onOpen }: LibraryPanelProps) {
  const library = useClassLibrary(classId);
  // Library PDFs you wrote on (their notebook is linked to the document).
  const classPages = usePages({ classId });
  const withNotes = useMemo(
    () => new Set((classPages.data ?? []).flatMap((page) => (page.libraryId ? [page.libraryId] : []))),
    [classPages.data],
  );
  const docs = useMemo(() => library.data ?? [], [library.data]);
  const [kind, setKind] = useState<LibraryKind | 'all'>('all');
  const [text, setText] = useState('');
  const query = useDebounced(text.trim());
  const search = useLibrarySearch(classId, query);
  const visible = useMemo(() => filterDocs(docs, kind, text), [docs, kind, text]);
  const noteWeeks = useLectureNoteWeeks(classId);
  // Weeks with his lecture notes but no class-folder documents still get a section (unfiltered view).
  const weeks = useMemo(() => {
    const groups = groupByWeek(visible);

    if (kind !== 'all' || text.trim()) return groups;
    const have = new Set(groups.map((group) => group.week));
    const extra = noteWeeks.filter((week) => !have.has(week)).map((week) => ({ week, docs: [] }));

    return [...groups, ...extra].sort(
      (a, b) => (a.week ?? Number.MAX_SAFE_INTEGER) - (b.week ?? Number.MAX_SAFE_INTEGER),
    );
  }, [kind, noteWeeks, text, visible]);
  const counts = useMemo(
    () =>
      Object.fromEntries(KINDS.map((item) => [item.id, filterDocs(docs, item.id, '').length])) as Record<
        LibraryKind | 'all',
        number
      >,
    [docs],
  );
  const byId = useMemo(() => new Map(docs.map((doc) => [doc.id, doc])), [docs]);
  const hits = query.length >= 2 ? (search.data ?? []) : [];

  if (library.isLoading) return <LoadingRows rows={6} />;
  if (library.error && !library.data) return <ErrorNote message={describeError(library.error)} onRetry={() => void library.refetch()} />;
  if (docs.length === 0)
    return (
      <EmptyState
        action={<LibraryUploadButton classId={classId} variant='primary' />}
        hint='Upload a PDF, like lecture slides or a handout, to write on it and make flashcards from it.'
        icon={Library}
        title='Library is empty'
      />
    );

  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
        <label className='relative flex-1'>
          <span className='sr-only'>Search the library</span>
          <Search className='text-st-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2' />
          <input
            className={`${INPUT_CLASS} min-h-11 w-full pl-9`}
            placeholder='Search titles and inside the documents'
            type='search'
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <LibraryUploadButton classId={classId} />
        <div className='flex flex-wrap gap-1.5'>
          {KINDS.filter((item) => item.id === 'all' || counts[item.id] > 0).map((item) => (
            <FilterChip
              key={item.id}
              active={kind === item.id}
              count={counts[item.id]}
              onClick={() => setKind(item.id)}
            >
              {item.label}
            </FilterChip>
          ))}
        </div>
      </div>

      {query.length >= 2 && (
        <Surface className='p-2'>
          <h3 className='text-st-muted px-3 py-1 text-xs font-medium uppercase tracking-wide'>Inside the documents</h3>
          {search.isLoading ? (
            <LoadingRows rows={2} />
          ) : search.error ? (
            <ErrorNote message={describeError(search.error)} onRetry={() => void search.refetch()} />
          ) : hits.length === 0 ? (
            <p className='text-st-muted px-3 py-2 text-sm'>No passage mentions that.</p>
          ) : (
            hits.map((hit, index) => {
              const doc = byId.get(hit.libraryId);

              return (
                <HitRow
                  key={`${hit.libraryId}-${hit.page}-${index}`}
                  hit={hit}
                  onOpen={() =>
                    onOpen(
                      doc ?? {
                        id: hit.libraryId,
                        title: hit.title,
                        kind: hit.kind,
                        week: hit.week,
                        path: hit.title,
                        updatedAt: null,
                      },
                    )
                  }
                />
              );
            })
          )}
        </Surface>
      )}

      {weeks.length === 0 ? (
        <p className='text-st-muted text-sm'>No title matches.</p>
      ) : (
        weeks.map((group) => (
          <section key={group.week ?? 'none'}>
            <h2 className='text-st-muted mb-1 text-xs font-medium uppercase tracking-wide'>
              {group.week !== null ? `Week ${group.week}` : 'Whole course'}
            </h2>
            <Surface className='flex flex-col gap-1 px-1 py-1'>
              <WeekNotes classId={classId} label='Your lecture notes' week={group.week} />
              {group.docs.map((doc) => (
                <DocRow key={doc.id} doc={doc} hasNotes={withNotes.has(doc.id)} onOpen={onOpen} />
              ))}
            </Surface>
          </section>
        ))
      )}
    </div>
  );
}
