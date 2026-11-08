import type { FlashcardSource } from '../lib/api';

import { useEffect, useRef, useState } from 'react';

import { extractLectureQuestions, generateFlashcards } from '../lib/api';

import { isStudyApiError } from '@/lib/api/errors';
import { useAiEnabled } from '@/hooks/useAiEnabled';
import { IfOnline } from '@/components/ui/NeedsInternet';

type State =
  | { kind: 'idle' }
  | { kind: 'running'; count: number }
  | { kind: 'done'; count: number }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; message: string };

const NO_TRANSCRIPT = /NO_TRANSCRIPT|no transcript/i;
const NO_TRANSCRIPT_REASON = 'Available once the transcript is ready';

interface StreamToBankButtonProps {
  idleLabel: string;
  noun: string;
  /** Streams the items; calls `onItem` per saved one and resolves with the final count. */
  run: (onItem: () => void, signal: AbortSignal) => Promise<number>;
  /** Set → the button is disabled and this is its tooltip. */
  disabledReason?: string | null;
}

/** A button that streams AI-made questions into the bank and counts them as they land. */
function StreamToBankButton({ idleLabel, noun, run, disabledReason }: StreamToBankButtonProps) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = async () => {
    const controller = new AbortController();

    abortRef.current = controller;
    setState({ kind: 'running', count: 0 });
    try {
      let seen = 0;
      const count = await run(() => setState({ kind: 'running', count: ++seen }), controller.signal);

      setState({ kind: 'done', count });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'Something went wrong';

      const noTranscript = (isStudyApiError(error) && error.code === 'NO_TRANSCRIPT') || NO_TRANSCRIPT.test(message);

      setState(noTranscript ? { kind: 'blocked', reason: NO_TRANSCRIPT_REASON } : { kind: 'error', message });
    }
  };

  const blockedReason = disabledReason ?? (state.kind === 'blocked' ? state.reason : null);
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const label =
    state.kind === 'running'
      ? `${idleLabel}… ${state.count}`
      : state.kind === 'done'
        ? `${plural(state.count)} added to bank`
        : state.kind === 'error'
          ? `Retry ${idleLabel.toLowerCase()}`
          : idleLabel;

  return (
    <button
      className='h-10 rounded-st border-2 border-st-clay-edge bg-st-surface px-4 text-sm font-medium text-st-fg hover:bg-st-accent-soft disabled:cursor-not-allowed disabled:opacity-60 shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
      disabled={state.kind === 'running' || !!blockedReason}
      title={blockedReason ?? (state.kind === 'error' ? state.message : undefined)}
      type='button'
      onClick={start}
    >
      {label}
    </button>
  );
}

/** Streams the lecture's questions into the bank (`POST /questions/extract`, SSE). */
function ExtractQuestionsButtonInner({
  classId,
  lectureId,
  disabledReason,
}: {
  classId: string;
  lectureId: string;
  disabledReason?: string | null;
}) {
  return (
    <StreamToBankButton
      disabledReason={disabledReason}
      idleLabel='Extract questions'
      noun='question'
      run={(onItem, signal) => extractLectureQuestions(classId, lectureId, onItem, signal)}
    />
  );
}

/** Streams flashcards (saved server-side as bank questions) from a lecture, video item or page. */
function FlashcardsButtonInner({
  source,
  classId,
  disabledReason,
}: {
  source: FlashcardSource;
  classId?: string;
  disabledReason?: string | null;
}) {
  return (
    <StreamToBankButton
      disabledReason={disabledReason}
      idleLabel='Flashcards'
      noun='card'
      run={(onItem, signal) => generateFlashcards(source, { classId, onCard: onItem, signal })}
    />
  );
}

/** Hidden for accounts without AI (`useAiEnabled`). */
export function ExtractQuestionsButton(props: Parameters<typeof ExtractQuestionsButtonInner>[0]) {
  return useAiEnabled() ? (
    <IfOnline label='Questions'>
      <ExtractQuestionsButtonInner {...props} />
    </IfOnline>
  ) : null;
}

/** Hidden for accounts without AI (`useAiEnabled`). */
export function FlashcardsButton(props: Parameters<typeof FlashcardsButtonInner>[0]) {
  return useAiEnabled() ? (
    <IfOnline label='Flashcards'>
      <FlashcardsButtonInner {...props} />
    </IfOnline>
  ) : null;
}
