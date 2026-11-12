import { boundaryPoint } from './graphLayout';
import { hashSeed, seededRandom } from './handwritingLayout';
import { extractJsonObject } from './markdownBlocks';
import { pageLength, toSceneBox, toScenePoint } from './penCoords';
import { arrowHeadPoints, estimateTextWidth, handEllipsePoints, handLinePoints, placeBelowFree } from './termsMap';

import type { ScenePt } from './penCoords';
import { TONE_INK } from './tones';

import type { NormalizedBox, PagePoint, PenAction, PenActionEnd, PenActionTarget, PenMarkVerdict, PenPlanResult, PenStrokeTool, SceneRect } from './types';

/**
 * «Explain on my page» — the pure half. The model answers with a short list of ACTIONS in page
 * coordinates (point here, circle that, underline this, arrow from A to B, write a note there, a free
 * stroke); this module validates that list and turns it into a deterministic DRAW PLAN in scene units:
 *
 *   pointer  — the animated dot + note bubble (overlay only, never saved)
 *   stroke   — a hand-drawn ellipse / underline / bowed arrow shaft + head / free pen stroke
 *   write    — a short note the handwriting pipeline writes in the owner's hand
 *
 * Imprecise model coordinates are the main risk: an action that names an ink cluster by id snaps to
 * that cluster's real box, and a written note is nudged into free space so it never covers ink. The
 * Fabric half is `penActionObjects.ts`.
 */

export const PEN_MAX_ACTIONS = 12;
export const PEN_MAX_TEXT = 120;
export const PEN_MAX_NOTE = 80;
export const PEN_MAX_SAY = 600;
export const PEN_MAX_STROKE_POINTS = 64;
/** A note's letter height as a fraction of the page height: the default, and what the model may ask for. */
export const PEN_DEFAULT_LETTER = 0.016;
/** Notes and labels never outgrow the page's own text: caps as a share of the page height. */
const NOTE_CAP = 0.02;
/** Clean mode (typed cards): the type size and the badge, as shares of the page height. */
const CARD_FONT_MIN = 0.011;
const CARD_FONT_MAX = 0.013;
const BADGE_MIN = 0.016;
const BADGE_MAX = 0.022;
/** Average glyph width and line pitch of the card's typeface, in font sizes. */
export const CARD_CHAR = 0.5;
export const CARD_PITCH = 1.3;
export const CARD_PAD = 0.45;

/** Greedy wrap for the card's typeface. */
export function wrapCardText(text: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;

    if (line && Array.from(next).length * fontSize * CARD_CHAR > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }

  if (line) lines.push(line);

  return lines.length ? lines : [text];
}
export const PEN_MIN_LETTER = 0.012;
export const PEN_MAX_LETTER = 0.05;

// ---------------------------------------------------------------------------
// Parsing: the model's answer → a validated plan
// ---------------------------------------------------------------------------

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const str = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;

  const text = value.replace(/\s+/g, ' ').trim();

  return text ? Array.from(text).slice(0, max).join('') : undefined;
};

/** `[x, y]` or `{x, y}`, 0..1 → a point; null when unusable. */
export function parsePagePoint(value: unknown): PagePoint | null {
  const raw = Array.isArray(value)
    ? value.map(Number)
    : value && typeof value === 'object'
      ? [Number((value as Record<string, unknown>).x), Number((value as Record<string, unknown>).y)]
      : null;

  if (!raw || raw.length < 2 || !Number.isFinite(raw[0]) || !Number.isFinite(raw[1])) return null;

  return { x: clamp01(raw[0]!), y: clamp01(raw[1]!) };
}

/** `[x, y, w, h]` or `{x, y, w, h}`, 0..1 → a box; null when unusable (no area / not numbers). */
export function parsePageBox(value: unknown): NormalizedBox | null {
  const raw = Array.isArray(value)
    ? value.map(Number)
    : value && typeof value === 'object'
      ? ['x', 'y', 'w', 'h'].map((key) => Number((value as Record<string, unknown>)[key]))
      : null;

  if (!raw || raw.length < 4 || raw.some((n) => !Number.isFinite(n))) return null;

  const [x, y, w, h] = raw as [number, number, number, number];
  const box = { x: clamp01(x), y: clamp01(y), w: clamp01(w), h: clamp01(h) };

  box.w = Math.min(box.w, 1 - box.x);
  box.h = Math.min(box.h, 1 - box.y);

  return box.w > 0.002 && box.h > 0.002 ? box : null;
}

