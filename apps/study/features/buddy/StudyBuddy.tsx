// The study buddy: a small helper that floats over a notebook page or PDF. Hold it (or hold the pen
// button in the air) and ask out loud; let go and it looks at the page, points at the spot and marks
// it up for a little while, with a short written answer beside it. A quick tap opens a box to type
// instead (the tablet has no voice engine without a server). «Keep» turns the marks into ink.
//
// The board does the looking and drawing (`requestBoardBuddy` in @repo/whiteboard-react); this file
// is only the floating button, the voice, and the answer bubble.
import type { BoardBuddyState } from '@repo/whiteboard-react';
import type { InkCanvasHandle } from '@/features/bank';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BOARD_BUDDY_MARKS_MS, BOARD_BUDDY_STATE_EVENT, BOARD_BUDDY_TALK_EVENT, registerBoardBuddy, requestBoardAiCommand, requestBoardBuddy } from '@repo/whiteboard-react';
import { cn } from '@repo/ui';
import { Check, CopyPlus, Eraser, Keyboard, Lasso, MessagesSquare, Mic, Pencil, PenLine, Send, Undo2, WandSparkles, X } from 'lucide-react';

import { BUDDY_QUICK_ASKS, buddyStatusLine, type BuddyPhase } from './status';

import { ActionButton, Badge, BOARD_CHIP_OVERRIDE, ErrorNote, INPUT_CLASS, Surface } from '@/components/ui/primitives';
import { InkCanvas } from '@/features/bank';
import { useDictation } from '@/features/tutor/useDictation';
import { useVoiceAiEnabled } from '@/hooks/useAiEnabled';

/** A press shorter than this is a tap (open the typing box), longer is hold-to-talk. */
const HOLD_MS = 280;

/** The verdict on the student's own work, in the mascot's voice (never «Wrong»). */
const VERDICT = {
  correct: { tone: 'ok', label: 'Correct' },
  partly: { tone: 'warn', label: 'Almost' },
  wrong: { tone: 'danger', label: 'Not quite' },
} as const;

/** The board's other AI tools — the buddy is the one door to all of them. */
const TOOLS = [
  { command: 'ai-lasso-once', label: 'Circle', title: 'Circle a part and ask about it', icon: Lasso },
  { command: 'ai-chat', label: 'Chat', title: 'Chat about this page', icon: MessagesSquare },
  { command: 'ai-generate', label: 'Create', title: 'Make something for this page', icon: WandSparkles },
  { command: 'ai-remake-page', label: 'Similar', title: 'Make a similar page', icon: CopyPlus },
] as const;

