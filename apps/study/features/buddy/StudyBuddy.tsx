// The study buddy: a small helper that floats over a notebook page or PDF. Hold it (or hold the pen
// button in the air) and ask out loud; let go and it looks at the page, points at the spot and marks
// it up for a little while, with a short written answer beside it. A quick tap opens a box to type
// instead (the tablet has no voice engine without a server). «Keep» turns the marks into ink.
//
// The board does the looking and drawing (`requestBoardBuddy` in @repo/whiteboard-react); this file
// is only the floating button, the voice, and the answer bubble.
import type { BoardBuddyState } from '@repo/whiteboard-react';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BOARD_BUDDY_STATE_EVENT, BOARD_BUDDY_TALK_EVENT, registerBoardBuddy, requestBoardBuddy } from '@repo/whiteboard-react';
import { cn } from '@repo/ui';
import { Check, Mic, Send, Sparkles, X } from 'lucide-react';

import { buddyStatusLine, type BuddyPhase } from './status';

import { ActionButton, Badge, INPUT_CLASS, Surface } from '@/components/ui/primitives';
import { useDictation } from '@/features/tutor/useDictation';

/** A press shorter than this is a tap (open the typing box), longer is hold-to-talk. */
const HOLD_MS = 280;

/** The verdict on the student's own work, in the mascot's voice (never «Wrong»). */
const VERDICT = {
  correct: { tone: 'ok', label: 'Correct' },
  partly: { tone: 'warn', label: 'Almost' },
  wrong: { tone: 'danger', label: 'Not quite' },
} as const;

