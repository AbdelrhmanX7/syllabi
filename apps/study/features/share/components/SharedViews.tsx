import type { WhiteboardDocument } from '@repo/whiteboard-core';
import type { ConceptMapContent, NotebookContent, QuestionSetContent, SharedView } from '../types';
import type { Question } from '@/lib/api/types';

import { useEffect, useState } from 'react';
import { Chip, addToast, cn } from '@repo/ui';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { createBlankWhiteboardDocument, normalizeWhiteboardDocument } from '@repo/whiteboard-core';
import { useWhiteboardStorage } from '@repo/whiteboard-react';
import dynamic from 'next/dynamic';

import { addSharedQuestion, deleteSharedQuestion, patchSharedMapTerms, patchSharedQuestion, useSharedEdit } from '../api';

import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { Toggle } from '@/components/ui/Toggle';
import { ActionButton, INPUT_CLASS } from '@/components/ui/primitives';
import { fetchJsonFromUrl } from '@/lib/api/upload';
import { useBoardTheme } from '@/lib/notebooks/board-theme';

const WhiteboardEditor = dynamic(() => import('@repo/whiteboard-react').then((mod) => mod.WhiteboardEditor), {
  ssr: false,
  loading: () => <BoardNote>Loading the board…</BoardNote>,
});
// Markdown + KaTeX renderer shared with the question bank (client-only).
const Markdown = dynamic(() => import('@/features/bank').then((mod) => mod.Markdown), { ssr: false });

function BoardNote({ children }: { children: React.ReactNode }) {
  return <div className='text-st-muted flex h-full items-center justify-center text-sm'>{children}</div>;
}

/**
 * A shared notebook, view only: the snapshot's board JSON is written to this device's board storage
 * under its own id (`shared-<shareId>`, rewritten on every open) and the editor runs read-only on it:
 * pan, zoom and scroll, no tools, no sync. PDF backgrounds live on the owner's device and do not
 * travel with the share, so only the ink and paper show.
 */
function NotebookView({ shareId, content }: { shareId: string; content: NotebookContent }) {
  const storage = useWhiteboardStorage();
  const boardTheme = useBoardTheme();
  const boardId = `shared-${shareId}`;
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let live = true;

    setState('loading');
    (async () => {
      const doc = content.contentUrl
        ? normalizeWhiteboardDocument(await fetchJsonFromUrl<WhiteboardDocument>(content.contentUrl))
        : createBlankWhiteboardDocument({ id: boardId, title: content.title, backgroundType: 'blank' });

      if (!doc) throw new Error('empty');
      await storage.saveWhiteboard({ ...doc, id: boardId, title: content.title });
      if (live) setState('ready');
    })().catch(() => live && setState('error'));

    return () => {
      live = false;
    };
  }, [boardId, content.contentUrl, content.title, content.version, storage]);

  return (
    <div className='border-st-line bg-st-bg relative h-[70vh] min-h-[360px] w-full overflow-hidden rounded-lg border'>
      {state === 'ready' ? (
        <WhiteboardEditor
          embedded
          hideChrome
          paperOverPdf
          readOnly
          verticalNotebook
          boardTheme={boardTheme}
          locale='en'
          whiteboardId={boardId}
        />
      ) : (
        <BoardNote>{state === 'error' ? 'Couldn’t load this notebook. Try again in a moment.' : 'Loading the board…'}</BoardNote>
      )}
    </div>
  );
}

const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.');
const TEXTAREA_CLASS = cn(INPUT_CLASS, 'min-h-20 py-2 text-base sm:text-sm');

/** Stem + answer fields with Save / Cancel (editing a row, or adding one). */
function QuestionForm({
  cards,
  initial,
  saving,
  saveLabel,
  onSave,
  onCancel,
}: {
  cards: boolean;
  initial: { stem: string; answer: string };
  saving: boolean;
  saveLabel: string;
  onSave: (value: { stem: string; answer: string }) => void;
  onCancel: () => void;
}) {
  const [stem, setStem] = useState(initial.stem);
  const [answer, setAnswer] = useState(initial.answer);

  return (
    <div className='flex flex-col gap-3'>
      <textarea
        aria-label={cards ? 'Front' : 'Question'}
        className={TEXTAREA_CLASS}
        placeholder={cards ? 'Front' : 'Question'}
        value={stem}
        onChange={(event) => setStem(event.target.value)}
      />
      <textarea
        aria-label={cards ? 'Back' : 'Answer'}
        className={TEXTAREA_CLASS}
        placeholder={cards ? 'Back' : 'Answer'}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
      />
      <div className='flex justify-end gap-3'>
        <ActionButton disabled={saving} onClick={onCancel}>
          Cancel
        </ActionButton>
        <ActionButton
          disabled={!stem.trim()}
          loading={saving}
          variant='primary'
          onClick={() => onSave({ stem: stem.trim(), answer: answer.trim() })}
        >
          {saveLabel}
        </ActionButton>
      </div>
    </div>
  );
}

