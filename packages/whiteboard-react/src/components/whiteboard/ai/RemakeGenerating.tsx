import React, { useEffect, useRef, useState } from 'react';

import { ArrowLeft, X } from 'lucide-react';

import { GlowRenderer, glowScale } from './glowShader';
import { BOARD_TEXT_FONT, ensureBoardFonts } from './rasterize';
import { draftProgress } from './remakeDraft';
import { remakeOrbState, remakeStatusText } from './generatingState';
import { RemakeOrb } from './RemakeOrb';

import type { RemakeDraft } from './remakeDraft';
import { useWbStrings } from '../../../i18n/context';

/**
 * The generating state of the «Similar copy» draft page, over the whole board: the edge glow and the
 * centred status card (orb + the current step + elapsed time + a way out). The dissolve itself is
 * RemakeDissolveOverlay, under both.
 */

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches));

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');

    if (!query) return;

    const update = () => setReduced(query.matches);

    query.addEventListener?.('change', update);

    return () => query.removeEventListener?.('change', update);
  }, []);

  return reduced;
}

export function useElapsedSeconds(since: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());

    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [since]);

  return Math.max(0, Math.floor((now - since) / 1000));
}

// ---------------------------------------------------------------------------
// Glow
// ---------------------------------------------------------------------------

/** Pulse (ms) then fade (ms) when the result lands. */
export const GLOW_PULSE_MS = 520;
export const GLOW_FADE_MS = 520;
const GLOW_FRAME_MS = 1000 / 30;

/**
 * The brand glow hugging the board's edges. WebGL at half resolution and ~30 fps, paused while the
 * tab is hidden; under reduced motion (or without WebGL) a static soft gradient border instead.
 * `finishing` = the result landed: one pulse, then it fades out.
 */
