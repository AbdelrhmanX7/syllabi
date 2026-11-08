import type { ClassDecks, TopicDeck } from './lib/deck';
import type { Question, StudyClass } from '@/lib/api/types';

import { useMemo, useState } from 'react';
import { cn } from '@repo/ui';
import { ChevronDown, GalleryVerticalEnd, Pencil, Play, Plus, Sparkles } from 'lucide-react';

import { AiMaker } from './components/AiMaker';
import { CardSheet } from './components/CardSheet';
import { StudySession } from './components/StudySession';
import { useFlashcards } from './hooks';
import { groupDecks, isDue, orderSession } from './lib/deck';

import {
  ActionButton,
  Badge,
  EmptyState,
  ErrorNote,
  FilterChip,
  LoadingRows,
  Surface,
} from '@/components/ui/primitives';
import { Sheet } from '@/features/inbox/components/Sheet';
import { useClasses } from '@/lib/api/hooks';
import { describeError } from '@/lib/api/errors';

export { FLASHCARD_TAG, isFlashcard } from './lib/deck';

type View = { kind: 'decks' } | { kind: 'session'; cards: Question[]; title: string };
type Editing = { card: Question | null; classId?: string; topic?: string } | null;

const classLabel = (cls: StudyClass | undefined, fallback = 'Class') =>
  cls ? (cls.code ? `${cls.code} · ${cls.name}` : cls.name) : fallback;

/**
 * `/flashcards` — decks by class, then topic (a card is a bank question tagged 'flashcard'), a
 * flip-and-grade study session on the bank's SRS, «New card» and «Make with AI».
 */
