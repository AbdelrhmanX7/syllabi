import React, { useEffect, useRef, useState } from 'react';

import { Loader2, RotateCcw, Trash2, X, Check, CopyPlus } from 'lucide-react';

import { RemakeAnswers } from './BoardAiPanel';
import { DissolveRenderer } from './dissolveShader';
import { draftProgress, finishingProgress, REMAKE_FADE_MS, REMAKE_PULSE_MS, REMAKE_REVEAL_MS } from './remakeDraft';
import { usePrefersReducedMotion } from './RemakeGenerating';

import type { UvRect } from './dissolveShader';
import type { RemakeDraft } from './remakeDraft';
import type { RemakeImageResult } from './types';
import { useWbStrings } from '../../../i18n/context';

/** A picture the overlay can show, with its natural size. */
export interface DraftPicture {
  source: HTMLCanvasElement | HTMLImageElement | ImageBitmap;
  width: number;
  height: number;
  /** A URL for the CSS fallback (reduced motion / no WebGL). */
  url: string;
}

/**
 * The original page, soft: downscaled (bilinear upsampling then blurs it for free), blurred where
 * the canvas supports `filter`, and washed toward paper so the dissolve reads as "being redrawn".
 */
export function makeSoftSnapshot(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const targetWidth = Math.max(1, Math.min(480, width));
  const scale = targetWidth / Math.max(1, width);
  const canvas = document.createElement('canvas');

  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext('2d');

  if (!context) return canvas;

  context.fillStyle = '#fbfaf6';
  context.fillRect(0, 0, canvas.width, canvas.height);

  if ('filter' in context) context.filter = 'blur(2.5px)';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  if ('filter' in context) context.filter = 'none';
  context.globalAlpha = 0.3;
  context.fillStyle = '#f1eee4';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalAlpha = 1;

  return canvas;
}

/** The page opens width-filled and scrolled to its top (see appendImagePages): its rect in the overlay. */
export function pageUvRect(picture: { width: number; height: number } | null, overlay: { width: number; height: number }): UvRect {
  if (!picture || overlay.width <= 0 || overlay.height <= 0) return [0, 0, 1, 1];

  const heightPx = (overlay.width * picture.height) / Math.max(1, picture.width);

  return [0, 0, 1, heightPx / overlay.height];
}

const MAX_DPR = 1.5;

/** How far the new page's front runs on the questions-only preview (the picture is still coming). */
export const PREVIEW_FINAL_PROGRESS = 0.6;

export interface RemakeDissolveOverlayProps {
  draft: RemakeDraft;
  /** The blurred original — what the first front reveals while generating. */
  content: DraftPicture | null;
  /**
   * What the second front reveals: the real new page once the result exists — or, after a streamed
   * `questions` frame, the new text over the blurred original (the front then stops part-way).
   */
  next: DraftPicture | null;
  style: React.CSSProperties;
  /** The finishing reveal (or its reduced-motion stand-in) is over; the overlay can go. */
  onRevealed: () => void;
  /** Test hook: a fixed progress instead of the live clock (the screenshot harness). */
  frozenProgress?: number;
}

/**
 * The «AI Dissolve» generating overlay of the draft page. Opaque, so it covers whatever the page
 * holds underneath; only ever mounted while the draft page is the one on screen. The status card and
 * the board glow are RemakeGenerating's, on top of it.
 */
