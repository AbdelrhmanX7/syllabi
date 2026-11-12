import type { Canvas, FabricObject } from 'fabric';

import type { WriteOnStroke } from './handwritingObjects';
import type { PenRevealStep } from './penActionObjects';

/**
 * The write-on: a handwritten answer appears word by word as if a pen were writing it — each word
 * wiped in left to right, lines in order. It is drawn on a throwaway canvas over the board; the real objects are added only when it
 * finishes, so autosave, sync and undo never see a half-written answer and the insert stays ONE undo
 * step. A tap anywhere on it finishes at once; `prefers-reduced-motion` skips it.
 */

export interface WriteOnPlayback {
  /** Resolves when the animation finished or was skipped; the overlay is still on screen. */
  done: Promise<void>;
  skip: () => void;
  /** Removes the overlay — call after the real objects have been rendered. */
  dispose: () => void;
  /** `linger` only: repaints the finished marks at the board's current pan/zoom. */
  repaint?: () => void;
}

/** The buddy's pencil: tip at the bottom-left corner, brand blue, cream outline so it reads on ink and on paper. */
export const PENCIL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28" fill="none"><path d="M2 26l2.2-7.4L19.6 3.2a2.4 2.4 0 013.4 0l1.8 1.8a2.4 2.4 0 010 3.4L9.4 23.8 2 26z" fill="#3b5bdb" stroke="#fbfaf6" stroke-width="2" stroke-linejoin="round"/><path d="M4.2 18.6l5.2 5.2" stroke="#fbfaf6" stroke-width="1.6"/><path d="M2 26l2.4-1-1.4-1.4L2 26z" fill="#18204a"/></svg>';

export const prefersReducedMotion = (): boolean => {
  try {
    return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
};

/** ~1.5 s for a line, up to 4 s for a long answer. */
export const writeOnDuration = (strokes: WriteOnStroke[]): number => Math.max(1500, Math.min(4000, 900 + strokes.length * 90));

export function playWriteOn(
  canvas: Canvas,
  host: HTMLElement,
  strokes: WriteOnStroke[],
  {
    fill,
    strokeWidth,
    offset = { dx: 0, dy: 0 },
    durationMs = writeOnDuration(strokes),
  }: {
    fill: string;
    strokeWidth: number;
    /** How far the objects moved after the strokes were built (scene units). */
    offset?: { dx: number; dy: number };
    durationMs?: number;
  },
): WriteOnPlayback {
  const element = canvas.getElement();
  const overlay = document.createElement('canvas');
  let finished = false;
  let frame: number | null = null;
  let resolve: () => void = () => undefined;
  const done = new Promise<void>((settle) => {
    resolve = settle;
  });

  const dispose = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    overlay.remove();
  };

  if (strokes.length === 0 || prefersReducedMotion() || typeof Path2D === 'undefined') {
    resolve();

    return { done, skip: () => undefined, dispose };
  }

  const hostRect = host.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const ratio = element.width / (rect.width || element.width || 1);

  overlay.width = element.width;
  overlay.height = element.height;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = `position:absolute;left:${rect.left - hostRect.left}px;top:${rect.top - hostRect.top}px;width:${rect.width}px;height:${rect.height}px;pointer-events:auto;touch-action:none;cursor:pointer;`;
  host.appendChild(overlay);

  const ctx = overlay.getContext('2d');
  const paths = strokes.map((stroke) => new Path2D(stroke.d));
  // Each word gets a share of the time proportional to its width — long words take longer to write.
  const weights = strokes.map((stroke) => Math.max(stroke.bounds.width, 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const starts: number[] = [];

  weights.reduce((sum, weight, index) => {
    starts[index] = sum / total;

    return sum + weight;
  }, 0);

  const finish = () => {
    if (finished) return;

    finished = true;

    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    resolve();
  };

  overlay.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    finish();
  });

  const t0 = performance.now();

  const draw = (now: number) => {
    if (!ctx || finished) return;

    const progress = Math.min(1, (now - t0) / durationMs);
    const vpt = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.setTransform(vpt[0]! * ratio, vpt[1]! * ratio, vpt[2]! * ratio, vpt[3]! * ratio, vpt[4]! * ratio, vpt[5]! * ratio);
    ctx.translate(offset.dx, offset.dy);
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    strokes.forEach((stroke, index) => {
      const share = weights[index]! / total;
      const local = (progress - starts[index]!) / share;

      if (local <= 0) return;

      const path = paths[index]!;
      const { left, top, width, height } = stroke.bounds;
      const pad = strokeWidth * 2;

      ctx.save();

      if (stroke.color) {
        ctx.fillStyle = stroke.color;
        ctx.strokeStyle = stroke.color;
      }

      if (local < 1) {
        const shown = width * local;
        const x = left;

        ctx.beginPath();
        ctx.rect(x - pad, top - pad, shown + pad * 2, height + pad * 2);
        ctx.clip();
      }

      ctx.fill(path, 'evenodd');
      ctx.stroke(path);
      ctx.restore();
    });

    if (progress >= 1) finish();
    else frame = requestAnimationFrame(draw);
  };

  frame = requestAnimationFrame(draw);

  return { done, skip: finish, dispose };
}

