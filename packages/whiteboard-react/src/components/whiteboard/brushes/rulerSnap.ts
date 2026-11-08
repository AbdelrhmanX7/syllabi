import { Point, Polyline } from 'fabric';

import type { TEvent } from 'fabric';

import type { LowLatencyPencilBrush, StrokeInterceptor } from './LowLatencyPencilBrush';

import { applySnappedShapeControls, createSnappedBrushObject, SNAPPED_SHAPE_PROP } from './shapeSnap';

/**
 * An on-screen straight edge (the host's ruler), in CLIENT px — the same space as a pointer event's
 * `clientX/Y`. `snapPx` is how far from the edge (screen px) a stroke may stray and still count as drawn
 * along it.
 */
export interface RulerEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  snapPx: number;
}

/** The host publishes the live edges here (a ruler has two long sides); null/empty = no ruler on screen. */
/** What the host needs to map paper positions onto the screen (the editor's `viewportRef`). */
export interface EditorViewport {
  zoom: number;
  offsetX: number;
  offsetY: number;
  /** Canvas top-left in client px. */
  originX: number;
  originY: number;
  /** 0-based index of the page shown. */
  pageIndex: number;
}

export type RulerEdgesRef = { current: (() => readonly RulerEdge[] | null) | null };

/** A stroke shorter than this on screen (px) is a dot or a tap, never snapped. */
const MIN_STROKE_PX = 24;

interface SceneEdge {
  a: { x: number; y: number };
  b: { x: number; y: number };
  length: number;
  tolerance: number;
}

export interface RulerSnapResult {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/** Pure: project a stroke (scene px) onto the first edge it lies along; null when it is not along one. */
export function snapStrokeToEdges(
  points: ReadonlyArray<{ x: number; y: number }>,
  edges: readonly SceneEdge[],
  minLength: number,
): RulerSnapResult | null {
  if (points.length < 2) return null;

  let best: { edge: SceneEdge; worst: number } | null = null;

  for (const edge of edges) {
    const dx = edge.b.x - edge.a.x;
    const dy = edge.b.y - edge.a.y;

    if (edge.length < 1) continue;

    let worst = 0;

    for (const p of points) {
      const dist = Math.abs((p.x - edge.a.x) * dy - (p.y - edge.a.y) * dx) / edge.length;

      if (dist > worst) worst = dist;
    }

    if (worst <= edge.tolerance && (!best || worst < best.worst)) best = { edge, worst };
  }

  if (!best) return null;

  const { a, b, length } = best.edge;
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const along = (p: { x: number; y: number }) => (p.x - a.x) * ux + (p.y - a.y) * uy;
  let lo = Infinity;
  let hi = -Infinity;

  for (const p of points) {
    const t = along(p);

    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }

  if (hi - lo < minLength) return null;

  // Forward along the stroke's own direction, so a stroke drawn right-to-left still starts where it began.
  const first = along(points[0]!);
  const last = along(points[points.length - 1]!);
  const [s, e] = first <= last ? [lo, hi] : [hi, lo];

  return { from: { x: a.x + ux * s, y: a.y + uy * s }, to: { x: a.x + ux * e, y: a.y + uy * e } };
}

function clientToScene(brush: LowLatencyPencilBrush, x: number, y: number): { x: number; y: number } | null {
  const canvas = brush.canvas;
  const el = canvas.upperCanvasEl;
  const rect = el.getBoundingClientRect();

  if (!rect.width || !rect.height) return null;

  const cx = (x - rect.left) * (canvas.getWidth() / rect.width);
  const cy = (y - rect.top) * (canvas.getHeight() / rect.height);
  const point = new Point(cx, cy).transform(invert(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0]));

  return { x: point.x, y: point.y };
}

function invert(m: readonly number[]): [number, number, number, number, number, number] {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  const det = a * d - b * c || 1;

  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * Ruler straight-edge: a stroke drawn along a ruler side commits as a straight line on that side, like a
 * pencil against a real ruler. Chains to an `inner` interceptor (hold-to-snap shapes), which keeps
 * working everywhere the ruler is not involved.
 */
export class RulerSnapInterceptor implements StrokeInterceptor {
  constructor(
    private readonly host: { getEdges(): readonly RulerEdge[] | null; getOpacity(): number },
    private readonly inner: StrokeInterceptor | null,
  ) {}

  strokeStart(brush: LowLatencyPencilBrush, pointer: Point, e: TEvent['e']): void {
    this.inner?.strokeStart(brush, pointer, e);
  }

  strokeSample(brush: LowLatencyPencilBrush, pointer: Point, e: TEvent['e'] | undefined): boolean {
    return this.inner?.strokeSample(brush, pointer, e) ?? false;
  }

  strokeFinalize(brush: LowLatencyPencilBrush): boolean {
    // A hold-to-snap shape (or a √) the teacher asked for wins; it also clears its own hold state.
    if (this.inner?.strokeFinalize(brush)) return true;

    const edges = this.host.getEdges();

    if (edges?.length) {
      const zoom = brush.canvas.getZoom() || 1;
      const sceneEdges: SceneEdge[] = [];

      for (const edge of edges) {
        const a = clientToScene(brush, edge.x1, edge.y1);
        const b = clientToScene(brush, edge.x2, edge.y2);

        if (a && b) sceneEdges.push({ a, b, length: Math.hypot(b.x - a.x, b.y - a.y), tolerance: edge.snapPx / zoom });
      }

      const snap = snapStrokeToEdges(brush.liveStrokePoints, sceneEdges, MIN_STROKE_PX / zoom);

      if (snap) {
        const canvas = brush.canvas;
        // A nib-swept brush (calligraphy) commits its filled outline swept along the straight edge.
        const nib = (brush as unknown as { outlinePathDataFor?: unknown }).outlinePathDataFor
          ? (brush as unknown as Parameters<typeof createSnappedBrushObject>[2])
          : null;
        const swept = nib
          ? createSnappedBrushObject(
              { kind: 'line', geometry: { type: 'poly', closed: false, points: [snap.from, snap.to] } },
              { color: String(brush.color), opacity: this.host.getOpacity() },
              nib,
            )
          : null;
        const line = swept ?? new Polyline([snap.from, snap.to], {
          stroke: String(brush.color),
          strokeWidth: brush.width,
          fill: '',
          opacity: this.host.getOpacity(),
          strokeLineCap: 'round',
          strokeLineJoin: 'round',
          strokeDashArray: brush.strokeDashArray ?? undefined,
          strokeUniform: true,
        });

        (line as unknown as Record<string, unknown>)[SNAPPED_SHAPE_PROP] = 'line';
        applySnappedShapeControls(line);

        if (canvas.contextTop) canvas.clearContext(canvas.contextTop);

        // Mirror what Fabric's own finalize leaves behind, minus the path (as shape-snap does).
        (brush as unknown as { _reset?: () => void })._reset?.();
        canvas.add(line);
        line.setCoords();
        canvas.requestRenderAll();

        return true;
      }
    }

    return false;
  }
}