const TYPE_ALIASES: Record<string, PenAction['type']> = {
  point_at: 'point_at',
  point: 'point_at',
  pointer: 'point_at',
  circle: 'circle',
  ring: 'circle',
  underline: 'underline',
  arrow: 'arrow',
  write: 'write',
  note: 'write',
  text: 'write',
  mark: 'mark',
  check: 'mark',
  grade: 'mark',
  pen_stroke: 'pen_stroke',
  stroke: 'pen_stroke',
  draw: 'pen_stroke',
};

const TOOLS = new Set<PenStrokeTool>(['pen', 'marker', 'highlighter']);

const MARK_VERDICTS: Record<string, PenMarkVerdict> = {
  correct: 'correct',
  right: 'correct',
  check: 'correct',
  wrong: 'wrong',
  incorrect: 'wrong',
  cross: 'wrong',
  warning: 'warning',
  partly: 'warning',
  incomplete: 'warning',
};

/** A verdict mark's ink: the answer view's semantic tones (green ✓, red ✗, amber !). */
export const MARK_INK: Record<PenMarkVerdict, string> = { correct: TONE_INK.success, wrong: TONE_INK.wrong, warning: TONE_INK.warning };

/** A cluster reference in any of the shapes a model writes: `'c1'`, `{clusterId}`, `{id}`, `{cluster}`. */
function clusterRef(value: unknown, known: ReadonlySet<string>): string | null {
  const id =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? ((value as Record<string, unknown>).clusterId ?? (value as Record<string, unknown>).cluster ?? (value as Record<string, unknown>).id)
        : undefined;

  return typeof id === 'string' && known.has(id.trim()) ? id.trim() : null;
}

/** A target: a known cluster id first (the snap), else a box; null when neither is usable. */
function parseTarget(action: Record<string, unknown>, known: ReadonlySet<string>): PenActionTarget | null {
  const raw = action.target ?? action.clusterId ?? action.box ?? action.bbox;
  const id = clusterRef(raw, known) ?? clusterRef(action.clusterId, known);

  if (id) return { clusterId: id };

  const box =
    parsePageBox(raw) ??
    parsePageBox(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).box ?? (raw as Record<string, unknown>).bbox : undefined) ??
    parsePageBox(action.box ?? action.bbox);

  return box ? { box } : null;
}

function parseEnd(value: unknown, known: ReadonlySet<string>): PenActionEnd | null {
  const id = clusterRef(value, known);

  if (id) return { clusterId: id };

  return parsePagePoint(value);
}

/** Every `n`-th point so a long polyline stays under the cap, first and last always kept. */
export function thinPoints<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;

  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);

  for (let index = 0; index < max; index += 1) out.push(points[Math.round(index * step)]!);

  return out;
}

/**
 * The model's `{actions, say}` → a plan the drawer can trust: unknown action types are dropped, a
 * target that names an unknown cluster falls back to its box (or is dropped), coordinates are clamped,
 * a note is cut to {@link PEN_MAX_TEXT} characters, a stroke to {@link PEN_MAX_STROKE_POINTS} points,
 * and at most {@link PEN_MAX_ACTIONS} actions survive, in the order the model gave them. Null when the
 * input is not an object at all.
 */
