// «Custom AI»: the study buddy, opened up. Its experts (each one job, in plain rules — edit ours or add
// your own), what it remembers about you, and every answer it gave with how it was made. Flat rows only
// (no cards inside lists); every remove asks first.
import type { BuddyExpert, BuddyNote, BuddyTurn, ExpertEdit, ExpertGives } from './api';

import { useState } from 'react';
import Head from 'next/head';
import { Brain, History, Plus, ThumbsDown, ThumbsUp, Trash2, Users } from 'lucide-react';

import { useBuddyExperts, useBuddyMutations, useBuddyNotes, useBuddyTurn, useBuddyTurns } from './api';

import { PageHeader } from '@/components/layout/PageHeader';
import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { ActionButton, Badge, DividerTabs, EmptyState, ErrorNote, Field, FilterChip, INPUT_CLASS, LoadingRows } from '@/components/ui/primitives';
import { Toggle } from '@/components/ui/Toggle';
import { Markdown } from '@/features/bank';
import { Sheet } from '@/features/inbox/components/Sheet';

type Tab = 'experts' | 'memory' | 'answers';

const GIVES: Array<{ key: ExpertGives; label: string }> = [
  { key: null, label: 'An answer' },
  { key: 'steps', label: 'Written steps' },
  { key: 'quiz', label: 'A quick check' },
  { key: 'similar', label: 'A practice question' },
];

const ROW = 'border-default-200 flex min-h-14 items-center gap-3 border-b px-1 py-2';
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const modelName = (model: string) => model.split('/').pop() ?? model;
const messageOf = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.');

const BLANK: ExpertEdit = { name: '', when: '', job: [], gives: null, weakTopics: false, enabled: true };

function ExpertSheet({ expert, onClose }: { expert: BuddyExpert | 'new'; onClose: () => void }) {
  const isNew = expert === 'new';
  const start = isNew ? BLANK : expert;
  const [name, setName] = useState(start.name);
  const [when, setWhen] = useState(start.when);
  const [job, setJob] = useState(start.job.join('\n'));
  const [gives, setGives] = useState<ExpertGives>(start.gives);
  const [weakTopics, setWeakTopics] = useState(start.weakTopics);
  const [confirm, setConfirm] = useState(false);
  const { saveExpert, removeExpert } = useBuddyMutations();
  const origin = isNew ? 'custom' : expert.origin;

  const save = () =>
    saveExpert.mutate(
      { id: isNew ? 'new' : expert.id, edit: { name: name.trim(), when: when.trim(), job: job.split('\n').map((line) => line.trim()).filter(Boolean), gives, weakTopics, enabled: isNew ? true : expert.enabled } },
      { onSuccess: onClose },
    );

  return (
    <>
      <Sheet
        footer={
          <div className='flex items-center gap-3'>
            {origin !== 'builtin' && !isNew && (
              <ActionButton variant='ghost' onClick={() => setConfirm(true)}>
                {origin === 'edited' ? 'Back to the original' : 'Delete'}
              </ActionButton>
            )}
            <ActionButton className='ml-auto' loading={saveExpert.isPending} variant='primary' onClick={save}>
              Save
            </ActionButton>
          </div>
        }
        subtitle={isNew ? 'One job, written as plain rules.' : origin === 'builtin' ? 'One of ours. Your changes apply only to you.' : origin === 'edited' ? 'One of ours, with your changes.' : 'Your own expert.'}
        title={isNew ? 'New expert' : start.name}
        onClose={onClose}
      >
        <div className='flex flex-col gap-3'>
          <Field label='Name'>
            <input className={INPUT_CLASS} maxLength={40} placeholder='Proof coach' value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field hint='The buddy reads this to decide when to call this expert.' label='When to use it'>
            <input className={INPUT_CLASS} maxLength={300} placeholder='You ask for help writing or checking a proof.' value={when} onChange={(event) => setWhen(event.target.value)} />
          </Field>
          <Field hint='One rule per line. Say what it must do, and what it must never do.' label='Its rules'>
            <textarea
              className={`${INPUT_CLASS} min-h-40 py-2 leading-snug`}
              placeholder={'Check each line of the proof follows from the one before.\nName the first gap, never rewrite the whole proof.'}
              value={job}
              onChange={(event) => setJob(event.target.value)}
            />
          </Field>
          <div className='flex flex-col gap-1.5'>
            <span className='text-st-fg text-sm font-semibold'>What it gives back</span>
            <div className='flex flex-wrap gap-2 pb-1'>
              {GIVES.map((option) => (
                <FilterChip key={option.label} active={gives === option.key} onClick={() => setGives(option.key)}>
                  {option.label}
                </FilterChip>
              ))}
            </div>
          </div>
          <div className='flex items-center justify-between gap-3'>
            <span className='text-st-fg text-sm font-semibold'>Leans towards your weakest topics</span>
            <Toggle checked={weakTopics} label='Leans towards your weakest topics' onChange={setWeakTopics} />
          </div>
          {saveExpert.isError && <ErrorNote message={messageOf(saveExpert.error)} />}
        </div>
      </Sheet>
      {confirm && !isNew && (
        <ConfirmSheet
          danger
          confirmLabel={origin === 'edited' ? 'Go back to the original' : 'Delete expert'}
          title={origin === 'edited' ? `Drop your changes to ${expert.name}?` : `Delete ${expert.name}?`}
          onClose={() => setConfirm(false)}
          onConfirm={() => removeExpert.mutate(expert.id, { onSuccess: onClose })}
        >
          {origin === 'edited' ? 'Your rules for this expert are removed and ours come back.' : 'This expert and its rules are removed. This cannot be undone.'}
        </ConfirmSheet>
      )}
    </>
  );
}

