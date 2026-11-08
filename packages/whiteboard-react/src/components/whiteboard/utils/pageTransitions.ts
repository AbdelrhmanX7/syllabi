/**
 * Slide TRANSITIONS — the animation between two pages, as PowerPoint plays it.
 *
 * This module is the pure half: given a kind, a direction and a progress between 0 and 1, it says
 * where the outgoing and incoming page sit, how opaque each is, and what part of each is visible.
 * It knows nothing about canvases, so the painter can stay a loop of draw calls and this can be
 * tested directly.
 *
 * Geometry convention: both layers are the FULL page area, `width` × `height` in CSS pixels, and an
 * offset moves that whole area. A clip is expressed in the same space, with (0,0) at the layer's
 * top-left. The painter never has to reconcile two coordinate systems.
 */

/** The transition kinds drawn natively. Anything else the deck asks for degrades to `fade`. */
export type TransitionKind = 'cut' | 'fade' | 'push' | 'wipe' | 'cover' | 'uncover' | 'split' | 'zoom';

const NATIVE_KINDS: readonly TransitionKind[] = ['cut', 'fade', 'push', 'wipe', 'cover', 'uncover', 'split', 'zoom'];

/**
 * The longest a transition may run. A deck can ask for eight seconds; on a whiteboard that is eight
 * seconds of a teacher waiting to write, so it is cut to three.
 */
export const MAX_TRANSITION_MS = 3_000;

/**
 * Map a deck's transition name onto something we can draw. The exotic p14 kinds (wheel, blinds,
 * comb, honeycomb, …) all land on `fade`, which reads as deliberate rather than broken — unlike an
 * unhandled name, which would show as an instant jump.
 */
export function normalizeTransitionKind(kind: string | undefined): TransitionKind {
  if (!kind) return 'fade';

  const lowered = kind.trim().toLowerCase();

  return (NATIVE_KINDS as readonly string[]).includes(lowered) ? (lowered as TransitionKind) : 'fade';
}

/** Clamp a declared duration into what we will actually animate. Unknown or ≤ 0 means instant. */
export function clampTransitionDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;

  return Math.min(durationMs, MAX_TRANSITION_MS);
}

/**
 * The direction a transition MOVES, following OOXML: `u` pushes the content upward, so the incoming
 * page rises from below. Diagonals combine both axes. An absent direction moves left, PowerPoint's
 * own default for a push.
 */
export function resolveDirectionVector(direction: string | undefined): { x: number; y: number } {
  switch ((direction ?? 'l').trim().toLowerCase()) {
    case 'r':
      return { x: 1, y: 0 };
    case 'u':
      return { x: 0, y: -1 };
    case 'd':
      return { x: 0, y: 1 };
    case 'lu':
      return { x: -1, y: -1 };
    case 'ld':
      return { x: -1, y: 1 };
    case 'ru':
      return { x: 1, y: -1 };
    case 'rd':
      return { x: 1, y: 1 };
    case 'l':
    default:
      return { x: -1, y: 0 };
  }
}

export function easeOutCubic(t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;

  return 1 - (1 - clamped) ** 3;
}