/**
 * The same overlay, for ready-made board objects drawn step by step (the «Map my terms» map: a level's
 * nodes, then its arrows, then the next level). Each object is wiped in left to right inside its own
 * box; the objects themselves are rendered, so what plays is exactly what lands. Same contract as
 * {@link playWriteOn}: nothing joins the board until `done`, a tap finishes at once.
 */
export function playObjectReveal(
  canvas: Canvas,
  host: HTMLElement,
  steps: FabricObject[][],
  { durationMs }: { durationMs?: number } = {},
): WriteOnPlayback {
  const element = canvas.getElement();
  const overlay = document.createElement('canvas');
  const all = steps.flat();
  const duration = durationMs ?? Math.max(1400, Math.min(4200, 700 + all.length * 45));
  let finished = false;
  let frame: number | null = null;
  let resolve: () => void = () => undefined;
  const done = new Promise<void>((settle) => {
    resolve = settle;
  });
  // Uncached while playing: an object off the canvas would cache at zoom 1 and draw blurred.
  const caching = all.map((object) => object.objectCaching);

  const dispose = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    overlay.remove();
    all.forEach((object, index) => {
      object.objectCaching = caching[index]!;
    });
  };

  if (all.length === 0 || prefersReducedMotion()) {
    resolve();

    return { done, skip: () => undefined, dispose };
  }

  all.forEach((object) => {
    object.objectCaching = false;
  });

  const hostRect = host.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const ratio = element.width / (rect.width || element.width || 1);

  overlay.width = element.width;
  overlay.height = element.height;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = `position:absolute;left:${rect.left - hostRect.left}px;top:${rect.top - hostRect.top}px;width:${rect.width}px;height:${rect.height}px;pointer-events:auto;touch-action:none;cursor:pointer;`;
  host.appendChild(overlay);

  const ctx = overlay.getContext('2d');
  const boxes = steps.map((list) => list.map((object) => object.getBoundingRect()));
  const finish = () => {
    if (finished) return;

    finished = true;

    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    resolve();
  };

  overlay.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    finish();
  });

  const t0 = performance.now();
  const share = 1 / steps.length;

  const draw = (now: number) => {
    if (!ctx || finished) return;

    const progress = Math.min(1, (now - t0) / duration);
    const vpt = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    steps.forEach((list, stepIndex) => {
      const local = (progress - stepIndex * share) / share;

      if (local <= 0) return;

      list.forEach((object, index) => {
        const box = boxes[stepIndex]![index]!;
        const pad = 4 / (vpt[0] || 1);

        ctx.save();
        ctx.setTransform(vpt[0]! * ratio, vpt[1]! * ratio, vpt[2]! * ratio, vpt[3]! * ratio, vpt[4]! * ratio, vpt[5]! * ratio);

        if (local < 1) {
          const shown = (box.width + pad * 2) * local;
          const x = box.left - pad;

          ctx.beginPath();
          ctx.rect(x, box.top - pad, shown, box.height + pad * 2);
          ctx.clip();
        }

        try {
          object.render(ctx);
        } catch {
          /* a half-built object: it still lands at the end */
        }

        ctx.restore();
      });
    });

    if (progress >= 1) finish();
    else frame = requestAnimationFrame(draw);
  };

  frame = requestAnimationFrame(draw);

  return { done, skip: finish, dispose };
}

/**
 * «Explain on my page»: the turn's steps played IN ORDER on the same throwaway overlay — a stroke is
 * drawn tip-first along its own polyline (a circle closes, an arrow leaves its box, a free stroke
 * runs), a note is wiped in word by word like {@link playWriteOn}, a pointer step pauses while the
 * caller shows the pointer sprite (`onPointer`). Completed steps stay on the overlay until `dispose`,
 * so what plays is exactly what lands when the real objects are added in one tick afterwards. Same
 * contract: nothing joins the board until `done`; a tap finishes at once; reduced motion skips it.
 */
