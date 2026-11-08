import { boundaryPoint, layoutGraph } from './graphLayout';
import { hashSeed, seededRandom } from './handwritingLayout';
import { extractJsonObject } from './markdownBlocks';

import type { ConceptMapDirection, SceneRect, TermsMapDirection, TermsMapEdge, TermsMapExtra, TermsMapNode, TermsMapResult } from './types';

/**
 * «Map my terms» — the pure half. The owner writes concept terms by hand and selects them; the client
 * cuts the ink into term clusters, the model (any model: it only sees the picture + cluster boxes and
 * answers with STRUCTURE — which clusters form a node, the links, the missing concepts) returns a
 * `terms_map`, and this module turns that structure into a deterministic DRAW PLAN:
 *
 *   ink-copy  — move a copy of a cluster's own strokes into its node slot (the original stays put)
 *   outline   — a hand-drawn ellipse around a node (seeded wobble, overshooting closure)
 *   arrow     — a hand-drawn shaft (split around its label) + a two-stroke arrowhead
 *   label     — a linking phrase or an AI-added concept, written in the handwriting pipeline
 *
 * Geometry is the client's alone (graphLayout.ts), so the same answer always lands the same way.
 * The Fabric half is `termsMapObjects.ts`.
 */

export interface ScenePt {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Clustering: selected strokes → term-level ink clusters
// ---------------------------------------------------------------------------

export interface InkCluster {
  /** `c1`…`cn` in reading order. */
  id: string;
  /** Union of the members' boxes, scene units. */
  rect: SceneRect;
  /** Indexes into the input array. */
  members: number[];
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;

  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const gapBetween = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));

export const unionRect = (rects: SceneRect[]): SceneRect => {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const rect of rects) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.left + rect.width);
    bottom = Math.max(bottom, rect.top + rect.height);
  }

  return Number.isFinite(left) ? { left, top, width: right - left, height: bottom - top } : { left: 0, top: 0, width: 0, height: 0 };
};

/**
 * Strokes → term clusters by spatial proximity (union-find). Two strokes belong to one term when the
 * horizontal gap between their boxes is under a word space (≈ 0.9 letter height — wide enough to keep
 * «plate tectonics» together, narrow enough to split terms written apart) and the vertical gap is
 * under ≈ 0.35 letter height (dots and accents join their word; the next line does not).
 */
export function clusterInk(
  rects: SceneRect[],
  { letterHeight, wordGap = 0.9, lineGap = 0.35 }: { letterHeight?: number; wordGap?: number; lineGap?: number } = {},
): InkCluster[] {
  if (rects.length === 0) return [];

  const lh = letterHeight && letterHeight > 0 ? letterHeight : Math.max(1, median(rects.map((rect) => rect.height)));
  const gx = lh * wordGap;
  const gy = lh * lineGap;
  const parent = rects.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;

    while (parent[root] !== root) root = parent[root]!;

    while (parent[index] !== root) {
      const next = parent[index]!;

      parent[index] = root;
      index = next;
    }

    return root;
  };

  for (let i = 0; i < rects.length; i += 1) {
    const a = rects[i]!;

    for (let j = i + 1; j < rects.length; j += 1) {
      const b = rects[j]!;
      const dx = gapBetween(a.left, a.left + a.width, b.left, b.left + b.width);
      const dy = gapBetween(a.top, a.top + a.height, b.top, b.top + b.height);

      if (dx <= gx && dy <= gy) parent[find(i)] = find(j);
    }
  }

  const groups = new Map<number, number[]>();

  rects.forEach((_, index) => {
    const root = find(index);

    groups.set(root, [...(groups.get(root) ?? []), index]);
  });

  const clusters = Array.from(groups.values()).map((members) => ({ members, rect: unionRect(members.map((index) => rects[index]!)) }));

  // Reading order: rows top → bottom (a row = centres within ~0.6 lh), then along the writing direction.
  clusters.sort((a, b) => {
    const ay = a.rect.top + a.rect.height / 2;
    const by = b.rect.top + b.rect.height / 2;

    if (Math.abs(ay - by) > lh * 0.6) return ay - by;

    return a.rect.left - b.rect.left;
  });

  return clusters.map((cluster, index) => ({ id: `c${index + 1}`, rect: cluster.rect, members: cluster.members }));
}