/** The panel's size, px — also the area the marks keep out of (it grows up from the button). */
const PANEL_W = 480;
const PANEL_MAX_H = 544;
/** The panel sits left of the board's right-edge buttons (pen shortcuts), the buddy's button stays at the edge. */
const PANEL_INSET = 56;
const panelSize = () => ({ w: Math.min(PANEL_W, window.innerWidth - 88), h: Math.min(window.innerHeight * 0.7, PANEL_MAX_H) });

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
  const [notes, setNotes] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<'correct' | 'wrong' | 'partly' | null>(null);
  const [padEmpty, setPadEmpty] = useState(true);
  // The composer is one slot: the pen pad, or the keyboard box.
  const [keyboard, setKeyboard] = useState(false);
  // The pad's eraser: its own button, or the pen's side button while it is held.
  const [erasing, setErasing] = useState(false);
  const [penButton, setPenButton] = useState(false);
  const typingRef = useRef(false);
  const [turn, setTurn] = useState(0);
  const lastAskRef = useRef<{ text: string; shown?: string; image?: Blob } | null>(null);
  const padRef = useRef<InkCanvasHandle>(null);
  // Talking needs the voice add-on; without it the button is tap-only.
  const voiceOn = useVoiceAiEnabled();
  const pressRef = useRef<{ at: number; timer: number | null; talking: boolean } | null>(null);

  const origin = () => {
    const box = buttonRef.current?.getBoundingClientRect();

    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : undefined;
  };

  /** Where the answer box will sit (it grows up from the button): marks stay out from under it. */
  const panelArea = () => {
    const box = buttonRef.current?.getBoundingClientRect();

    if (!box) return undefined;

    const { w, h } = panelSize();

    // The panel hangs under the top bar, its right edge PANEL_INSET in from the screen's.
    const right = window.innerWidth - 12 - PANEL_INSET;

    return { x: right - w, y: box.bottom + 8, w, h };
  };

  const ask = useCallback((text: string, shown?: string, questionImage?: Blob) => {
    const clean = text.trim();

    if (!clean && !questionImage) return;

    setOpen(true);
    setTyping(false);
    setDraft('');
    setQuestion(shown ?? clean);
    setPadEmpty(true);
    setAnswer(null);
    setError(null);
    setMarks(0);
    setVerdict(null);
    setNotes([]);
    setTurn((value) => value + 1);
    lastAskRef.current = { text: clean, ...(shown ? { shown } : {}), ...(questionImage ? { image: questionImage } : {}) };
    setPhase('reading');
    requestBoardBuddy({ type: 'ask', question: clean, ...(origin() ? { origin: origin()! } : {}), ...(questionImage ? { questionImage } : {}), ...(panelArea() ? { avoid: panelArea()! } : {}) });
  }, []);

  /** The question written on the pad → a picture the tutor reads beside the page. */
  const askWritten = useCallback(() => {
    const b64 = padRef.current?.rasterize();

    if (!b64) return;

    const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));

    ask('', 'Your written question', new Blob([bytes], { type: 'image/png' }));
  }, [ask]);

  const dictation = useDictation((text) => ask(text), (message) => {
    setOpen(true);
    setError(message);
    setPhase('idle');
    // No voice here: offer the typing box straight away.
    setTyping(true);
  });

  typingRef.current = typing && open;

  // The pen's side button erases on the pad while held (the tablet reports it apart from the pen's touch).
  useEffect(() => {
    const onPen = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; buttonState?: number }>).detail;

      if (detail?.kind === 'motion' && typeof detail.buttonState === 'number') setPenButton((detail.buttonState & 32) !== 0);
    };

    window.addEventListener('wb-native-pen', onPen);

    return () => window.removeEventListener('wb-native-pen', onPen);
  }, []);

  // On screen: the pen button's long hold now talks to this buddy (elsewhere it stays a menu press).
  useEffect(() => registerBoardBuddy(), []);

  // The board's side of the turn.
  useEffect(() => {
    const onState = (event: Event) => {
      const state = (event as CustomEvent<BoardBuddyState>).detail;

      if (!state) return;

      if (state.phase === 'done') {
        setPhase('done');
        if (state.heard) setQuestion(state.heard);
        setAnswer(state.say?.trim() || (state.marks > 0 ? 'Look at the marks on your page.' : "I couldn't find anything to mark here."));
        setMarks(state.marks);
        setVerdict(state.verdict ?? null);
        setNotes(state.notes ?? []);
      } else if (state.phase === 'error') {
        setPhase('idle');
        setError(state.message);
      } else if (state.phase === 'cleared') {
        setMarks(0);
        // A turn that was cut off before it answered: never leave «Thinking…» on screen.
        setPhase((was) => (was === 'reading' || was === 'planning' || was === 'drawing' ? 'idle' : was));
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

      // With the pad open the side button is its eraser, not the microphone.
      if (active && typingRef.current) return;

      if (active && !voiceOn) {
        // No voice on this account: the hold opens the pad to write the question instead.
        setOpen(true);
        setError(null);
        setTyping(true);
      } else if (active) {
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
  }, [start, stop, voiceOn]);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const press = { at: Date.now(), timer: null as number | null, talking: false };

    if (voiceOn) press.timer = window.setTimeout(() => {
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
    setPhase('idle');
  };

  const busy = phase === 'reading' || phase === 'planning' || phase === 'drawing';
  const status = buddyStatusLine({ phase, dictation: dictation.state });
  const listening = dictation.state === 'recording';
  const canSend = keyboard ? draft.trim().length > 0 : !padEmpty;
  const send = () => (keyboard ? ask(draft) : askWritten());
  const retry = () => {
    const last = lastAskRef.current;

    if (last) ask(last.text, last.shown, last.image);
  };

  return (
    // One chip in the board's top bar (no floating button over the page); its panel drops down under the
    // bar, clear of the right-edge buttons. Positioned against the bar itself (the nearest positioned box).
    <>
      {open && (
        <Surface className='buddy-panel pointer-events-auto absolute right-14 top-full z-40 mt-2 flex max-h-[min(70vh,34rem)] w-[min(30rem,calc(100vw-5.5rem))] flex-col text-left'>
          <div className='flex items-center gap-2 py-1 pl-3 pr-1'>
            {answer && verdict && <Badge className='shrink-0' tone={VERDICT[verdict].tone}>{VERDICT[verdict].label}</Badge>}
            <span className={cn('min-w-0 flex-1 truncate text-sm font-semibold', status || !answer ? 'text-st-fg' : 'text-st-muted')} title={question || undefined}>
              {status ?? (answer || busy ? question : 'Study buddy')}
            </span>
            <ActionButton aria-label='Close' className='w-11 shrink-0 px-0' title='Close' variant='ghost' onClick={close}>
              <X className='h-4 w-4' />
            </ActionButton>
          </div>
          {error && (
            <div className='px-3 pb-3'>
              <ErrorNote message={error} onRetry={lastAskRef.current ? retry : undefined} />
            </div>
          )}
          {answer && (
            <div key={turn} className='buddy-fade scroll-shadow-y min-h-0 flex-1 overflow-y-auto px-3 pb-3'>
              <p className='text-st-fg whitespace-pre-wrap text-sm leading-snug'>{answer}</p>
              {notes.length > 0 && (
                <ul className='text-st-fg mt-1.5 list-disc space-y-0.5 pl-4 text-sm leading-snug'>
                  {notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {answer && !typing && (
            <div className='flex items-center gap-2 px-3 pb-3'>
              {marks > 0 && (
                <ActionButton variant='primary' onClick={() => requestBoardBuddy({ type: 'keep' })}>
                  <Check className='h-4 w-4' /> Keep on page
                </ActionButton>
              )}
              <ActionButton variant='ghost' onClick={() => setTyping(true)}>
                Ask more
              </ActionButton>
            </div>
          )}
          {/* How long the marks have left: a thin bar that runs out (they fade on their own). */}
          {marks > 0 && (
            <div aria-hidden className='bg-default-200 mx-3 mb-3 h-0.5 overflow-hidden rounded-full'>
              <div key={turn} className='buddy-bar bg-st-accent h-full origin-left' style={{ animationDuration: `${BOARD_BUDDY_MARKS_MS}ms` }} />
            </div>
          )}
          {typing && (
            <div className='flex flex-col gap-3 px-3 pb-3'>
              <div className='grid grid-cols-3 gap-2'>
                {BUDDY_QUICK_ASKS.map((quick, index) => (
                  <ActionButton key={quick.label} className='px-2' disabled={busy} variant={index === 0 ? 'primary' : 'secondary'} onClick={() => ask(quick.question, quick.label)}>
                    {quick.short}
                  </ActionButton>
                ))}
              </div>
              {keyboard ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    ask(draft);
                  }}
                >
                  <input aria-label='Your question' className={INPUT_CLASS} disabled={busy} placeholder='Type your question' value={draft} onChange={(event) => setDraft(event.target.value)} />
                </form>
              ) : (
                <InkCanvas
                  ref={padRef}
                  hideToolbar
                  disabled={busy}
                  frameClassName='rounded-st border-2 border-st-control-edge'
                  growable={false}
                  minHeight={200}
                  placeholder={voiceOn ? 'Write your question, or hold Ask to talk' : 'Write your question'}
                  tool={erasing || penButton ? 'eraser' : 'pen'}
                  onChange={setPadEmpty}
                />
              )}
              <div className='flex items-center gap-1'>
                {!keyboard && (
                  <>
                    <ActionButton aria-label='Undo' className='w-11 px-0' disabled={padEmpty} title='Undo the last stroke' variant='ghost' onClick={() => padRef.current?.undo()}>
                      <Undo2 className='h-4 w-4' />
                    </ActionButton>
                    <ActionButton
                      aria-label='Eraser'
                      aria-pressed={erasing}
                      className={cn('w-11 px-0', erasing && '!bg-st-accent-soft')}
                      title='Eraser: rub out strokes (or hold the pen button)'
                      variant='ghost'
                      onClick={() => setErasing((was) => !was)}
                    >
                      <Eraser className='h-4 w-4' />
                    </ActionButton>
                  </>
                )}
                <ActionButton
                  aria-label={keyboard ? 'Write with the pen' : 'Type with the keyboard'}
                  className='w-11 px-0'
                  title={keyboard ? 'Write with the pen' : 'Type with the keyboard'}
                  variant='ghost'
                  onClick={() => setKeyboard((was) => !was)}
                >
                  {keyboard ? <PenLine className='h-4 w-4' /> : <Keyboard className='h-4 w-4' />}
                </ActionButton>
                <span className='flex-1' />
                {canSend && (
                  <ActionButton disabled={busy} variant='primary' onClick={send}>
                    <Send className='h-4 w-4' /> Ask
                  </ActionButton>
                )}
              </div>
              <div className='border-default-200 grid grid-cols-4 gap-1 border-t pt-2'>
                {TOOLS.map((tool) => (
                  <ActionButton
                    key={tool.command}
                    className='flex-col gap-0.5 px-1 py-1 text-xs'
                    title={tool.title}
                    variant='ghost'
                    onClick={() => {
                      setOpen(false);
                      setTyping(false);
                      requestBoardBuddy({ type: 'clear' });
                      requestBoardAiCommand(tool.command);
                    }}
                  >
                    <tool.icon className='h-4 w-4' /> {tool.label}
                  </ActionButton>
                ))}
              </div>
            </div>
          )}
        </Surface>
      )}
      <span ref={buttonRef} className='pointer-events-auto relative inline-flex'>
        {listening && <span aria-hidden className='buddy-ring border-st-star-lip rounded-st pointer-events-none absolute inset-0 border-2' />}
        <ActionButton
          aria-busy={busy}
          aria-label={voiceOn ? 'Study buddy: hold to talk, tap for more' : 'Study buddy'}
          className={cn(BOARD_CHIP_OVERRIDE, 'select-none')}
          title={voiceOn ? 'Hold to talk, tap for more' : 'Ask about this page'}
          variant={listening ? 'accent' : 'primary'}
          onContextMenu={(event) => event.preventDefault()}
          onPointerCancel={() => endPress(true)}
          onPointerDown={onPointerDown}
          onPointerUp={() => endPress(false)}
        >
          {listening ? (
            <Mic className='h-3.5 w-3.5' />
          ) : (
            // Thinking: the pencil rocks. Drawing: it is out on the page.
            <Pencil className={cn('h-3.5 w-3.5', phase === 'drawing' ? 'opacity-0' : busy && 'buddy-rock')} />
          )}{' '}
          <span data-chip-label>Ask</span>
        </ActionButton>
      </span>
    </>
  );
}
