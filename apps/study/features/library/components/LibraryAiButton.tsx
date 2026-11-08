import type { SseFrame } from '@/lib/api/http';
import type { Question } from '@/lib/api/types';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Layers, Sparkles } from 'lucide-react';
import Link from 'next/link';

import { ActionButton } from '@/components/ui/primitives';
import { tagAsFlashcard } from '@/features/flashcards/lib/tag';
import { aiFlashcards, extractQuestions } from '@/lib/api/endpoints';
import { describeError } from '@/lib/api/errors';
import { isSampleData } from '@/lib/api/sample';
import { useAiEnabled } from '@/hooks/useAiEnabled';

/**
 * «Make questions» (`/questions/extract` from {libraryId}: a stored PDF/image is read page by page,
 * a note or text-only PDF by its text) and «Flashcards» (`/ai/flashcards` {libraryId}). Both save
 * into the bank as they stream; this shows the running count and a link there.
 */
export interface LibraryAiButtonProps {
  classId: string;
  libraryId: string;
  mode: 'questions' | 'flashcards';
  /** PDFs only: e.g. "3-5". */
  pageRange?: string;
}

function LibraryAiButtonInner({ classId, libraryId, mode, pageRange }: LibraryAiButtonProps) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [sample, setSample] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  // A different doc is a different run.
  useEffect(() => {
    abortRef.current?.abort();
    setBusy(false);
    setCount(null);
    setError(null);
  }, [libraryId]);

  const run = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();

    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setCount(0);
    setSample(false);
    const onFrame = (frame: SseFrame) => {
      if (frame.event !== 'question') return;
      if (mode === 'flashcards') tagAsFlashcard(frame.data as Question);
      setCount((value) => (value ?? 0) + 1);
      if (isSampleData(frame.data)) setSample(true);
    };

    try {
      if (mode === 'questions') {
        await extractQuestions(
          { classId, from: { libraryId, ...(pageRange?.trim() ? { pageRange: pageRange.trim() } : {}) } },
          onFrame,
          controller.signal,
        );
      } else {
        await aiFlashcards({ libraryId, classId }, onFrame, controller.signal);
      }
      void queryClient.invalidateQueries({ queryKey: ['study', 'questions'] });
      void queryClient.invalidateQueries({ queryKey: ['study', 'mastery'] });
    } catch (err) {
      if (!controller.signal.aborted) setError(describeError(err, 'The AI step failed'));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const Icon = mode === 'questions' ? Sparkles : Layers;
  const noun = mode === 'questions' ? 'question' : 'flashcard';

  return (
    <div className='flex flex-col gap-1'>
      <ActionButton
        className='min-h-10 px-3'
        loading={busy}
        variant={mode === 'questions' ? 'primary' : 'secondary'}
        onClick={() => void run()}
      >
        <Icon className='h-4 w-4' /> {mode === 'questions' ? 'Make questions' : 'Flashcards'}
      </ActionButton>
      {count !== null && !error && (
        <p className='text-st-muted text-xs'>
          {busy ? `${count} ${noun}${count === 1 ? '' : 's'} so far…` : `${count} ${noun}${count === 1 ? '' : 's'} `}
          {!busy && (
            <>
              {sample ? 'drafted (sample preview)' : 'added'} ·{' '}
              <Link
                className='text-st-accent font-medium underline-offset-2 hover:underline'
                href={`/bank/?classId=${encodeURIComponent(classId)}`}
              >
                Open bank
              </Link>
            </>
          )}
        </p>
      )}
      {error && <p className='text-st-danger text-xs'>{error}</p>}
    </div>
  );
}

/** Hidden for accounts without AI (`useAiEnabled`). */
export function LibraryAiButton(props: Parameters<typeof LibraryAiButtonInner>[0]) {
  return useAiEnabled() ? <LibraryAiButtonInner {...props} /> : null;
}