// ---------------------------------------------------------------------------
// Parsing: the model's answer → a validated structure
// ---------------------------------------------------------------------------

const str = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  return undefined;
};

const MAX_LABEL = 60;

const DIRECTIONS: Record<string, TermsMapDirection> = {
  tb: 'TB', td: 'TB', bt: 'TB', 'top-down': 'TB', lr: 'LR', rl: 'LR', ltr: 'LR', rtl: 'LR', radial: 'radial',
};

const numberOr = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;

  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined;
};

/**
 * The model's `terms_map` → a structure the drawer can trust. Every selected cluster ends up in
 * exactly one node (a cluster the model skipped becomes its own node, so no ink is ever dropped; a
 * cluster claimed twice stays with the first claimer); a node left with no ink is kept as an AI-added
 * concept; edges must join known nodes; levels are filled from the edges when missing.
 */
export function parseTermsMap(input: unknown, clusterIds: readonly string[]): TermsMapResult | null {
  let value = typeof input === 'string' ? extractJsonObject(input) : input;

  if (!value || typeof value !== 'object') return null;

  for (const key of ['terms_map', 'termsMap', 'map', 'result']) {
    const inner = (value as Record<string, unknown>)[key];

    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      value = inner;
      break;
    }
  }

  const source = value as Record<string, unknown>;
  const known = new Set(clusterIds);
  const claimed = new Set<string>();
  const usedIds = new Set<string>();
  const nodes: TermsMapNode[] = [];
  const extra: TermsMapExtra[] = [];
  const levelHint = new Map<string, number | undefined>();
  const uniqueId = (raw: string | undefined, fallback: string) => {
    let id = raw ?? fallback;

    while (usedIds.has(id)) id = `${id}_`;
    usedIds.add(id);

    return id;
  };

  (Array.isArray(source.nodes) ? source.nodes : []).forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;

    const node = raw as Record<string, unknown>;
    const refs = Array.isArray(node.clusterIds) ? node.clusterIds : Array.isArray(node.clusters) ? node.clusters : node.cluster !== undefined ? [node.cluster] : [];
    const own = refs.map(str).filter((ref): ref is string => Boolean(ref && known.has(ref) && !claimed.has(ref)));
    const text = str(node.text ?? node.label) ?? '';
    const level = numberOr(node.level);

    own.forEach((ref) => claimed.add(ref));

    if (own.length === 0) {
      // Ink the model invented or double-claimed: if it names a concept, it is an AI-added one.
      if (!text) return;

      const id = uniqueId(str(node.id), `x${index + 1}`);

      extra.push({ id, text, level: level ?? 1 });
      levelHint.set(id, level);

      return;
    }

    const id = uniqueId(str(node.id), `n${index + 1}`);

    nodes.push({ id, text, clusterIds: Array.from(new Set(own)), level: level ?? 0, ...(node.focus === true ? { focus: true } : {}) });
    levelHint.set(id, level);
  });

  // Every cluster is drawn: the ones the model left out become nodes of their own.
  for (const ref of clusterIds) {
    if (claimed.has(ref)) continue;

    const id = uniqueId(`t_${ref}`, `t_${ref}`);

    nodes.push({ id, text: '', clusterIds: [ref], level: 1 });
    levelHint.set(id, undefined);
  }

  if (nodes.length === 0) return null;

  (Array.isArray(source.extra) ? source.extra : Array.isArray(source.extras) ? source.extras : []).forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;

    const item = raw as Record<string, unknown>;
    const text = str(item.text ?? item.label);

    if (!text) return;

    const id = uniqueId(str(item.id), `e${index + 1}`);
    const level = numberOr(item.level);

    extra.push({ id, text, level: level ?? 1 });
    levelHint.set(id, level);
  });

  const all = [...nodes.map((node) => ({ id: node.id, text: node.text })), ...extra];
  const byId = new Set(all.map((node) => node.id));
  const byText = new Map(all.filter((node) => node.text).map((node) => [node.text, node.id]));
  const resolve = (ref: unknown) => {
    const key = str(ref);

    if (!key) return undefined;

    return byId.has(key) ? key : byText.get(key);
  };
  const edges: TermsMapEdge[] = [];
  const seen = new Set<string>();

  for (const raw of Array.isArray(source.edges) ? source.edges : Array.isArray(source.links) ? source.links : []) {
    if (!raw || typeof raw !== 'object') continue;

    const edge = raw as Record<string, unknown>;
    const from = resolve(edge.from ?? edge.source);
    const to = resolve(edge.to ?? edge.target);

    if (!from || !to || from === to || seen.has(`${from}>${to}`)) continue;

    seen.add(`${from}>${to}`);

    const label = (str(edge.label ?? edge.text) ?? '').slice(0, MAX_LABEL);

    edges.push({ from, to, label });
  }

  // Levels: the model's where given, else breadth-first from the roots of the edges.
  if (Array.from(levelHint.values()).some((level) => level === undefined)) {
    const depth = bfsDepth(all.map((node) => node.id), edges, levelHint);

    for (const node of nodes) if (levelHint.get(node.id) === undefined) node.level = depth.get(node.id) ?? 1;
    for (const item of extra) if (levelHint.get(item.id) === undefined) item.level = depth.get(item.id) ?? 1;
  }

  const result: TermsMapResult = {
    direction: DIRECTIONS[str(source.direction)?.toLowerCase() ?? ''] ?? 'TB',
    nodes,
    edges,
    extra,
  };
  const title = str(source.title);

  if (title) result.title = title;

  return result;
}