/**
 * Cards (front / back) or questions (stem / answer): flat rows, answers behind one switch. With
 * `edit` (Can edit) each row has Edit and Delete and there is an Add row; changes save to the original.
 */
function QuestionSetView({
  content,
  cards,
  edit,
}: {
  content: QuestionSetContent;
  cards: boolean;
  edit?: { shareId: string; classId: string; topic: string | null };
}) {
  const [showAnswers, setShowAnswers] = useState(cards);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Question | null>(null);
  const shareId = edit?.shareId ?? '';
  const save = useSharedEdit(shareId, ({ id, value }: { id: string; value: { stem: string; answer: string } }) =>
    patchSharedQuestion(id, value),
  );
  const add = useSharedEdit(shareId, (value: { stem: string; answer: string }) =>
    addSharedQuestion({
      classId: edit?.classId ?? '',
      topic: edit?.topic || content.topic || content.questions[0]?.topic || 'General',
      tags: cards ? ['flashcard'] : [],
      ...value,
    }),
  );
  const remove = useSharedEdit(shareId, (id: string) => deleteSharedQuestion(id));
  const noun = cards ? 'card' : 'question';
  const fail = (e: unknown) => addToast({ title: errorText(e), color: 'danger' });

  return (
    <div className='flex flex-col gap-2'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
        <p className='text-st-muted min-w-0 flex-1 basis-56 text-sm'>
          {content.questions.length} {cards ? 'cards' : 'questions'}
          {content.topic ? ` · ${content.topic}` : ''} · {content.className}
        </p>
        <span className='text-st-fg text-sm'>{cards ? 'Show backs' : 'Show answers'}</span>
        <Toggle checked={showAnswers} label={cards ? 'Show backs' : 'Show answers'} onChange={setShowAnswers} />
      </div>
      {!content.questions.length && !edit && <p className='text-st-muted text-sm'>Nothing here yet.</p>}
      {(content.questions.length > 0 || edit) && (
        <ol className='border-st-line divide-st-line bg-st-surface flex flex-col divide-y rounded-lg border'>
          {content.questions.map((question, index) => (
            <li key={question.id} className='flex gap-3 px-4 py-3'>
              <span className='text-st-muted w-6 shrink-0 pt-0.5 text-right text-xs tabular-nums'>{index + 1}</span>
              <div className='min-w-0 flex-1'>
                {edit && editing === question.id ? (
                  <QuestionForm
                    cards={cards}
                    initial={{ stem: question.stem, answer: question.answer ?? '' }}
                    saveLabel='Save'
                    saving={save.isPending}
                    onCancel={() => setEditing(null)}
                    onSave={(value) =>
                      save.mutate({ id: question.id, value }, { onSuccess: () => setEditing(null), onError: fail })
                    }
                  />
                ) : (
                  <>
                    <div className='text-st-fg text-sm'>
                      <Markdown text={question.stem} />
                    </div>
                    {(question.choices?.length ?? 0) > 0 && (
                      <ul className='text-st-muted mt-1 list-disc pl-5 text-sm'>
                        {(question.choices ?? []).map((choice) => (
                          <li key={choice}>{choice}</li>
                        ))}
                      </ul>
                    )}
                    {showAnswers && question.answer && (
                      <div className='border-st-line text-st-muted mt-2 border-l-2 pl-3 text-sm'>
                        <Markdown text={question.answer} />
                      </div>
                    )}
                    {question.editedBy && <p className='text-st-muted mt-1 text-xs'>Edited by {question.editedBy.name}</p>}
                  </>
                )}
              </div>
              {edit && editing !== question.id && (
                <div className='flex shrink-0 items-start gap-1'>
                  <ActionButton
                    aria-label={`Edit ${noun} ${index + 1}`}
                    className='w-11 px-0'
                    variant='ghost'
                    onClick={() => setEditing(question.id)}
                  >
                    <Pencil className='h-4 w-4' />
                  </ActionButton>
                  <ActionButton
                    aria-label={`Delete ${noun} ${index + 1}`}
                    className='w-11 px-0'
                    variant='ghost'
                    onClick={() => setDeleting(question)}
                  >
                    <Trash2 className='text-st-danger h-4 w-4' />
                  </ActionButton>
                </div>
              )}
            </li>
          ))}
          {edit && (
            <li className='px-4 py-3'>
              {adding ? (
                <QuestionForm
                  cards={cards}
                  initial={{ stem: '', answer: '' }}
                  saveLabel={`Add ${noun}`}
                  saving={add.isPending}
                  onCancel={() => setAdding(false)}
                  onSave={(value) => add.mutate(value, { onSuccess: () => setAdding(false), onError: fail })}
                />
              ) : (
                <ActionButton variant='ghost' onClick={() => setAdding(true)}>
                  <Plus className='h-4 w-4' /> Add {noun}
                </ActionButton>
              )}
            </li>
          )}
        </ol>
      )}
      {deleting && (
        <ConfirmSheet
          danger
          confirmLabel='Delete'
          title={`Delete this ${noun}?`}
          onClose={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id, { onError: fail })}
        >
          It goes for everyone this is shared with, the owner included.
        </ConfirmSheet>
      )}
    </div>
  );
}

