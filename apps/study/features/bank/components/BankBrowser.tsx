import type { BankFilters, ResultFilter } from '../lib/filters';
import type { Question, QuestionSourceKind, StudyClass } from '@/lib/api/types';

import React, { useMemo, useState } from 'react';
import { Checkbox } from '@repo/ui';
import { ListChecks, NotebookPen, Play, Search, Trash2, X } from 'lucide-react';

import { SOURCE_LABEL, applyFilters, sourcesOf, topicsOf } from '../lib/filters';

import { QuestionCard } from './QuestionCard';

import { ActionButton, FilterChip } from '@/components/ui/primitives';
import { track } from '@/lib/analytics';

/**
 * The bank browser: chip filters (class / topic / source / due / result), a search box, and the
 * question cards. Filtering is client-side over the loaded set; the parent reloads from the server
 * when the class changes.
 */

export interface BankBrowserProps {
  questions: Question[];
  classes: StudyClass[];
  filters: BankFilters;
  onFilters: (next: BankFilters) => void;
  onOpen: (question: Question) => void;
  onDelete?: (question: Question) => void;
  loading?: boolean;
  error?: string | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** Practise exactly these questions (the picked ones, or everything the filters show). */
  onPractice?: (questions: Question[]) => void;
  /** A board exam from exactly these questions. */
  onBoardExam?: (questions: Question[]) => void;
}

const RESULT_OPTIONS: { value: ResultFilter; label: string }[] = [
  { value: 'any', label: 'Any result' },
  { value: 'unseen', label: 'Never tried' },
  { value: 'wrong', label: 'Got wrong' },
  { value: 'partial', label: 'Partial' },
  { value: 'right', label: 'Got right' },
];

