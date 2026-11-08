import type { SheetCell } from '../lib/sheet';
import type { GlyphPoint, GlyphSample } from '@repo/whiteboard-react';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@repo/ui';
import { Check, Eraser } from 'lucide-react';
import { MAX_SAMPLES_PER_GLYPH, normalizeGlyph } from '@repo/whiteboard-react';

import { cellPromptKey, cellTails } from '../lib/sheet';
import { hwNumber, hwT } from '../lib/strings';

import { ActionButton } from '@/components/ui/primitives';

/** Pen width in CSS px — the notebook's default brush at 100 %. */
const INK_WIDTH = 2.4;
/** Baseline / x-height as fractions of the cell height. */
const BASELINE = 0.68;
const X_HEIGHT = 0.26;
/** Join tails: how far the dashed guide reaches in from the cell edge. */
const TAIL = 0.16;

interface Geometry {
  w: number;
  h: number;
  baselineY: number;
  xHeightPx: number;
}

function geometryOf(w: number, h: number): Geometry {
  return { w, h, baselineY: h * BASELINE, xHeightPx: h * X_HEIGHT };
}

function paintGuides(
  ctx: CanvasRenderingContext2D,
  g: Geometry,
  ink: string,
  tails: { right: boolean; left: boolean },
) {
  const top = g.baselineY - g.xHeightPx;

  ctx.save();
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.05;
  ctx.fillRect(0, top, g.w, g.xHeightPx);
  ctx.globalAlpha = 0.28;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, g.baselineY + 0.5);
  ctx.lineTo(g.w, g.baselineY + 0.5);
  ctx.stroke();
  ctx.globalAlpha = 0.14;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(0, top + 0.5);
  ctx.lineTo(g.w, top + 0.5);
  ctx.stroke();
  // Join tails on the baseline: a dashed lead-in on the right (from the previous letter), a lead-out on the left.
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = INK_WIDTH;
  ctx.lineCap = 'round';
  ctx.setLineDash([2, 5]);
  if (tails.right) {
    ctx.beginPath();
    ctx.moveTo(g.w - 4, g.baselineY);
    ctx.lineTo(g.w * (1 - TAIL), g.baselineY);
    ctx.stroke();
  }
  if (tails.left) {
    ctx.beginPath();
    ctx.moveTo(4, g.baselineY);
    ctx.lineTo(g.w * TAIL, g.baselineY);
    ctx.stroke();
  }
  ctx.restore();
}

function paintStroke(ctx: CanvasRenderingContext2D, stroke: readonly GlyphPoint[], ink: string) {
  if (stroke.length === 0) return;
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = INK_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(stroke[0][0], stroke[0][1]);
  if (stroke.length === 1) ctx.lineTo(stroke[0][0], stroke[0][1]);
  for (let i = 1; i < stroke.length - 1; i++) {
    const [cx, cy] = stroke[i];
    const [nx, ny] = stroke[i + 1];

    ctx.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
  }
  if (stroke.length > 1) {
    const [lx, ly] = stroke[stroke.length - 1];

    ctx.lineTo(lx, ly);
  }
  ctx.stroke();
  ctx.restore();
}

function paintSegment(ctx: CanvasRenderingContext2D, from: GlyphPoint, to: GlyphPoint, ink: string) {
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = INK_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
  ctx.stroke();
  ctx.restore();
}

/** The nearest ancestor that scrolls vertically (the app's `<main>`), for finger panning. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;

    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }

  return null;
}

export interface InkCellProps {
  cell: SheetCell;
  /** Samples the bank already holds for this cell. */
  count: number;
  onAccept: (sample: GlyphSample) => void;
}

/**
 * One sheet cell: a canvas with the guide baseline, the x-height band and the join tails of the form,
 * the prompt in the corner, and «Clear» / «Accept» once there is ink. The pen (or a mouse) writes;
 * a finger pans the page. Strokes are kept in cell px and normalised on accept.
 */
