import type { BBox, EraserCapsule, Vec } from './eraserGeometry';
import { capsuleBBox } from './eraserGeometry';

/**
 * One object-eraser pass over a BATCH of samples.
 *
 * The eraser used to run its whole pipeline — broad-phase query, exact hit tests, a `remove` + render
 * request per stroke — once per sample. The DOM path coalesced to one sample per frame; the Android
 * S Pen button path (MainActivity forwards every sample Android batched into the frame's ACTION_MOVE)
 * ran it for each of them back to back. Now a frame's samples become one swept polyline: ONE query
 * with the box of all its capsules, each candidate tested against the capsules it can reach, and the
 * hits removed together.
 */

/** The capsules the ring sweeps from `from` (the previous sample, or null at a drag's first) through `points`. */
export function sweepCapsules(from: Vec | null, points: readonly Vec[], r: number): EraserCapsule[] {
  const capsules: EraserCapsule[] = [];
  let previous = from;

  for (const point of points) {
    capsules.push({ a: previous ?? point, b: point, r });
    previous = point;
  }

  return capsules;
}

/** The union of the capsules' boxes, each padded by `pad`. Null for no capsules. */
export function capsulesBBox(capsules: readonly EraserCapsule[], pad = 0): BBox | null {
  if (capsules.length === 0) return null;

  const box = capsuleBBox(capsules[0], pad);

  for (let i = 1; i < capsules.length; i += 1) {
    const next = capsuleBBox(capsules[i], pad);

    box.minX = Math.min(box.minX, next.minX);
    box.minY = Math.min(box.minY, next.minY);
    box.maxX = Math.max(box.maxX, next.maxX);
    box.maxY = Math.max(box.maxY, next.maxY);
  }

  return box;
}

const boxesIntersect = (a: BBox, b: BBox): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

/**
 * The candidates any capsule touches, in candidate order. A capsule is only tested against a candidate
 * whose box it can reach (`bboxOf` null = always test), so a long batched sweep stays local per stroke.
 */
export function collectSweepHits<T>(
  candidates: readonly T[],
  capsules: readonly EraserCapsule[],
  hits: (obj: T, capsule: EraserCapsule) => boolean,
  bboxOf: (obj: T) => BBox | null = () => null,
  pad = 0,
): T[] {
  const capsuleBoxes = capsules.map((capsule) => capsuleBBox(capsule, pad));
  const result: T[] = [];

  for (const obj of candidates) {
    const box = bboxOf(obj);

    for (let i = 0; i < capsules.length; i += 1) {
      if (box && !boxesIntersect(box, capsuleBoxes[i])) continue;

      if (hits(obj, capsules[i])) {
        result.push(obj);
        break;
      }
    }
  }

  return result;
}