function ConceptMapView({ content, edit }: { content: ConceptMapContent; edit?: { shareId: string; mapId: string } }) {
  const [terms, setTerms] = useState(content.promptTerms);
  const [draft, setDraft] = useState('');
  const save = useSharedEdit(edit?.shareId ?? '', (next: string[]) => patchSharedMapTerms(edit?.mapId ?? '', next));
  const changed = terms.join('\n') !== content.promptTerms.join('\n');
  const facts = [
    content.className,
    content.week ? `Week ${content.week}` : null,
    content.number ? `Map ${content.number}` : null,
    content.editedBy ? `Edited by ${content.editedBy.name}` : null,
  ].filter(Boolean);

  useEffect(() => setTerms(content.promptTerms), [content.promptTerms]);

  const addDraft = () => {
    const term = draft.trim();

    if (term && !terms.some((t) => t.toLowerCase() === term.toLowerCase())) setTerms([...terms, term]);
    setDraft('');
  };

  return (
    <div className='flex flex-col gap-3'>
      {facts.length > 0 && <p className='text-st-muted text-sm'>{facts.join(' · ')}</p>}
      <p className='text-st-fg text-sm font-semibold'>Terms to connect</p>
      {terms.length ? (
        <div className='flex flex-wrap gap-3'>
          {terms.map((term) => (
            <Chip
              key={term}
              isClosable={Boolean(edit && terms.length > 1)}
              size='md'
              variant='flat'
              onClose={edit && terms.length > 1 ? () => setTerms(terms.filter((t) => t !== term)) : undefined}
            >
              {term}
            </Chip>
          ))}
        </div>
      ) : (
        <p className='text-st-muted text-sm'>No terms yet.</p>
      )}
      {edit ? (
        <div className='flex flex-wrap gap-3'>
          <input
            aria-label='Add a term'
            className={cn(INPUT_CLASS, 'min-w-0 flex-1 basis-48 text-base sm:text-sm')}
            maxLength={120}
            placeholder='Add a term'
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addDraft();
              }
            }}
          />
          <ActionButton disabled={!draft.trim()} onClick={addDraft}>
            <Plus className='h-4 w-4' /> Add
          </ActionButton>
          <ActionButton
            disabled={!changed}
            loading={save.isPending}
            variant='primary'
            onClick={() =>
              save.mutate(terms, {
                onSuccess: () => addToast({ title: 'Terms saved', color: 'success' }),
                onError: (e) => addToast({ title: errorText(e), color: 'danger' }),
              })
            }
          >
            Save terms
          </ActionButton>
        </div>
      ) : (
        <p className='text-st-muted text-xs'>Make a copy to draw your own map from these terms and get it graded.</p>
      )}
    </div>
  );
}

/** The shared item; a named editor (not the owner viewing their own link) gets the editable version. */
export function SharedContent({ view }: { view: SharedView }) {
  const { share } = view;
  const canEdit = share.role === 'editor' && !share.isOwner && Boolean(share.resourceId);
  const id = share.resourceId ?? '';

  switch (share.resourceType) {
    case 'notebook':
      return <NotebookView content={view.content as NotebookContent} shareId={share.id} />;
    case 'deck':
    case 'questions':
      return (
        <QuestionSetView
          cards={share.resourceType === 'deck'}
          content={view.content as QuestionSetContent}
          edit={canEdit ? { shareId: share.id, classId: id, topic: share.topic ?? null } : undefined}
        />
      );
    case 'conceptMap':
      return <ConceptMapView content={view.content as ConceptMapContent} edit={canEdit ? { shareId: share.id, mapId: id } : undefined} />;
  }
}