export function BankBrowser({
  questions,
  classes,
  filters,
  onFilters,
  onOpen,
  onDelete,
  loading,
  error,
  hasMore,
  onLoadMore,
  onPractice,
  onBoardExam,
}: BankBrowserProps) {
  const [showAllTopics, setShowAllTopics] = useState(false);
  // Pick mode: tapping a card ticks it instead of opening it; the bar practises the ticked ones.
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const togglePick = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);

      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });
  const stopPicking = () => {
    setPicking(false);
    setPicked(new Set());
  };
  const classScoped = useMemo(
    () => (filters.classId ? questions.filter((q) => q.classId === filters.classId) : questions),
    [filters.classId, questions],
  );
  const topics = useMemo(() => topicsOf(classScoped), [classScoped]);
  const sources = useMemo(() => sourcesOf(classScoped), [classScoped]);
  const visible = useMemo(() => applyFilters(questions, filters), [filters, questions]);
  const classById = useMemo(() => new Map(classes.map((c) => [c.id, c])), [classes]);
  // A topic arriving from a link (`?topic=`) that no loaded question carries still gets a chip, so
  // the active filter is visible and clearable instead of silently hiding everything.
  const knownTopic = !filters.topic || topics.some((t) => t.topic === filters.topic);
  const topicList = [
    ...(knownTopic ? [] : [{ topic: filters.topic!, count: 0 }]),
    ...(showAllTopics ? topics : topics.slice(0, 8)),
  ];
  const set = (patch: Partial<BankFilters>) => onFilters({ ...filters, ...patch });
  // Picked questions in on-screen order (a pick hidden by a later filter still counts).
  const pickedList = questions.filter((q) => picked.has(q.id));
  const allShownPicked = visible.length > 0 && visible.every((q) => picked.has(q.id));
  const active =
    Boolean(filters.topic) ||
    Boolean(filters.source) ||
    filters.dueOnly ||
    filters.result !== 'any' ||
    filters.q.trim().length > 0;

  return (
    <div className='flex flex-col gap-4'>
      <label className='relative block'>
        <Search className='pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-st-muted' />
        <input
          className='h-12 w-full rounded-st border-2 border-st-control-edge bg-st-surface pl-11 pr-11 text-base text-st-fg outline-none placeholder:text-st-muted focus:border-st-accent'
          placeholder='Search stems, topics, tags…'
          type='search'
          value={filters.q}
          onChange={(event) => set({ q: event.target.value })}
        />
        {filters.q ? (
          <button
            aria-label='Clear search'
            className='absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-st-muted hover:bg-st-raised'
            type='button'
            onClick={() => set({ q: '' })}
          >
            <X className='h-4 w-4' />
          </button>
        ) : null}
      </label>

      {classes.length > 1 ? (
        <ChipRow label='Class'>
          <Chip active={!filters.classId} onPress={() => set({ classId: null, topic: null })}>
            All
          </Chip>
          {classes.map((c) => (
            <Chip
              key={c.id}
              active={filters.classId === c.id}
              dot={c.color}
              onPress={() => set({ classId: c.id, topic: null })}
            >
              {c.code || c.name}
            </Chip>
          ))}
        </ChipRow>
      ) : null}

      {topicList.length ? (
        <ChipRow label='Topic'>
          <Chip active={!filters.topic} onPress={() => set({ topic: null })}>
            All
          </Chip>
          {topicList.map(({ topic, count }) => (
            <Chip
              key={topic}
              active={filters.topic === topic}
              onPress={() => set({ topic: filters.topic === topic ? null : topic })}
            >
              {topic} <span className='opacity-60'>{count}</span>
            </Chip>
          ))}
          {topics.length > 8 ? (
            <Chip active={false} onPress={() => setShowAllTopics((v) => !v)}>
              {showAllTopics ? 'Less' : `+${topics.length - 8} more`}
            </Chip>
          ) : null}
        </ChipRow>
      ) : null}

      <ChipRow label='Show'>
        <Chip active={filters.dueOnly} onPress={() => set({ dueOnly: !filters.dueOnly })}>
          Due now
        </Chip>
        {RESULT_OPTIONS.map((option) => (
          <Chip
            key={option.value}
            active={filters.result === option.value}
            onPress={() => set({ result: option.value })}
          >
            {option.label}
          </Chip>
        ))}
        {sources.length > 1 ? (
          <>
            {/* Source is a different question («where from»), so a thin rule sets it apart without a new row. */}
            <span aria-hidden className='bg-st-clay-edge mx-0.5 h-5 w-0.5 self-center rounded-full' />
            {sources.map((source) => (
              <Chip
                key={source}
                active={filters.source === source}
                onPress={() => set({ source: filters.source === source ? null : (source as QuestionSourceKind) })}
              >
                {SOURCE_LABEL[source]}
              </Chip>
            ))}
          </>
        ) : null}
        {active ? (
          <Chip
            active={false}
            onPress={() => onFilters({ ...filters, topic: null, source: null, dueOnly: false, result: 'any', q: '' })}
          >
            <X className='h-3.5 w-3.5' /> Reset
          </Chip>
        ) : null}
      </ChipRow>

      <div className='flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2'>
        <p className='text-xs text-st-muted'>
          {loading ? 'Loading…' : `${visible.length} question${visible.length === 1 ? '' : 's'}`}
          {picking ? ` · ${picked.size} picked` : ''}
        </p>
        <span className='flex-1' />
        {picking ? (
          <>
            <ActionButton
              className='min-h-9 px-3'
              disabled={!visible.length}
              variant='ghost'
              onClick={() =>
                setPicked((current) => {
                  const next = new Set(current);

                  for (const q of visible) {
                    if (allShownPicked) next.delete(q.id);
                    else next.add(q.id);
                  }

                  return next;
                })
              }
            >
              {allShownPicked ? 'Untick shown' : 'Tick all shown'}
            </ActionButton>
            <ActionButton className='min-h-9 px-3' variant='ghost' onClick={stopPicking}>
              <X className='h-4 w-4' /> Cancel
            </ActionButton>
          </>
        ) : (
          <>
            {onPractice && active && visible.length > 0 ? (
              <ActionButton className='min-h-9 px-3' variant='ghost' onClick={() => {
                  track('practice_started', { kind: 'questions', mode: 'filtered', count: visible.length });
                  onPractice(visible);
                }}
              >
                <Play className='h-4 w-4' /> Practice these {visible.length}
              </ActionButton>
            ) : null}
            {onPractice && visible.length > 0 ? (
              <ActionButton className='min-h-9 px-3' variant='ghost' onClick={() => setPicking(true)}>
                <ListChecks className='h-4 w-4' /> Pick questions
              </ActionButton>
            ) : null}
          </>
        )}
      </div>
      {error ? (
        <p className='rounded-2xl bg-st-danger/10 p-3 text-sm text-st-danger'>
          {error}
        </p>
      ) : null}

      <div className='grid gap-3 lg:grid-cols-2'>
        {visible.map((question) => (
          <QuestionCard
            key={question.id}
            elevated
            actions={
              picking ? (
                <span onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    aria-label='Pick this question'
                    isSelected={picked.has(question.id)}
                    onValueChange={() => togglePick(question.id)}
                  />
                </span>
              ) : onDelete ? (
                <button
                  aria-label='Delete question'
                  className='flex h-9 w-9 items-center justify-center rounded-full text-st-muted hover:text-st-danger'
                  type='button'
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(question);
                  }}
                >
                  <Trash2 className='h-4 w-4' />
                </button>
              ) : null
            }
            question={question}
            studyClass={classById.get(question.classId) ?? null}
            onOpen={picking ? (q) => togglePick(q.id) : onOpen}
          />
        ))}
      </div>

      {!loading && !visible.length ? (
        <div className='rounded-2xl border border-dashed border-st-line p-10 text-center'>
          <p className='text-base font-medium text-st-fg'>No questions here yet</p>
          <p className='mt-1 text-sm text-st-muted'>
            Snap a photo of a problem set, or pull questions from a Canvas page.
          </p>
        </div>
      ) : null}

      {picking && onPractice ? (
        // Flat bar pinned to the bottom of the screen while picking; the clay buttons keep room for their lip.
        <div className='sticky bottom-0 z-10 -mx-1 flex items-center gap-3 border-t border-st-line bg-st-bg px-1 pb-3 pt-3'>
          <p className='min-w-0 text-sm font-medium text-st-fg'>
            {picked.size ? `${picked.size} picked` : 'Tap questions to pick them'}
          </p>
          <span className='flex-1' />
          {onBoardExam ? (
            <ActionButton
              aria-label='Board exam'
              className='shrink-0'
              disabled={!pickedList.length}
              variant='secondary'
              onClick={() => {
                onBoardExam(pickedList);
                stopPicking();
              }}
            >
              <NotebookPen className='h-4 w-4' /> <span className='hidden sm:inline'>Board exam</span>
            </ActionButton>
          ) : null}
          <ActionButton
            className='shrink-0'
            disabled={!pickedList.length}
            variant='primary'
            onClick={() => {
              track('practice_started', { kind: 'questions', mode: 'picked', count: pickedList.length });
              onPractice(pickedList);
              stopPicking();
            }}
          >
            <Play className='h-4 w-4' /> Practice {pickedList.length || ''}
          </ActionButton>
        </div>
      ) : null}

      {hasMore && onLoadMore ? (
        <button
          className='mx-auto flex h-12 items-center rounded-st border-2 border-st-clay-edge bg-st-surface px-6 text-sm font-medium text-st-fg hover:bg-st-accent-soft shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
          disabled={loading}
          type='button'
          onClick={onLoadMore}
        >
          Load more
        </button>
      ) : null}
    </div>
  );
}

function ChipRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // Label centred on the first line of chips (32px chip + 3px lip); rows wrap with room for the lips.
    <div className='flex items-start gap-3'>
      <span className='w-14 shrink-0 text-[11px] font-semibold uppercase leading-8 tracking-wide text-st-muted'>{label}</span>
      <div className='flex flex-1 flex-wrap gap-x-2 gap-y-2.5 pb-[3px]'>{children}</div>
    </div>
  );
}

export function Chip({
  active,
  dot,
  onPress,
  children,
}: {
  active: boolean;
  dot?: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <FilterChip active={active} onClick={onPress}>
      {dot ? <span className='h-2.5 w-2.5 rounded-full' style={{ background: dot }} /> : null}
      {children}
    </FilterChip>
  );
}
