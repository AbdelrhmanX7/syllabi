import { ActiveSelection } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { AI_OBJECT_PROP, translateObjects } from './boardObjects';
import { planHandConceptMap } from './handConceptMap';
import { estimateHandStyle, inkSamplesFromObjects } from './handStyle';
import { hashSeed, seededRandom } from './handwritingLayout';
import { planHandEdge } from './termsMap';
import { buildTermsMapObjects, penPath } from './termsMapObjects';

import type { AiObjectTag } from './boardObjects';
import type { ContentLang } from './markdownBlocks';
import type { ConceptMap, SceneRect } from './types';

/**
 * Making a hand-drawn concept map on the board easy to handle (the map is plain pen ink — paths and
 * written-text groups — tagged per node / link by termsMapObjects.ts):
 *
 * - Drag a node (its outline or its words): the rest of the node comes along live; on release it is
 *   nudged off any node it landed on, and every link touching it is redrawn between the new
 *   positions (shaft broken round its phrase, the phrase moved along).
 * - Drag a link, a phrase or the title: the whole map comes along.
 * - «Move whole map» (HandMapControls) selects every part, so it moves as one.
 * - «Tidy» lays the map out again from scratch where it stands (the layered layout, nothing
 *   overlapping).
 *
 * Every change is one synchronous burst of canvas events, so the editor's snapshot records it with
 * the move as ONE undo step. Maps drawn before these tags existed carry no `lh` and are left alone.
 */

type Tagged = FabricObject & { [AI_OBJECT_PROP]?: AiObjectTag };

export const tagOf = (object: FabricObject): AiObjectTag | undefined => (object as Tagged)[AI_OBJECT_PROP];

/** A part of a hand-drawn concept map that can be moved / redrawn (has its letter height). */
export const isHandMapPart = (object: FabricObject) => {
  const tag = tagOf(object);

  return Boolean(tag?.batch && typeof tag.lh === 'number' && tag.lh > 0 && tag.kind.startsWith('terms-'));
};

/** The node a part belongs to (outline, ring, written words, copied ink), if any. */
export function nodeOfPart(tag: AiObjectTag | undefined): string | undefined {
  if (!tag) return undefined;
  if ((tag.kind === 'terms-node' || tag.kind === 'terms-ink') && tag.source && tag.source !== '__title') return tag.source;
  if (tag.kind === 'terms-label') return tag.node;

  return undefined;
}

/** The link (`from->to`) a part belongs to (shaft / head stroke, written phrase), if any. */
export function edgeOfPart(tag: AiObjectTag | undefined): string | undefined {
  if (!tag) return undefined;
  if (tag.kind === 'terms-edge') return tag.source;
  if (tag.kind === 'terms-label') return tag.edge;

  return undefined;
}

/** Store the map on its first outline, so «Tidy» can lay it out again after a reload. */
export function rememberHandMap(objects: FabricObject[], map: ConceptMap): void {
  const first = objects.find((object) => tagOf(object)?.kind === 'terms-node');
  const tag = first && tagOf(first);

  if (tag) tag.map = JSON.stringify({ title: map.title, nodes: map.nodes.map(({ bbox: _bbox, ...node }) => node), edges: map.edges });
}

const hits = (a: SceneRect, b: SceneRect) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/**
 * The smallest shift that takes `rect` off every rect in `others` (each kept `gap` away): push out
 * along the shorter overlap axis, repeat. Zero when nothing is hit.
 */
