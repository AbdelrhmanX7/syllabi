/**
 * Graph axes — the pure half. A graph on the board is described by a small spec: which axes it has
 * (both, the x-axis alone = a number line, or the y-axis alone) and where each one starts and ends.
 * `planGraph` turns the spec into lines, arrow heads and number labels in local px (origin top-left),
 * which utils/graphObject.ts builds into one board object. Editing a graph = planning it again.
 */

export type GraphMode = 'xy' | 'x' | 'y';

export interface GraphSpec {
  mode: GraphMode;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export const DEFAULT_GRAPH: GraphSpec = { mode: 'xy', xMin: -5, xMax: 5, yMin: -5, yMax: 5 };

const LIMIT = 1_000_000;

const finite = (value: unknown, fallback: number): number => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

  return typeof n === 'number' && Number.isFinite(n) ? Math.max(-LIMIT, Math.min(LIMIT, n)) : fallback;
};

/** Any input → a usable spec: finite numbers, start below end (swapped when given backwards), a known mode. */
export function normalizeGraphSpec(raw: Partial<Record<keyof GraphSpec, unknown>> | null | undefined): GraphSpec {
  const mode: GraphMode = raw?.mode === 'x' || raw?.mode === 'y' ? raw.mode : 'xy';
  const pair = (a: unknown, b: unknown, min: number, max: number): [number, number] => {
    let lo = finite(a, min);
    let hi = finite(b, max);

    if (lo > hi) [lo, hi] = [hi, lo];
    if (lo === hi) hi = lo + 1;

    return [lo, hi];
  };
  const [xMin, xMax] = pair(raw?.xMin, raw?.xMax, DEFAULT_GRAPH.xMin, DEFAULT_GRAPH.xMax);
  const [yMin, yMax] = pair(raw?.yMin, raw?.yMax, DEFAULT_GRAPH.yMin, DEFAULT_GRAPH.yMax);

  return { mode, xMin, xMax, yMin, yMax };
}

/** The spacing between numbered ticks: 1, 2 or 5 × a power of ten, so the axis shows at most `maxTicks` gaps. */
export function niceStep(span: number, maxTicks = 12): number {
  if (!(span > 0)) return 1;

  const rough = span / maxTicks;
  const power = 10 ** Math.floor(Math.log10(rough));

  for (const factor of [1, 2, 5, 10]) {
    if (factor * power >= rough - 1e-12) return factor * power;
  }

  return 10 * power;
}

/** The multiples of `step` inside [min, max], cleaned of floating-point dust. */
export function tickValues(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(min / step - 1e-9);
  const last = Math.floor(max / step + 1e-9);

  for (let k = first; k <= last && out.length < 400; k += 1) out.push(Number((k * step).toPrecision(12)));

  return out;
}

/** A tick's number as a person writes it: no trailing zeros, a real minus sign. */
export function tickLabel(value: number, step: number): string {
  const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  const text = value.toFixed(decimals).replace(/\.?0+$/, (zeros) => (zeros.startsWith('.') ? '' : zeros));
  const clean = decimals > 0 ? text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : text;

  return (clean === '-0' ? '0' : clean).replace('-', '−');
}

export interface GraphLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: 'axis' | 'grid' | 'tick';
}

export interface GraphLabel {
  x: number;
  y: number;
  text: string;
  /** Where (x, y) sits on the text. */
  alignX: 'left' | 'center' | 'right';
  alignY: 'top' | 'center' | 'bottom';
  name?: boolean;
}

export interface GraphPlan {
  width: number;
  height: number;
  lines: GraphLine[];
  /** Arrow heads: the tip and the unit direction the axis runs in there. */
  arrows: Array<{ x: number; y: number; dx: number; dy: number }>;
  labels: GraphLabel[];
  fontSize: number;
}

/** Plot size (px) per mode, before the board's zoom is divided out. */
const PLOT = 360;
const TICK = 5;
const PAD = 14;

/**
 * The spec → what to draw. The axes cross at zero when zero is in range; otherwise each axis sits on
 * the edge nearest to zero (so a graph from 2 to 10 still has its axis, at the start). A number line
 * (`x` or `y` alone) has arrows at both ends.
 */