export default function FlashcardsHome({ classId: initialClassId }: { classId?: string }) {
  const classesQuery = useClasses('all');
  const classes = useMemo(() => classesQuery.data ?? [], [classesQuery.data]);
  const classById = useMemo(() => new Map(classes.map((cls) => [cls.id, cls])), [classes]);
  const cardsQuery = useFlashcards();
  const [filter, setFilter] = useState<string | null>(initialClassId ?? null);
  const [view, setView] = useState<View>({ kind: 'decks' });
  const [editing, setEditing] = useState<Editing>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [openDeck, setOpenDeck] = useState<string | null>(null);

  const allDecks = useMemo(
    () => groupDecks(cardsQuery.data ?? [], classes.map((cls) => cls.id)),
    [cardsQuery.data, classes],
  );
  const decks = filter ? allDecks.filter((group) => group.classId === filter) : allDecks;
  const shown = decks.flatMap((group) => group.topics.flatMap((deck) => deck.cards));
  const dueCount = shown.filter((card) => isDue(card)).length;
  const topicsByClass = useMemo(
    () => new Map(allDecks.map((group) => [group.classId, group.topics.map((deck) => deck.topic)])),
    [allDecks],
  );
  const pickClass = filter ?? initialClassId;
  const scopeTitle = filter ? classLabel(classById.get(filter)) : 'All decks';

  const study = (cards: Question[], title: string, all: boolean) => {
    const queue = orderSession(cards, { all });

    if (queue.length) setView({ kind: 'session', cards: queue, title });
  };

  const sheets = (
    <>
      {editing && (
        <CardSheet
          card={editing.card}
          classes={classes}
          defaultClassId={editing.classId ?? pickClass}
          defaultTopic={editing.topic}
          topicsByClass={topicsByClass}
          onClose={() => setEditing(null)}
        />
      )}
      {aiOpen && (
        <Sheet subtitle='Cards stream into the class decks' title='Make cards with AI' onClose={() => setAiOpen(false)}>
          <AiMaker classes={classes} defaultClassId={pickClass} />
        </Sheet>
      )}
    </>
  );

  if (view.kind === 'session') {
    return <StudySession cards={view.cards} title={view.title} onExit={() => setView({ kind: 'decks' })} />;
  }

  const total = shown.length;
  const loading = cardsQuery.isLoading || classesQuery.isLoading;

  return (
    <div className='flex flex-col gap-4 pb-2'>
      {sheets}
      <header className='flex flex-wrap items-center gap-3'>
        <div className='min-w-[10rem] flex-1'>
          <h1 className='text-st-fg text-2xl font-bold'>Flashcards</h1>
          <p className='text-st-muted text-sm'>
            {loading ? 'Loading…' : `${total} card${total === 1 ? '' : 's'} · ${dueCount} due`}
          </p>
        </div>
        <ActionButton disabled={!classes.length} variant='secondary' onClick={() => setAiOpen(true)}>
          <Sparkles className='h-4 w-4' /> Make with AI
        </ActionButton>
        <ActionButton disabled={!classes.length} variant='secondary' onClick={() => setEditing({ card: null })}>
          <Plus className='h-4 w-4' /> New card
        </ActionButton>
        {total > 0 && dueCount < total && (
          <ActionButton
            variant={dueCount > 0 ? 'secondary' : 'primary'}
            onClick={() => study(shown, scopeTitle, true)}
          >
            {dueCount > 0 ? null : <Play className='h-4 w-4' />} Study all
          </ActionButton>
        )}
        {dueCount > 0 && (
          <ActionButton variant='primary' onClick={() => study(shown, scopeTitle, false)}>
            <Play className='h-4 w-4' /> Study {dueCount} due
          </ActionButton>
        )}
      </header>

      {allDecks.length > 1 && (
        <div className='flex flex-wrap gap-2 pb-1'>
          <FilterChip active={!filter} count={(cardsQuery.data ?? []).length} onClick={() => setFilter(null)}>
            All
          </FilterChip>
          {allDecks.map((group) => (
            <FilterChip
              key={group.classId}
              active={filter === group.classId}
              count={group.count}
              onClick={() => setFilter(group.classId)}
            >
              {classById.get(group.classId)?.code || classById.get(group.classId)?.name || 'Class'}
            </FilterChip>
          ))}
        </div>
      )}

      {cardsQuery.error ? (
        <ErrorNote
          message={describeError(cardsQuery.error, 'Could not load your cards')}
          onRetry={() => void cardsQuery.refetch()}
        />
      ) : loading ? (
        <LoadingRows rows={5} />
      ) : decks.length === 0 ? (
        <EmptyState
          action={
            classes.length ? (
              <div className='flex flex-wrap justify-center gap-3'>
                <ActionButton variant='primary' onClick={() => setEditing({ card: null })}>
                  <Plus className='h-4 w-4' /> New card
                </ActionButton>
                <ActionButton variant='secondary' onClick={() => setAiOpen(true)}>
                  <Sparkles className='h-4 w-4' /> Make with AI
                </ActionButton>
              </div>
            ) : undefined
          }
          hint='Write your own, or let the AI make a deck from a library file, notebook page or lecture.'
          icon={GalleryVerticalEnd}
          title='No flashcards yet'
        />
      ) : (
        <div className='flex flex-col gap-3'>
          {decks.map((group) => (
            <ClassGroup
              key={group.classId}
              cls={classById.get(group.classId)}
              group={group}
              openDeck={openDeck}
              onAdd={(topic) => setEditing({ card: null, classId: group.classId, topic })}
              onEdit={(card) => setEditing({ card })}
              onStudy={study}
              onToggle={(key) => setOpenDeck((current) => (current === key ? null : key))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ClassGroup({
  cls,
  group,
  openDeck,
  onToggle,
  onStudy,
  onEdit,
  onAdd,
}: {
  cls: StudyClass | undefined;
  group: ClassDecks;
  openDeck: string | null;
  onToggle: (key: string) => void;
  onStudy: (cards: Question[], title: string, all: boolean) => void;
  onEdit: (card: Question) => void;
  onAdd: (topic: string) => void;
}) {
  const title = classLabel(cls);
  const cards = group.topics.flatMap((deck) => deck.cards);

  return (
    <Surface as='section' className='px-3 py-2'>
      <div className='flex min-h-11 items-center gap-2'>
        <h2 className='text-st-fg min-w-0 flex-1 truncate text-base font-semibold' title={title}>
          {title}
        </h2>
        <span className='text-st-muted shrink-0 text-sm tabular-nums'>
          {group.count} · {group.due} due
        </span>
        <ActionButton
          className='min-h-9 shrink-0 px-3'
          variant='ghost'
          onClick={() => onStudy(cards, title, group.due === 0)}
        >
          <Play className='h-4 w-4' /> Study
        </ActionButton>
      </div>
      <ul className='flex flex-col gap-1'>
        {group.topics.map((deck) => (
          <DeckRow
            key={deck.key}
            classTitle={title}
            deck={deck}
            open={openDeck === deck.key}
            onAdd={() => onAdd(deck.topic)}
            onEdit={onEdit}
            onStudy={onStudy}
            onToggle={() => onToggle(deck.key)}
          />
        ))}
      </ul>
    </Surface>
  );
}

function DeckRow({
  deck,
  classTitle,
  open,
  onToggle,
  onStudy,
  onEdit,
  onAdd,
}: {
  deck: TopicDeck;
  classTitle: string;
  open: boolean;
  onToggle: () => void;
  onStudy: (cards: Question[], title: string, all: boolean) => void;
  onEdit: (card: Question) => void;
  onAdd: () => void;
}) {
  return (
    <li className='border-st-line border-t'>
      <div className='flex min-h-11 items-center gap-2'>
        <button
          aria-expanded={open}
          className='hover:bg-st-raised rounded-st flex min-h-11 min-w-0 flex-1 items-center gap-2 px-1 text-left'
          type='button'
          onClick={onToggle}
        >
          <ChevronDown
            className={cn('text-st-muted h-4 w-4 shrink-0 transition-transform duration-150', open ? '' : '-rotate-90')}
          />
          <span className='text-st-fg min-w-0 flex-1 truncate text-sm font-medium' title={deck.topic}>
            {deck.topic}
          </span>
          <span className='text-st-muted shrink-0 text-xs tabular-nums'>{deck.cards.length}</span>
          {deck.due > 0 && <Badge tone='accent'>{deck.due} due</Badge>}
        </button>
        <ActionButton
          aria-label={`Study ${deck.topic}`}
          className='min-h-9 shrink-0 px-3'
          variant='ghost'
          onClick={() => onStudy(deck.cards, `${classTitle} · ${deck.topic}`, deck.due === 0)}
        >
          <Play className='h-4 w-4' />
          <span className='hidden sm:inline'>{deck.due > 0 ? 'Study' : 'Study all'}</span>
        </ActionButton>
      </div>
      {open && (
        <ul className='flex flex-col gap-1 pb-2 ps-7'>
          {deck.cards.map((card) => (
            <li key={card.id}>
              <button
                className='hover:bg-st-raised rounded-st group flex min-h-10 w-full items-center gap-2 px-2 text-left'
                title={`${card.stem}\n— ${card.answer}`}
                type='button'
                onClick={() => onEdit(card)}
              >
                <span className='text-st-fg min-w-0 flex-1 truncate text-sm'>{card.stem}</span>
                <span className='text-st-muted hidden min-w-0 flex-1 truncate text-sm sm:block'>{card.answer}</span>
                <Pencil className='text-st-muted h-3.5 w-3.5 shrink-0' />
              </button>
            </li>
          ))}
          <li>
            <button
              className='text-st-accent hover:bg-st-raised rounded-st flex min-h-10 w-full items-center gap-2 px-2 text-left text-sm font-medium'
              type='button'
              onClick={onAdd}
            >
              <Plus className='h-4 w-4' /> Add a card to {deck.topic}
            </button>
          </li>
        </ul>
      )}
    </li>
  );
}
