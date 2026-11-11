import type { InkStroke } from '../lib/ink';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ColorSwatch } from '@repo/ui';
import { Eraser, PenLine, Plus, Redo2, Trash2, Undo2 } from 'lucide-react';

import { drawStroke, eraseAt, isInkEmpty, rasterizeInk } from '../lib/ink';

/**
 * Pressure-sensitive pen canvas for working a problem out by hand.
 *
 * Input model (Galaxy Tab S9 Ultra + S Pen, also fine with a mouse):
 *   - `pointerType === 'pen'` draws; width follows pressure. The S Pen button (`buttons & 2`) or an
 *     eraser-mapped tip (`buttons & 32`) erases whole strokes while held.
 *   - `pointerType === 'touch'` never draws. A lone finger scrolls the nearest scroll container
 *     (the canvas is `touch-action: none` so the pen is never hijacked into a scroll); a touch that
 *     lands while the pen is down or within ~500 ms of lifting is a resting palm and is ignored.
 *   - `pointerType === 'mouse'` draws at a fixed mid pressure (desktop dev).
 *
 * Strokes live in a ref (a redraw per pointermove would be far too slow for React state); the
 * component only re-renders for toolbar state. Colours are stored as tokens so dark mode can resolve
 * them at draw time; `rasterize()` always paints black on white for the model.
 */

export type InkTool = 'pen' | 'eraser';
export type InkColor = 'ink' | 'blue' | 'red' | 'green';

export interface InkCanvasHandle {
  getStrokes: () => InkStroke[];
  setStrokes: (strokes: InkStroke[]) => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;
  isEmpty: () => boolean;
  /** Cropped PNG (base64, no prefix) or null when nothing was drawn. */
  rasterize: () => string | null;
}

export interface InkCanvasProps {
  /** Starting height in CSS px; the user can add more space. */
  minHeight?: number;
  className?: string;
  /** Fires when the canvas flips between empty and non-empty, and after every committed stroke. */
  onChange?: (empty: boolean) => void;
  disabled?: boolean;
  /** Hide the built-in tool strip (the host renders its own). */
  hideToolbar?: boolean;
  initialStrokes?: InkStroke[];
  /** Controlled tool (the host's own tool strip); the built-in strip keeps its own state otherwise. */
  tool?: InkTool;
  /** Hint drawn on an empty canvas; null hides it. */
  placeholder?: string | null;
  /** Show the «More space» button (default true). */
  growable?: boolean;
}

/** Most tablets report a frame's samples in line with the frame's own point; past this they're wrong. */
const MAX_FRAME_SHIFT_PX = 24;

const PALM_WINDOW_MS = 500;
const ERASER_RADIUS = 14;
const GROW_STEP = 260;
const PEN_WIDTH = 2.4;
const MAX_HISTORY = 100;

const COLOR_LIGHT: Record<InkColor, string> = { ink: '#18204A', blue: '#1d4ed8', red: '#be123c', green: '#047857' };
const COLOR_DARK: Record<InkColor, string> = { ink: '#F1EEE4', blue: '#93c5fd', red: '#fda4af', green: '#6ee7b7' };

export const isDarkMode = () =>
  typeof document !== 'undefined' &&
  (document.documentElement.classList.contains('dark') ||
    (!document.documentElement.classList.contains('light') &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches));

export const resolveColor = (token: string, dark: boolean) => (dark ? COLOR_DARK : COLOR_LIGHT)[token as InkColor] ?? token;

function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null;

  while (current) {
    const { overflowY } = getComputedStyle(current);

    if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) return current;
    current = current.parentElement;
  }

  return null;
}