export function StudyBuddy() {
  const buttonRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<BuddyPhase>('idle');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marks, setMarks] = useState(0);
  const [verdict, setVerdict] = useState<'correct' | 'wrong' | 'partly' | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pressRef = useRef<{ at: number; timer: number | null; talking: boolean } | null>(null);

  const origin = () => {
    const box = buttonRef.current?.getBoundingClientRect();

    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : undefined;
  };

  const ask = useCallback((text: string) => {
    const clean = text.trim();

    if (!clean) return;

    setOpen(true);
    setTyping(false);
    setDraft('');
    setQuestion(clean);
    setAnswer(null);
    setError(null);
    setMarks(0);
    setVerdict(null);
    setPhase('reading');
    requestBoardBuddy({ type: 'ask', question: clean, ...(origin() ? { origin: origin()! } : {}) });
  }, []);

  const dictation = useDictation(ask, (message) => {
    setOpen(true);
    setError(message);
    setPhase('idle');
    // No voice here: offer the typing box straight away.
    setTyping(true);
  });

  // On screen: the pen button's long hold now talks to this buddy (elsewhere it stays a menu press).
  useEffect(() => registerBoardBuddy(), []);

  // The typing box takes the keyboard as soon as it opens.
  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing]);

  // The board's side of the turn.
  useEffect(() => {
    const onState = (event: Event) => {
      const state = (event as CustomEvent<BoardBuddyState>).detail;

      if (!state) return;

      if (state.phase === 'done') {
        setPhase('done');
        setAnswer(state.say?.trim() || (state.marks > 0 ? 'Look at the marks on your page.' : "I couldn't find anything to mark here."));
        setMarks(state.marks);
        setVerdict(state.verdict ?? null);
      } else if (state.phase === 'error') {
        setPhase('idle');
        setError(state.message);
      } else if (state.phase === 'cleared') {
        setMarks(0);
      } else if (state.phase === 'kept') {
        setMarks(0);
        setPhase('kept');
      } else {
        setPhase(state.phase);
      }
    };

    window.addEventListener(BOARD_BUDDY_STATE_EVENT, onState);

    return () => window.removeEventListener(BOARD_BUDDY_STATE_EVENT, onState);
  }, []);

  // Pen button «Talk to the buddy»: listen while it is held in the air.
  const { start, stop } = dictation;

  useEffect(() => {
    const onTalk = (event: Event) => {
      const active = (event as CustomEvent<{ active?: boolean }>).detail?.active;

      if (active) {
        setOpen(true);
        setError(null);
        setTyping(false);
        void start();
      } else {
        stop();
      }
    };

    window.addEventListener(BOARD_BUDDY_TALK_EVENT, onTalk);

    return () => window.removeEventListener(BOARD_BUDDY_TALK_EVENT, onTalk);
  }, [start, stop]);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const press = { at: Date.now(), timer: null as number | null, talking: false };

    press.timer = window.setTimeout(() => {
      press.talking = true;
      setOpen(true);
      setError(null);
      setTyping(false);
      void start();
    }, HOLD_MS);
    pressRef.current = press;
  };

  const endPress = (cancelled: boolean) => {
    const press = pressRef.current;

    pressRef.current = null;

    if (!press) return;
    if (press.timer !== null) window.clearTimeout(press.timer);

    if (press.talking) {
      stop();
    } else if (!cancelled) {
      // A tap: open the typing box, or fold it away when it is already open.
      if (open && typing) {
        setTyping(false);
      } else {
        setOpen(true);
        setTyping(true);
      }
      setError(null);
    }
  };

  const close = () => {
    setOpen(false);
    setTyping(false);
    requestBoardBuddy({ type: 'clear' });
    setMarks(0);
    if (phase === 'done' || phase === 'kept') setPhase('idle');
  };

  const busy = phase === 'reading' || phase === 'planning' || phase === 'drawing';
  const status = buddyStatusLine({ phase, dictation: dictation.state, seconds: dictation.seconds });
  const listening = dictation.state === 'recording';

  return (
    <div className='pointer-events-none absolute bottom-24 right-3 z-30 flex flex-col items-end gap-3'>
      {open && (
        <Surface className='pointer-events-auto flex max-h-[40vh] w-[min(20rem,calc(100vw-2rem))] flex-col'>
          <div className='flex items-center gap-2 px-3 pt-2'>
            <span className={cn('min-w-0 flex-1 truncate text-xs font-semibold', error ? 'text-st-danger' : 'text-st-muted')}>
              {error ?? status ?? 'Ask about this page'}
            </span>
            <ActionButton aria-label='Close' className='min-h-9 w-9 shrink-0 px-0' title='Close' variant='ghost' onClick={close}>
              <X className='h-4 w-4' />
            </ActionButton>
          </div>
          {(question || answer) && (
            <div className='scroll-shadow-y min-h-0 flex-1 overflow-y-auto px-3 pb-2'>
              {question && <p className='text-st-muted truncate text-xs' title={question}>“{question}”</p>}
              {answer && (
                <p className='text-st-fg whitespace-pre-wrap text-sm leading-snug'>
                  {verdict && (
                    <Badge className='mr-1.5 align-middle' tone={VERDICT[verdict].tone}>
                      {VERDICT[verdict].label}
                    </Badge>
                  )}
                  {answer}
                </p>
              )}
            </div>
          )}
          {(marks > 0 || typing) && (
            <div className='flex flex-col gap-3 px-3 pb-3 pt-1'>
              {marks > 0 && (
                <div className='flex items-center gap-2'>
                  <ActionButton className='min-h-9 px-3' variant='soft' onClick={() => requestBoardBuddy({ type: 'keep' })}>
                    <Check className='h-4 w-4' /> Keep marks
                  </ActionButton>
                  <span className='text-st-muted text-xs'>They fade on their own.</span>
                </div>
              )}
              {typing && (
                <form
                  className='flex items-center gap-2'
                  onSubmit={(event) => {
                    event.preventDefault();
                    ask(draft);
                  }}
                >
                  <input
                    ref={inputRef}
                    aria-label='Your question'
                    className={INPUT_CLASS}
                    disabled={busy}
                    placeholder='Ask about this page'
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <ActionButton aria-label='Ask' className='w-11 shrink-0 px-0' disabled={busy || !draft.trim()} type='submit' variant='primary'>
                    <Send className='h-4 w-4' />
                  </ActionButton>
                </form>
              )}
            </div>
          )}
        </Surface>
      )}
      <span ref={buttonRef} className='pointer-events-auto inline-flex'>
      <ActionButton
        aria-label='Study buddy: hold to talk, tap to type'
        className='pointer-events-auto h-12 min-h-12 w-12 select-none rounded-full px-0'
        loading={busy}
        title='Hold to talk, tap to type'
        variant={listening ? 'danger' : 'primary'}
        onContextMenu={(event) => event.preventDefault()}
        onPointerCancel={() => endPress(true)}
        onPointerDown={onPointerDown}
        onPointerUp={() => endPress(false)}
      >
        {!busy && (listening ? <Mic className='h-5 w-5' /> : <Sparkles className='h-5 w-5' />)}
      </ActionButton>
      </span>
    </div>
  );
}