export function RemakeBoardGlow({ finishing, frozenTime }: { finishing: boolean; /** Test hook: a fixed clock (screenshots). */ frozenTime?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [shown, setShown] = useState(false);
  const finishingRef = useRef(finishing);

  finishingRef.current = finishing;

  // Fade in on mount (one frame later, so the transition runs).
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));

    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (reduced || !canvas) {
      setWebgl(false);

      return;
    }

    let renderer: GlowRenderer | null = null;

    try {
      renderer = GlowRenderer.create(canvas);
    } catch {
      renderer = null;
    }

    setWebgl(Boolean(renderer));

    if (!renderer) return;

    let frame: number | null = null;
    let last = 0;
    let finishStart: number | null = null;
    const start = performance.now();

    const step = (now: number) => {
      frame = null;

      if (document.visibilityState === 'hidden') return;

      if (now - last >= GLOW_FRAME_MS - 2) {
        last = now;

        let pulse = 0;

        if (finishingRef.current) {
          finishStart ??= now;
          pulse = Math.sin(Math.PI * Math.min(1, (now - finishStart) / GLOW_PULSE_MS));
        }

        if (!renderer!.isLost()) {
          const scale = glowScale(window.devicePixelRatio);
          const width = Math.max(1, Math.round(canvas.clientWidth * scale));
          const height = Math.max(1, Math.round(canvas.clientHeight * scale));

          renderer!.render(width, height, scale, frozenTime ?? ((now - start) / 1000) % 600, pulse);
        }
      }

      frame = requestAnimationFrame(step);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && frame === null) frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
      renderer?.dispose();
    };
  }, [reduced, frozenTime]);

  const opacity = !shown ? 0 : finishing ? 0 : 1;
  // The fade waits for the pulse; coming in is quick.
  const transition = finishing ? `opacity ${GLOW_FADE_MS}ms ease-out ${Math.round(GLOW_PULSE_MS * 0.6)}ms` : 'opacity 400ms ease-out';

  return (
    <div aria-hidden className='pointer-events-none absolute inset-0 z-[17]' data-remake-glow={webgl ? 'webgl' : 'css'} style={{ opacity, transition }}>
      <canvas ref={canvasRef} className='absolute inset-0 h-full w-full' style={{ display: webgl === false ? 'none' : 'block' }} />
      {webgl === false ? (
        // Static: a thin brand-gradient rim with a soft inner wash. No motion, no filters.
        <div
          className='absolute inset-0'
          style={{
            border: '3px solid transparent',
            borderImage: 'linear-gradient(120deg, #2f5bea, #6e8cff, #ec4899, #006fee) 1',
            boxShadow: 'inset 0 0 28px rgba(147, 83, 211, 0.32), inset 0 0 64px rgba(236, 72, 153, 0.12)',
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step text: top → down, blurred out / blurred in
// ---------------------------------------------------------------------------

export const STEP_TRANSITION_MS = 350;

const STEP_STYLE_ID = 'wb-remake-step-style';

function ensureStepStyles() {
  if (typeof document === 'undefined' || document.getElementById(STEP_STYLE_ID)) return;

  const style = document.createElement('style');

  style.id = STEP_STYLE_ID;
  // Only a single short line is ever blurred — a small layer, cheap on Android.
  style.textContent = `
@keyframes wb-step-in { from { opacity: 0; transform: translateY(-75%); filter: blur(6px); } to { opacity: 1; transform: translateY(0); filter: blur(0); } }
@keyframes wb-step-out { from { opacity: 1; transform: translateY(0); filter: blur(0); } to { opacity: 0; transform: translateY(75%); filter: blur(6px); } }
@keyframes wb-step-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes wb-step-fade-out { from { opacity: 1; } to { opacity: 0; } }
.wb-step-clip { overflow: hidden; padding-block: 6px; margin-block: -6px; -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 6px, #000 calc(100% - 6px), transparent 100%); mask-image: linear-gradient(to bottom, transparent 0, #000 6px, #000 calc(100% - 6px), transparent 100%); box-sizing: content-box; }
.wb-step-line { position: absolute; inset-inline: 0; top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; will-change: transform, opacity, filter; }
.wb-step-in { animation: wb-step-in ${STEP_TRANSITION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both; }
.wb-step-out { animation: wb-step-out ${STEP_TRANSITION_MS}ms cubic-bezier(0.55, 0, 0.75, 0.3) both; }
@media (prefers-reduced-motion: reduce) {
  .wb-step-in { animation: wb-step-fade-in 200ms ease-out both; }
  .wb-step-out { animation: wb-step-fade-out 200ms ease-out both; }
}`;
  document.head.appendChild(style);
}

interface StepLine {
  id: number;
  text: string;
  leaving: boolean;
}

/** One line of text; a new value pushes the old one down and out (blurring) while it drops in from above. */
export function StepText({ text, className, style }: { text: string; className?: string; style?: React.CSSProperties }) {
  const [lines, setLines] = useState<StepLine[]>(() => [{ id: 0, text, leaving: false }]);
  const idRef = useRef(0);

  useEffect(ensureStepStyles, []);

  useEffect(() => {
    setLines((current) => {
      const live = current.find((line) => !line.leaving);

      if (live?.text === text) return current;

      idRef.current += 1;

      return [...current.filter((line) => !line.leaving).map((line) => ({ ...line, leaving: true })), { id: idRef.current, text, leaving: false }];
    });

    // Normally the old line leaves on its own `animationend`; this is the backstop (a throttled tab).
    const timer = setTimeout(() => setLines((current) => current.filter((line) => !line.leaving)), STEP_TRANSITION_MS * 4);

    return () => clearTimeout(timer);
  }, [text]);

  const drop = (id: number) => setLines((current) => current.filter((line) => line.id !== id || !line.leaving));

  return (
    <div aria-live='polite' className={`wb-step-clip relative ${className ?? ''}`} style={{ height: '1.6em', ...style }}>
      {lines.map((line, index) => (
        <span
          key={line.id}
          aria-hidden={line.leaving || undefined}
          className={`wb-step-line ${line.leaving ? 'wb-step-out' : index === 0 && lines.length === 1 && line.id === 0 ? '' : 'wb-step-in'}`}
          data-step-line={line.leaving ? 'out' : 'in'}
          onAnimationEnd={line.leaving ? () => drop(line.id) : undefined}
        >
          {line.text}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status card
// ---------------------------------------------------------------------------

export interface RemakeStatusCardProps {
  draft: RemakeDraft;
  statusLine: string | null;
  onCancel: () => void;
  /** Back to the page being copied; generation keeps going (a toast says when it is ready). */
  onBack: (() => void) | null;
}

/**
 * Centred over the board: the orb (stage → animation), the current step, elapsed seconds and the
 * expected wait, «Cancel» and «Back to the original page». On the finishing reveal the orb settles into
 * «breathing» and the card fades away; the review card replaces it.
 */
export function RemakeStatusCard({ draft, statusLine, onCancel, onBack }: RemakeStatusCardProps) {
  const { t, dir } = useWbStrings();
  const elapsed = useElapsedSeconds(draft.startedAt);
  const finishing = draft.phase !== 'generating';
  const [shown, setShown] = useState(false);
  const [progress, setProgress] = useState(() => draftProgress(draft, Date.now()));
  const draftRef = useRef(draft);

  draftRef.current = draft;

  useEffect(() => {
    void ensureBoardFonts();

    const frame = requestAnimationFrame(() => setShown(true));

    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (finishing) {
      setProgress(1);

      return;
    }

    const update = () => setProgress(draftProgress(draftRef.current, Date.now()));

    update();

    const timer = setInterval(update, 500);

    return () => clearInterval(timer);
  }, [finishing]);

  const orb = remakeOrbState(draft);
  const text = finishing ? t('ai.draft.ready') : remakeStatusText(draft, statusLine);
  const visible = shown && !finishing;

  return (
    <div className='pointer-events-none absolute inset-0 z-[18] flex items-center justify-center px-4' dir={dir}>
      <div
        aria-busy={!finishing}
        aria-label={t('ai.gen.remaking')}
        className='border-sk border-ink bg-paper text-ink shadow-sk pointer-events-auto w-full max-w-[22rem] rounded-2xl px-4 pb-3 pt-4'
        data-remake-status
        role='status'
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0) scale(1)' : finishing ? 'scale(0.96)' : 'translateY(8px) scale(0.98)',
          // Finishing: the orb breathes for a beat before the card goes.
          transition: finishing ? 'opacity 380ms ease-in 650ms, transform 380ms ease-in 650ms' : 'opacity 240ms ease-out, transform 240ms ease-out',
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className='flex items-center gap-3'>
          <div className='flex h-16 w-16 shrink-0 items-center justify-center'>
            <RemakeOrb size={64} state={orb} />
          </div>
          <div className='min-w-0 flex-1'>
            <StepText className='text-sm leading-[1.6]' style={{ fontFamily: BOARD_TEXT_FONT, fontWeight: 500 }} text={text} />
            <p className='text-ink/60 mt-0.5 text-[11px]' style={{ fontFamily: BOARD_TEXT_FONT }}>
              <span className='tabular-nums' data-remake-elapsed>
                {t('ai.seconds', { n: elapsed })}
              </span>
              <span aria-hidden> · </span>
              {t('ai.gen.takesMinutes')}
            </p>
          </div>
        </div>

        <div aria-hidden className='bg-ink/10 mt-3 h-1 overflow-hidden rounded-full'>
          <div
            className='h-full rounded-full transition-[width] duration-500'
            style={{ width: `${Math.round(progress * 100)}%`, background: 'linear-gradient(90deg, #006fee, #ec4899, #6e8cff, #2f5bea)' }}
          />
        </div>

        <div className='mt-2.5 flex items-center justify-between gap-2'>
          {onBack ? (
            <button className='text-ink/70 hover:text-ink flex items-center gap-1 rounded-lg px-1 py-1 text-[11px] font-semibold' disabled={finishing} type='button' onClick={onBack}>
              <ArrowLeft aria-hidden className='h-3.5 w-3.5' />
              {t('ai.gen.backToOriginal')}
            </button>
          ) : (
            <span />
          )}
          <button
            className='border-ink/20 hover:bg-ink/5 flex shrink-0 items-center gap-1 rounded-xl border px-2.5 py-1 text-[11px] font-semibold'
            disabled={finishing}
            type='button'
            onClick={onCancel}
          >
            <X aria-hidden className='h-3.5 w-3.5' />
            {t('ai.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