export function playPenTurn(
  canvas: Canvas,
  host: HTMLElement,
  steps: PenRevealStep[],
  {
    onPointer,
    maxTotalMs = 9000,
    linger = false,
    pencil = false,
  }: {
    onPointer?: (at: { x: number; y: number }, note?: string) => void;
    maxTotalMs?: number;
    /**
     * Keep the finished marks painted on the overlay (pass-through to touches) instead of waiting for
     * the real objects — the buddy's temporary marks. `repaint()` follows pan/zoom; `dispose()` ends them.
     */
    linger?: boolean;
    /** A pencil that travels with the drawing (its tip on the stroke being made) — the buddy's cursor. */
    pencil?: boolean;
  } = {},
): WriteOnPlayback {
  const element = canvas.getElement();
  const overlay = document.createElement('canvas');
  let finished = false;
  let frame: number | null = null;
  let resolve: () => void = () => undefined;
  const done = new Promise<void>((settle) => {
    resolve = settle;
  });
  const pointed = new Set<number>();
  const point = (index: number) => {
    const step = steps[index];

    if (!step || step.kind !== 'pointer' || pointed.has(index)) return;

    pointed.add(index);
    onPointer?.(step.at, step.note);
  };

  let pencilEl: HTMLElement | null = null;
  const dispose = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    overlay.remove();
    pencilEl?.remove();
  };

  const instant = steps.length === 0 || prefersReducedMotion();

  if (typeof Path2D === 'undefined' || (instant && !linger)) {
    // No animation: the pointers still show, so the «look here» is not lost.
    steps.forEach((_, index) => point(index));
    resolve();

    return { done, skip: () => undefined, dispose };
  }

  const vpt0 = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
  const zoom = vpt0[0] || 1;
  const hostRect = host.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const ratio = element.width / (rect.width || element.width || 1);

  overlay.width = element.width;
  overlay.height = element.height;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = `position:absolute;left:${rect.left - hostRect.left}px;top:${rect.top - hostRect.top}px;width:${rect.width}px;height:${rect.height}px;pointer-events:auto;touch-action:none;cursor:pointer;`;
  host.appendChild(overlay);

  if (pencil && !instant) {
    pencilEl = document.createElement('div');
    pencilEl.setAttribute('aria-hidden', 'true');
    // The tip of the drawn pencil is the element's bottom-left corner; only transform/opacity move.
    pencilEl.style.cssText = 'position:absolute;left:0;top:0;width:28px;height:28px;margin-top:-28px;pointer-events:none;z-index:43;opacity:0;transition:opacity 200ms ease;will-change:transform;';
    pencilEl.innerHTML = PENCIL_SVG;
    host.appendChild(pencilEl);
  }

  const movePencil = (tip: { x: number; y: number } | null) => {
    if (!pencilEl) return;

    if (!tip) {
      pencilEl.style.opacity = '0';

      return;
    }

    const vpt = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
    const left = tip.x * vpt[0]! + vpt[4]! + (rect.left - hostRect.left);
    const top = tip.y * vpt[3]! + vpt[5]! + (rect.top - hostRect.top);

    pencilEl.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
    pencilEl.style.opacity = '1';
  };

  const ctx = overlay.getContext('2d');
  // Each step's own clock: a stroke by its on-screen length, a note by its words, a pointer a dwell.
  const polylineLength = (points: Array<{ x: number; y: number }>) => points.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - points[i - 1]!.x, p.y - points[i - 1]!.y) : 0), 0);
  let durations = steps.map((step) => {
    if (step.kind === 'stroke') return Math.max(320, Math.min(1400, 220 + polylineLength(step.points) * zoom * 2.2));
    if (step.kind === 'write') return Math.max(600, Math.min(2600, 500 + step.strokes.length * 110));

    return 750;
  });
  const total = durations.reduce((sum, ms) => sum + ms, 0);

  if (total > maxTotalMs) durations = durations.map((ms) => (ms * maxTotalMs) / total);

  const starts: number[] = [];

  durations.reduce((sum, ms, index) => {
    starts[index] = sum;

    return sum + ms;
  }, 0);

  const totalMs = durations.reduce((sum, ms) => sum + ms, 0);
  const writePaths = new Map<number, Path2D[]>();

  steps.forEach((step, index) => {
    if (step.kind === 'write') writePaths.set(index, step.strokes.map((stroke) => new Path2D(stroke.d)));
  });

  const finish = () => {
    if (finished) return;

    finished = true;
    steps.forEach((_, index) => point(index));

    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;

    movePencil(null);

    if (linger) {
      overlay.style.pointerEvents = 'none';
      paint(totalMs);
    }

    resolve();
  };

  overlay.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    finish();
  });

  /** The polyline up to `fraction` of its length, as the pencil brush would smooth it. */
  const traceStroke = (context: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>, fraction: number) => {
    const length = polylineLength(points);
    const target = length * Math.max(0, Math.min(1, fraction));
    const shown: Array<{ x: number; y: number }> = [points[0]!];
    let run = 0;

    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1]!;
      const b = points[index]!;
      const segment = Math.hypot(b.x - a.x, b.y - a.y);

      if (run + segment >= target) {
        const t = segment > 0 ? (target - run) / segment : 1;

        shown.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        break;
      }

      run += segment;
      shown.push(b);
    }

    context.beginPath();
    context.moveTo(shown[0]!.x, shown[0]!.y);

    if (shown.length === 1) context.lineTo(shown[0]!.x + 0.01, shown[0]!.y);
    else if (shown.length === 2) context.lineTo(shown[1]!.x, shown[1]!.y);
    else {
      for (let index = 1; index < shown.length - 1; index += 1) {
        const p = shown[index]!;
        const next = shown[index + 1]!;

        context.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
      }

      const last = shown[shown.length - 1]!;

      context.lineTo(last.x, last.y);
    }

    context.stroke();

    return shown[shown.length - 1]!;
  };

  const t0 = performance.now();

  function paint(elapsed: number) {
    if (!ctx) return;

    const vpt = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // Where the pen is right now (scene units): the step being drawn.
    let tip: { x: number; y: number } | null = null;

    steps.forEach((step, index) => {
      const local = (elapsed - starts[index]!) / durations[index]!;

      if (local <= 0) return;

      if (step.kind === 'pointer') {
        point(index);
        if (local < 1) tip = step.at;

        return;
      }

      ctx.save();
      ctx.setTransform(vpt[0]! * ratio, vpt[1]! * ratio, vpt[2]! * ratio, vpt[3]! * ratio, vpt[4]! * ratio, vpt[5]! * ratio);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      if (step.kind === 'stroke') {
        ctx.strokeStyle = step.color;
        ctx.lineWidth = step.width;
        ctx.globalAlpha = step.opacity;
        const end = traceStroke(ctx, step.points, local);

        if (local < 1) tip = end;
      } else {
        const { scale, dx, dy } = step.transform;
        const paths = writePaths.get(index)!;
        const weights = step.strokes.map((stroke) => Math.max(stroke.bounds.width, 1));
        const sum = weights.reduce((acc, weight) => acc + weight, 0);
        let offset = 0;

        ctx.translate(dx, dy);
        ctx.scale(scale, scale);
        ctx.fillStyle = step.fill;
        ctx.strokeStyle = step.fill;
        ctx.lineWidth = step.strokeWidth;

        step.strokes.forEach((stroke, strokeIndex) => {
          const share = weights[strokeIndex]! / sum;
          const wordLocal = (Math.min(1, local) - offset) / share;

          offset += share;

          if (wordLocal <= 0) return;

          const { left, top, width, height } = stroke.bounds;
          const pad = step.strokeWidth * 2;

          ctx.save();

          if (wordLocal < 1) {
            const shown = width * wordLocal;
            const x = left;

            if (local < 1) tip = { x: (left + shown) * scale + dx, y: (top + height * 0.6) * scale + dy };

            ctx.beginPath();
            ctx.rect(x - pad, top - pad, shown + pad * 2, height + pad * 2);
            ctx.clip();
          }

          ctx.fill(paths[strokeIndex]!, 'evenodd');
          ctx.stroke(paths[strokeIndex]!);
          ctx.restore();
        });
      }

      ctx.restore();
    });

    if (elapsed < totalMs) movePencil(tip);
  }

  const draw = (now: number) => {
    if (!ctx || finished) return;

    const elapsed = Math.min(totalMs, now - t0);

    paint(elapsed);

    if (elapsed >= totalMs) finish();
    else frame = requestAnimationFrame(draw);
  };

  if (instant) finish();
  else frame = requestAnimationFrame(draw);

  return { done, skip: finish, dispose, ...(linger ? { repaint: () => finished && paint(totalMs) } : {}) };
}
