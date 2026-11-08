import type { TutorContext, TutorMessage, TutorMode } from '../types';
import type { StudyClass } from '@/lib/api/types';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';

import { useAsk, useConversation } from '../hooks';
import { threadMode } from '../lib/conversations';
import { quickPromptsForClass } from '../lib/prompts';
import { quizScore } from '../lib/stream';

import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { QuizScore } from './QuizScore';

import { ErrorNote, LoadingRows } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';
import { isSampleData } from '@/lib/api/sample';

export interface ChatProps {
  classId?: string | null;
  cls?: Pick<StudyClass, 'code' | 'name'> | null;
  /** The thread to show; absent = a new one starts with the first question. */
  conversationId?: string | null;
  onConversationCreated?: (id: string) => void;
  /** Every turn carries this (item / page / video moment the screen opened with). */
  baseContext?: TutorContext;
  initialMode?: TutorMode;
  /** The sheet: tighter spacing, icon-only mode toggle. */
  compact?: boolean;
  focusOnMount?: boolean;
  /** A line under the empty state, e.g. «About: Lesson 3 at 12:40». */
  contextLabel?: string | null;
}

/** One conversation: the thread, the streaming answer, and the question box. */
export function Chat({
  classId,
  cls,
  conversationId,
  onConversationCreated,
  baseContext,
  initialMode = 'explain',
  compact = false,
  focusOnMount = false,
  contextLabel,
}: ChatProps) {
  const detail = useConversation(conversationId);
  const ask = useAsk();
  const [mode, setMode] = useState<TutorMode>(initialMode);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const quickPrompts = useMemo(() => quickPromptsForClass(cls), [cls]);

  // A thread opened from the list keeps its own mode (its latest turn's).
  const savedMode = threadMode(detail.data);

  useEffect(() => {
    if (savedMode) setMode(savedMode);
  }, [savedMode]);

  // Switching threads drops any stream that belonged to the previous one.
  useEffect(() => {
    ask.reset();
  }, [conversationId]);

  const messages: TutorMessage[] = useMemo(() => {
    const base = detail.data?.messages ?? [];
    const { status, pending, stream } = ask.state;

    if (status !== 'streaming' && status !== 'error') return base;
    if (!pending) return base;
    const assistant: TutorMessage = {
      role: 'assistant',
      text: stream.text,
      createdAt: pending.createdAt,
      mode: pending.mode,
      ...(stream.sources.length ? { sources: stream.sources } : {}),
    };

    return [...base, pending, ...(status === 'streaming' || stream.text ? [assistant] : [])];
  }, [ask.state, detail.data?.messages]);

  const streaming = ask.state.status === 'streaming';
  // The running score: this turn's `done {quiz}` once it lands, else the thread's saved one.
  const score = useMemo(
    () => quizScore(ask.state.stream.quiz ?? detail.data?.quiz ?? null),
    [ask.state.stream.quiz, detail.data?.quiz],
  );
  const lastVerdict = ask.state.stream.quiz?.graded?.result ?? null;
  const sampleThread = isSampleData(detail.data) || ask.state.stream.sample;

  // Follow the answer while the user is at the bottom; a manual scroll up pauses that.
  useEffect(() => {
    const node = listRef.current;

    if (!node || !stickRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const node = listRef.current;

    if (!node) return;
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  };

  const send = useCallback(
    async (question: string, context: TutorContext) => {
      stickRef.current = true;
      const hasContext = Object.keys(context).length > 0;
      const id = await ask.send({
        classId,
        conversationId: conversationId ?? null,
        mode,
        question,
        ...(hasContext ? { context } : {}),
      });

      if (id && id !== conversationId) onConversationCreated?.(id);
    },
    [ask, classId, conversationId, mode, onConversationCreated],
  );

  const empty = messages.length === 0 && !detail.isLoading;

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div
        ref={listRef}
        className={compact ? 'min-h-0 flex-1 overflow-y-auto px-3 py-3' : 'min-h-0 flex-1 overflow-y-auto px-1 py-2'}
        onScroll={onScroll}
      >
        {detail.isLoading && <LoadingRows rows={3} />}
        {detail.error && (
          <ErrorNote
            message={describeError(detail.error, 'Could not open this chat')}
            onRetry={() => void detail.refetch()}
          />
        )}
        {empty && (
          <div className='text-st-muted flex h-full flex-col items-center justify-center gap-2 px-4 text-center'>
            <span className='bg-st-raised text-st-fg flex h-11 w-11 items-center justify-center rounded-full'>
              <Sparkles className='h-5 w-5' strokeWidth={1.75} />
            </span>
            <p className='text-st-fg text-base font-semibold'>{cls ? `Ask about ${cls.code}` : 'Ask the tutor'}</p>
            {contextLabel && <p className='text-st-fg text-sm'>{contextLabel}</p>}
            <p className='max-w-sm text-sm'>
              <span className='text-st-fg font-medium'>Explain</span> answers from this class’s readings, transcripts
              and your notes. <span className='text-st-fg font-medium'>Quiz me</span> asks one question at a time — type
              or write your answer.
            </p>
          </div>
        )}
        {messages.length > 0 && (
          <div className='flex flex-col gap-3'>
            {messages.map((message, index) => {
              const last = index === messages.length - 1;

              return (
                <MessageBubble
                  key={`${message.createdAt}:${message.role}:${index}`}
                  classId={classId}
                  message={message}
                  sample={message.role === 'assistant' && sampleThread}
                  streaming={last && streaming && message.role === 'assistant'}
                />
              );
            })}
          </div>
        )}
        {ask.state.status === 'error' && ask.state.error && (
          <div className='mt-3'>
            <ErrorNote
              message={ask.state.error}
              onRetry={() => {
                const { pending } = ask.state;

                if (pending) void send(pending.text, pending.context ?? {});
              }}
            />
          </div>
        )}
      </div>
      <div className={compact ? 'border-st-line border-t p-2' : 'pt-2'}>
        {mode === 'quiz' && score && <QuizScore compact={compact} lastVerdict={lastVerdict} score={score} />}
        <Composer
          baseContext={baseContext}
          compact={compact}
          focusOnMount={focusOnMount}
          mode={mode}
          quickPrompts={quickPrompts}
          showQuickPrompts={empty}
          streaming={streaming}
          onModeChange={setMode}
          onSend={(question, context) => void send(question, context)}
          onStop={ask.cancel}
        />
      </div>
    </div>
  );
}
