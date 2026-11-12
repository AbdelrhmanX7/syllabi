import { FabricImage, FabricObject as BaseFabricObject, FabricText, Group, Line, Polyline, Rect } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { BOARD_TEXT_FONT } from '../ai/rasterize';

import { normalizeGraphSpec, planGraph } from './graphAxes';

import type { GraphPlan, GraphSpec } from './graphAxes';

/**
 * Graph axes on the board — the Fabric half of utils/graphAxes.ts. A graph is ONE object (a Group of
 * its lines, arrow heads and numbers) that carries its spec in `wbGraph`, so it can be moved, resized,
 * copied, saved and — because the spec travels with it — edited later: editing rebuilds the group
 * from the new spec in the same place, at the same size.
 */

export const GRAPH_PROP = 'wbGraph';
/** On a PINNED graph (a picture of it, see {@link graphToPinnedImage}): the size and turn to give it back on unpin. */
export const GRAPH_FRAME_PROP = 'wbGraphFrame';

/** Ink for the axes and numbers (never solid black), and the faint grid behind them. */
const AXIS_INK = '#1f2937';
const GRID_INK = '#d8dbe4';

/** `wbGraph` must survive save / load / copy: it is the only thing that makes a graph editable. */
export function registerGraphPersistence(): void {
  const base = BaseFabricObject as unknown as { customProperties?: string[] };

  for (const prop of [GRAPH_PROP, GRAPH_FRAME_PROP]) {
    if (!base.customProperties?.includes(prop)) base.customProperties = [...(base.customProperties ?? []), prop];
  }
  // A pinned graph is a picture: the picture class keeps its own list.
  for (const prop of [GRAPH_PROP, GRAPH_FRAME_PROP]) {
    if (!FabricImage.customProperties?.includes(prop)) FabricImage.customProperties = [...(FabricImage.customProperties ?? []), prop];
  }
}

// At import, not on first use: a board that LOADS a graph and saves again must keep `wbGraph` even
// when no graph was built in this session.
registerGraphPersistence();

/** The spec of a graph object, or null when the object is not one. */
export function graphSpecOf(object: unknown): GraphSpec | null {
  const raw = (object as Record<string, unknown> | null | undefined)?.[GRAPH_PROP];

  return raw && typeof raw === 'object' ? normalizeGraphSpec(raw as Partial<GraphSpec>) : null;
}

/** Everything the plan draws, with room for the numbers' own width, plus a margin. */
export function graphBounds(plan: GraphPlan, margin = 10): { left: number; top: number; width: number; height: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const take = (x: number, y: number) => {
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  };

  for (const line of plan.lines) {
    take(line.x1, line.y1);
    take(line.x2, line.y2);
  }

  for (const label of plan.labels) {
    const width = Array.from(label.text).length * plan.fontSize * 0.62;
    const height = plan.fontSize * 1.2;
    const x = label.alignX === 'left' ? label.x : label.alignX === 'right' ? label.x - width : label.x - width / 2;
    const y = label.alignY === 'top' ? label.y : label.alignY === 'bottom' ? label.y - height : label.y - height / 2;

    take(x, y);
    take(x + width, y + height);
  }

  return { left: left - margin, top: top - margin, width: right - left + margin * 2, height: bottom - top + margin * 2 };
}