export const InkCanvas = forwardRef<InkCanvasHandle, InkCanvasProps>(function InkCanvas(
  {
    minHeight = 440,
    className = '',
    onChange,
    disabled = false,
    hideToolbar = false,
    initialStrokes,
    tool: toolProp,
    placeholder = 'Work it out here with the pen…',
    growable = true,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const strokesRef = useRef<InkStroke[]>(initialStrokes ?? []);
  // Undo/redo: whole stroke lists (cheap — strokes are shared between them, never copied).
  const historyRef = useRef<InkStroke[][]>([]);
  const futureRef = useRef<InkStroke[][]>([]);
  // `recorded`: this erase gesture already has its undo step — one swipe is ONE undo, however many
  // pointermoves took strokes.
  const liveRef = useRef<{ pointerId: number; stroke: InkStroke; drawn: number; erasing: boolean; recorded?: boolean } | null>(
    null,
  );
  const scrollRef = useRef<{ pointerId: number; startY: number; startTop: number; target: HTMLElement | null } | null>(
    null,
  );
  const penActiveRef = useRef(0);
  const [ownTool, setTool] = useState<InkTool>('pen');
  const tool = toolProp ?? ownTool;
  const [color, setColor] = useState<InkColor>('ink');
  const [height, setHeight] = useState(minHeight);
  const [version, setVersion] = useState(0);
  const onChangeRef = useRef(onChange);

  onChangeRef.current = onChange;

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');

    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dark = isDarkMode();

    for (const stroke of strokesRef.current) drawStroke(ctx, { ...stroke, color: resolveColor(stroke.color, dark) });
    if (liveRef.current && !liveRef.current.erasing) {
      const live = liveRef.current.stroke;

      drawStroke(ctx, { ...live, color: resolveColor(live.color, dark) });
    }
  }, []);

  const bump = useCallback(() => {
    setVersion((v) => v + 1);
    onChangeRef.current?.(isInkEmpty(strokesRef.current));
  }, []);

  // Size the bitmap to the element × DPR; redraw after every resize.
  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      redraw();
    };

    fit();
    const observer = new ResizeObserver(fit);

    observer.observe(canvas);
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onTheme = () => redraw();

    media?.addEventListener?.('change', onTheme);
    const classWatch = new MutationObserver(onTheme);

    classWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', onTheme);
      classWatch.disconnect();
    };
  }, [redraw, height]);

  /** The list as it was before an action: one undo step; a new action drops the redo branch. */
  const record = useCallback((previous: InkStroke[]) => {
    historyRef.current.push(previous);
    if (historyRef.current.length > MAX_HISTORY) historyRef.current.shift();
    futureRef.current = [];
  }, []);

  const commit = useCallback(
    (next: InkStroke[]) => {
      record(strokesRef.current);
      strokesRef.current = next;
      redraw();
      bump();
    },
    [bump, record, redraw],
  );

  const undo = useCallback(() => {
    const previous = historyRef.current.pop();

    if (!previous) return;
    futureRef.current.push(strokesRef.current);
    strokesRef.current = previous;
    redraw();
    bump();
  }, [bump, redraw]);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();

    if (!next) return;
    historyRef.current.push(strokesRef.current);
    strokesRef.current = next;
    redraw();
    bump();
  }, [bump, redraw]);

  const clear = useCallback(() => {
    if (strokesRef.current.length) commit([]);
  }, [commit]);

  useImperativeHandle(
    ref,
    () => ({
      getStrokes: () => strokesRef.current,
      setStrokes: (strokes) => {
        strokesRef.current = strokes;
        historyRef.current = [];
        futureRef.current = [];
        redraw();
        bump();
      },
      clear,
      undo,
      redo,
      isEmpty: () => isInkEmpty(strokesRef.current),
      rasterize: () => rasterizeInk(strokesRef.current)?.b64 ?? null,
    }),
    [bump, clear, redraw, redo, undo],
  );

  const localPoint = (event: React.PointerEvent | PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();

    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const pressureOf = (event: { pointerType: string; pressure: number }) =>
    event.pointerType === 'pen' ? (event.pressure > 0 ? event.pressure : 0.5) : 0.5;

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const canvas = canvasRef.current!;

    if (event.pointerType === 'touch') {
      const penBusy = liveRef.current !== null || performance.now() - penActiveRef.current < PALM_WINDOW_MS;

      if (penBusy || scrollRef.current) return; // palm, or a second finger
      const target = findScrollParent(canvas);

      scrollRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startTop: target ? target.scrollTop : window.scrollY,
        target,
      };
      canvas.setPointerCapture(event.pointerId);

      return;
    }
    if (liveRef.current) return; // one pen at a time
    event.preventDefault();
    const erasing =
      tool === 'eraser' || (event.pointerType === 'pen' && (event.buttons & 32) !== 0) || (event.buttons & 2) !== 0;
    const point = localPoint(event);

    if (erasing) {
      liveRef.current = {
        pointerId: event.pointerId,
        stroke: { points: [], color, width: PEN_WIDTH },
        drawn: 0,
        erasing: true,
      };
      const next = eraseAt(strokesRef.current, point, ERASER_RADIUS);

      if (next !== strokesRef.current) {
        record(strokesRef.current);
        liveRef.current.recorded = true;
        strokesRef.current = next;
        redraw();
      }
    } else {
      liveRef.current = {
        pointerId: event.pointerId,
        stroke: { points: [{ ...point, p: pressureOf(event) }], color, width: PEN_WIDTH },
        drawn: 0,
        erasing: false,
      };
    }
    canvas.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const scroll = scrollRef.current;

    if (scroll && scroll.pointerId === event.pointerId) {
      const delta = event.clientY - scroll.startY;

      if (scroll.target) scroll.target.scrollTop = scroll.startTop - delta;
      else window.scrollTo({ top: scroll.startTop - delta });

      return;
    }
    const live = liveRef.current;

    if (!live || live.pointerId !== event.pointerId) return;
    event.preventDefault();
    const native = event.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
    const events = native.getCoalescedEvents?.() ?? [];
    const samples = events.length ? events : [native];
    // Some tablets (Galaxy Tab S9 Ultra) report a frame's in-between samples a few px off the frame's own
    // point, which zig-zags the line. Shift them so the frame's last sample lands on its own point.
    const anchor = localPoint(native);
    const lastSample = samples.length > 1 ? localPoint(samples[samples.length - 1]!) : anchor;
    const shiftX = anchor.x - lastSample.x;
    const shiftY = anchor.y - lastSample.y;
    const shift = Math.hypot(shiftX, shiftY) <= MAX_FRAME_SHIFT_PX ? { x: shiftX, y: shiftY } : null;
    const pointOf = (sample: PointerEvent) => {
      if (sample === native) return anchor;
      const point = localPoint(sample);

      return shift ? { x: point.x + shift.x, y: point.y + shift.y } : point;
    };

    if (live.erasing) {
      let current = strokesRef.current;

      for (const sample of samples) current = eraseAt(current, pointOf(sample), ERASER_RADIUS);

      if (current !== strokesRef.current) {
        if (!live.recorded) {
          record(strokesRef.current);
          live.recorded = true;
        }
        strokesRef.current = current;
        redraw();
      }

      return;
    }
    // An absurd offset means the in-between samples can't be trusted: the frame's own point only.
    for (const sample of shift ? samples : [native]) {
      const point = pointOf(sample);
      const last = live.stroke.points[live.stroke.points.length - 1];

      if (last && Math.abs(last.x - point.x) < 0.4 && Math.abs(last.y - point.y) < 0.4) continue;
      live.stroke.points.push({ ...point, p: pressureOf(sample) });
    }
    const ctx = canvasRef.current?.getContext('2d');

    if (ctx) {
      const dark = isDarkMode();

      drawStroke(ctx, { ...live.stroke, color: resolveColor(live.stroke.color, dark) }, live.drawn);
      live.drawn = Math.max(1, live.stroke.points.length - 1);
    }
  };

  const finish = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (scrollRef.current?.pointerId === event.pointerId) {
      scrollRef.current = null;

      return;
    }
    const live = liveRef.current;

    if (!live || live.pointerId !== event.pointerId) return;
    liveRef.current = null;
    if (event.pointerType === 'pen') penActiveRef.current = performance.now();
    if (live.erasing) {
      bump();

      return;
    }
    if (live.stroke.points.length === 0) return;
    record(strokesRef.current);
    strokesRef.current = [...strokesRef.current, live.stroke];
    redraw();
    bump();
  };

  const empty = isInkEmpty(strokesRef.current) && version >= 0;
  const canUndo = historyRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;

  return (
    <div ref={wrapRef} className={`flex flex-col ${className}`}>
      {hideToolbar ? null : (
        <div className='mb-2 flex flex-wrap items-center gap-2'>
          <ToolButton active={tool === 'pen'} label='Pen' onPress={() => setTool('pen')}>
            <PenLine className='h-5 w-5' />
          </ToolButton>
          <ToolButton active={tool === 'eraser'} label='Eraser' onPress={() => setTool('eraser')}>
            <Eraser className='h-5 w-5' />
          </ToolButton>
          <span className='mx-1 h-6 w-px bg-st-raised' />
          {(Object.keys(COLOR_LIGHT) as InkColor[]).map((token) => {
            const pick = () => {
              setColor(token);
              setTool('pen');
            };

            // The ink renders lighter on a dark page, so each swatch shows the colour it will draw in.
            return (
              <React.Fragment key={token}>
                <ColorSwatch className='h-11 w-11 dark:hidden' color={COLOR_LIGHT[token]} isSelected={color === token} label={`${token} ink`} onClick={pick} />
                <ColorSwatch className='hidden h-11 w-11 dark:inline-flex' color={COLOR_DARK[token]} isSelected={color === token} label={`${token} ink`} onClick={pick} />
              </React.Fragment>
            );
          })}
          <span className='flex-1' />
          <ToolButton disabled={!canUndo} label='Undo' onPress={() => undo()}>
            <Undo2 className='h-5 w-5' />
          </ToolButton>
          <ToolButton disabled={!canRedo} label='Redo' onPress={() => redo()}>
            <Redo2 className='h-5 w-5' />
          </ToolButton>
          <ToolButton disabled={empty} label='Clear' onPress={() => clear()}>
            <Trash2 className='h-5 w-5' />
          </ToolButton>
        </div>
      )}
      <div className='relative overflow-hidden rounded-2xl border border-st-line bg-st-surface'>
        <canvas
          ref={canvasRef}
          className={`block w-full select-none text-st-fg/10 ${disabled ? 'opacity-70' : ''} ${tool === 'eraser' ? 'cursor-cell' : 'cursor-crosshair'}`}
          style={{
            height,
            touchAction: 'none',
            backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0 35px, currentColor 35px 36px)',
            backgroundPositionY: '20px',
          }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerCancel={finish}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
        />
        {empty && !disabled && placeholder ? (
          <p className='pointer-events-none absolute left-4 top-3 text-sm text-st-muted'>{placeholder}</p>
        ) : null}
        {growable ? (
        <button
          aria-label='Add writing space'
          className='absolute bottom-2 right-2 flex h-10 items-center gap-1 rounded-md bg-st-raised px-3 text-xs font-medium text-st-muted hover:bg-st-raised'
          type='button'
          onClick={() => setHeight((h) => h + GROW_STEP)}
        >
          <Plus className='h-4 w-4' /> More space
        </button>
        ) : null}
      </div>
    </div>
  );
});

function ToolButton({
  active = false,
  disabled = false,
  label,
  onPress,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={`flex h-11 min-w-11 items-center justify-center rounded-xl px-3 text-sm font-medium transition ${
        active
          ? 'bg-st-accent text-st-accent-fg'
          : 'bg-st-raised text-st-fg hover:bg-st-raised'
      } disabled:cursor-not-allowed disabled:opacity-40`}
      disabled={disabled}
      title={label}
      type='button'
      onClick={onPress}
    >
      {children}
    </button>
  );
}
