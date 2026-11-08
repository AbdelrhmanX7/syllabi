import type { QuickPrompt, TutorContext, TutorMode } from '../types';
import type { InkCanvasHandle } from '@/features/bank';
import type { KeyboardEvent } from 'react';

import { useCallback, useEffect, useRef, useState } from 'react';
import { addToast, cn } from '@repo/ui';
import { ArrowUp, Keyboard, Loader2, MessageCircle, Mic, PenLine, Square, Target } from 'lucide-react';

import { canDictate } from '../lib/transcribe';
import { useDictation } from '../useDictation';

import { InkCanvas } from '@/features/bank';

export interface ComposerProps {
  mode: TutorMode;
  onModeChange: (mode: TutorMode) => void;
  /** Sends `question` (may be empty with a pen answer) + the picture when the pad was used. */
  onSend: (question: string, context: TutorContext) => void;
  streaming: boolean;
  onStop: () => void;
  quickPrompts?: QuickPrompt[];
  /** Chips are shown above the box only while the thread is empty. */
  showQuickPrompts?: boolean;
  /** The base context every turn carries (item / page / video moment the screen opened with). */
  baseContext?: TutorContext;
  focusOnMount?: boolean;
  compact?: boolean;
}

const MODES: { id: TutorMode; label: string; icon: typeof MessageCircle }[] = [
  { id: 'explain', label: 'Explain', icon: MessageCircle },
  { id: 'quiz', label: 'Quiz me', icon: Target },
];