/** A new graph object for `spec`; `scale` shrinks or grows it (1 = 360 px of plot). Its top-left is at (0, 0). */
export function buildGraphObject(spec: GraphSpec, scale = 1): Group {
  registerGraphPersistence();

  const clean = normalizeGraphSpec(spec);
  const plan = planGraph(clean);
  const still = { selectable: false, evented: false, strokeUniform: false } as const;
  const parts: FabricObject[] = [];
  // A white card behind the whole graph (numbers and arrows included), so it reads on lined or squared
  // paper, over a PDF and on the dark board.
  const box = graphBounds(plan);

  parts.push(
    new Rect({
      ...still,
      originX: 'left',
      originY: 'top',
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      rx: 8,
      ry: 8,
      fill: '#ffffff',
      stroke: GRID_INK,
      strokeWidth: 1,
    }),
  );

  for (const kind of ['grid', 'tick', 'axis'] as const) {
    for (const line of plan.lines) {
      if (line.kind !== kind) continue;

      parts.push(
        new Line([line.x1, line.y1, line.x2, line.y2], {
          ...still,
          stroke: kind === 'grid' ? GRID_INK : AXIS_INK,
          strokeWidth: kind === 'axis' ? 2 : kind === 'tick' ? 1.5 : 1,
          strokeLineCap: 'round',
        }),
      );
    }
  }

  for (const arrow of plan.arrows) {
    // A small open head: two strokes back from the tip, 28° off the axis.
    const back = 9;
    const spread = 4.5;
    const nx = -arrow.dy;
    const ny = arrow.dx;
    const base = { x: arrow.x - arrow.dx * back, y: arrow.y - arrow.dy * back };

    parts.push(
      new Polyline(
        [
          { x: base.x + nx * spread, y: base.y + ny * spread },
          { x: arrow.x, y: arrow.y },
          { x: base.x - nx * spread, y: base.y - ny * spread },
        ],
        { ...still, fill: '', stroke: AXIS_INK, strokeWidth: 2, strokeLineCap: 'round', strokeLineJoin: 'round' },
      ),
    );
  }

  for (const label of plan.labels) {
    parts.push(
      new FabricText(label.text, {
        ...still,
        left: label.x,
        top: label.y,
        originX: label.alignX,
        originY: label.alignY,
        fontSize: label.name ? plan.fontSize + 2 : plan.fontSize,
        fontStyle: label.name ? 'italic' : 'normal',
        fontFamily: BOARD_TEXT_FONT,
        fontWeight: 500,
        fill: AXIS_INK,
      }),
    );
  }

  const group = new Group(parts, { originX: 'left', originY: 'top', left: 0, top: 0, scaleX: scale, scaleY: scale });

  (group as unknown as Record<string, unknown>)[GRAPH_PROP] = clean;

  return group;
}

/**
 * Edits a graph in place: a new group for `spec` takes the old one's place — same spot (its top-left
 * stays put), same size on the page, same turn, same layer — and becomes the selection. One remove and
 * one add in the same tick: one undo step.
 */
export function replaceGraphObject(canvas: Canvas, current: FabricObject, spec: GraphSpec): FabricObject {
  const next = buildGraphObject(spec, current.scaleX ?? 1);
  const corner = current.getPointByOrigin('left', 'top');
  const index = canvas.getObjects().indexOf(current);

  next.set({ scaleX: current.scaleX ?? 1, scaleY: current.scaleY ?? 1, angle: current.angle ?? 0 });
  next.setPositionByOrigin(corner, 'left', 'top');
  next.setCoords();

  canvas.discardActiveObject();
  canvas.remove(current);

  if (index >= 0) canvas.insertAt(index, next);
  else canvas.add(next);

  canvas.setActiveObject(next);
  canvas.requestRenderAll();

  return next;
}

/**
 * A graph to PIN: a sharp picture of it, in the same place, carrying the graph's spec and frame. The
 * board's pinned pictures live under the ink and survive every eraser — so points drawn on a pinned
 * graph can be rubbed out without ever touching the graph. Null when it cannot be drawn.
 */
export async function graphToPinnedImage(graph: FabricObject): Promise<FabricImage | null> {
  const spec = graphSpecOf(graph);

  if (!spec) return null;

  const multiplier = 3;
  const centre = graph.getCenterPoint();
  const angle = graph.angle ?? 0;

  // Drawn upright (the turn goes onto the picture), so unpinning restores it exactly.
  graph.set({ angle: 0 });
  graph.setCoords();

  let url: string;

  try {
    url = graph.toCanvasElement({ multiplier }).toDataURL('image/png');
  } catch {
    return null;
  } finally {
    graph.set({ angle });
    graph.setCoords();
  }

  const image = await FabricImage.fromURL(url);

  image.set({ originX: 'center', originY: 'center', left: centre.x, top: centre.y, scaleX: 1 / multiplier, scaleY: 1 / multiplier, angle });
  image.setCoords();
  (image as unknown as Record<string, unknown>)[GRAPH_PROP] = spec;
  (image as unknown as Record<string, unknown>)[GRAPH_FRAME_PROP] = { scaleX: graph.scaleX ?? 1, scaleY: graph.scaleY ?? 1 };

  return image;
}

/** The editable graph a pinned picture stands for, in the same place; null when the picture is not a pinned graph. */
export function pinnedImageToGraph(image: FabricObject): Group | null {
  const spec = graphSpecOf(image);

  if (!spec || !(image instanceof FabricImage)) return null;

  const frame = (image as unknown as Record<string, { scaleX?: number; scaleY?: number } | undefined>)[GRAPH_FRAME_PROP];
  const graph = buildGraphObject(spec, frame?.scaleX ?? 1);

  graph.set({ scaleX: frame?.scaleX ?? 1, scaleY: frame?.scaleY ?? frame?.scaleX ?? 1, angle: image.angle ?? 0 });
  graph.setPositionByOrigin(image.getCenterPoint(), 'center', 'center');
  graph.setCoords();

  return graph;
}
