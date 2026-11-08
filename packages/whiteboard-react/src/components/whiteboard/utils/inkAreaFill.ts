import { Path, Point, util } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { inkPenOf } from '../brushes/inkPenMark';
import { fitOutline, outlineLoopPoints } from './inkOutlineResize';
import { FILL_STYLE_PROP, INK_FILL_PROP } from './shapeStyle';
import { isInkAreaFill, isStyledShape } from './shapeStylePaint';

import type { OutlinePoint } from './inkOutlineResize';
import type { ShapeFillStyle } from './shapeStyle';

/**
 * A background for hand-drawn ink: the area a stroke (or a few strokes) encloses, filled with a colour or
 * a hatch and laid UNDER the ink, so the handwriting stays on top.
 *
 * The fill is its own object — a plain filled path marked `wbInkFill` — inserted just below the lowest of
 * the strokes in the same burst of changes (one undo step). Choosing a fill again on a selection that
 * holds it edits it; choosing «none» removes it. Old copies of the app open it as a plain filled shape.
 *
 * The area is the stroke's centre line, closed from its last point back to its first:
 *   - a pen stroke (a line with a width) is its own path;
 *   - an outline stroke (the brush / script pens save the outline of the mark) is paired side to side
 *     (see `inkOutlineResize`), and the midpoints of the pairs are the centre line.
 * Several strokes (a box drawn in four lines) are chained end to nearest end into one outline first.
 */

type Pathish = FabricObject & { path?: ReadonlyArray<ReadonlyArray<string | number>>; pathOffset: Point };

/** Is this a hand-drawn ink stroke (a freehand path, not a shape, an eraser mark or a fill)? */
export function isInkStroke(object: FabricObject): boolean {
  if (!object.isType('Path') || isInkAreaFill(object) || isStyledShape(object)) return false;

  return (object as FabricObject & { globalCompositeOperation?: string }).globalCompositeOperation !== 'destination-out';
}

/** The centre line of an outline loop, end to end (one side's pairing midpoints). */
export function outlineCentreLine(points: readonly OutlinePoint[], axis: number): OutlinePoint[] {
  const count = points.length;
  const start = Math.ceil(axis / 2);
  const half = Math.floor(count / 2);
  const out: OutlinePoint[] = [];

  for (let k = 0; k <= half; k += 1) {
    const i = (((start + k) % count) + count) % count;
    const j = (((axis - i) % count) + count) % count;

    out.push({ x: (points[i]!.x + points[j]!.x) / 2, y: (points[i]!.y + points[j]!.y) / 2 });
  }

  return out;
}

/** Points along a path's commands (curves sampled), in path space. */
function samplePath(path: ReadonlyArray<ReadonlyArray<string | number>>): OutlinePoint[] {
  const out: OutlinePoint[] = [];
  let at = { x: 0, y: 0 };

  for (const command of path) {
    const op = String(command[0]).toUpperCase();
    const n = command.slice(1).map(Number);

    if (op === 'M' || op === 'L') {
      at = { x: n[0]!, y: n[1]! };
      out.push(at);
    } else if (op === 'Q') {
      for (let s = 1; s <= 4; s += 1) {
        const t = s / 4;
        const u = 1 - t;

        out.push({ x: u * u * at.x + 2 * u * t * n[0]! + t * t * n[2]!, y: u * u * at.y + 2 * u * t * n[1]! + t * t * n[3]! });
      }
      at = { x: n[2]!, y: n[3]! };
    } else if (op === 'C') {
      for (let s = 1; s <= 6; s += 1) {
        const t = s / 6;
        const u = 1 - t;

        out.push({
          x: u * u * u * at.x + 3 * u * u * t * n[0]! + 3 * u * t * t * n[2]! + t * t * t * n[4]!,
          y: u * u * u * at.y + 3 * u * u * t * n[1]! + 3 * u * t * t * n[3]! + t * t * t * n[5]!,
        });
      }
      at = { x: n[4]!, y: n[5]! };
    }
  }

  return out;
}