export function nudgeOff(rect: SceneRect, others: SceneRect[], gap: number): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;

  for (let round = 0; round < 40; round += 1) {
    const moved = { ...rect, left: rect.left + dx, top: rect.top + dy };
    const grown = (other: SceneRect) => ({ left: other.left - gap, top: other.top - gap, width: other.width + gap * 2, height: other.height + gap * 2 });
    const hit = others.map(grown).find((other) => hits(moved, other));

    if (!hit) break;
    const pushRight = hit.left + hit.width - moved.left;
    const pushLeft = moved.left + moved.width - hit.left;
    const pushDown = hit.top + hit.height - moved.top;
    const pushUp = moved.top + moved.height - hit.top;
    const best = Math.min(pushRight, pushLeft, pushDown, pushUp);

    if (best === pushRight) dx += pushRight;
    else if (best === pushLeft) dx -= pushLeft;
    else if (best === pushDown) dy += pushDown;
    else dy -= pushUp;
  }

  const clear = (x: number, y: number) =>
    !others.some((other) => hits({ ...rect, left: rect.left + x, top: rect.top + y }, { left: other.left - gap, top: other.top - gap, width: other.width + gap * 2, height: other.height + gap * 2 }));

  if (clear(dx, dy)) return { dx, dy };

  // Wedged between two (pushing off one lands on the other): the nearest free spot on rings round
  // where it was dropped.
  const step = Math.max(gap, Math.min(rect.width, rect.height) / 3, 1);

  for (let ring = 1; ring <= 80; ring += 1) {
    let best: { dx: number; dy: number; d: number } | null = null;

    for (let i = -ring; i <= ring; i += 1) {
      for (const j of Math.abs(i) === ring ? Array.from({ length: ring * 2 + 1 }, (_, k) => k - ring) : [-ring, ring]) {
        const x = i * step;
        const y = j * step;
        const d = Math.hypot(x, y);

        if ((!best || d < best.d) && clear(x, y)) best = { dx: x, dy: y, d };
      }
    }
    if (best) return { dx: best.dx, dy: best.dy };
  }

  return { dx, dy };
}

const unionRect = (rects: SceneRect[]): SceneRect | null => {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));

  return {
    left,
    top,
    width: Math.max(...rects.map((rect) => rect.left + rect.width)) - left,
    height: Math.max(...rects.map((rect) => rect.top + rect.height)) - top,
  };
};

const boundsOf = (object: FabricObject): SceneRect => {
  object.setCoords();
  const rect = object.getBoundingRect();

  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};

/** All parts of one map (by batch), in canvas order. */
export const mapParts = (canvas: Canvas, batch: string) => canvas.getObjects().filter((object) => isHandMapPart(object) && tagOf(object)!.batch === batch);

/** A node's ellipse, read off its (smallest) outline as it now stands. */
function nodeEllipse(parts: FabricObject[], node: string): { cx: number; cy: number; rx: number; ry: number; rect: SceneRect } | null {
  const outlines = parts.filter((object) => tagOf(object)?.kind === 'terms-node' && tagOf(object)?.source === node).map(boundsOf);
  const words = parts.filter((object) => nodeOfPart(tagOf(object)) === node).map(boundsOf);
  const rect = outlines.sort((a, b) => a.width * a.height - b.width * b.height)[0] ?? unionRect(words);

  if (!rect) return null;

  return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, rx: rect.width / 2, ry: rect.height / 2, rect };
}