export function parsePenPlan(input: unknown, clusterIds: readonly string[]): PenPlanResult | null {
  let value = typeof input === 'string' ? extractJsonObject(input) : input;

  if (!value || typeof value !== 'object') return null;

  for (const key of ['plan', 'result', 'board_actions', 'boardActions']) {
    const inner = (value as Record<string, unknown>)[key];

    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      value = inner;
      break;
    }
  }

  const source = value as Record<string, unknown>;
  const known = new Set(clusterIds);
  const actions: PenAction[] = [];
  const list = Array.isArray(source.actions) ? source.actions : Array.isArray(source.steps) ? source.steps : [];

  for (const raw of list) {
    if (actions.length >= PEN_MAX_ACTIONS) break;
    if (!raw || typeof raw !== 'object') continue;

    const action = raw as Record<string, unknown>;
    const type = TYPE_ALIASES[String(action.type ?? action.kind ?? action.action ?? '').toLowerCase()];

    switch (type) {
      case 'point_at': {
        const at = parsePagePoint(action.at ?? action.point ?? action.position);
        const target = at ? null : parseTarget(action, known);

        if (!at && !target) break;

        const note = str(action.note ?? action.text ?? action.label, PEN_MAX_NOTE);

        // A pointer aimed at a cluster points at its centre — resolved at plan time through `target`.
        actions.push({ type: 'point_at', ...(at ? { at } : {}), ...(target ? { target } : {}), ...(note ? { note } : {}) });
        break;
      }
      case 'circle':
      case 'underline': {
        const target = parseTarget(action, known);

        if (target) actions.push({ type, target });
        break;
      }
      case 'arrow': {
        const from = parseEnd(action.from ?? action.start ?? action.source, known);
        const to = parseEnd(action.to ?? action.end ?? action.target, known);

        if (!from || !to) break;

        const label = str(action.label ?? action.text, PEN_MAX_NOTE);

        actions.push({ type: 'arrow', from, to, ...(label ? { label } : {}) });
        break;
      }
      case 'write': {
        const text = str(action.text ?? action.note ?? action.content, PEN_MAX_TEXT);
        const at = parsePagePoint(action.at ?? action.position ?? action.point);
        const near = action.near !== undefined ? parseTarget({ target: action.near }, known) : null;

        if (!text || (!at && !near)) break;

        const size = Number(action.size ?? action.letterHeight);

        actions.push({ type: 'write', text, ...(near ? { near } : { at: at! }), ...(Number.isFinite(size) && size > 0 ? { size: Math.max(PEN_MIN_LETTER, Math.min(PEN_MAX_LETTER, size)) } : {}) });
        break;
      }
      case 'mark': {
        const target = parseTarget(action, known);
        const verdict = MARK_VERDICTS[String(action.verdict ?? action.mark ?? '').toLowerCase()];

        if (!target || !verdict) break;

        // The glyph is drawn; a label that repeats it («✓ Correct») loses the copy.
        const label = str(String(action.label ?? action.text ?? action.note ?? '').replace(/^[\s✓✔✗✘×!]+/u, ''), PEN_MAX_NOTE);

        actions.push({ type: 'mark', target, verdict, ...(label ? { label } : {}) });
        break;
      }
      case 'pen_stroke': {
        const points = (Array.isArray(action.points) ? action.points : []).map(parsePagePoint).filter((point): point is PagePoint => point !== null);

        if (points.length < 2) break;

        const tool = TOOLS.has(action.tool as PenStrokeTool) ? (action.tool as PenStrokeTool) : 'pen';

        actions.push({ type: 'pen_stroke', points: thinPoints(points, PEN_MAX_STROKE_POINTS), tool });
        break;
      }
      default:
        break;
    }
  }

  const say = str(source.say ?? source.answer ?? source.message, PEN_MAX_SAY);
  const verdict = source.verdict === 'correct' || source.verdict === 'wrong' || source.verdict === 'partly' ? source.verdict : undefined;

  const heard = str(source.heard, 200);

  const steps = (Array.isArray(source.steps) ? (source.steps as unknown[]) : [])
    .map((step) => str(step, 240) ?? '')
    .filter((step) => step.length > 0)
    .slice(0, 14);

  return { actions, ...(say ? { say } : {}), ...(verdict ? { verdict } : {}), ...(heard ? { heard } : {}), ...(steps.length ? { steps } : {}) };
}

// ---------------------------------------------------------------------------
// The draw plan
// ---------------------------------------------------------------------------

