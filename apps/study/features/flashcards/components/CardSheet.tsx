import type { Question, StudyClass } from '@/lib/api/types';

import { useState } from 'react';
import { cn } from '@repo/ui';
import { PenLine, Trash2 } from 'lucide-react';

import { useFlashcardMutations, useFlashcards } from '../hooks';

import { BookmarkButton } from './BookmarkButton';
import { NotePad } from './NotePad';
import { NotePreview } from './NotePreview';

import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { ActionButton, ErrorNote, Field, INPUT_CLASS } from '@/components/ui/primitives';
import { Sheet } from '@/features/inbox/components/Sheet';
import { describeError } from '@/lib/api/errors';

const FIELD = cn(INPUT_CLASS, 'text-base');

/** «New card» / edit: front, back, class, topic. Edit adds Delete (behind a confirm). */
export function CardSheet({
  card,
  classes,
  defaultClassId,
  defaultTopic,
  topicsByClass,
  onClose,
}: {
  card?: Question | null;
  classes: StudyClass[];
  defaultClassId?: string;
  defaultTopic?: string;
  topicsByClass: Map<string, string[]>;
  onClose: () => void;
}) {
  const { create, update, remove } = useFlashcardMutations();
  const [front, setFront] = useState(card?.stem ?? '');
  const [back, setBack] = useState(card?.answer ?? '');
  const [classId, setClassId] = useState(card?.classId ?? defaultClassId ?? classes[0]?.id ?? '');
  const [topic, setTopic] = useState(card?.topic ?? defaultTopic ?? '');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [added, setAdded] = useState(0);
  const [writing, setWriting] = useState(false);
  // Bookmark and note save on their own, so read them from the live list, not the snapshot.
  const cardsQuery = useFlashcards();
  const live = card ? (cardsQuery.data?.find((item) => item.id === card.id) ?? card) : null;
  const busy = create.isPending || update.isPending || remove.isPending;
  const canSave = front.trim().length > 0 && back.trim().length > 0 && Boolean(classId);
  const topics = topicsByClass.get(classId) ?? [];

  const save = async (another: boolean) => {
    if (!canSave) return;
    setError(null);
    const draft = { classId, topic, front, back };

    try {
      if (card) await update.mutateAsync({ card, draft });
      else await create.mutateAsync(draft);
      if (another && !card) {
        // Keep class + topic for the next card.
        setFront('');
        setBack('');
        setAdded((n) => n + 1);
      } else onClose();
    } catch (err) {
      setError(describeError(err, 'Could not save the card'));
    }
  };

  return (
    <>
      <Sheet
        footer={
          <div className='flex flex-wrap items-center justify-end gap-3'>
            {card ? (
              <ActionButton className='mr-auto' disabled={busy} variant='ghost' onClick={() => setConfirmDelete(true)}>
                <Trash2 className='text-st-danger h-4 w-4' /> Delete
              </ActionButton>
            ) : (
              <ActionButton disabled={!canSave} loading={create.isPending} variant='secondary' onClick={() => void save(true)}>
                Save + next
              </ActionButton>
            )}
            <ActionButton disabled={!canSave} loading={busy} variant='primary' onClick={() => void save(false)}>
              {card ? 'Save' : 'Add card'}
            </ActionButton>
          </div>
        }
        subtitle={added ? `${added} added` : undefined}
        title={card ? 'Edit card' : 'New card'}
        onClose={onClose}
      >
        <div className='flex flex-col gap-3'>
          <Field hint='Markdown and $LaTeX$ work.' label='Front'>
            <textarea
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className={cn(FIELD, 'min-h-[88px] py-2')}
              placeholder='Question or term'
              value={front}
              onChange={(event) => setFront(event.target.value)}
            />
          </Field>
          <Field label='Back'>
            <textarea
              className={cn(FIELD, 'min-h-[88px] py-2')}
              placeholder='Answer or definition'
              value={back}
              onChange={(event) => setBack(event.target.value)}
            />
          </Field>
          <div className='grid gap-3 sm:grid-cols-2'>
            <Field label='Class'>
              <select className={FIELD} value={classId} onChange={(event) => setClassId(event.target.value)}>
                {classes.map((cls) => (
                  <option key={cls.id} value={cls.id}>
                    {cls.code ? `${cls.code} — ${cls.name}` : cls.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label='Topic'>
              <input
                className={FIELD}
                list='flashcard-topics'
                placeholder='General'
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
              />
              <datalist id='flashcard-topics'>
                {topics.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </Field>
          </div>
          {live && (
            <div className='border-st-line flex flex-col gap-2 border-t pt-3'>
              <div className='flex items-center gap-2'>
                <span className={cn('min-w-0 flex-1 text-sm', live.note ? 'text-st-fg font-medium' : 'text-st-muted')}>
                  {live.note ? 'Your note' : 'No note yet'}
                </span>
                <ActionButton className='min-h-9 px-3' variant='ghost' onClick={() => setWriting(true)}>
                  <PenLine className='h-4 w-4' /> {live.note ? 'Edit note' : 'Write a note'}
                </ActionButton>
                <BookmarkButton card={live} className='shrink-0' />
              </div>
              {live.note && <NotePreview note={live.note} />}
            </div>
          )}
          {error && <ErrorNote message={error} />}
        </div>
      </Sheet>
      {writing && live && <NotePad card={live} onClose={() => setWriting(false)} />}
      {confirmDelete && card && (
        <ConfirmSheet
          danger
          confirmLabel='Delete card'
          title='Delete this card?'
          onClose={() => setConfirmDelete(false)}
          onConfirm={() =>
            void remove
              .mutateAsync(card)
              .then(onClose)
              .catch((err: unknown) => setError(describeError(err, 'Could not delete the card')))
          }
        >
          It leaves the deck and the question bank, with its review history. This can&apos;t be undone.
        </ConfirmSheet>
      )}
    </>
  );
}
