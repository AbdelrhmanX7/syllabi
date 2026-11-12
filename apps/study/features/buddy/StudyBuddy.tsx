// The study buddy: a small helper that floats over a notebook page or PDF. Hold it (or hold the pen
// button in the air) and ask out loud; let go and it looks at the page, points at the spot and marks
// it up for a little while, with a short written answer beside it. A quick tap opens a box to type
// instead (the tablet has no voice engine without a server). «Keep» turns the marks into ink.
//
// The board does the looking and drawing (`requestBoardBuddy` in @repo/whiteboard-react); this file
// is only the floating button, the voice, and the answer bubble.
import type { BoardBuddyState, PenQuiz, PenSimilar, PenTraceStep } from '@repo/whiteboard-react';
import type { InkCanvasHandle } from '@/features/bank';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BOARD_BUDDY_STATE_EVENT,
  BOARD_BUDDY_TALK_EVENT,
  registerBoardBuddy,
  requestBoardAiCommand,
  requestBoardBuddy,
  ThinkingOrbMark,
} from '@repo/whiteboard-react';
import { cn } from '@repo/ui';
import { Check, ChevronDown, CopyPlus, Eraser, FilePlus2, Keyboard, Lasso, MessagesSquare, Mic, Pencil, PenLine, Send, ThumbsDown, ThumbsUp, Undo2, WandSparkles, X } from 'lucide-react';

import { useBuddyExperts } from './api';
import { BUDDY_LINE_MS, BUDDY_QUICK_ASKS, buddyStatus, buddyStatusLine, type BuddyPhase } from './status';

import { ActionButton, Badge, BOARD_CHIP_OVERRIDE, ErrorNote, INPUT_CLASS, Surface } from '@/components/ui/primitives';
import { InkCanvas, Markdown } from '@/features/bank';
import { isMockRoute } from '@/lib/api/client';
import { studyPost } from '@/lib/api/http';
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
  { command: 'ai-remake-page', label: 'Remake', title: 'Make a similar copy of this whole page', icon: CopyPlus },
] as const;

/** A model id as people say it: «claude-sonnet-5-5», not «anthropic/claude-sonnet-5-5». */
const modelName = (model: string) => model.split('/').pop() ?? model;