/** A stroke's centre line in SCENE coordinates (null when it has none we can read). */
export function strokeCentreLine(object: FabricObject): OutlinePoint[] | null {
  const path = (object as Pathish).path;

  if (!path) return null;

  const stroked = typeof object.stroke === 'string' && object.stroke !== '' && (object.strokeWidth ?? 0) > 0;
  let local: OutlinePoint[] | null;

  if (stroked) {
    local = samplePath(path);
  } else {
    const loop = outlineLoopPoints(path);

    local = loop ? outlineCentreLine(loop, fitOutline(loop, inkPenOf(object)).axis) : null;
  }

  if (!local || local.length < 2) return null;

  const offset = (object as Pathish).pathOffset;
  const matrix = object.calcTransformMatrix();

  return local.map((p) => {
    const scene = util.transformPoint(new Point(p.x - offset.x, p.y - offset.y), matrix);

    return { x: scene.x, y: scene.y };
  });
}

/** Chains polylines end to nearest end (flipping as needed) into one outline, starting from the first. */
export function chainLines(lines: ReadonlyArray<readonly OutlinePoint[]>): OutlinePoint[] {
  const rest = lines.filter((line) => line.length > 0).map((line) => line.slice());
  const out: OutlinePoint[] = rest.shift() ?? [];

  while (rest.length > 0) {
    const tail = out[out.length - 1]!;
    let best = 0;
    let flip = false;
    let bestDistance = Number.POSITIVE_INFINITY;

    rest.forEach((line, index) => {
      const toStart = Math.hypot(line[0]!.x - tail.x, line[0]!.y - tail.y);
      const toEnd = Math.hypot(line[line.length - 1]!.x - tail.x, line[line.length - 1]!.y - tail.y);

      if (toStart < bestDistance) {
        bestDistance = toStart;
        best = index;
        flip = false;
      }
      if (toEnd < bestDistance) {
        bestDistance = toEnd;
        best = index;
        flip = true;
      }
    });

    const [next] = rest.splice(best, 1);

    out.push(...(flip ? next!.reverse() : next!));
  }

  return out;
}

/**
 * Sets (or with `transparent`, removes) the fill under the selected ink. `strokes` are the selected ink
 * strokes; `existing` any ink fills already in the selection. Returns the fill object (or null), and
 * whether anything changed.
 */
export function setInkAreaFill(
  canvas: Canvas,
  strokes: readonly FabricObject[],
  existing: readonly FabricObject[],
  fill: { color?: string; style?: ShapeFillStyle },
): { object: FabricObject | null; changed: boolean } {
  const none = fill.color !== undefined && (!fill.color || fill.color === 'transparent');

  if (existing.length > 0) {
    if (none) {
      canvas.remove(...existing);

      return { object: null, changed: true };
    }

    for (const object of existing) {
      if (fill.color !== undefined) object.set('fill', fill.color);
      if (fill.style !== undefined) object.set(FILL_STYLE_PROP as never, (fill.style === 'solid' ? undefined : fill.style) as never);
      object.set('dirty', true);
      canvas.fire('object:modified', { target: object } as never);
    }

    return { object: existing[0]!, changed: true };
  }

  // Only a colour creates a fill; picking a pattern alone with no fill yet waits for a colour.
  if (none || fill.color === undefined || strokes.length === 0) return { object: null, changed: false };

  const lines = strokes.map(strokeCentreLine).filter((line): line is OutlinePoint[] => !!line && line.length >= 2);
  const outline = chainLines(lines);

  if (outline.length < 3) return { object: null, changed: false };

  const data = [...outline.map((p, i): Array<string | number> => [i === 0 ? 'M' : 'L', p.x, p.y]), ['Z']];
  const area = new Path(data as never, {
    fill: fill.color,
    stroke: '',
    strokeWidth: 0,
    fillRule: 'nonzero',
    objectCaching: true,
  });

  (area as unknown as Record<string, unknown>)[INK_FILL_PROP] = true;
  if (fill.style && fill.style !== 'solid') (area as unknown as Record<string, unknown>)[FILL_STYLE_PROP] = fill.style;

  const objects = canvas.getObjects();
  const lowest = Math.min(...strokes.map((stroke) => objects.indexOf(stroke)).filter((index) => index >= 0));

  canvas.insertAt(Number.isFinite(lowest) ? lowest : 0, area);
  area.setCoords();

  return { object: area, changed: true };
}
