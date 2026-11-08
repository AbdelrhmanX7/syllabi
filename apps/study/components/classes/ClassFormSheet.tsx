import type { StudyClass } from '@/lib/api/types';

import { useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import { useRouter } from 'next/router';

import { ActionButton, ErrorNote, Field, INPUT_CLASS } from '@/components/ui/primitives';
import { Sheet } from '@/features/inbox/components/Sheet';
import { describeError } from '@/lib/api/errors';
import { useManualClassMutations } from '@/lib/api/hooks';

const COLORS = ['#C05621', '#2B6CB0', '#2F855A', '#6B46C1', '#B83280', '#B7791F', '#319795', '#4A5568'];

/**
 * New / edit a class of his own — anything he wants to study that is not on Canvas (LeetCode, a
 * startup course…). Editing a manual class also offers Delete, behind a confirm step.
 */
export function ClassFormSheet({ cls, onClose }: { cls?: StudyClass; onClose: () => void }) {
  const router = useRouter();
  const { create, update, remove } = useManualClassMutations();
  const [name, setName] = useState(cls?.name ?? '');
  const [code, setCode] = useState(cls?.code ?? '');
  const [color, setColor] = useState(cls?.color ?? COLORS[3]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const busy = create.isPending || update.isPending || remove.isPending;
  const error = create.error ?? update.error ?? remove.error;
  const canSave = name.trim().length > 0 && !busy;

  const save = () => {
    if (!canSave) return;
    // Every label in the app reads `code`; an empty one falls back to the name.
    const body = { name: name.trim(), code: code.trim() || name.trim().slice(0, 30), color };

    if (cls) {
      update.mutate({ id: cls.id, ...body }, { onSuccess: onClose });
    } else {
      create.mutate(body, {
        onSuccess: (created) => {
          onClose();
          void router.push(`/class/?id=${encodeURIComponent(created.id)}`);
        },
      });
    }
  };

  const destroy = () => {
    if (!cls) return;
    remove.mutate(cls.id, {
      onSuccess: () => {
        onClose();
        void router.replace('/classes/');
      },
    });
  };

  return (
    <Sheet
      footer={
        confirmDelete ? (
          <div className='flex flex-wrap items-center justify-end gap-3'>
            <p className='text-st-fg mr-auto text-sm'>Delete «{cls?.name}»? Its notes and questions are kept.</p>
            <ActionButton disabled={busy} onClick={() => setConfirmDelete(false)}>
              Cancel
            </ActionButton>
            <ActionButton loading={remove.isPending} variant='danger' onClick={destroy}>
              <Trash2 className='h-4 w-4' /> Delete
            </ActionButton>
          </div>
        ) : (
          <div className='flex flex-wrap items-center justify-end gap-3'>
            {cls && (
              <ActionButton className='mr-auto' disabled={busy} variant='danger' onClick={() => setConfirmDelete(true)}>
                <Trash2 className='h-4 w-4' /> Delete
              </ActionButton>
            )}
            <ActionButton disabled={busy} onClick={onClose}>
              Cancel
            </ActionButton>
            <ActionButton
              disabled={!canSave}
              loading={create.isPending || update.isPending}
              variant='primary'
              onClick={save}
            >
              {cls ? 'Save' : 'Create class'}
            </ActionButton>
          </div>
        )
      }
      subtitle={cls ? undefined : 'Anything you want to study — LeetCode, a startup course, a language.'}
      title={cls ? 'Edit class' : 'New class'}
      onClose={onClose}
    >
      <form
        className='flex flex-col gap-4'
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Field label='Name'>
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className={INPUT_CLASS}
            maxLength={80}
            placeholder='LeetCode'
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field hint='Optional — the short label in the sidebar; the name is used when empty.' label='Short code'>
          <input
            className={INPUT_CLASS}
            maxLength={30}
            placeholder='DSA'
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>
        <div className='flex flex-col gap-1.5'>
          <span className='text-st-fg text-sm font-medium'>Colour</span>
          <div className='flex flex-wrap gap-3'>
            {COLORS.map((swatch) => (
              <button
                key={swatch}
                aria-label={`Colour ${swatch}`}
                aria-pressed={color === swatch}
                className='flex h-10 w-10 items-center justify-center rounded-full'
                style={{ backgroundColor: swatch }}
                type='button'
                onClick={() => setColor(swatch)}
              >
                {color === swatch && <Check className='h-5 w-5 text-white' />}
              </button>
            ))}
          </div>
        </div>
        {error && <ErrorNote message={describeError(error)} />}
        <button className='hidden' type='submit' />
      </form>
    </Sheet>
  );
}
