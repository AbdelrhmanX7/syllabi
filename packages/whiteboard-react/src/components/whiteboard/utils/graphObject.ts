import { FabricObject as BaseFabricObject, FabricText, Group, Line, Polyline } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { BOARD_TEXT_FONT } from '../ai/rasterize';

import { normalizeGraphSpec, planGraph } from './graphAxes';

import type { GraphSpec } from './graphAxes';

/**
 * Graph axes on the board — the Fabric half of utils/graphAxes.ts. A graph is ONE object (a Group of
 * its lines, arrow heads and numbers) that carries its spec in `wbGraph`, so it can be moved, resized,
 * copied, saved and — because the spec travels with it — edited later: editing rebuilds the group
 * from the new spec in the same place, at the same size.
 */

export const GRAPH_PROP = 'wbGraph';

/** Ink for the axes and numbers (never solid black), and the faint grid behind them. */
const AXIS_INK = '#1f2937';
const GRID_INK = '#d8dbe4';

/** `wbGraph` must survive save / load / copy: it is the only thing that makes a graph editable. */
export function registerGraphPersistence(): void {
  const base = BaseFabricObject as unknown as { customProperties?: string[] };

  if (!base.customProperties?.includes(GRAPH_PROP)) {
    base.customProperties = [...(base.customProperties ?? []), GRAPH_PROP];
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

/** A new graph object for `spec`; `scale` shrinks or grows it (1 = 360 px of plot). Its top-left is at (0, 0). */
export function buildGraphObject(spec: GraphSpec, scale = 1): Group {
  registerGraphPersistence();

  const clean = normalizeGraphSpec(spec);
  const plan = planGraph(clean);
  const still = { selectable: false, evented: false, strokeUniform: false } as const;
  const parts: FabricObject[] = [];

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
