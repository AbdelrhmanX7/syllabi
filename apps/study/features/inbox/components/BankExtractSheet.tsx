import { useEffect, useRef, useState } from 'react';
import { cn } from '@repo/ui';
import { BookOpen, Check, Sparkles } from 'lucide-react';

import { Sheet } from './Sheet';

import { ActionButton, ErrorNote, LinkButton } from '@/components/ui/primitives';
import { extractQuestions } from '@/features/bank/api';
import { fileToPngB64 } from '@/features/bank/lib/image';
import { describeError } from '@/lib/api/errors';
import { useClasses } from '@/lib/api/hooks';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; found: number }
  | { kind: 'done'; count: number }
  | { kind: 'error'; message: string };

/** Where the photo comes from: an inbox item, or a file shared into the app (Android share target). */
export interface ExtractSource {
  /** Image src for the preview, if any. */
  preview: string | null;
  classId?: string | null;
  load: () => Promise<Blob>;
}

/**
 * «Use in bank» / «Make questions»: the photo goes to `POST /questions/extract` as `imagePngB64` (the
 * extract endpoint reads page pixels directly), into the chosen class's bank. `onExtracted` fires
 * when at least one question was saved.
 */
export function BankExtractSheet({
  source,
  onClose,
  onExtracted,
}: {
  source: ExtractSource;
  onClose: () => void;
  onExtracted?: () => void;
}) {
  const { data: classes } = useClasses();
  const [classId, setClassId] = useState(source.classId ?? '');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!classId && classes?.length === 1) setClassId(classes[0].id);
  }, [classId, classes]);
  useEffect(() => () => abort.current?.abort(), []);

  const run = async () => {
    const controller = new AbortController();

    abort.current = controller;
    setPhase({ kind: 'running', found: 0 });
    try {
      const png = await fileToPngB64(await source.load());
      let found = 0;
      const count = await extractQuestions(
        classId,
        { imagePngB64: png },
        () => setPhase({ kind: 'running', found: (found += 1) }),
        controller.signal,
      );

      if (controller.signal.aborted) return;
      setPhase({ kind: 'done', count });
      if (count > 0) onExtracted?.();
    } catch (error) {
      if (!controller.signal.aborted) setPhase({ kind: 'error', message: describeError(error) });
    }
  };

  return (
    <Sheet
      footer={
        phase.kind === 'done' && phase.count > 0 ? (
          <div className='flex justify-end gap-2'>
            <ActionButton onClick={onClose}>Close</ActionButton>
            <LinkButton href={`/bank/?classId=${encodeURIComponent(classId)}`} variant='primary'>
              <BookOpen className='h-4 w-4' /> Open the bank
            </LinkButton>
          </div>
        ) : (
          <div className='flex justify-end gap-2'>
            <ActionButton onClick={onClose}>Cancel</ActionButton>
            <ActionButton
              disabled={!classId}
              loading={phase.kind === 'running'}
              variant='primary'
              onClick={() => void run()}
            >
              <Sparkles className='h-4 w-4' /> Make questions
            </ActionButton>
          </div>
        )
      }
      subtitle='Questions found in the photo are saved to the class bank.'
      title='Use in bank'
      onClose={onClose}
    >
      <div className='flex flex-col gap-4 sm:flex-row'>
        {source.preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed B2 / data / blob URL
          <img
            alt='Source for the questions'
            className='rounded-st bg-st-raised aspect-[4/3] w-full shrink-0 object-cover sm:w-56'
            src={source.preview}
          />
        ) : null}
        <div className='flex min-w-0 flex-1 flex-col gap-3'>
          <p className='text-st-fg text-sm font-medium'>Class</p>
          <div className='flex flex-wrap gap-2'>
            {(classes ?? []).map((cls) => (
              <button
                key={cls.id}
                aria-pressed={classId === cls.id}
                className={cn(
                  'inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-xs font-medium',
                  classId === cls.id
                    ? 'bg-st-accent text-st-accent-fg border-st-accent-lip'
                    : 'border-st-line text-st-fg hover:bg-st-raised',
                )}
                disabled={phase.kind === 'running'}
                type='button'
                onClick={() => setClassId(cls.id)}
              >
                <span className='h-2 w-2 rounded-sm' style={{ backgroundColor: cls.color }} />
                {cls.code || cls.name}
              </button>
            ))}
          </div>
          {phase.kind === 'running' && (
            <p className='text-st-muted text-sm'>
              Reading the photo…{' '}
              {phase.found > 0 ? `${phase.found} question${phase.found === 1 ? '' : 's'} so far` : ''}
            </p>
          )}
          {phase.kind === 'done' && (
            <p className='text-st-fg flex items-center gap-2 text-sm'>
              {phase.count > 0 ? (
                <>
                  <Check className='text-st-ok h-4 w-4' /> {phase.count} question{phase.count === 1 ? '' : 's'} added.
                </>
              ) : (
                'No questions found in that photo.'
              )}
            </p>
          )}
          {phase.kind === 'error' && <ErrorNote message={phase.message} />}
        </div>
      </div>
    </Sheet>
  );
}