/** One line for the closed «How I answered» row: the expert, the model that answered, the time it took. */
function traceLine(trace: PenTraceStep[]): string {
  const expert = trace.find((step) => step.kind === 'expert');
  const total = trace.reduce((sum, step) => sum + step.ms, 0);
  const model = expert?.models.length ? modelName(expert.models[expert.models.length - 1]!) : null;

  return [expert?.name ?? trace[0]?.name, model, total > 0 ? `${(total / 1000).toFixed(1)}s` : null].filter(Boolean).join(' · ');
}

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
  const [steps, setSteps] = useState<string[]>([]);
  // The experts' extras: a quick check, a practice question, and how the answer was made.
  const [quiz, setQuiz] = useState<PenQuiz | null>(null);
  const [quizPick, setQuizPick] = useState<number | null>(null);
  const [similar, setSimilar] = useState<PenSimilar | null>(null);
  const [trace, setTrace] = useState<PenTraceStep[]>([]);
  const [showTrace, setShowTrace] = useState(false);
  const [turnId, setTurnId] = useState<string | null>(null);
  const [rating, setRating] = useState<'up' | 'down' | null>(null);
  const [wrote, setWrote] = useState(false);
  const [skill, setSkill] = useState<string | null>(null);
  // Custom AI: a switched-off expert loses its button; the student's own experts get one each.
  const experts = useBuddyExperts().data;
  const off = new Set((experts ?? []).filter((expert) => !expert.enabled).map((expert) => expert.id));
  const quickAsks = BUDDY_QUICK_ASKS.filter((quick) => !off.has(quick.skill));
  const ownExperts = (experts ?? []).filter((expert) => expert.origin === 'custom' && expert.enabled);
  const [verdict, setVerdict] = useState<'correct' | 'wrong' | 'partly' | null>(null);
  const [padEmpty, setPadEmpty] = useState(true);
  // The composer is one slot: the pen pad, or the keyboard box.
  const [keyboard, setKeyboard] = useState(false);
  // The pad's eraser: its own button, or the pen's side button while it is held.
  const [erasing, setErasing] = useState(false);
  const [penButton, setPenButton] = useState(false);
  const typingRef = useRef(false);
  const [turn, setTurn] = useState(0);
  const [tick, setTick] = useState(0);
  const lastAskRef = useRef<{ text: string; shown?: string; image?: Blob; skill?: string } | null>(null);
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

  const ask = useCallback((text: string, shown?: string, questionImage?: Blob, expert?: string) => {
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
    setSteps([]);
    setQuiz(null);
    setQuizPick(null);
    setSimilar(null);
    setTrace([]);
    setShowTrace(false);
    setTurnId(null);
    setRating(null);
    setWrote(false);
    setSkill(expert ?? null);
    setTurn((value) => value + 1);
    lastAskRef.current = { text: clean, ...(shown ? { shown } : {}), ...(questionImage ? { image: questionImage } : {}), ...(expert ? { skill: expert } : {}) };
    setPhase('reading');
    requestBoardBuddy({ type: 'ask', question: clean, ...(origin() ? { origin: origin()! } : {}), ...(questionImage ? { questionImage } : {}), ...(panelArea() ? { avoid: panelArea()! } : {}), ...(expert ? { skill: expert } : {}) });
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
    // Like the board: HELD while the pen writes = erase for as long as it is held; a quick press in the
    // air = switch between pen and eraser (so a button that is simply clicked works too).
    let pressedAt = 0;
    let touched = false;
    const onPen = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; buttonState?: number; contact?: boolean }>).detail;

      if (detail?.kind !== 'motion' || typeof detail.buttonState !== 'number') return;

      const held = (detail.buttonState & 32) !== 0;

      if (held && pressedAt === 0) {
        pressedAt = Date.now();
        touched = false;
      }
      if (held && detail.contact) touched = true;

      if (!held && pressedAt !== 0) {
        const quick = Date.now() - pressedAt < 400;

        pressedAt = 0;
        if (quick && !touched && typingRef.current) setErasing((was) => !was);
      }

      setPenButton(held);
    };

    window.addEventListener('wb-native-pen', onPen);

    return () => window.removeEventListener('wb-native-pen', onPen);
  }, []);

  // While it thinks, the status line turns over every couple of seconds (see status.ts).
  useEffect(() => {
    setTick(0);
    if (phase !== 'planning') return;

    const id = window.setInterval(() => setTick((value) => value + 1), BUDDY_LINE_MS);

    return () => window.clearInterval(id);
  }, [phase]);

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
        setAnswer(
          state.say?.trim() ||
            (state.steps?.length ? 'Here it is, step by step.' : state.quiz ? 'Quick one to check the idea:' : state.similar ? 'Here is one to practise.' : state.marks > 0 ? 'Look at the marks on your page.' : "I couldn't find anything to mark here."),
        );
        setQuiz(state.quiz ?? null);
        setSimilar(state.similar ?? null);
        setTrace(state.trace ?? []);
        setTurnId(state.turnId ?? null);
        setWrote(Boolean(state.wrote));
        if (state.skill) setSkill(state.skill);
        setMarks(state.marks);
        setVerdict(state.verdict ?? null);
        setNotes(state.notes ?? []);
        setSteps(state.steps ?? []);
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

  /** The first tap counts: it shows which answer is right, and tells the server (it joins the buddy's memory). */
  const answerQuiz = (choice: number) => {
    if (quizPick !== null) return;

    setQuizPick(choice);
    if (turnId && !isMockRoute('/ai/buddy/turns', 'POST')) void studyPost(`/ai/buddy/turns/${turnId}/quiz`, { choice }).catch(() => undefined);
  };

  /** Thumbs up / down on this answer (tap the same one again to take it back). */
  const rate = (value: 'up' | 'down') => {
    const next = rating === value ? null : value;

    setRating(next);
    if (turnId && !isMockRoute('/ai/buddy/turns', 'POST')) void studyPost(`/ai/buddy/turns/${turnId}/rating`, { rating: next }).catch(() => undefined);
  };
  const working = buddyStatus({ phase, dictation: dictation.state, tick });
  const status = buddyStatusLine({ phase, dictation: dictation.state, tick });
  const listening = dictation.state === 'recording';
  const canSend = keyboard ? draft.trim().length > 0 : !padEmpty;
  const send = () => (keyboard ? ask(draft) : askWritten());
  const retry = () => {
    const last = lastAskRef.current;

    if (last) ask(last.text, last.shown, last.image, last.skill);
  };

  return (
    // One chip in the board's top bar (no floating button over the page); its panel drops down under the
    // bar, clear of the right-edge buttons. Positioned against the bar itself (the nearest positioned box).
    <>
      {open && (
        <Surface className='buddy-panel pointer-events-auto absolute right-14 top-full z-40 mt-2 flex max-h-[min(70vh,34rem)] w-[min(30rem,calc(100vw-5.5rem))] flex-col text-left'>
          <div className='flex items-center gap-2 py-1 pl-3 pr-1'>
            {answer && verdict && <Badge className='shrink-0' tone={VERDICT[verdict].tone}>{VERDICT[verdict].label}</Badge>}
            {/* Working: the orb moves in the step's own way, and the line under it changes with each step. */}
            {working && <ThinkingOrbMark className='shrink-0' size={20} state={working.orb} />}
            <span
              key={working ? working.line : 'rest'}
              className={cn('min-w-0 flex-1 truncate text-sm font-semibold', working && 'buddy-line', status || !answer ? 'text-st-fg' : 'text-st-muted')}
              title={question || undefined}
            >
              {status ?? (answer || busy ? question : 'Study buddy')}
            </span>
            <ActionButton aria-label='Close' className='w-11 shrink-0 px-0' title='Close' variant='ghost' onClick={close}>
              <X className='h-4 w-4' />
            </ActionButton>
          </div>
          {busy && question && (
            <p className='text-st-muted truncate px-3 pb-3 text-xs' title={question}>
              {question}
            </p>
          )}
          {error && (
            <div className='px-3 pb-3'>
              <ErrorNote message={error} onRetry={lastAskRef.current ? retry : undefined} />
            </div>
          )}
          {answer && (
            <div key={turn} className='buddy-fade scroll-shadow-y min-h-0 flex-1 overflow-y-auto px-3 pb-3'>
              {/* Written on the page already: the panel only says so (it must not cover the writing with a copy). */}
              {wrote && steps.length === 0 ? (
                <p className='text-st-muted text-sm leading-snug' data-buddy-wrote>
                  I wrote the answer on your page.
                </p>
              ) : (
                <Markdown className='!text-sm !leading-snug' text={answer} />
              )}
              {/* «Solve»: the worked solution — on the page when there was room, else listed here. */}
              {steps.length > 0 &&
                (wrote ? (
                  <p className='text-st-muted mt-1 text-sm leading-snug' data-buddy-wrote>
                    The {steps.length} steps are written on your page.
                  </p>
                ) : (
                  <ol className='text-st-fg mt-1.5 list-decimal space-y-1 pl-5 text-sm leading-snug' data-buddy-steps>
                    {steps.map((step, index) => (
                      <li key={`${index}-${step}`}>
                        <Markdown className='!text-sm !leading-snug' text={step} />
                      </li>
                    ))}
                  </ol>
                ))}
              {/* «Quick check»: one question, four answers; a tap shows which is right and why. */}
              {quiz && (
                <div className='mt-2 flex flex-col gap-1.5' data-buddy-quiz>
                  <Markdown className='!text-sm !leading-snug font-semibold' text={quiz.question} />
                  {quiz.choices.map((choice, index) => {
                    const picked = quizPick !== null;
                    const right = index === quiz.answer;

                    return (
                      <button
                        key={`${index}-${choice}`}
                        className={cn(
                          'rounded-st flex min-h-11 items-center gap-2 border px-3 py-1.5 text-left text-sm',
                          !picked && 'border-st-control-edge text-st-fg',
                          picked && right && 'border-success-300 bg-success-50 text-success-800',
                          picked && !right && index === quizPick && 'border-danger-300 bg-danger-50 text-danger-800',
                          picked && !right && index !== quizPick && 'border-default-200 text-st-muted',
                        )}
                        disabled={picked}
                        type='button'
                        onClick={() => answerQuiz(index)}
                      >
                        <span className='shrink-0 font-semibold'>{'ABCDE'[index]}</span>
                        <Markdown className='!text-sm !leading-snug min-w-0 flex-1 !text-inherit' text={choice} />
                      </button>
                    );
                  })}
                  {quizPick !== null && (
                    <Markdown className='!text-sm !leading-snug' text={`**${quizPick === quiz.answer ? 'Yes!' : 'Almost.'}** ${quiz.why}`} />
                  )}
                </div>
              )}
              {/* «Similar question»: the new question, and a button that puts it on a new page. */}
              {similar && (
                <div className='border-default-200 mt-2 border-t pt-2' data-buddy-similar>
                  <p className='text-st-muted text-xs font-semibold'>{similar.title}</p>
                  <Markdown className='!text-sm !leading-snug' text={similar.markdown} />
                </div>
              )}
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
              {similar && (
                <ActionButton
                  variant='primary'
                  onClick={() => {
                    requestBoardBuddy({ type: 'page', title: similar.title, markdown: similar.markdown });
                    setOpen(false);
                  }}
                >
                  <FilePlus2 className='h-4 w-4' /> Put it on a new page
                </ActionButton>
              )}
              <ActionButton variant='ghost' onClick={() => setTyping(true)}>
                Ask more
              </ActionButton>
              {/* The marks stay as long as the student wants; this takes them off the page. */}
              {marks > 0 && (
                <ActionButton className='ml-auto' variant='ghost' onClick={() => requestBoardBuddy({ type: 'clear' })}>
                  Hide marks
                </ActionButton>
              )}
            </div>
          )}
          {/* What next, without typing: the other experts, one tap each. */}
          {answer && !typing && (
            <div className='flex flex-wrap items-center gap-2 px-3 pb-3' data-buddy-next>
              {quickAsks.filter((quick) => ['solve', 'similar', 'quiz'].includes(quick.skill) && quick.skill !== skill).map((quick) => (
                <ActionButton key={quick.skill} className='px-3' variant='secondary' onClick={() => ask(quick.question, quick.label, undefined, quick.skill)}>
                  {quick.label}
                </ActionButton>
              ))}
            </div>
          )}
          {/* How this answer was made: which expert, what it read, which model — and a thumbs up or down. */}
          {answer && !typing && trace.length > 0 && (
            <div className='border-default-200 text-st-muted border-t px-3 py-1.5 text-xs' data-buddy-trace>
              <div className='flex items-center gap-1'>
                <button className='flex min-h-9 min-w-0 flex-1 items-center gap-1 text-left' type='button' onClick={() => setShowTrace((value) => !value)}>
                  <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', showTrace && 'rotate-180')} />
                  <span className='truncate'>How I answered: {traceLine(trace)}</span>
                </button>
                <ActionButton aria-label='Good answer' className={cn('w-9 px-0', rating === 'up' && 'text-success-600')} title='Good answer' variant='ghost' onClick={() => rate('up')}>
                  <ThumbsUp className='h-4 w-4' />
                </ActionButton>
                <ActionButton aria-label='Bad answer' className={cn('w-9 px-0', rating === 'down' && 'text-danger-600')} title='Bad answer' variant='ghost' onClick={() => rate('down')}>
                  <ThumbsDown className='h-4 w-4' />
                </ActionButton>
              </div>
              {showTrace && (
                <ol className='mt-1 space-y-1 pb-1'>
                  {trace.map((step, index) => (
                    <li key={`${index}-${step.kind}`} className='leading-snug'>
                      <span className='text-st-fg font-semibold'>{step.name}</span>
                      {step.models.length > 0 && <span> · {step.models.map(modelName).join(', ')}</span>}
                      {step.ms > 0 && <span> · {(step.ms / 1000).toFixed(1)}s</span>}
                      <span className='block'>{step.detail}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {typing && (
            <div className='flex flex-col gap-3 px-3 pb-3'>
              <div className='grid gap-1.5' style={{ gridTemplateColumns: `repeat(${Math.max(1, quickAsks.length)}, minmax(0, 1fr))` }}>
                {quickAsks.map((quick, index) => (
                  <ActionButton key={quick.label} className='px-1 text-sm' disabled={busy} title={quick.label} variant={index === 0 ? 'primary' : 'secondary'} onClick={() => ask(quick.question, quick.label, undefined, quick.skill)}>
                    {quick.short}
                  </ActionButton>
                ))}
              </div>
              {ownExperts.length > 0 && (
                <div className='flex flex-wrap gap-2' data-buddy-own>
                  {ownExperts.map((expert) => (
                    <ActionButton key={expert.id} className='px-3 text-sm' disabled={busy} title={expert.when} variant='secondary' onClick={() => ask(`Use the ${expert.name} expert on this page.`, expert.name, undefined, expert.id)}>
                      {expert.name}
                    </ActionButton>
                  ))}
                </div>
              )}
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