export type PenPrimitive =
  /** The animated pointer dot (+ a note bubble). Overlay only — nothing lands on the board. */
  | { kind: 'pointer'; at: ScenePt; note?: string }
  /** One pen stroke, scene points; `width` in scene units. */
  | { kind: 'stroke'; role: 'circle' | 'underline' | 'arrow' | 'arrow-head' | 'ink' | 'mark'; points: ScenePt[]; tool: PenStrokeTool; width: number; color?: string }
  /** A typed note on a small cream card (clean mode): `box` is the card, `rim` its edge colour (absent = the tutor's ink). */
  | { kind: 'chip'; role: 'note' | 'label'; text: string; lines: string[]; box: SceneRect; fontSize: number; rim?: string }
  /** A verdict badge: a filled circle `size` across, centred on `at`, with a white ✓ / ✗ / !. */
  | { kind: 'badge'; verdict: PenMarkVerdict; at: ScenePt; size: number; color: string }
  /** Text to write inside `box` (top-start aligned, line pitch 1.5 × letter height). `color`: a verdict's ink instead of the owner's. */
  | { kind: 'write'; role: 'note' | 'label'; text: string; lines: string[]; box: SceneRect; letterHeight: number; color?: string };

export interface PenPlan {
  primitives: PenPrimitive[];
  /** Everything the plan draws, scene units; null for an empty plan. */
  bounds: SceneRect | null;
  /** Notes and labels the page had no room for — shown with the answer, never over content. */
  overflow: string[];
}

export interface PenPlanContext {
  /** The page sheet in scene units — what the model's 0..1 coordinates are relative to. */
  page: SceneRect;
  /** Cluster id → its scene box (the owner's ink the model may name). */
  clusters: ReadonlyMap<string, SceneRect>;
  /** Boxes already taken (the owner's ink, earlier AI objects): a written note never covers one. */
  occupied: readonly SceneRect[];
  /**
   * The page's real empty space (pageOccupancy — printed text and pictures count as taken, not just
   * ink): the free box nearest to `wanted`, or null when there is no room. When given it replaces the
   * `occupied` nudge, and a note with no room becomes a pointer bubble instead of covering content.
   */
  /** `home`: the region the note is about — it stays inside that region's own question (see the layer). */
  place?: (wanted: SceneRect, alt?: SceneRect, home?: SceneRect) => SceneRect | null;
  /**
   * The tutor's own look (the study buddy): notes are typed on small cream cards instead of written
   * in the owner's hand, and its strokes are thin — nothing of it can be mistaken for the student's ink.
   */
  clean?: boolean;
  /** The owner's letter height, scene units. */
  letterHeight: number;
  /** The pen nib, scene units. */
  strokeWidth: number;
  seed?: number;
}

const intersects = (a: SceneRect, b: SceneRect) =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

const centreOf = (rect: SceneRect): ScenePt => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

const toward = (a: ScenePt, b: ScenePt, distance: number): ScenePt => {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;

  return { x: a.x + ((b.x - a.x) / length) * distance, y: a.y + ((b.y - a.y) / length) * distance };
};

const pointsBounds = (points: ScenePt[]): SceneRect => {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }

  return { left, top, width: right - left, height: bottom - top };
};