export function linearEasing(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/**
 * Sliding kinds ease out, so the page arrives the way a physical card would rather than stopping
 * dead. A fade or a wipe stays linear: eased opacity reads as a stutter.
 */
export function transitionEasing(kind: TransitionKind): (t: number) => number {
  return kind === 'push' || kind === 'cover' || kind === 'uncover' ? easeOutCubic : linearEasing;
}

export interface TransitionClip {
  active: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TransitionLayerFrame {
  /** False when this layer contributes nothing to the frame and can be skipped entirely. */
  visible: boolean;
  alpha: number;
  /** Offset of the whole page area, in CSS pixels. */
  dx: number;
  dy: number;
  /** Uniform scale about the page area's centre. */
  scale: number;
  /** Up to two clip rects; a layer with both active is drawn through their union (`split` inward). */
  clipA: TransitionClip;
  clipB: TransitionClip;
}

export interface TransitionFrame {
  previous: TransitionLayerFrame;
  next: TransitionLayerFrame;
  /** `uncover` slides the OLD page away over the new one, so the old is painted last. */
  previousOnTop: boolean;
}

/**
 * Fold `-0` to `0`. Multiplying a direction of -1 by a progress of 0 yields negative zero, which is
 * invisible on a canvas but is a distinct value to `Object.is`, so it leaks into equality checks.
 */
const px = (value: number): number => value + 0;

const createLayer = (): TransitionLayerFrame => ({
  alpha: 1,
  clipA: { active: false, height: 0, width: 0, x: 0, y: 0 },
  clipB: { active: false, height: 0, width: 0, x: 0, y: 0 },
  dx: 0,
  dy: 0,
  scale: 1,
  visible: true,
});

/**
 * One reusable frame object. The painter allocates a single one per component and hands it back on
 * every animation frame, so a transition running at 60 fps allocates nothing.
 */
export function createTransitionFrame(): TransitionFrame {
  return { next: createLayer(), previous: createLayer(), previousOnTop: false };
}

function resetLayer(layer: TransitionLayerFrame): void {
  layer.visible = true;
  layer.alpha = 1;
  layer.dx = 0;
  layer.dy = 0;
  layer.scale = 1;
  layer.clipA.active = false;
  layer.clipB.active = false;
}

function setClip(clip: TransitionClip, x: number, y: number, width: number, height: number): void {
  clip.active = true;
  clip.x = x;
  clip.y = y;
  clip.width = width;
  clip.height = height;
}

export interface TransitionSpec {
  kind: string | undefined;
  /** Compass motion only: l, r, u, d, ld, lu, rd, ru. */
  direction?: string;
  /** in / out, for split and zoom. */
  option?: string;
  /** Axis for split, OOXML spelling: `horz` = a horizontal split line, so the halves move vertically. */
  orient?: 'horz' | 'vert';
}

/**
 * Which axis a split opens along, as a boolean "vertically" (top and bottom halves).
 *
 * `orient` is authoritative, because the native side emits it for exactly this. A deck that gives
 * only a direction falls back to the axis that direction moves along, and a transition with neither
 * splits vertically, which is PowerPoint's own default (`orient="horz"`).
 */
export function isVerticalSplit(spec: TransitionSpec): boolean {
  if (spec.orient === 'horz') return true;
  if (spec.orient === 'vert') return false;

  return resolveDirectionVector(spec.direction).y !== 0 || spec.direction === undefined;
}

/**
 * Fill `out` with the layout of one animation frame.
 *
 * `progress` is RAW time progress (0 → 1); the easing for the kind is applied here, so the caller
 * only has to divide elapsed time by duration.
 */
export function resolveTransitionFrame(
  spec: TransitionSpec,
  progress: number,
  width: number,
  height: number,
  out: TransitionFrame,
): TransitionFrame {
  const kind = normalizeTransitionKind(spec.kind);
  const p = transitionEasing(kind)(progress);
  const vector = resolveDirectionVector(spec.direction);
  const option = spec.option?.trim().toLowerCase();

  resetLayer(out.previous);
  resetLayer(out.next);
  out.previousOnTop = false;

  switch (kind) {
    case 'cut': {
      // Nothing animates: the old page is on screen until the moment the new one replaces it.
      out.previous.visible = p < 1;
      out.next.visible = p >= 1;
      break;
    }

    case 'fade': {
      out.next.alpha = p;
      break;
    }

    case 'push': {
      out.next.dx = px(-vector.x * width * (1 - p));
      out.next.dy = px(-vector.y * height * (1 - p));
      out.previous.dx = px(vector.x * width * p);
      out.previous.dy = px(vector.y * height * p);
      break;
    }

    case 'cover': {
      // The new page slides over a stationary old one.
      out.next.dx = px(-vector.x * width * (1 - p));
      out.next.dy = px(-vector.y * height * (1 - p));
      break;
    }

    case 'uncover': {
      // The old page slides away and reveals a stationary new one underneath.
      out.previous.dx = px(vector.x * width * p);
      out.previous.dy = px(vector.y * height * p);
      out.previousOnTop = true;
      break;
    }

    case 'wipe': {
      // The revealed band grows from the edge the motion travels AWAY from: moving up uncovers
      // from the bottom. Diagonals wipe along their horizontal component.
      if (vector.x !== 0) {
        const bandWidth = width * p;

        setClip(out.next.clipA, vector.x < 0 ? width - bandWidth : 0, 0, bandWidth, height);
      } else {
        const bandHeight = height * p;

        setClip(out.next.clipA, 0, vector.y < 0 ? height - bandHeight : 0, width, bandHeight);
      }

      break;
    }

    case 'split': {
      // `out` (the default) opens from the centre; `in` closes from both edges toward it.
      const vertical = isVerticalSplit(spec);
      const inward = option === 'in';
      const span = vertical ? height : width;
      const grown = span * p;

      if (inward) {
        const band = grown / 2;

        if (vertical) {
          setClip(out.next.clipA, 0, 0, width, band);
          setClip(out.next.clipB, 0, height - band, width, band);
        } else {
          setClip(out.next.clipA, 0, 0, band, height);
          setClip(out.next.clipB, width - band, 0, band, height);
        }
      } else if (vertical) {
        setClip(out.next.clipA, 0, (height - grown) / 2, width, grown);
      } else {
        setClip(out.next.clipA, (width - grown) / 2, 0, grown, height);
      }

      break;
    }

    case 'zoom': {
      // `in` (the default) grows the new page from small; `out` drops it in from oversized.
      const from = option === 'out' ? ZOOM_OUT_FROM : ZOOM_IN_FROM;

      out.next.scale = from + (1 - from) * p;
      out.next.alpha = p;
      break;
    }
  }

  return out;
}

const ZOOM_IN_FROM = 0.3;
const ZOOM_OUT_FROM = 1.6;