export function RemakeDissolveOverlay({ draft, content, next, style, onRevealed, frozenProgress }: RemakeDissolveOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<DissolveRenderer | null>(null);
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [fading, setFading] = useState(false);
  const [barProgress, setBarProgress] = useState(0);
  const reduced = usePrefersReducedMotion();
  const revealing = draft.phase === 'revealing';
  const draftRef = useRef(draft);
  const revealedRef = useRef(onRevealed);
  const hasNextRef = useRef(Boolean(next));

  draftRef.current = draft;
  revealedRef.current = onRevealed;
  hasNextRef.current = Boolean(next);

  // One WebGL context per overlay; none at all under reduced motion.
  useEffect(() => {
    const canvas = canvasRef.current;

    if (reduced || !canvas) {
      setWebgl(false);

      return;
    }

    const renderer = DissolveRenderer.create(canvas);

    rendererRef.current = renderer;
    setWebgl(Boolean(renderer));

    return () => {
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, [reduced]);

  // Textures follow the pictures; their rect follows the overlay's size.
  useEffect(() => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;

    if (!renderer || !canvas) return;

    const box = { width: canvas.clientWidth, height: canvas.clientHeight };

    renderer.setContent(content?.source ?? null, pageUvRect(content, box));
    renderer.setNext(next?.source ?? null, pageUvRect(next, box));
  }, [content, next, webgl]);

  // The frame loop: runs only while the tab is visible; the clock is paused, not skipped, when hidden.
  useEffect(() => {
    let frame: number | null = null;
    let displayed = frozenProgress ?? 0;
    let displayedFinal = 0;
    let last = performance.now();
    let revealStart: number | null = null;
    let revealFrom = 0;
    let revealFinalFrom = 0;
    let finished = false;
    let barTick = 0;
    const clockStart = performance.now();

    const finish = () => {
      if (finished) return;
      finished = true;
      setFading(true);
      setTimeout(() => revealedRef.current(), REMAKE_FADE_MS);
    };

    const step = (now: number) => {
      frame = null;

      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      const dt = Math.min(0.1, (now - last) / 1000);
      const current = draftRef.current;
      let progress = displayed;
      let finalProgress = 0;
      let pulse = 0;

      last = now;

      if (current.phase === 'revealing') {
        if (revealStart === null) {
          revealStart = now;
          revealFrom = displayed;
          revealFinalFrom = displayedFinal;
        }

        const t = now - revealStart;

        progress = finishingProgress(revealFrom, t, REMAKE_REVEAL_MS);
        finalProgress = revealFinalFrom + (1 - revealFinalFrom) * Math.min(1, t / REMAKE_REVEAL_MS);

        if (t > REMAKE_REVEAL_MS) {
          const k = Math.min(1, (t - REMAKE_REVEAL_MS) / REMAKE_PULSE_MS);

          pulse = Math.sin(Math.PI * k);

          if (k >= 1) finish();
        }
      } else {
        const target = frozenProgress ?? draftProgress(current, Date.now());

        // Chase the target instead of jumping to it when a new stage starts.
        displayed += (target - displayed) * Math.min(1, dt * 1.6);
        progress = displayed;

        // Questions-only preview: the new text front runs part-way and waits for the picture.
        const finalTarget = current.questionsReady && hasNextRef.current ? PREVIEW_FINAL_PROGRESS : 0;

        displayedFinal += (finalTarget - displayedFinal) * Math.min(1, dt * 1.2);
        finalProgress = displayedFinal;
      }

      const canvas = canvasRef.current;
      const renderer = rendererRef.current;

      if (canvas && renderer && !renderer.isLost()) {
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const height = Math.max(1, Math.round(canvas.clientHeight * dpr));

        // Wrapped so float precision never degrades on a long run.
        renderer.render(width, height, { time: ((now - clockStart) / 1000) % 600, progress, finalProgress, pulse });
      }

      if ((barTick += 1) % 6 === 0) setBarProgress(current.phase === 'revealing' ? 1 : progress);

      if (!finished) frame = requestAnimationFrame(step);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && frame === null && !finished) {
        last = performance.now();
        frame = requestAnimationFrame(step);
      }
    };

    if (webgl) {
      frame = requestAnimationFrame(step);
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [webgl, frozenProgress]);

  // No WebGL loop: a plain progress bar from the same pure clock, and a short hold on the result.
  useEffect(() => {
    if (webgl !== false) return;

    if (revealing) {
      setBarProgress(1);

      const timer = setTimeout(() => {
        setFading(true);
        setTimeout(() => revealedRef.current(), REMAKE_FADE_MS);
      }, reduced ? 350 : 700);

      return () => clearTimeout(timer);
    }

    const update = () => setBarProgress(frozenProgress ?? draftProgress(draftRef.current, Date.now()));

    update();

    const timer = setInterval(update, 500);

    return () => clearInterval(timer);
  }, [webgl, revealing, reduced, frozenProgress]);

  const shown = (revealing || draft.questionsReady) && next ? next : content;

  return (
    <div
      aria-hidden
      className='pointer-events-auto absolute overflow-hidden'
      data-remake-dissolve={webgl ? 'webgl' : 'css'}
      dir='ltr'
      style={{ ...style, background: '#fbfaf6', opacity: fading ? 0 : 1, transition: `opacity ${REMAKE_FADE_MS}ms ease-out` }}
      // The page under it is a placeholder: nothing to draw on, and no stroke may start through it.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <canvas ref={canvasRef} aria-hidden className='absolute inset-0 h-full w-full' style={{ display: webgl ? 'block' : 'none' }} />

      {webgl === false ? (
        <div aria-hidden className='absolute inset-0'>
          {shown ? (
            <img
              alt=''
              className='absolute left-0 top-0 w-full'
              src={shown.url}
              style={{
                filter: revealing ? 'none' : shown === next ? 'blur(1px)' : 'blur(6px)',
                opacity: revealing ? 1 : 0.35 + 0.5 * barProgress,
                transition: 'opacity 600ms ease, filter 600ms ease',
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface RemakeDraftReviewProps {
  result: RemakeImageResult;
  busy: boolean;
  onKeep: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  /** How far bottom-docked board chrome (the toolbar) reaches up, px — the card sits above it. */
  bottomInset?: number;
}

/** The draft's review card, docked at the bottom of its page — never drawn on the page itself. */
export function RemakeDraftReview({ result, busy, onKeep, onRetry, onDiscard, bottomInset = 0 }: RemakeDraftReviewProps) {
  const { t, dir } = useWbStrings();
  return (
    <div
      className='pointer-events-none absolute inset-x-0 bottom-0 z-[40] flex justify-center px-3 pb-[max(12px,env(safe-area-inset-bottom))]'
      style={bottomInset > 0 ? { paddingBottom: `max(${Math.round(bottomInset) + 10}px, env(safe-area-inset-bottom))`, transition: 'padding-bottom 200ms ease-out' } : undefined}
    >
      <div
        className='border-sk border-ink bg-paper text-ink shadow-sk pointer-events-auto max-h-[45dvh] w-full max-w-md space-y-2 overflow-y-auto rounded-2xl p-3'
        data-remake-review
        dir={dir}
        role='dialog'
        aria-label={t('ai.draft.aria')}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className='flex items-center gap-2'>
          <CopyPlus aria-hidden className='h-4 w-4' />
          <p className='flex-1 text-sm font-bold'>{t('ai.draft.title')}</p>
        </div>
        {/* A draft ALWAYS: the image model gets about one question per page wrong on its first pass,
            and «ok» has missed a one-dot misspelling (BE #557 live notes). */}
        {result.verification.ok ? (
          <p className='text-ink/65 text-[11px]'>{t('ai.draft.review')}</p>
        ) : (
          <div className='rounded-xl bg-[#e11d48]/10 px-2.5 py-2 text-xs leading-5'>
            <p className='text-ink font-semibold'>{t('ai.draft.typo')}</p>
            {result.verification.mismatches.length ? (
              <ul className='text-ink/75 list-disc ps-4'>
                {result.verification.mismatches.slice(0, 8).map((mismatch, index) => (
                  <li key={index}>{mismatch}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        <RemakeAnswers result={result} />
        <div className='border-ink/10 flex flex-wrap gap-1.5 border-t pt-2'>
          <button
            className='rounded-sk border-sk border-ink bg-citrine text-ink shadow-sk active:shadow-sk-pressed flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold disabled:opacity-50'
            disabled={busy}
            type='button'
            onClick={onKeep}
          >
            {busy ? <Loader2 aria-hidden className='h-3.5 w-3.5 animate-spin' /> : <Check aria-hidden className='h-3.5 w-3.5' />}
            {t('ai.draft.keep')}
          </button>
          <button className='border-ink/25 hover:bg-ink/5 flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold disabled:opacity-50' disabled={busy} type='button' onClick={onRetry}>
            <RotateCcw aria-hidden className='h-3.5 w-3.5' />
            {t('ai.draft.retry')}
          </button>
          <button className='border-ink/25 hover:bg-ink/5 flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold text-[#e11d48] disabled:opacity-50' disabled={busy} type='button' onClick={onDiscard}>
            <Trash2 aria-hidden className='h-3.5 w-3.5' />
            {t('ai.draft.discard')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** «The new page is ready» while the teacher is on another page. */
export function RemakeReadyToast({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  const { t, dir } = useWbStrings();
  return (
    <div className='pointer-events-none absolute inset-x-0 top-16 z-[41] flex justify-center px-4'>
      <div className='border-sk border-ink bg-paper text-ink shadow-sk pointer-events-auto flex items-center gap-2 rounded-full py-1 pe-1 ps-3 text-xs font-semibold' dir={dir} role='status'>
        {t('ai.draft.ready')}
        <button className='rounded-full bg-[#2f5bea] px-2.5 py-1 text-[11px] font-semibold text-white' type='button' onClick={onOpen}>
          {t('ai.draft.open')}
        </button>
        <button aria-label={t('focus.hide')} className='hover:bg-ink/5 rounded-full p-1' type='button' onClick={onDismiss}>
          <X aria-hidden className='h-3.5 w-3.5' />
        </button>
      </div>
    </div>
  );
}