function Experts() {
  const experts = useBuddyExperts();
  const { saveExpert } = useBuddyMutations();
  const [editing, setEditing] = useState<BuddyExpert | 'new' | null>(null);

  if (experts.isLoading) return <LoadingRows rows={6} />;
  if (experts.isError) return <ErrorNote message={messageOf(experts.error)} onRetry={() => void experts.refetch()} />;

  return (
    <>
      <div className='flex items-center justify-between gap-3 pb-2'>
        <p className='text-st-muted text-sm'>Each expert has one job. The buddy picks one per question, or you tap its button.</p>
        <ActionButton className='shrink-0' variant='primary' onClick={() => setEditing('new')}>
          <Plus className='h-4 w-4' /> New expert
        </ActionButton>
      </div>
      <ul data-custom-ai='experts'>
        {(experts.data ?? []).map((expert) => (
          <li key={expert.id} className={ROW}>
            <button className='flex min-w-0 flex-1 flex-col text-left' type='button' onClick={() => setEditing(expert)}>
              <span className='flex items-center gap-2'>
                <span className='text-st-fg truncate text-sm font-semibold'>{expert.name}</span>
                {expert.origin === 'custom' && <Badge tone='accent'>Yours</Badge>}
                {expert.origin === 'edited' && <Badge tone='warn'>Edited</Badge>}
              </span>
              <span className='text-st-muted truncate text-xs' title={expert.when}>
                {expert.when}
              </span>
            </button>
            <Toggle
              checked={expert.enabled}
              label={`${expert.name} on`}
              onChange={(enabled) => saveExpert.mutate({ id: expert.id, edit: { name: expert.name, when: expert.when, job: expert.job, gives: expert.gives, weakTopics: expert.weakTopics, enabled } })}
            />
          </li>
        ))}
      </ul>
      {editing && <ExpertSheet expert={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function Memory() {
  const notes = useBuddyNotes();
  const { addNote, forgetNote } = useBuddyMutations();
  const experts = useBuddyExperts();
  const [draft, setDraft] = useState('');
  const [removing, setRemoving] = useState<BuddyNote | null>(null);
  const by = (id: string) => (id === 'you' ? 'you' : id === 'quiz' ? 'a quick check' : (experts.data?.find((expert) => expert.id === id)?.name ?? id));

  if (notes.isLoading) return <LoadingRows rows={4} />;
  if (notes.isError) return <ErrorNote message={messageOf(notes.error)} onRetry={() => void notes.refetch()} />;

  return (
    <>
      <form
        className='flex items-center gap-3 pb-3'
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim().length >= 8) addNote.mutate(draft.trim(), { onSuccess: () => setDraft('') });
        }}
      >
        <input aria-label='A note for the buddy' className={INPUT_CLASS} maxLength={200} placeholder='Tell the buddy something about you: “Show me the graph first.”' value={draft} onChange={(event) => setDraft(event.target.value)} />
        <ActionButton className='shrink-0' disabled={draft.trim().length < 8} loading={addNote.isPending} type='submit' variant='primary'>
          Add
        </ActionButton>
      </form>
      {(notes.data ?? []).length === 0 ? (
        <EmptyState hint='The buddy saves a short note when it spots something lasting, like a slip you keep making.' icon={Brain} title='Nothing remembered yet' />
      ) : (
        <ul data-custom-ai='memory'>
          {(notes.data ?? []).map((note) => (
            <li key={`${note.classId}-${note.text}`} className={ROW}>
              <span className='min-w-0 flex-1'>
                <span className='text-st-fg block text-sm'>{note.text}</span>
                <span className='text-st-muted block text-xs'>
                  From {by(note.by)} · {day(note.at)}
                </span>
              </span>
              <ActionButton aria-label='Forget this' className='w-11 shrink-0 px-0' title='Forget this' variant='ghost' onClick={() => setRemoving(note)}>
                <Trash2 className='h-4 w-4' />
              </ActionButton>
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <ConfirmSheet danger confirmLabel='Forget it' title='Forget this note?' onClose={() => setRemoving(null)} onConfirm={() => forgetNote.mutate(removing)}>
          “{removing.text}” — the buddy will no longer use it.
        </ConfirmSheet>
      )}
    </>
  );
}

function TurnSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const turn = useBuddyTurn(id);
  const { rateTurn } = useBuddyMutations();
  const [rating, setRating] = useState<'up' | 'down' | null | undefined>(undefined);
  const data = turn.data;
  const shown = rating === undefined ? (data?.rating ?? null) : rating;
  const rate = (value: 'up' | 'down') => {
    const next = shown === value ? null : value;

    setRating(next);
    rateTurn.mutate({ id, rating: next });
  };

  return (
    <Sheet
      wide
      footer={
        data && (
          <div className='flex items-center gap-2'>
            <span className='text-st-muted min-w-0 flex-1 truncate text-xs'>
              {data.models.map(modelName).join(', ')} · {(data.latencyMs / 1000).toFixed(1)}s · ${data.costUsd.toFixed(3)}
            </span>
            <ActionButton aria-label='Good answer' className={shown === 'up' ? 'text-success-600 w-11 px-0' : 'w-11 px-0'} variant='ghost' onClick={() => rate('up')}>
              <ThumbsUp className='h-4 w-4' />
            </ActionButton>
            <ActionButton aria-label='Bad answer' className={shown === 'down' ? 'text-danger-600 w-11 px-0' : 'w-11 px-0'} variant='ghost' onClick={() => rate('down')}>
              <ThumbsDown className='h-4 w-4' />
            </ActionButton>
          </div>
        )
      }
      subtitle={data ? `${data.expert} · ${day(data.at)}` : undefined}
      title={data?.question || 'Answer'}
      onClose={onClose}
    >
      {turn.isLoading && <LoadingRows rows={4} />}
      {turn.isError && <ErrorNote message={messageOf(turn.error)} />}
      {data && (
        <div className='flex flex-col gap-3 text-sm'>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {data.imageUrl && <img alt='The page as the buddy saw it' className='border-default-200 rounded-st max-h-80 w-full border object-contain' src={data.imageUrl} />}
          {data.status === 'error' ? (
            <p className='text-danger-700'>It failed: {data.error}</p>
          ) : (
            <div>
              {data.reply?.say && <Markdown className='!text-sm !leading-snug' text={data.reply.say} />}
              {data.reply?.steps && (
                <ol className='text-st-fg mt-1 list-decimal space-y-1 pl-5'>
                  {data.reply.steps.map((step, index) => (
                    <li key={`${index}-${step}`}>
                      <Markdown className='!text-sm !leading-snug' text={step} />
                    </li>
                  ))}
                </ol>
              )}
              {data.reply?.quiz && (
                <div className='mt-1'>
                  <Markdown className='!text-sm !leading-snug font-semibold' text={data.reply.quiz.question} />
                  <ol className='list-[upper-alpha] space-y-0.5 pl-5'>
                    {data.reply.quiz.choices.map((choice, index) => (
                      <li key={`${index}-${choice}`} className={index === data.reply?.quiz?.answer ? 'text-success-700 font-semibold' : ''}>
                        <Markdown className='!text-sm !leading-snug !text-inherit' text={choice} />
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {data.reply?.similar && <Markdown className='!text-sm !leading-snug mt-1' text={data.reply.similar.markdown} />}
            </div>
          )}
          <div>
            <p className='text-st-fg pb-1 font-semibold'>How it answered</p>
            <ol className='text-st-muted space-y-1 text-xs'>
              {data.trace.map((step, index) => (
                <li key={`${index}-${step.kind}`}>
                  <span className='text-st-fg font-semibold'>{step.name}</span>
                  {step.models.length > 0 && <span> · {step.models.map(modelName).join(', ')}</span>}
                  {step.ms > 0 && <span> · {(step.ms / 1000).toFixed(1)}s</span>}
                  <span className='block'>{step.detail}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function Answers() {
  const [filter, setFilter] = useState<'all' | 'up' | 'down'>('all');
  const turns = useBuddyTurns(filter === 'all' ? undefined : filter);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <div className='flex flex-wrap items-center gap-2 pb-3'>
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          All
        </FilterChip>
        <FilterChip active={filter === 'up'} onClick={() => setFilter('up')}>
          <ThumbsUp className='h-3.5 w-3.5' /> Good
        </FilterChip>
        <FilterChip active={filter === 'down'} onClick={() => setFilter('down')}>
          <ThumbsDown className='h-3.5 w-3.5' /> Bad
        </FilterChip>
      </div>
      {turns.isLoading && <LoadingRows rows={5} />}
      {turns.isError && <ErrorNote message={messageOf(turns.error)} onRetry={() => void turns.refetch()} />}
      {turns.data && turns.data.length === 0 && <EmptyState hint='Ask the buddy something on a notebook page and it shows up here.' icon={History} title='No answers yet' />}
      <ul data-custom-ai='answers'>
        {(turns.data ?? []).map((turn: BuddyTurn) => (
          <li key={turn.id}>
            <button className={`${ROW} w-full text-left`} type='button' onClick={() => setOpen(turn.id)}>
              <span className='min-w-0 flex-1'>
                <span className='text-st-fg block truncate text-sm font-semibold' title={turn.question}>
                  {turn.question || 'A question'}
                </span>
                <span className='text-st-muted block truncate text-xs'>
                  {turn.expert}
                  {turn.pickedBy === 'picker' ? ' (picked for you)' : ''} · {turn.models.length ? modelName(turn.models[turn.models.length - 1]!) : 'no model'} · {(turn.latencyMs / 1000).toFixed(1)}s · {day(turn.at)}
                </span>
              </span>
              {turn.status === 'error' && <Badge tone='danger'>Failed</Badge>}
              {turn.rating === 'up' && <ThumbsUp className='text-success-600 h-4 w-4 shrink-0' />}
              {turn.rating === 'down' && <ThumbsDown className='text-danger-600 h-4 w-4 shrink-0' />}
            </button>
          </li>
        ))}
      </ul>
      {open && <TurnSheet id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export default function CustomAiPage() {
  const [tab, setTab] = useState<Tab>('experts');

  return (
    <>
      <Head>
        <title>Custom AI</title>
      </Head>
      <PageHeader back='/settings/' subtitle='Your study buddy, opened up: its experts, what it remembers about you, and its answers.' title='Custom AI' />
      <DividerTabs
        aria-label='Custom AI'
        tabs={[
          { key: 'experts', label: 'Experts', icon: <Users className='h-4 w-4' /> },
          { key: 'memory', label: 'Memory', icon: <Brain className='h-4 w-4' /> },
          { key: 'answers', label: 'Answers', icon: <History className='h-4 w-4' /> },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className='pt-3'>
        {tab === 'experts' && <Experts />}
        {tab === 'memory' && <Memory />}
        {tab === 'answers' && <Answers />}
      </div>
    </>
  );
}