/** Redraw one link between its nodes as they now stand; its phrase moves to the new break. */
function rerouteEdge(canvas: Canvas, parts: FabricObject[], key: string): void {
  const strokes = parts.filter((object) => tagOf(object)?.kind === 'terms-edge' && tagOf(object)?.source === key);
  const phrase = parts.filter((object) => tagOf(object)?.kind === 'terms-label' && tagOf(object)?.edge === key);
  const split = key.indexOf('->');

  if (strokes.length === 0 || split < 0) return;
  const from = key.slice(0, split);
  const to = key.slice(split + 2);
  const a = nodeEllipse(parts, from);
  const b = nodeEllipse(parts, to);

  if (!a || !b) return;
  const tag = tagOf(strokes[0]!)!;
  const lh = tag.lh!;
  const lines = phrase
    .map((object) => ({ text: tagOf(object)?.source ?? '', top: boundsOf(object).top }))
    .sort((p, q) => p.top - q.top)
    .map((line) => line.text)
    .filter(Boolean);
  // Phrases may not land on a node (its own ends included) or on another link's phrase.
  const nodeRects = Array.from(new Set(parts.map((object) => nodeOfPart(tagOf(object))).filter((id): id is string => Boolean(id))))
    .map((id) => nodeEllipse(parts, id)?.rect)
    .filter((rect): rect is SceneRect => Boolean(rect));
  const otherPhrases = parts.filter((object) => tagOf(object)?.kind === 'terms-label' && tagOf(object)?.edge && tagOf(object)?.edge !== key).map(boundsOf);
  const taken = [...nodeRects, ...otherPhrases];
  const plan = (withPhrase: boolean) =>
    planHandEdge(
      { from, to, label: withPhrase && lines.length ? lines.join(' ') : undefined, lines: withPhrase ? lines : [], arrow: tag.arrow ?? 'end' },
      { centre: { x: a.cx, y: a.cy }, rx: a.rx, ry: a.ry },
      { centre: { x: b.cx, y: b.cy }, rx: b.rx, ry: b.ry },
      {
        step: 0,
        letterHeight: lh,
        random: seededRandom(hashSeed(`${tag.batch}:${key}`)),
        avoid: (rect) => taken.some((other) => hits(rect, other)),
      },
    );
  let made = plan(true);
  let phraseAt = unionRect(made.flatMap((primitive) => (primitive.kind === 'label' ? [primitive.box] : [])));

  // No free spot along the link (two nodes dropped close): one whole shaft, the phrase pushed off
  // whatever it landed on.
  if (phraseAt && taken.some((other) => hits(phraseAt!, other))) {
    const { dx, dy } = nudgeOff(phraseAt, taken, lh * 0.2);

    phraseAt = { ...phraseAt, left: phraseAt.left + dx, top: phraseAt.top + dy };
    made = plan(false);
  }
  const style = strokes[0]!;
  const color = typeof style.stroke === 'string' ? style.stroke : '#18204a';
  const strokeWidth = style.strokeWidth ?? 2;
  const fresh: FabricObject[] = [];

  for (const primitive of made) {
    if (primitive.kind !== 'arrow') continue;
    for (const d of `${primitive.d} ${primitive.head}`.split(/(?=M )/).map((part) => part.trim()).filter(Boolean)) {
      const path = penPath(d, { color, strokeWidth });

      (path as Tagged)[AI_OBJECT_PROP] = { kind: 'terms-edge', source: key, batch: tag.batch, lh, arrow: tag.arrow ?? 'end' };
      fresh.push(path);
    }
  }
  const target = phraseAt;
  const current = unionRect(phrase.map(boundsOf));

  if (target && current) {
    translateObjects(phrase, target.left + target.width / 2 - (current.left + current.width / 2), target.top + target.height / 2 - (current.top + current.height / 2));
  }

  const at = canvas.getObjects().indexOf(strokes[0]!);

  canvas.remove(...strokes);
  canvas.insertAt(Math.max(0, Math.min(at, canvas.getObjects().length)), ...fresh);
}

/**
 * After a move: every node of the map that was moved (not the whole map) is nudged off the others
 * and its links are redrawn. `moved` = the objects that were dragged.
 */