export function planGraph(input: GraphSpec, size = PLOT): GraphPlan {
  const spec = normalizeGraphSpec(input);
  const hasX = spec.mode !== 'y';
  const hasY = spec.mode !== 'x';
  const spanX = spec.xMax - spec.xMin;
  const spanY = spec.yMax - spec.yMin;
  const fontSize = Math.round(size / 28);
  const width = hasX ? size : 0;
  // Both axes share one scale when their ranges are comparable (a square grid); a lopsided range gets its own.
  const ratio = spanY / spanX;
  const height = hasY ? (hasX ? size * Math.max(0.5, Math.min(1.5, ratio)) : size) : 0;
  const sx = hasX ? width / spanX : 0;
  const sy = hasY ? height / spanY : 0;
  const px = (x: number) => (x - spec.xMin) * sx;
  const py = (y: number) => height - (y - spec.yMin) * sy;
  const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
  // Where each axis sits: through zero, or on the edge nearest to it.
  const axisX = hasY ? px(clamp(0, spec.xMin, spec.xMax)) : 0;
  const axisY = hasX ? (hasY ? py(clamp(0, spec.yMin, spec.yMax)) : 0) : 0;
  // As many numbers as fit without touching: a number needs about 2.6 of its heights sideways, 1.8 upward.
  const stepX = niceStep(spanX, Math.max(2, Math.min(12, Math.floor(width / (fontSize * 2.6)))));
  const stepY = niceStep(spanY, Math.max(2, Math.min(12, Math.floor(height / (fontSize * 1.8)))));
  // The corner «0» drops under the x-axis when the next number down leaves it room; on a squat graph it
  // moves to the right of the y-axis instead (never onto «−1»).
  const zeroBelow = stepY * sy >= fontSize * 2.4;
  const lines: GraphLine[] = [];
  const arrows: GraphPlan['arrows'] = [];
  const labels: GraphLabel[] = [];
  const crossing = hasX && hasY;

  if (hasX) {
    for (const value of tickValues(spec.xMin, spec.xMax, stepX)) {
      const x = px(value);

      if (crossing) lines.push({ x1: x, y1: 0, x2: x, y2: height, kind: 'grid' });
      lines.push({ x1: x, y1: axisY - TICK, x2: x, y2: axisY + TICK, kind: 'tick' });

      // Where the axes cross, one «0» is enough (written by the y loop, beside the corner).
      if (crossing && Math.abs(x - axisX) < 0.5) continue;

      labels.push({ x, y: axisY + TICK + 3, text: tickLabel(value, stepX), alignX: 'center', alignY: 'top' });
    }

    lines.push({ x1: -PAD, y1: axisY, x2: width + PAD, y2: axisY, kind: 'axis' });
    arrows.push({ x: width + PAD, y: axisY, dx: 1, dy: 0 });
    if (!hasY) arrows.push({ x: -PAD, y: axisY, dx: -1, dy: 0 });
    labels.push({ x: width + PAD + 6, y: axisY, text: 'x', alignX: 'left', alignY: 'center', name: true });
  }

  if (hasY) {
    for (const value of tickValues(spec.yMin, spec.yMax, stepY)) {
      const y = py(value);

      if (crossing) lines.push({ x1: 0, y1: y, x2: width, y2: y, kind: 'grid' });
      lines.push({ x1: axisX - TICK, y1: y, x2: axisX + TICK, y2: y, kind: 'tick' });

      const atCross = crossing && Math.abs(y - axisY) < 0.5;

      if (atCross && !zeroBelow) {
        labels.push({ x: axisX + 4, y: y + TICK + 3, text: tickLabel(value, stepY), alignX: 'left', alignY: 'top' });
        continue;
      }

      labels.push({
        x: axisX - TICK - 4,
        // The corner's «0» drops just under the x-axis so the axis line does not strike it through.
        y: atCross ? y + TICK + 3 : y,
        text: tickLabel(value, stepY),
        alignX: 'right',
        alignY: atCross ? 'top' : 'center',
      });
    }

    lines.push({ x1: axisX, y1: height + PAD, x2: axisX, y2: -PAD, kind: 'axis' });
    arrows.push({ x: axisX, y: -PAD, dx: 0, dy: -1 });
    if (!hasX) arrows.push({ x: axisX, y: height + PAD, dx: 0, dy: 1 });
    labels.push({ x: axisX, y: -PAD - 6, text: 'y', alignX: 'center', alignY: 'bottom', name: true });
  }

  return { width, height, lines, arrows, labels, fontSize };
}