export function InkCell({ cell, count, onAccept }: InkCellProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const geometryRef = useRef<Geometry>(geometryOf(1, 1));
  const strokesRef = useRef<GlyphPoint[][]>([]);
  const liveRef = useRef<GlyphPoint[] | null>(null);
  const pointerRef = useRef<number | null>(null);
  const panRef = useRef<{ pointerId: number; lastY: number; target: HTMLElement } | null>(null);
  const [strokeCount, setStrokeCount] = useState(0);
  const [justSaved, setJustSaved] = useState(false);
  const tails = cellTails(cell);
  const full = count >= MAX_SAMPLES_PER_GLYPH;

  const ink = useCallback(() => (canvasRef.current ? getComputedStyle(canvasRef.current).color : '#171717'), []);

  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');

    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const g = geometryRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);
    const color = ink();

    paintGuides(ctx, g, color, tails);
    for (const stroke of strokesRef.current) paintStroke(ctx, stroke, color);
    if (liveRef.current) paintStroke(ctx, liveRef.current, color);
  }, [ink, tails]);

  // Size the backing store to the frame (device pixels) and repaint on every resize / theme change.
  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;

    if (!frame || !canvas) return;
    const measure = () => {
      const w = frame.clientWidth;
      const h = frame.clientHeight;
      const dpr = window.devicePixelRatio || 1;

      if (w === 0 || h === 0) return;
      // Strokes are in CSS px; a resize rescales them so the writing keeps its place on the guides.
      const previous = geometryRef.current;

      if (previous.w > 1 && (previous.w !== w || previous.h !== h)) {
        const sx = w / previous.w;
        const sy = h / previous.h;

        strokesRef.current = strokesRef.current.map((stroke) =>
          stroke.map(([x, y, p]): GlyphPoint => [x * sx, y * sy, p]),
        );
      }
      geometryRef.current = geometryOf(w, h);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      repaint();
    };

    measure();
    const observer = new ResizeObserver(measure);

    observer.observe(frame);
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    media.addEventListener('change', repaint);
    const themeObserver = new MutationObserver(repaint);

    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      observer.disconnect();
      media.removeEventListener('change', repaint);
      themeObserver.disconnect();
    };
  }, [repaint]);

  const pointOf = (event: PointerEvent | React.PointerEvent): GlyphPoint => {
    const rect = canvasRef.current!.getBoundingClientRect();

    return [event.clientX - rect.left, event.clientY - rect.top, event.pressure || 0.5];
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;

    if (!canvas) return;
    if (event.pointerType === 'touch') {
      // A finger pans the sheet; the cell never takes its ink.
      const target = scrollParent(canvas);

      if (target) panRef.current = { pointerId: event.pointerId, lastY: event.clientY, target };

      return;
    }
    // The pen's eraser end (button 5) is not a writing stroke.
    if (event.buttons & 32) return;
    if (pointerRef.current !== null) return;
    event.preventDefault();
    pointerRef.current = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    liveRef.current = [pointOf(event)];
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pan = panRef.current;

    if (pan && pan.pointerId === event.pointerId) {
      pan.target.scrollTop -= event.clientY - pan.lastY;
      pan.lastY = event.clientY;

      return;
    }
    if (pointerRef.current !== event.pointerId || !liveRef.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    const native = event.nativeEvent;
    const samples: PointerEvent[] =
      typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length > 0
        ? native.getCoalescedEvents()
        : [native];
    const color = ink();

    for (const sample of samples) {
      const point = pointOf(sample);
      const previous = liveRef.current[liveRef.current.length - 1];

      // Drop digitizer jitter below a quarter pixel.
      if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 0.25) continue;
      liveRef.current.push(point);
      if (ctx) paintSegment(ctx, previous, point, color);
    }
  };

  const endStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null;

      return;
    }
    if (pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    const live = liveRef.current;

    liveRef.current = null;
    if (live && live.length > 0) {
      strokesRef.current = [...strokesRef.current, live];
      setStrokeCount(strokesRef.current.length);
    }
    repaint();
  };

  const clear = () => {
    strokesRef.current = [];
    liveRef.current = null;
    setStrokeCount(0);
    repaint();
  };

  const accept = () => {
    if (strokesRef.current.length === 0) return;
    const g = geometryRef.current;
    const sample = normalizeGlyph({
      strokes: strokesRef.current,
      baselineY: g.baselineY,
      xHeight: g.xHeightPx,
      cell: { x: 0, y: 0, w: g.w, h: g.h },
      dir: cell.dir,
      source: 'sheet',
    });

    if (sample) onAccept(sample);
    clear();
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 1_200);
  };

  const promptKey = cellPromptKey(cell);

  return (
    <div
      className={cn(
        'rounded-st border-st-line bg-st-surface flex flex-col overflow-hidden border',
        full && 'border-st-ok/40',
      )}
      data-cell-key={cell.key}
      data-cell-samples={count}
    >
      <div ref={frameRef} className='relative aspect-[5/4] w-full'>
        <canvas
          ref={canvasRef}
          aria-label={`${cell.label} — ${hwT(promptKey)}`}
          className='text-st-fg absolute inset-0 h-full w-full'
          style={{ touchAction: 'none' }}
          onPointerCancel={endStroke}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endStroke}
        />
        {/* Prompt: the letter big enough to copy, its position in the word under it. */}
        <div className='pointer-events-none absolute right-2 top-1.5 flex flex-col items-end leading-none'>
          <span className='text-st-muted text-xl font-medium'>
            {cell.prompt}
          </span>
          <span className='text-st-muted mt-0.5 text-[10px]'>{hwT(promptKey)}</span>
        </div>
        <span
          data-cell-count
          className={cn(
            'pointer-events-none absolute left-2 top-1.5 inline-flex items-center gap-1 text-[11px] font-medium tabular-nums',
            count > 0 ? 'text-st-ok' : 'text-st-muted',
          )}
        >
          {count > 0 && <Check className='h-3 w-3' />}
          {hwT('samples', { count: hwNumber(count), max: hwNumber(MAX_SAMPLES_PER_GLYPH) })}
        </span>
      </div>
      <div className='border-st-line flex min-h-10 items-center justify-between gap-2 border-t px-2 py-1'>
        {strokeCount === 0 ? (
          <span className={cn('text-xs', justSaved ? 'text-st-ok font-medium' : 'text-st-muted')}>
            {justSaved ? hwT('sampleAdded') : hwT('writeHere')}
          </span>
        ) : (
          <>
            <ActionButton aria-label={hwT('clear')} className='min-h-8 px-2 text-xs' variant='ghost' onClick={clear}>
              <Eraser className='h-3.5 w-3.5' /> {hwT('clear')}
            </ActionButton>
            <ActionButton data-cell-accept className='min-h-8 px-3 text-xs' variant='primary' onClick={accept}>
              <Check className='h-3.5 w-3.5' /> {hwT('accept')}
            </ActionButton>
          </>
        )}
      </div>
    </div>
  );
}
