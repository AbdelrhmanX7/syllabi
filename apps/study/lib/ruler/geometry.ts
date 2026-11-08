// Pure ruler maths. Everything is in one plane of screen px (the board root's local space); the ruler
// is a rectangle `length × thickness` centred on `(cx, cy)` and rotated `angle` degrees clockwise.

export interface RulerPose {
  cx: number;
  cy: number;
  /** Degrees, any real number (kept unwrapped while a gesture runs). */
  angle: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** Angles within this many degrees of a multiple of {@link SNAP_STEP_DEG} lock to it. */
export const SNAP_TOLERANCE_DEG = 3;
export const SNAP_STEP_DEG = 45;

/** The angle, magnetised to the nearest 45° multiple when within tolerance. */
export function snapAngle(angle: number): number {
  const nearest = Math.round(angle / SNAP_STEP_DEG) * SNAP_STEP_DEG;

  return Math.abs(angle - nearest) <= SNAP_TOLERANCE_DEG ? nearest : angle;
}

/** Display angle: 0 ≤ a < 180 (a ruler turned half a turn is the same ruler). */
export function displayAngle(angle: number): number {
  return ((Math.round(angle * 10) / 10) % 180 + 180) % 180;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Ruler-local offset `(u along, v across, from the centre)` → plane point. */
export function toPlane(pose: RulerPose, u: number, v: number): Pt {
  const c = Math.cos(rad(pose.angle));
  const s = Math.sin(rad(pose.angle));

  return { x: pose.cx + u * c - v * s, y: pose.cy + u * s + v * c };
}

/** Plane point → ruler-local `(u, v)` from the centre. */
export function toLocal(pose: RulerPose, p: Pt): Pt {
  const c = Math.cos(rad(pose.angle));
  const s = Math.sin(rad(pose.angle));
  const dx = p.x - pose.cx;
  const dy = p.y - pose.cy;

  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

/** Is `p` on the ruler body (`slack` px of forgiveness around it)? */
export function hitsRuler(pose: RulerPose, length: number, thickness: number, p: Pt, slack = 0): boolean {
  const l = toLocal(pose, p);

  return Math.abs(l.x) <= length / 2 + slack && Math.abs(l.y) <= thickness / 2 + slack;
}

/** The two long sides as plane segments: top (the tick edge) then bottom. */
export function longEdges(pose: RulerPose, length: number, thickness: number): [[Pt, Pt], [Pt, Pt]] {
  const h = thickness / 2;
  const l = length / 2;

  return [
    [toPlane(pose, -l, -h), toPlane(pose, l, -h)],
    [toPlane(pose, -l, h), toPlane(pose, l, h)],
  ];
}

export const angleBetween = (a: Pt, b: Pt): number => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
export const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Keep the ruler's centre inside the board so it can always be grabbed again. */
export function clampCentre(pose: RulerPose, width: number, height: number): RulerPose {
  return { ...pose, cx: Math.min(width, Math.max(0, pose.cx)), cy: Math.min(height, Math.max(0, pose.cy)) };
}