export function settleMovedNodes(canvas: Canvas, moved: FabricObject[]): boolean {
  const batches = new Set(moved.filter(isHandMapPart).map((object) => tagOf(object)!.batch!));
  let changed = false;

  for (const batch of Array.from(batches)) {
    const parts = mapParts(canvas, batch);

    if (parts.every((part) => moved.includes(part))) continue; // the whole map moved as one
    const nodes = Array.from(new Set(moved.filter((object) => tagOf(object)?.batch === batch).map((object) => nodeOfPart(tagOf(object))).filter((id): id is string => Boolean(id))));

    if (nodes.length === 0) continue;
    const lh = tagOf(parts[0]!)!.lh!;
    const allNodes = Array.from(new Set(parts.map((object) => nodeOfPart(tagOf(object))).filter((id): id is string => Boolean(id))));

    for (const node of nodes) {
      const own = nodeEllipse(parts, node);
      const others = allNodes
        .filter((id) => !nodes.includes(id))
        .map((id) => nodeEllipse(parts, id)?.rect)
        .filter((rect): rect is SceneRect => Boolean(rect));

      if (!own) continue;
      const { dx, dy } = nudgeOff(own.rect, others, lh * 0.5);

      if (dx || dy) translateObjects(parts.filter((object) => nodeOfPart(tagOf(object)) === node), dx, dy);
    }

    const links = new Set(
      parts
        .map((object) => edgeOfPart(tagOf(object)))
        .filter((key): key is string => Boolean(key) && nodes.some((node) => key!.startsWith(`${node}->`) || key!.endsWith(`->${node}`))),
    );

    for (const key of Array.from(links)) rerouteEdge(canvas, mapParts(canvas, batch), key);
    changed = true;
  }

  return changed;
}

/**
 * What a tap on a map part should select: the whole node for a node part, the whole map for a link,
 * a phrase or the title. Null = leave the selection alone.
 */
export function expandMapSelection(canvas: Canvas, selected: FabricObject[]): FabricObject[] | null {
  const parts = selected.filter(isHandMapPart);

  if (parts.length === 0) return null;
  const want = new Set(selected);

  for (const part of parts) {
    const tag = tagOf(part)!;
    const node = nodeOfPart(tag);
    const all = mapParts(canvas, tag.batch!);

    for (const object of node ? all.filter((other) => nodeOfPart(tagOf(other)) === node) : all) want.add(object);
  }

  return want.size === selected.length ? null : Array.from(want);
}

/**
 * The parts that ride along when `target` is dragged: the rest of its node for a node part, the
 * rest of the map for a link / phrase / title part. [] for anything else (or a multi-selection,
 * which already moves what it holds).
 */
export function dragCompanions(canvas: Canvas, target: FabricObject): FabricObject[] {
  if (target instanceof ActiveSelection || !isHandMapPart(target)) return [];
  const want = expandMapSelection(canvas, [target]);

  return want ? want.filter((object) => object !== target) : [];
}

/** Is this `object:modified` the end of a pointer drag (not a recolour / restroke, which fire it too)? */
export const isPointerDrag = (event: { transform?: { action?: string } | null }) => event.transform?.action === 'drag';

/**
 * Wire the map's handling onto a canvas: while a part is dragged, the rest of its node (or, for a
 * link / phrase / title, the rest of the map) follows it live — plain `set`s, no events; on release
 * the moved nodes are nudged clear and their links redrawn (one burst = one undo step). Fabric's own
 * press → drag is left alone (swapping the selection on press would cost the drag). Returns the detach.
 */