/** The question box: mode toggle, quick prompts, typed text or a pen pad, send / stop. */
export function Composer({
  mode,
  onModeChange,
  onSend,
  streaming,
  onStop,
  quickPrompts = [],
  showQuickPrompts = false,
  baseContext,
  focusOnMount = false,
  compact = false,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [pen, setPen] = useState(false);
  const [inkEmpty, setInkEmpty] = useState(true);
  const inkRef = useRef<InkCanvasHandle>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusOnMount) textRef.current?.focus();
  }, [focusOnMount]);

  const [micAvailable, setMicAvailable] = useState(false);
  const dictation = useDictation(
    (spoken) => {
      setText((current) => (current.trim() ? `${current.trimEnd()} ${spoken}` : spoken));
      window.setTimeout(() => {
        const el = textRef.current;

        if (!el) return;
        el.focus();
        el.style.height = 'auto';
        el.style.height = `${Math.min(192, el.scrollHeight)}px`;
      }, 0);
    },
    (description) => addToast({ title: "Mic didn't work", description, color: 'danger', timeout: 6_000 }),
  );
  const recording = dictation.state === 'recording';
  const transcribing = dictation.state === 'transcribing';

  useEffect(() => setMicAvailable(canDictate()), []);

  const canSend = !streaming && (text.trim().length > 0 || (pen && !inkEmpty));

  const submit = useCallback(() => {
    if (!canSend) return;
    const ink = pen && inkRef.current && !inkRef.current.isEmpty() ? inkRef.current.rasterize() : null;
    const context: TutorContext = { ...(baseContext ?? {}), ...(ink ? { imagePngB64: ink } : {}) };

    onSend(text.trim(), context);
    setText('');
    if (ink) {
      inkRef.current?.clear();
      setInkEmpty(true);
    }
    textRef.current?.focus();
  }, [baseContext, canSend, onSend, pen, text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const applyPrompt = (prompt: QuickPrompt) => {
    if (prompt.mode) onModeChange(prompt.mode);
    if (prompt.pen) {
      setPen(true);
      setText(prompt.question);
      textRef.current?.focus();

      return;
    }
    onSend(prompt.question, { ...(baseContext ?? {}) });
  };

  const placeholder =
    mode === 'quiz'
      ? pen
        ? 'Optional: add a typed note to your pen answer'
        : 'Your answer… (Enter to send, Shift+Enter for a new line)'
      : pen
        ? 'What should I look at in your writing?'
        : 'Ask anything about this class… (Enter to send)';

  return (
    <div className='border-st-clay-edge bg-st-surface rounded-st-lg shadow-clay border-2 p-2'>
      {showQuickPrompts && quickPrompts.length > 0 && (
        <div className='mb-2 flex flex-wrap gap-1.5 px-1 pt-1'>
          {quickPrompts.map((prompt) => (
            <button
              key={prompt.label}
              className='border-st-line bg-st-bg text-st-fg hover:bg-st-raised inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium'
              disabled={streaming}
              type='button'
              onClick={() => applyPrompt(prompt)}
            >
              {prompt.pen ? (
                <PenLine className='h-3.5 w-3.5' />
              ) : prompt.mode === 'quiz' ? (
                <Target className='h-3.5 w-3.5' />
              ) : null}
              {prompt.label}
            </button>
          ))}
        </div>
      )}

      {pen && (
        <div className='mb-2'>
          <InkCanvas ref={inkRef} disabled={streaming} minHeight={compact ? 200 : 260} onChange={setInkEmpty} />
        </div>
      )}

      <div className='flex flex-wrap items-end gap-2 lg:flex-nowrap'>
        <div className='mr-auto flex shrink-0 items-center gap-1 lg:mr-0'>
          <div aria-label='Mode' className='border-st-line bg-st-bg flex rounded-full border p-0.5' role='group'>
            {MODES.map((entry) => {
              const Icon = entry.icon;
              const active = entry.id === mode;

              return (
                <button
                  key={entry.id}
                  aria-pressed={active}
                  className={cn(
                    'inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors',
                    active ? 'bg-st-accent text-st-accent-fg' : 'text-st-fg hover:bg-st-raised',
                  )}
                  disabled={streaming}
                  title={
                    entry.id === 'quiz'
                      ? 'One question at a time; answer by typing or with the pen'
                      : 'Explain with sources'
                  }
                  type='button'
                  onClick={() => onModeChange(entry.id)}
                >
                  <Icon className='h-3.5 w-3.5' />
                  {!compact && entry.label}
                </button>
              );
            })}
          </div>
          <button
            aria-pressed={pen}
            className={cn(
              'border-st-line inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors',
              pen ? 'bg-st-accent text-st-accent-fg' : 'bg-st-bg text-st-fg hover:bg-st-raised',
            )}
            title={pen ? 'Hide the pen pad' : 'Answer with the pen'}
            type='button'
            onClick={() => setPen((value) => !value)}
          >
            {pen ? <Keyboard className='h-4 w-4' /> : <PenLine className='h-4 w-4' />}
          </button>
        </div>

        <textarea
          ref={textRef}
          aria-label={mode === 'quiz' ? 'Your answer' : 'Your question'}
          className='text-st-fg placeholder:text-st-muted order-first max-h-48 min-h-[2.75rem] min-w-0 flex-1 basis-full resize-none lg:order-none lg:basis-auto bg-transparent px-2 py-2.5 text-base leading-6 outline-none'
          placeholder={placeholder}
          rows={1}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            event.target.style.height = 'auto';
            event.target.style.height = `${Math.min(192, event.target.scrollHeight)}px`;
          }}
          onKeyDown={onKeyDown}
        />

        {micAvailable &&
          (recording ? (
            <button
              aria-label='Stop recording'
              className='bg-st-danger text-st-accent-fg inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-3 text-sm font-medium tabular-nums'
              type='button'
              onClick={dictation.stop}
            >
              <Square className='h-4 w-4' />
              {Math.floor(dictation.seconds / 60)}:{String(dictation.seconds % 60).padStart(2, '0')}
            </button>
          ) : (
            <button
              aria-label='Speak your question'
              className='border-st-line bg-st-bg text-st-fg hover:bg-st-raised inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-40'
              disabled={streaming || transcribing}
              title='Speak instead of typing'
              type='button'
              onClick={() => void dictation.start()}
            >
              {transcribing ? <Loader2 className='h-4 w-4 animate-spin' /> : <Mic className='h-4 w-4' />}
            </button>
          ))}

        {streaming ? (
          <button
            aria-label='Stop'
            className='bg-st-accent text-st-accent-fg border-st-accent-lip border-2 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full'
            type='button'
            onClick={onStop}
          >
            <Square className='h-4 w-4' />
          </button>
        ) : (
          <button
            aria-label='Send'
            className='bg-st-accent text-st-accent-fg border-st-accent-lip inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 transition-opacity disabled:opacity-40'
            disabled={!canSend}
            type='button'
            onClick={submit}
          >
            <ArrowUp className='h-4 w-4' />
          </button>
        )}
      </div>
    </div>
  );
}
