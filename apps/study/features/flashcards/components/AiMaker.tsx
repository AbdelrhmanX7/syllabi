import type { AiSource } from '../api';
import type { Question, StudyClass } from '@/lib/api/types';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from '@repo/ui';
import { BookOpen, FileText, Mic, Sparkles } from 'lucide-react';

import { makeFlashcards } from '../api';

import { ActionButton, EmptyState, ErrorNote, Field, FilterChip, INPUT_CLASS, LoadingRows } from '@/components/ui/primitives';
import { listClassLibrary, listLectures, listPages } from '@/lib/api/endpoints';
import { describeError } from '@/lib/api/errors';

type Kind = AiSource['kind'];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'library', label: 'Library' },
  { kind: 'page', label: 'Notebook pages' },
  { kind: 'lecture', label: 'Lectures' },
];

const ICON = { library: BookOpen, page: FileText, lecture: Mic } as const;

async function loadSources(kind: Kind, classId: string): Promise<AiSource[]> {
  if (kind === 'library') {
    const docs = await listClassLibrary(classId);

    return docs.map((doc) => ({ kind, id: doc.id, title: doc.title }));
  }
  if (kind === 'page') {
    const pages = await listPages({ classId });

    return pages.map((page) => ({ kind, id: page.id, title: page.title || 'Untitled page' }));
  }
  const lectures = await listLectures(classId);

  return lectures
    .filter((lecture) => lecture.status === 'ready')
    .map((lecture) => ({ kind, id: lecture.id, title: lecture.title }));
}

/**
 * «Make with AI»: pick a class and a source (library doc, notebook page, lecture) and stream
 * `/ai/flashcards` into the class's decks. Rendered inside a Sheet body — flat rows only.
 */
export function AiMaker({
  classes,
  defaultClassId,
  defaultKind = 'library',
}: {
  classes: StudyClass[];
  defaultClassId?: string;
  defaultKind?: Kind;
}) {
  const queryClient = useQueryClient();
  const [classId, setClassId] = useState(defaultClassId ?? classes[0]?.id ?? '');
  const [kind, setKind] = useState<Kind>(defaultKind);
  const [running, setRunning] = useState<AiSource | null>(null);
  const [made, setMade] = useState<Question[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sources = useQuery({
    queryKey: ['study', 'flashcard-sources', kind, classId],
    queryFn: () => loadSources(kind, classId),
    enabled: Boolean(classId),
    staleTime: 60_000,
  });

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async (source: AiSource) => {
    abortRef.current?.abort();
    const controller = new AbortController();

    abortRef.current = controller;
    setRunning(source);
    setMade([]);
    setError(null);
    try {
      const cards = await makeFlashcards(classId, source, (card) => setMade((list) => [...list, card]), controller.signal);

      if (!controller.signal.aborted && cards.length === 0) setError('No cards came out of that source — try another');
    } catch (err) {
      if (!controller.signal.aborted) setError(describeError(err, 'Could not make cards'));
    } finally {
      if (!controller.signal.aborted) {
        setRunning(null);
        void queryClient.invalidateQueries({ queryKey: ['study', 'questions'] });
        void queryClient.invalidateQueries({ queryKey: ['study', 'mastery'] });
      }
    }
  };

  const list = sources.data ?? [];

  return (
    <div className='flex flex-col gap-3'>
      <Field label='Class'>
        <select
          className={cn(INPUT_CLASS, 'text-base')}
          disabled={running !== null}
          value={classId}
          onChange={(event) => setClassId(event.target.value)}
        >
          {classes.map((cls) => (
            <option key={cls.id} value={cls.id}>
              {cls.code ? `${cls.code} — ${cls.name}` : cls.name}
            </option>
          ))}
        </select>
      </Field>
      <div className='flex flex-wrap gap-2 pb-1'>
        {KINDS.map((entry) => (
          <FilterChip key={entry.kind} active={kind === entry.kind} onClick={() => setKind(entry.kind)}>
            {entry.label}
          </FilterChip>
        ))}
      </div>

      {(running || made.length > 0) && (
        <div className='border-st-line rounded-st flex flex-col gap-1 border-2 p-2'>
          <p className='text-st-fg px-1 text-sm font-semibold'>
            {running ? `Making cards from ${running.title}… ${made.length}` : `${made.length} card${made.length === 1 ? '' : 's'} added`}
          </p>
          {made.map((card) => (
            <p key={card.id} className='text-st-muted truncate px-1 text-sm' title={card.stem}>
              {card.stem}
            </p>
          ))}
        </div>
      )}
      {error && <ErrorNote message={error} />}

      {sources.isLoading ? (
        <LoadingRows rows={3} />
      ) : sources.error ? (
        <ErrorNote message={describeError(sources.error, 'Could not load sources')} onRetry={() => void sources.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState
          hint={kind === 'lecture' ? 'Finished lecture recordings show up here.' : 'Nothing in this class yet.'}
          icon={ICON[kind]}
          title='Nothing to make cards from'
        />
      ) : (
        <ul className='flex flex-col gap-1'>
          {list.map((source) => {
            const Icon = ICON[source.kind];
            const active = running?.id === source.id;

            return (
              <li key={source.id} className='rounded-st hover:bg-st-raised flex min-h-11 items-center gap-3 px-2'>
                <Icon className='text-st-muted h-4 w-4 shrink-0' />
                <span className='text-st-fg min-w-0 flex-1 truncate text-sm' title={source.title}>
                  {source.title}
                </span>
                <ActionButton
                  className='min-h-9 shrink-0 px-3 text-xs !shadow-none'
                  disabled={running !== null && !active}
                  loading={active}
                  variant='ghost'
                  onClick={() => void run(source)}
                >
                  <Sparkles className='h-4 w-4' /> Make cards
                </ActionButton>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