function bfsDepth(ids: string[], edges: TermsMapEdge[], hints: Map<string, number | undefined>): Map<string, number> {
  const incoming = new Map(ids.map((id) => [id, 0]));

  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);

  const hinted = ids.filter((id) => hints.get(id) === 0);
  const roots = hinted.length ? hinted : ids.filter((id) => (incoming.get(id) ?? 0) === 0 && edges.some((edge) => edge.from === id));
  const depth = new Map<string, number>();
  const queue = roots.length ? [...roots] : ids.slice(0, 1);

  queue.forEach((id) => depth.set(id, hints.get(id) ?? 0));

  while (queue.length) {
    const current = queue.shift()!;

    for (const edge of edges) {
      if (edge.from === current && !depth.has(edge.to)) {
        depth.set(edge.to, (depth.get(current) ?? 0) + 1);
        queue.push(edge.to);
      }
    }
  }

  return depth;
}

// ---------------------------------------------------------------------------
// Hand-drawn strokes (pure SVG path data, seeded)
// ---------------------------------------------------------------------------

const fmt = (value: number) => Math.round(value * 100) / 100;

/** Points → a smooth pen-like path: quadratic curves through the midpoints (what the pencil brush does). */
export function smoothPath(points: ScenePt[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)} L ${fmt(points[0]!.x + 0.01)} ${fmt(points[0]!.y)}`;
  if (points.length === 2) return `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)} L ${fmt(points[1]!.x)} ${fmt(points[1]!.y)}`;

  const parts = [`M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`];

  for (let index = 1; index < points.length - 1; index += 1) {
    const p = points[index]!;
    const next = points[index + 1]!;

    parts.push(`Q ${fmt(p.x)} ${fmt(p.y)} ${fmt((p.x + next.x) / 2)} ${fmt((p.y + next.y) / 2)}`);
  }

  const last = points[points.length - 1]!;

  parts.push(`L ${fmt(last.x)} ${fmt(last.y)}`);

  return parts.join(' ');
}

/**
 * A hand-drawn ellipse: starts near the upper left, goes round once and OVERSHOOTS the start a little
 * (a pen never closes a loop exactly), with a slow radius wobble and a slight tilt. Seeded.
 */
export function handEllipsePoints(cx: number, cy: number, rx: number, ry: number, random: () => number): ScenePt[] {
  const steps = 40;
  const start = -Math.PI * 0.72 + (random() - 0.5) * 0.5;
  const overshoot = 0.28 + random() * 0.22;
  const sweep = Math.PI * 2 + overshoot;
  const phase1 = random() * Math.PI * 2;
  const phase2 = random() * Math.PI * 2;
  const tilt = ((random() - 0.5) * 5 * Math.PI) / 180;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  // The loop starts a hair inside and ends a hair outside, so the two ends cross instead of meeting.
  const drift = 0.035 + random() * 0.025;
  const points: ScenePt[] = [];

  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const theta = start + sweep * t;
    const wobble = 1 + Math.sin(theta + phase1) * 0.025 + Math.sin(2 * theta + phase2) * 0.015 + (t - 0.5) * drift * 2;
    const x = Math.cos(theta) * rx * wobble;
    const y = Math.sin(theta) * ry * wobble;

    points.push({ x: cx + x * cosT - y * sinT, y: cy + x * sinT + y * cosT });
  }

  return points;
}

/** A slightly bowed hand line from `a` to `b`. */
export function handLinePoints(a: ScenePt, b: ScenePt, random: () => number): ScenePt[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const bow = (random() - 0.5) * 0.07 * length;
  const nx = -dy / length;
  const ny = dx / length;
  const points: ScenePt[] = [];
  const steps = 6;

  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const lift = Math.sin(Math.PI * t) * bow;

    points.push({ x: a.x + dx * t + nx * lift, y: a.y + dy * t + ny * lift });
  }

  return points;
}

/** Two short strokes meeting at `tip`, opening back along the shaft direction `from → tip`. */
export function arrowHeadPoints(from: ScenePt, tip: ScenePt, size: number, random: () => number): ScenePt[] {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const spread = (26 + (random() - 0.5) * 8) * (Math.PI / 180);
  const left = { x: tip.x - Math.cos(angle - spread) * size, y: tip.y - Math.sin(angle - spread) * size };
  const right = { x: tip.x - Math.cos(angle + spread) * size * (0.9 + random() * 0.2), y: tip.y - Math.sin(angle + spread) * size * (0.9 + random() * 0.2) };

  return [left, tip, right];
}

// ---------------------------------------------------------------------------
// The draw plan
// ---------------------------------------------------------------------------

export type TermsPrimitive =
  /** Copy cluster `clusterId`'s strokes, moved by (dx, dy) — plan-local, before the plan is placed. */
  | { kind: 'ink-copy'; step: number; nodeId: string; clusterId: string; dx: number; dy: number }
  | { kind: 'outline'; step: number; nodeId: string; d: string; dashed: boolean; focusRing?: boolean; color?: string }
  /** `d` = the shaft (one or two strokes, `M…M…`), `head` = the arrowhead stroke. */
  | { kind: 'arrow'; step: number; from: string; to: string; d: string; head: string; arrow?: 'none' | 'end' | 'both'; color?: string }
  /**
   * Text to write inside `box` (centre-aligned, scaled down to fit its width). `fit` = how much wider
   * than the box the written ink may run (default 1.3; 1 = never past the box). `nodeId` / `edge`
   * (`from->to`) say which node / link the text belongs to, so the board can move it with them.
   */
  | {
      kind: 'label';
      step: number;
      role: 'link' | 'extra' | 'node' | 'title';
      text: string;
      box: SceneRect;
      textHeight: number;
      fit?: number;
      nodeId?: string;
      edge?: string;
      /** Ink for this primitive; the build's pen colour when absent. */
      color?: string;
    };

export interface TermsMapPlan {
  primitives: TermsPrimitive[];
  /** The map's extent, plan-local, top-left at (0, 0). */
  width: number;
  height: number;
  /** Node ellipses, plan-local centres + radii. */
  nodes: Map<string, { cx: number; cy: number; rx: number; ry: number; extra: boolean }>;
}

export interface TermsPlanOptions {
  /** The owner's letter height (HandStyle.letterHeight), scene units. */
  letterHeight: number;
  seed?: number;
}

/** Rough width of handwritten text of height `h` — the layout's slot; the real text is fitted into it. */
export const estimateTextWidth = (text: string, h: number) => Math.max(h * 1.4, Array.from(text).length * h * 0.58);

const toLayoutDirection = (direction: TermsMapDirection): ConceptMapDirection =>
  direction === 'radial' ? 'radial' : direction === 'LR' ? 'ltr' : 'tb';

const lerp = (a: ScenePt, b: ScenePt, t: number): ScenePt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

const toward = (a: ScenePt, b: ScenePt, distance: number): ScenePt => {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;

  return { x: a.x + ((b.x - a.x) / length) * distance, y: a.y + ((b.y - a.y) / length) * distance };
};

export interface HandEdgeEnd {
  centre: ScenePt;
  rx: number;
  ry: number;
}

/**
 * One hand-drawn link between two ellipses: a bowed shaft broken around its linking phrase (or, too
 * short to break, the phrase beside it), a two-stroke head at `to` — and at `from` too for `both`,
 * none for `none`. Shared by «Map my terms» and the hand-drawn reference map.
 *
 * `lines` writes the phrase on several lines (a long phrase on a crowded map); `avoid` says a box is
 * taken (another phrase, a node): the phrase then slides along the shaft (and to the other side of a
 * short one) to the first free spot. Without either it is one line at 55% along — as it always was.
 * `via` bends the shaft through that point (a link that would cut across another node): two legs,
 * the phrase on the longer one, the head on the last.
 */
export function planHandEdge(
  edge: { from: string; to: string; label?: string; arrow?: 'none' | 'end' | 'both'; lines?: string[] },
  a: HandEdgeEnd,
  b: HandEdgeEnd,
  {
    step,
    letterHeight,
    random,
    avoid,
    via,
  }: { step: number; letterHeight: number; random: () => number; avoid?: (box: SceneRect) => boolean; via?: ScenePt },
): TermsPrimitive[] {
  const lh = Math.max(1, letterHeight);
  const linkHeight = lh * 0.8;
  const gap = lh * 0.3;
  const start = toward(boundaryPoint(a.centre, { width: a.rx * 2, height: a.ry * 2 }, via ?? b.centre, 'ellipse'), via ?? b.centre, gap);
  const end = toward(boundaryPoint(b.centre, { width: b.rx * 2, height: b.ry * 2 }, via ?? a.centre, 'ellipse'), via ?? a.centre, gap);
  const legs: Array<[ScenePt, ScenePt]> = via ? [[start, via], [via, end]] : [[start, end]];
  const legLength = ([p, q]: [ScenePt, ScenePt]) => Math.hypot(q.x - p.x, q.y - p.y);
  const labelLeg = legs.length > 1 && legLength(legs[1]!) > legLength(legs[0]!) ? 1 : 0;
  const shafts = legs.map(([p, q]) => smoothPath(handLinePoints(p, q, random)));
  const out: TermsPrimitive[] = [];

  if (edge.label) {
    const [legStart, legEnd] = legs[labelLeg]!;
    const length = legLength(legs[labelLeg]!);
    const lines = edge.lines?.length ? edge.lines : [edge.label];
    const lineBox = linkHeight * 1.6;
    const size = { width: Math.max(...lines.map((line) => estimateTextWidth(line, linkHeight))), height: lineBox + (lines.length - 1) * linkHeight * 1.25 };
    const cutBox = { width: size.width + lh * 0.5, height: size.height + lh * 0.3 };
    const boxAt = (centre: ScenePt): SceneRect => ({ left: centre.x - size.width / 2, top: centre.y - size.height / 2, width: size.width, height: size.height });
    const fits = (t: number) => {
      const middle = lerp(legStart, legEnd, t);
      const before = boundaryPoint(middle, cutBox, legStart, 'rect');
      const after = boundaryPoint(middle, cutBox, legEnd, 'rect');
      const room = Math.hypot(before.x - legStart.x, before.y - legStart.y) > lh * 0.4 && Math.hypot(legEnd.x - after.x, legEnd.y - after.y) > lh * 0.4;

      return room ? { middle, before, after } : null;
    };
    const along = (avoid ? [0.55, 0.44, 0.66, 0.34, 0.76, 0.26, 0.84] : [0.55]).map(fits).filter((spot): spot is NonNullable<typeof spot> => spot !== null);
    const inline = along.find((spot) => !avoid?.(boxAt(spot.middle))) ?? (avoid ? null : along[0]) ?? null;
    const broken = (spot: NonNullable<typeof inline>) =>
      `${smoothPath(handLinePoints(legStart, spot.before, random))} ${smoothPath(handLinePoints(spot.after, legEnd, random))}`;
    let labelCentre: ScenePt;

    if (inline) {
      labelCentre = inline.middle;
      shafts[labelLeg] = broken(inline);
    } else {
      // Too short to break (or every break is taken): one shaft, the phrase beside it — on the right
      // of a downward arrow, else the other side, else further along.
      const ux = (legEnd.x - legStart.x) / (length || 1);
      const uy = (legEnd.y - legStart.y) / (length || 1);
      let nx = -uy;
      let ny = ux;

      if (nx < 0 || (nx === 0 && ny > 0)) {
        nx = -nx;
        ny = -ny;
      }

      const offset = (Math.abs(nx) * size.width) / 2 + (Math.abs(ny) * size.height) / 2 + lh * 0.3;
      const besides = (avoid ? [0.55, 0.4, 0.7, 0.28, 0.82] : [0.55]).flatMap((t) => {
        const middle = lerp(legStart, legEnd, t);

        return [1, -1].map((side) => ({ x: middle.x + nx * offset * side, y: middle.y + ny * offset * side }));
      });

      labelCentre = besides.find((centre) => !avoid?.(boxAt(centre))) ?? (along[0]?.middle && avoid ? along[0].middle : besides[0]!);

      if (along[0] && labelCentre === along[0].middle) shafts[labelLeg] = broken(along[0]);
    }

    const box = boxAt(labelCentre);

    lines.forEach((line, index) => {
      out.push({
        kind: 'label',
        step,
        role: 'link',
        text: line,
        box: { left: box.left, top: box.top + index * linkHeight * 1.25, width: box.width, height: lineBox },
        textHeight: linkHeight,
      });
    });
  }

  const arrow = edge.arrow ?? 'end';
  const [lastFrom] = legs[legs.length - 1]!;
  const [, firstTo] = legs[0]!;
  const lastLength = Math.hypot(end.x - lastFrom.x, end.y - lastFrom.y);
  const firstLength = Math.hypot(firstTo.x - start.x, firstTo.y - start.y);
  const headSize = Math.max(lh * 0.5, Math.min(lh * 0.9, lastLength * 0.3));
  const heads: string[] = [];

  if (arrow !== 'none') heads.push(smoothPath(arrowHeadPoints(toward(end, lastFrom, Math.min(lastLength, lh)), end, headSize, random)));
  if (arrow === 'both') heads.push(smoothPath(arrowHeadPoints(toward(start, firstTo, Math.min(firstLength, lh)), start, headSize, random)));

  out.push({ kind: 'arrow', step, from: edge.from, to: edge.to, d: shafts.join(' '), head: heads.join(' ') });

  return out;
}

/**
 * Structure + the clusters' scene boxes → the draw plan. Each own node's clusters sit side by side on
 * one line (in their original left-to-right order, vertically centred) inside a hand ellipse; AI-added
 * concepts get a slot sized for their text and a dashed ellipse; every edge is a bowed shaft broken
 * around its linking phrase, with a two-stroke head. Steps: level 0 nodes, then their arrows, then
 * level 1 nodes… so the reveal draws the map the way a person would.
 */
export function planTermsMap(result: TermsMapResult, clusters: ReadonlyMap<string, SceneRect>, options: TermsPlanOptions): TermsMapPlan {
  const lh = Math.max(1, options.letterHeight);
  const random = seededRandom(options.seed ?? hashSeed(JSON.stringify([result.nodes.map((n) => [n.id, n.clusterIds]), result.edges, result.extra.map((e) => e.id)])));
  const linkHeight = lh * 0.8;
  const clusterGap = lh * 0.5;
  const inner = new Map<string, { width: number; height: number; slots: Array<{ clusterId: string; x: number; y: number; rect: SceneRect }> }>();

  // Ink line of each own node: clusters left → right, centred on one mid-line.
  for (const node of result.nodes) {
    const rects = node.clusterIds
      .map((clusterId) => ({ clusterId, rect: clusters.get(clusterId) }))
      .filter((item): item is { clusterId: string; rect: SceneRect } => Boolean(item.rect))
      .sort((a, b) => a.rect.left - b.rect.left);
    const height = Math.max(lh * 0.6, ...rects.map((item) => item.rect.height));
    let x = 0;
    const slots = rects.map((item) => {
      const slot = { clusterId: item.clusterId, x, y: (height - item.rect.height) / 2, rect: item.rect };

      x += item.rect.width + clusterGap;

      return slot;
    });

    inner.set(node.id, { width: Math.max(lh, x - clusterGap), height, slots });
  }

  for (const item of result.extra) inner.set(item.id, { width: estimateTextWidth(item.text, lh), height: lh * 1.5, slots: [] });

  const radii = new Map<string, { rx: number; ry: number }>();

  inner.forEach((box, id) => radii.set(id, { rx: (box.width / 2) * 1.12 + lh * 0.6, ry: (box.height / 2) * 1.22 + lh * 0.5 }));

  const labelled = result.edges.filter((edge) => edge.label);
  const labelBoxes = labelled.map((edge) => ({ width: estimateTextWidth(edge.label, linkHeight), height: linkHeight * 1.6 }));
  const maxLabelW = Math.max(0, ...labelBoxes.map((box) => box.width));
  const maxLabelH = Math.max(0, ...labelBoxes.map((box) => box.height));
  const direction = toLayoutDirection(result.direction);
  const vertical = direction === 'tb';
  const levelGap = lh * 2.4 + (labelled.length ? (vertical ? maxLabelH : maxLabelW) + lh * 0.8 : 0);
  const siblingGap = Math.max(lh * 1.4, vertical ? maxLabelW * 0.75 : maxLabelH * 1.3);
  const levels = new Map<string, number>([...result.nodes, ...result.extra].map((node) => [node.id, node.level]));
  const ids = [...result.nodes.map((node) => node.id), ...result.extra.map((item) => item.id)];
  const layout = layoutGraph(
    ids.map((id) => ({ id, width: radii.get(id)!.rx * 2, height: radii.get(id)!.ry * 2, level: levels.get(id) })),
    result.edges,
    { direction, levelGap, siblingGap },
  );
  const pad = lh * 0.5;
  const shiftX = pad - layout.bounds.left;
  const shiftY = pad - layout.bounds.top;
  const centre = (id: string): ScenePt => {
    const placed = layout.nodes.get(id)!;

    return { x: placed.x + shiftX, y: placed.y + shiftY };
  };
  const depthOf = (id: string) => layout.nodes.get(id)?.depth ?? 0;
  const primitives: TermsPrimitive[] = [];
  const planNodes: TermsMapPlan['nodes'] = new Map();
  const extraIds = new Set(result.extra.map((item) => item.id));

  for (const id of ids) {
    const c = centre(id);
    const { rx, ry } = radii.get(id)!;
    const box = inner.get(id)!;
    const step = depthOf(id) * 2;
    const extra = extraIds.has(id);

    planNodes.set(id, { cx: c.x, cy: c.y, rx, ry, extra });
    primitives.push({ kind: 'outline', step, nodeId: id, d: smoothPath(handEllipsePoints(c.x, c.y, rx, ry, random)), dashed: extra });

    if (result.nodes.find((node) => node.id === id)?.focus) {
      primitives.push({
        kind: 'outline',
        step,
        nodeId: id,
        d: smoothPath(handEllipsePoints(c.x, c.y, rx + lh * 0.3, ry + lh * 0.25, random)),
        dashed: false,
        focusRing: true,
      });
    }

    if (extra) {
      const text = result.extra.find((item) => item.id === id)!.text;

      primitives.push({
        kind: 'label',
        step,
        role: 'extra',
        text,
        box: { left: c.x - box.width / 2, top: c.y - box.height / 2, width: box.width, height: box.height },
        textHeight: lh,
      });
      continue;
    }

    const left = c.x - box.width / 2;
    const top = c.y - box.height / 2;

    for (const slot of box.slots) {
      primitives.push({ kind: 'ink-copy', step, nodeId: id, clusterId: slot.clusterId, dx: left + slot.x - slot.rect.left, dy: top + slot.y - slot.rect.top });
    }
  }

  for (const edge of result.edges) {
    if (!layout.nodes.has(edge.from) || !layout.nodes.has(edge.to)) continue;

    const ra = radii.get(edge.from)!;
    const rb = radii.get(edge.to)!;

    primitives.push(
      ...planHandEdge(
        { from: edge.from, to: edge.to, label: edge.label },
        { centre: centre(edge.from), rx: ra.rx, ry: ra.ry },
        { centre: centre(edge.to), rx: rb.rx, ry: rb.ry },
        { step: depthOf(edge.from) * 2 + 1, letterHeight: lh, random },
      ),
    );
  }

  primitives.sort((x, y) => x.step - y.step);

  return { primitives, width: layout.bounds.width + pad * 2, height: layout.bounds.height + pad * 2, nodes: planNodes };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

const intersects = (a: SceneRect, b: SceneRect) =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/**
 * Where the map goes: under the selection, centred on it, pushed further down past anything already
 * there — a notebook grows downward, so «below» always has room eventually.
 */
export function placeBelowFree(
  anchor: SceneRect,
  size: { width: number; height: number },
  occupied: SceneRect[],
  gap: number,
  { minLeft }: { minLeft?: number } = {},
): { left: number; top: number } {
  let left = anchor.left + (anchor.width - size.width) / 2;

  if (minLeft !== undefined) left = Math.max(minLeft, left);

  let top = anchor.top + anchor.height + gap;

  for (let attempt = 0; attempt < 500; attempt += 1) {
    const candidate = { left: left - gap / 2, top: top - gap / 2, width: size.width + gap, height: size.height + gap };
    const hits = occupied.filter((rect) => intersects(rect, candidate));

    if (hits.length === 0) break;

    top = Math.max(...hits.map((rect) => rect.top + rect.height)) + gap;
  }

  return { left, top };
}

/** The clusters' boxes normalised into the captured region (what the model is told about the image). */
export function clusterBoxes(clusters: InkCluster[], region: SceneRect): Array<{ id: string; bbox: { x: number; y: number; w: number; h: number } }> {
  const round = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 10000) / 10000;

  return clusters.map((cluster) => ({
    id: cluster.id,
    bbox: {
      x: round((cluster.rect.left - region.left) / region.width),
      y: round((cluster.rect.top - region.top) / region.height),
      w: round(cluster.rect.width / region.width),
      h: round(cluster.rect.height / region.height),
    },
  }));
}