export function attachHandConceptMapControl(canvas: Canvas): () => void {
  let busy = false;
  // The drag in progress: its target, where it started, and its companions' starting spots.
  let dragging: { target: FabricObject; left: number; top: number; companions: Array<{ object: FabricObject; left: number; top: number }> } | null = null;

  const onMoving = (event: { target?: FabricObject; transform?: { original?: { left?: number; top?: number } } }) => {
    const target = event.target;

    if (busy || !target) return;
    if (!dragging || dragging.target !== target) {
      const companions = dragCompanions(canvas, target);

      if (companions.length === 0) {
        dragging = null;

        return;
      }
      dragging = {
        target,
        left: event.transform?.original?.left ?? target.left ?? 0,
        top: event.transform?.original?.top ?? target.top ?? 0,
        companions: companions.map((object) => ({ object, left: object.left ?? 0, top: object.top ?? 0 })),
      };
    }
    const dx = (target.left ?? 0) - dragging.left;
    const dy = (target.top ?? 0) - dragging.top;

    for (const companion of dragging.companions) {
      companion.object.set({ left: companion.left + dx, top: companion.top + dy });
      companion.object.setCoords();
    }
  };

  const onModified = (event: { target?: FabricObject; transform?: { action?: string } | null }) => {
    const held = dragging;

    dragging = null;
    if (busy || !event.target || !isPointerDrag(event)) return;
    const dragged = event.target instanceof ActiveSelection ? event.target.getObjects() : [event.target];
    const moved = [...dragged, ...(held && held.target === event.target ? held.companions.map((companion) => companion.object) : [])];

    if (!moved.some(isHandMapPart)) return;
    busy = true;
    try {
      // Out of a multi-selection first: its members report group-relative positions.
      const reselect = canvas.getActiveObjects();
      const multi = canvas.getActiveObject() instanceof ActiveSelection;

      if (multi) canvas.discardActiveObject();
      settleMovedNodes(canvas, moved);
      if (multi) {
        const alive = reselect.filter((object) => canvas.getObjects().includes(object));

        if (alive.length) canvas.setActiveObject(alive.length === 1 ? alive[0]! : new ActiveSelection(alive, { canvas }));
      }
      canvas.requestRenderAll();
    } finally {
      busy = false;
    }
  };

  canvas.on('object:moving', onMoving as never);
  canvas.on('object:modified', onModified as never);

  return () => {
    canvas.off('object:moving', onMoving as never);
    canvas.off('object:modified', onModified as never);
  };
}
/** The map the active selection belongs to (its batch), if any. */
export function selectedHandMap(canvas: Canvas): string | null {
  const part = canvas.getActiveObjects().find(isHandMapPart);

  return part ? tagOf(part)!.batch! : null;
}

/** Select every part of a map, so it moves as one. */
export function selectWholeMap(canvas: Canvas, batch: string): void {
  const parts = mapParts(canvas, batch);

  if (parts.length === 0) return;
  canvas.discardActiveObject();
  canvas.setActiveObject(new ActiveSelection(parts, { canvas }));
  canvas.requestRenderAll();
}

/**
 * «Tidy»: lay the map out again from scratch (the layered layout — nothing overlapping), written at
 * its letter height, its top-left where the map's top-left now is. ONE tick: old parts out, new in.
 * False when the map carries no stored graph (drawn before it was stored).
 */
export async function tidyHandMap(canvas: Canvas, batch: string, { lang, zoom }: { lang?: ContentLang; zoom: number }): Promise<boolean> {
  const parts = mapParts(canvas, batch);
  const holder = parts.find((object) => tagOf(object)?.map);

  if (!holder) return false;
  let map: ConceptMap;

  try {
    map = JSON.parse(tagOf(holder)!.map!) as ConceptMap;
  } catch {
    return false;
  }
  canvas.discardActiveObject();
  const lh = tagOf(holder)!.lh!;
  const where = unionRect(parts.map(boundsOf));
  const outline = parts.find((object) => tagOf(object)?.kind === 'terms-node') ?? holder;
  const others = canvas.getObjects().filter((object) => !parts.includes(object) && object.visible !== false);
  const hand = estimateHandStyle(inkSamplesFromObjects(others));
  const color = typeof outline.stroke === 'string' ? outline.stroke : (hand?.color ?? '#18204a');
  const strokeWidth = outline.strokeWidth ?? hand?.strokeWidth ?? 2;
  const plan = planHandConceptMap(map, { letterHeight: lh });
  const built = await buildTermsMapObjects(plan, {
    sources: new Map(),
    color,
    strokeWidth,
    hand: hand ? { ...hand, color, letterHeight: lh, strokeWidth } : null,
    zoom,
    lang,
    batch,
    lh,
  });

  if (built.objects.length === 0 || !where) return false;
  // The page may have changed while the words were being written.
  if (!parts.every((part) => canvas.getObjects().includes(part))) return false;
  rememberHandMap(built.objects, map);
  translateObjects(built.objects, where.left, where.top);
  canvas.remove(...parts);
  canvas.add(...built.objects);
  canvas.requestRenderAll();

  return true;
}
