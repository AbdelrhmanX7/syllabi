import React, { useEffect, useState } from 'react';
import { BookText, Pencil, Save, X } from 'lucide-react';

import { useGuide, useSaveGuide } from '../api';
import { confirmDiscard, useUnsavedGuard } from '../lib/useUnsavedGuard';

import { ActionButton, EmptyState, ErrorNote, LoadingRows, Surface } from '@/components/ui/primitives';
import { Markdown } from '@/features/bank/components/Markdown';
import { describeError } from '@/lib/api/errors';
import { formatRelative } from '@/lib/format';

const GUIDE_MAX = 20_000;

/** The class guide: rendered markdown, or a textarea with save + an unsaved-changes guard. */
export function GuideEditor({ classId }: { classId: string }) {
  const guide = useGuide(classId);
  const save = useSaveGuide(classId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const saved = guide.data?.markdown ?? '';
  const dirty = editing && draft !== saved;

  useUnsavedGuard(dirty);

  useEffect(() => {
    if (!editing) setDraft(saved);
  }, [editing, saved]);

  const startEdit = () => {
    setDraft(saved);
    save.reset();
    setEditing(true);
  };

  const cancel = () => {
    if (!confirmDiscard(dirty)) return;
    setEditing(false);
  };

  const submit = () => {
    save.mutate(draft, { onSuccess: () => setEditing(false) });
  };

  return (
    <Surface as='section' className='p-4 sm:p-5'>
      <div className='mb-3 flex flex-wrap items-start gap-3'>
        <div className='min-w-0 flex-1'>
          <h2 className='text-st-fg flex items-center gap-2 text-base font-semibold'>
            <BookText className='h-4 w-4' /> Class guide
          </h2>
          <p className='text-st-muted mt-0.5 text-sm'>Every AI answer for this class follows this guide.</p>
        </div>
        {editing ? (
          <div className='flex gap-2'>
            <ActionButton variant='ghost' onClick={cancel}>
              <X className='h-4 w-4' /> Cancel
            </ActionButton>
            <ActionButton
              disabled={!dirty || draft.length > GUIDE_MAX}
              loading={save.isPending}
              variant='primary'
              onClick={submit}
            >
              <Save className='h-4 w-4' /> Save
            </ActionButton>
          </div>
        ) : (
          <ActionButton disabled={guide.isLoading || guide.isError} onClick={startEdit}>
            <Pencil className='h-4 w-4' /> Edit
          </ActionButton>
        )}
      </div>

      {guide.isLoading ? <LoadingRows rows={4} /> : null}
      {guide.isError ? <ErrorNote message={describeError(guide.error)} onRetry={() => void guide.refetch()} /> : null}
      {save.isError ? <ErrorNote message={describeError(save.error)} /> : null}

      {editing ? (
        <div className='mt-2 flex flex-col gap-1.5'>
          <textarea
            spellCheck
            aria-label='Class guide markdown'
            className='rounded-st border-st-clay-edge bg-st-surface text-st-fg focus:border-st-accent min-h-[420px] w-full border-2 p-3 font-mono text-sm leading-6 focus:outline-none'
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                event.preventDefault();
                if (dirty) submit();
              }
            }}
          />
          <p className={`text-xs ${draft.length > GUIDE_MAX ? 'text-st-danger' : 'text-st-muted'}`}>
            Markdown · {draft.length.toLocaleString()} / {GUIDE_MAX.toLocaleString()} characters
            {dirty ? ' · unsaved' : ''}
          </p>
        </div>
      ) : guide.data ? (
        saved.trim() ? (
          <>
            <Markdown className='max-w-3xl' text={saved} />
            {guide.data.updatedAt ? (
              <p className='text-st-muted mt-3 text-xs'>Edited {formatRelative(guide.data.updatedAt)}</p>
            ) : null}
          </>
        ) : (
          <EmptyState
            hint='Tell the tutor how to explain this class: tone, notation, what to emphasise.'
            icon={BookText}
            title='No guide yet'
          />
        )
      ) : null}
    </Surface>
  );
}
