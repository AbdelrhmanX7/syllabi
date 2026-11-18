import type { QuestionType, StudyClass } from '@/lib/api/types';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';

import { ActionButton, ErrorNote } from '@/components/ui/primitives';
import { ToggleRow } from '@/components/ui/Toggle';
import { Sheet } from '@/features/inbox/components/Sheet';
import { describeError } from '@/lib/api/errors';
import { patchClass } from '@/lib/api/endpoints';

/** Every kind of question, in plain words. */
export const QUESTION_TYPE_LABELS: { type: QuestionType; label: string }[] = [
  { type: 'free', label: 'Written answer' },
  { type: 'mcq', label: 'Multiple choice' },
  { type: 'fill_blank', label: 'Fill in the blank' },
  { type: 'matching', label: 'Matching' },
  { type: 'label_image', label: 'Label a picture' },
  { type: 'code_output', label: 'What does the code print' },
  { type: 'code_write', label: 'Write code' },
];

/**
 * «Question types» for one class: the kinds of questions it uses. Nothing of a switched-off kind is
 * made for this class any more, and drills, mock exams and quizzes leave those questions out.
 */
export function QuestionTypesButton({ cls, onSaved }: { cls: StudyClass; onSaved?: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const all = QUESTION_TYPE_LABELS.map((t) => t.type);
  const [on, setOn] = useState<Set<QuestionType>>(new Set(cls.questionTypes ?? all));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limited = Boolean(cls.questionTypes?.length);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await patchClass(cls.id, { questionTypes: on.size === all.length ? null : all.filter((t) => on.has(t)) });
      await queryClient.invalidateQueries({ queryKey: ['study', 'classes'] });
      onSaved?.();
      setOpen(false);
    } catch (failure) {
      setError(describeError(failure, 'Could not save the question types'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ActionButton
        className='min-h-9 px-3'
        variant='ghost'
        onClick={() => {
          setOn(new Set(cls.questionTypes ?? all));
          setError(null);
          setOpen(true);
        }}
      >
        <SlidersHorizontal className='h-4 w-4' /> {limited ? `Types · ${cls.questionTypes!.length}` : 'Types'}
      </ActionButton>
      {open ? (
        <Sheet
          footer={
            <ActionButton disabled={!on.size} loading={busy} variant='primary' onClick={() => void save()}>
              Save
            </ActionButton>
          }
          subtitle='Only these get made for this class, and drills and mock exams use only these.'
          title={`Question types · ${cls.code || cls.name}`}
          onClose={() => setOpen(false)}
        >
          <div className='divide-st-line flex flex-col divide-y'>
            {QUESTION_TYPE_LABELS.map(({ type, label }) => (
              <ToggleRow
                key={type}
                checked={on.has(type)}
                disabled={on.size === 1 && on.has(type)}
                label={label}
                onChange={(next) =>
                  setOn((current) => {
                    const copy = new Set(current);

                    if (next) copy.add(type);
                    else copy.delete(type);

                    return copy;
                  })
                }
              />
            ))}
          </div>
          {error ? <ErrorNote message={error} /> : null}
        </Sheet>
      ) : null}
    </>
  );
}