const unionOf = (rects: SceneRect[]): SceneRect | null => {
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

/** Greedy word wrap for handwriting of height `letterHeight` into `maxWidth` (scene units). */
export function wrapHandText(text: string, letterHeight: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const space = letterHeight * 0.34;
  const lines: string[] = [];
  let line = '';
  let width = 0;

  for (const word of words) {
    const w = estimateTextWidth(word, letterHeight);

    if (line && width + space + w > maxWidth) {
      lines.push(line);
      line = word;
      width = w;
    } else {
      width = line ? width + space + w : w;
      line = line ? `${line} ${word}` : word;
    }
  }

  if (line) lines.push(line);

  return lines.length ? lines : [text];
}

/** Keeps `box` on the sheet (shifted, never shrunk). */
function clampToPage(box: SceneRect, page: SceneRect): SceneRect {
  const left = Math.max(page.left, Math.min(box.left, page.left + page.width - box.width));
  const top = Math.max(page.top, Math.min(box.top, page.top + page.height - box.height));

  return { ...box, left, top };
}

/**
 * Where a note goes: where the model asked when that spot is free, else straight below the taken
 * boxes it hit (`placeBelowFree`, a notebook grows down), always on the sheet. `occupied` grows by the
 * placed box so two notes never land on each other.
 */
export function placeNote(
  wanted: SceneRect,
  occupied: SceneRect[],
  { page, gap }: { page: SceneRect; gap: number },
): SceneRect {
  const first = clampToPage(wanted, page);
  const padded = (rect: SceneRect): SceneRect => ({ left: rect.left - gap / 2, top: rect.top - gap / 2, width: rect.width + gap, height: rect.height + gap });
  const free = (rect: SceneRect) => !occupied.some((taken) => intersects(taken, padded(rect)));
  let placed = first;

  if (!free(first)) {
    const anchor = { left: first.left, top: first.top - gap, width: first.width, height: 0 };
    const below = placeBelowFree(anchor, { width: first.width, height: first.height }, occupied, gap);

    placed = clampToPage({ ...first, left: below.left, top: below.top }, page);

    // Pinned to the bottom edge and still covered: slide sideways, start side first.
    if (!free(placed)) {
      const steps = [1, -1, 2, -2, 3, -3];
      const side = steps.map((step) => clampToPage({ ...placed, left: placed.left + step * (first.width / 2 + gap) }, page)).find(free);

      if (side) placed = side;
    }
  }

  occupied.push(placed);

  return placed;
}

function resolveTarget(target: PenActionTarget, ctx: PenPlanContext): SceneRect | null {
  if ('clusterId' in target) {
    const rect = ctx.clusters.get(target.clusterId);

    return rect && rect.width >= 0 && rect.height >= 0 ? rect : null;
  }

  const rect = toSceneBox(target.box, ctx.page);

  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/** An arrow end: a point as is; a cluster → the point on its (padded) box facing the other end. */
function resolveEnd(end: PenActionEnd, other: ScenePt | null, ctx: PenPlanContext, lh: number): ScenePt | null {
  if ('clusterId' in end) {
    const rect = ctx.clusters.get(end.clusterId);

    if (!rect) return null;

    const centre = centreOf(rect);

    if (!other) return centre;

    const edge = boundaryPoint(centre, { width: rect.width + lh * 0.6, height: rect.height + lh * 0.5 }, other, 'rect');

    return toward(edge, other, lh * 0.25);
  }

  return toScenePoint(end, ctx.page);
}

/** The scene centre an end stands for (before the boundary snap) — what the OTHER end aims at. */
function endCentre(end: PenActionEnd, ctx: PenPlanContext): ScenePt | null {
  if ('clusterId' in end) {
    const rect = ctx.clusters.get(end.clusterId);

    return rect ? centreOf(rect) : null;
  }

  return toScenePoint(end, ctx.page);
}

/**
 * Validated actions → the draw plan, in the model's order (the reveal plays them as a person would).
 * Geometry is the client's alone: a circle hugs its cluster with the hand-ellipse wobble, an underline
 * runs just under the box along the writing direction, an arrow leaves one box's edge for the other's
 * with a two-stroke head, a note is wrapped to at most ~40% of the sheet and nudged into free space.
 */
export function planPenActions(result: PenPlanResult, ctx: PenPlanContext): PenPlan {
  const lh = Math.max(1, ctx.letterHeight);
  const nib = Math.max(0.5, ctx.strokeWidth);
  const random = seededRandom(ctx.seed ?? hashSeed(JSON.stringify(result.actions)));
  const occupied = [...ctx.occupied];
  const primitives: PenPrimitive[] = [];
  const extents: SceneRect[] = [];
  const overflow: string[] = [];
  const stroke = (role: Extract<PenPrimitive, { kind: 'stroke' }>['role'], points: ScenePt[], tool: PenStrokeTool = 'pen', width = nib, color?: string) => {
    if (points.length < 2) return;

    primitives.push({ kind: 'stroke', role, points, tool, width, ...(color ? { color } : {}) });
    extents.push(pointsBounds(points));
  };
  const pointer = (at: ScenePt, note?: string) => {
    primitives.push({ kind: 'pointer', at, ...(note ? { note: Array.from(note).slice(0, PEN_MAX_NOTE).join('') } : {}) });
    extents.push({ left: at.x - lh, top: at.y - lh, width: lh * 2, height: lh * 2 });
  };
  /** A free box for `wanted`: the page's real empty space when known, else the ink-box nudge. */
  const fit = (wanted: SceneRect, alt?: SceneRect, home?: SceneRect): SceneRect | null =>
    ctx.place ? ctx.place(wanted, alt, home) : placeNote(wanted, occupied, { page: ctx.page, gap: lh * 0.4 });
  /**
   * The whole handwritten line a region sits on (its neighbours level with it, a few letters apart):
   * a mark goes at the END of the line, not into the middle of it.
   */
  const lineOf = (rect: SceneRect): SceneRect => {
    let line = rect;
    let grew = true;

    while (grew) {
      grew = false;

      for (const other of ctx.clusters.values()) {
        const overlap = Math.min(line.top + line.height, other.top + other.height) - Math.max(line.top, other.top);
        const gap = Math.max(other.left - (line.left + line.width), line.left - (other.left + other.width));
        const inside = other.left >= line.left && other.left + other.width <= line.left + line.width;

        if (inside || overlap < Math.min(line.height, other.height) * 0.5 || gap > lh * 3) continue;

        const left = Math.min(line.left, other.left);
        const top = Math.min(line.top, other.top);

        line = {
          left,
          top,
          width: Math.max(line.left + line.width, other.left + other.width) - left,
          height: Math.max(line.top + line.height, other.top + other.height) - top,
        };
        grew = true;
      }
    }

    return line;
  };
  /**
   * Writes `text` in empty space near `at`. With the page's real empty space known and no room for
   * it (even a size smaller), the words go to `overflow` (shown with the answer) — never over content.
   */
  const write = (role: 'note' | 'label', text: string, at: ScenePt, letterHeight: number, maxWidth: number, color?: string, below?: ScenePt, home?: SceneRect) => {
    for (const height of ctx.place ? [letterHeight, letterHeight * 0.8] : [letterHeight]) {
      const lines = wrapHandText(text, height, maxWidth);
      const width = Math.min(maxWidth, Math.max(...lines.map((line) => estimateTextWidth(line, height))));
      const size = { width, height: height * 1.5 * lines.length };
      const box = fit({ left: at.x, top: at.y, ...size }, below ? { left: below.x, top: below.y, ...size } : undefined, home);

      if (box) {
        primitives.push({ kind: 'write', role, text, lines, box, letterHeight: height, ...(color ? { color } : {}) });
        extents.push(box);

        return;
      }
    }

    overflow.push(text);
  };
  const thin = ctx.clean ? Math.min(nib, Math.max(1, ctx.page.height * 0.002)) : nib;
  const cardFont = Math.min(ctx.page.height * CARD_FONT_MAX, Math.max(lh * 0.6, ctx.page.height * CARD_FONT_MIN));
  /** The card for `text` (≤ `maxLines` lines), or null when it would be longer — that goes to the answer instead. */
  const cardFor = (text: string, maxWidth: number, maxLines: number) => {
    const lines = wrapCardText(text, cardFont, maxWidth);

    if (lines.length > maxLines) return null;

    const pad = cardFont * CARD_PAD;
    const width = Math.max(...lines.map((line) => Array.from(line).length * cardFont * CARD_CHAR)) + pad * 2;

    return { lines, width, height: lines.length * cardFont * CARD_PITCH + pad * 2 };
  };
  /** A typed card in empty space near `at` (or `below`), inside `home`'s question; no room → the answer. */
  const card = (role: 'note' | 'label', text: string, at: ScenePt, maxWidth: number, maxLines: number, rim?: string, below?: ScenePt, home?: SceneRect) => {
    const made = cardFor(text, maxWidth, maxLines);
    const size = made ? { width: made.width, height: made.height } : null;
    const box = size ? fit({ left: at.x, top: at.y, ...size }, below ? { left: below.x, top: below.y, ...size } : undefined, home) : null;

    if (!made || !box) {
      overflow.push(text);

      return;
    }

    primitives.push({ kind: 'chip', role, text, lines: made.lines, box, fontSize: cardFont, ...(rim ? { rim } : {}) });
    extents.push(box);
  };
  // A labelled mark already says what a note beside the same region would repeat.
  const labelled = new Set(
    result.actions.flatMap((action) => (action.type === 'mark' && action.label && 'clusterId' in action.target ? [action.target.clusterId] : [])),
  );
  /** Just right of a region, level with its top — where a note about it reads naturally. */
  const beside = (rect: SceneRect): ScenePt => ({ x: rect.left + rect.width + lh * 0.8, y: rect.top });
  /** Just under a region, at its left edge — the second choice when there is no room beside it. */
  const under = (rect: SceneRect): ScenePt => ({ x: rect.left, y: rect.top + rect.height + lh * 0.5 });

  for (const action of result.actions) {
    switch (action.type) {
      case 'point_at': {
        const rect = action.target ? resolveTarget(action.target, ctx) : null;
        const at = rect ? centreOf(rect) : action.at ? toScenePoint(action.at, ctx.page) : null;

        if (!at) break;

        primitives.push({ kind: 'pointer', at, ...(action.note ? { note: action.note } : {}) });
        extents.push({ left: at.x - lh, top: at.y - lh, width: lh * 2, height: lh * 2 });
        break;
      }
      case 'circle': {
        const rect = resolveTarget(action.target, ctx);

        if (!rect) break;

        const centre = centreOf(rect);
        const rx = Math.max(lh * 0.8, rect.width / 2 + lh * 0.55);
        const ry = Math.max(lh * 0.7, rect.height / 2 + lh * 0.45);

        stroke('circle', handEllipsePoints(centre.x, centre.y, rx, ry, random), 'pen', thin);
        break;
      }
      case 'underline': {
        const rect = resolveTarget(action.target, ctx);

        if (!rect) break;

        const y = Math.min(ctx.page.top + ctx.page.height, rect.top + rect.height + lh * 0.25);
        const a = { x: rect.left - lh * 0.15, y };
        const b = { x: rect.left + rect.width + lh * 0.15, y };

        stroke('underline', handLinePoints(a, b, random), 'pen', thin);
        break;
      }
      case 'arrow': {
        const fromCentre = endCentre(action.from, ctx);
        const toCentre = endCentre(action.to, ctx);
        const start = resolveEnd(action.from, toCentre, ctx, lh);
        const end = resolveEnd(action.to, fromCentre, ctx, lh);

        if (!start || !end) break;

        const length = Math.hypot(end.x - start.x, end.y - start.y);

        if (length < lh * 0.6) break;

        const headSize = Math.max(lh * 0.5, Math.min(lh * 0.9, length * 0.3));

        stroke('arrow', handLinePoints(start, end, random), 'pen', thin);
        stroke('arrow-head', arrowHeadPoints(toward(end, start, Math.min(length, lh)), end, headSize, random), 'pen', thin);

        if (action.label) {
          // Beside the shaft's middle, on the side that reads first (the right of a downward arrow).
          const ux = (end.x - start.x) / length;
          const uy = (end.y - start.y) / length;
          let nx = -uy;
          let ny = ux;

          if (nx < 0 || (nx === 0 && ny > 0)) {
            nx = -nx;
            ny = -ny;
          }

          const labelHeight = lh * 0.8;
          const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
          const offset = lh * 0.6;
          const at = { x: middle.x + nx * offset, y: middle.y + ny * offset - labelHeight * 0.75 };

          if (ctx.clean) card('label', action.label, at, ctx.page.width * 0.22, 2);
          else write('label', action.label, at, labelHeight, Math.max(lh * 4, ctx.page.width * 0.3));
        }

        break;
      }
      case 'mark': {
        const rect = resolveTarget(action.target, ctx);

        if (!rect) break;

        const ink = MARK_INK[action.verdict];
        // Small and steady whatever the handwriting's size: a badge the size of a printed capital.
        const size = Math.min(ctx.page.height * BADGE_MAX, Math.max(lh * 0.9, ctx.page.height * BADGE_MIN));
        const made = action.label ? cardFor(action.label, ctx.page.width * 0.26, 2) : null;
        const gap = size * 0.35;
        const line = lineOf(rect);
        const anchor = { x: line.left + line.width + lh * 0.6, y: rect.top + rect.height / 2 - size / 2 };
        const wholeSize = { width: size + (made ? gap + made.width : 0), height: Math.max(size, made?.height ?? 0) };
        // The badge and its card as one box: at the end of the line, else right under it — inside this question.
        const whole = made ? fit({ left: anchor.x, top: anchor.y, ...wholeSize }, { left: under(line).x, top: under(line).y, ...wholeSize }, rect) : null;
        const box = whole ?? fit({ left: anchor.x, top: anchor.y, width: size, height: size }, { left: under(line).x, top: under(line).y, width: size, height: size }, rect);

        // The exact spot: a wavy line under a wrong or shaky step (never read as a fraction bar or the student's own underline).
        if (action.verdict !== 'correct') {
          const y = Math.min(ctx.page.top + ctx.page.height, rect.top + rect.height + lh * 0.3);
          const from = rect.left - lh * 0.1;
          const length = rect.width + lh * 0.2;
          const wave = Math.max(4, lh * 0.5);
          const count = Math.max(8, Math.round((length / wave) * 8));
          const points: ScenePt[] = [];

          for (let k = 0; k <= count; k += 1) {
            const t = k / count;

            points.push({ x: from + length * t, y: y + Math.sin((t * length * Math.PI * 2) / wave) * Math.max(1.5, lh * 0.09) });
          }

          stroke('underline', points, 'pen', Math.max(1.5, thin), ink);
        }

        // The label always reaches the student: on its card, or with the answer when the page has no room.
        if (action.label && !whole) overflow.push(action.label);

        if (!box) break;

        primitives.push({ kind: 'badge', verdict: action.verdict, at: { x: box.left + size / 2, y: box.top + box.height / 2 }, size, color: ink });
        extents.push({ left: box.left, top: box.top + (box.height - size) / 2, width: size, height: size });

        if (whole && made && action.label) {
          const chipBox = { left: box.left + size + gap, top: box.top + (box.height - made.height) / 2, width: made.width, height: made.height };

          primitives.push({ kind: 'chip', role: 'label', text: action.label, lines: made.lines, box: chipBox, fontSize: cardFont, rim: ink });
          extents.push(chipBox);
        }

        break;
      }
      case 'write': {
        const letterHeight = Math.max(2, pageLength(Math.min(NOTE_CAP, action.size ?? PEN_DEFAULT_LETTER), ctx.page));
        const nearRect = action.near ? resolveTarget(action.near, ctx) : null;
        const nearLine = nearRect ? lineOf(nearRect) : null;
        const at = nearLine ? beside(nearLine) : action.at ? toScenePoint(action.at, ctx.page) : null;

        if (!at) break;

        if (ctx.clean) {
          if (action.near && 'clusterId' in action.near && labelled.has(action.near.clusterId)) break;

          card('note', action.text, at, ctx.page.width * 0.3, 3, undefined, nearLine ? under(nearLine) : undefined, nearRect ?? undefined);
          break;
        }

        write('note', action.text, at, letterHeight, Math.max(letterHeight * 6, ctx.page.width * 0.42), undefined, nearLine ? under(nearLine) : undefined, nearRect ?? undefined);
        break;
      }
      case 'pen_stroke': {
        const points = action.points.map((point) => toScenePoint(point, ctx.page));
        const width = action.tool === 'highlighter' ? lh * 0.9 : action.tool === 'marker' ? nib * 2.2 : nib;

        stroke('ink', points, action.tool ?? 'pen', width);
        break;
      }
      default:
        break;
    }
  }

  return { primitives, bounds: unionOf(extents), overflow };
}
