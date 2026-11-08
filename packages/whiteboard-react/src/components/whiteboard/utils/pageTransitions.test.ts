import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampTransitionDurationMs,
  createTransitionFrame,
  easeOutCubic,
  isVerticalSplit,
  normalizeTransitionKind,
  resolveDirectionVector,
  resolveTransitionFrame,
  transitionEasing,
  MAX_TRANSITION_MS,
} from './pageTransitions';

import type { TransitionSpec } from './pageTransitions';

const W = 1000;
const H = 500;

const frameAt = (spec: TransitionSpec, progress: number) =>
  resolveTransitionFrame(spec, progress, W, H, createTransitionFrame());

test('an unknown or exotic kind degrades to fade', () => {
  assert.equal(normalizeTransitionKind('honeycomb'), 'fade');
  assert.equal(normalizeTransitionKind('wheel'), 'fade');
  assert.equal(normalizeTransitionKind(undefined), 'fade');
  assert.equal(normalizeTransitionKind('PUSH'), 'push');
});

test('duration is clamped to the ceiling, and unknown means instant', () => {
  assert.equal(clampTransitionDurationMs(800), 800);
  assert.equal(clampTransitionDurationMs(8_000), MAX_TRANSITION_MS);
  assert.equal(clampTransitionDurationMs(0), 0);
  assert.equal(clampTransitionDurationMs(-1), 0);
  assert.equal(clampTransitionDurationMs(Number.NaN), 0);
});

test('directions map to a motion vector, defaulting to left', () => {
  assert.deepEqual(resolveDirectionVector('u'), { x: 0, y: -1 });
  assert.deepEqual(resolveDirectionVector('d'), { x: 0, y: 1 });
  assert.deepEqual(resolveDirectionVector('r'), { x: 1, y: 0 });
  assert.deepEqual(resolveDirectionVector('ld'), { x: -1, y: 1 });
  assert.deepEqual(resolveDirectionVector(undefined), { x: -1, y: 0 });
});

test('sliding kinds ease out, opacity kinds stay linear', () => {
  assert.equal(transitionEasing('push'), easeOutCubic);
  assert.equal(transitionEasing('cover'), easeOutCubic);
  assert.equal(transitionEasing('uncover'), easeOutCubic);
  assert.equal(transitionEasing('fade')(0.5), 0.5);
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.ok(easeOutCubic(0.5) > 0.5);
});

test('cut shows the old page until the very end', () => {
  assert.equal(frameAt({ kind: 'cut' }, 0).previous.visible, true);
  assert.equal(frameAt({ kind: 'cut' }, 0).next.visible, false);
  assert.equal(frameAt({ kind: 'cut' }, 0.5).previous.visible, true);
  assert.equal(frameAt({ kind: 'cut' }, 1).previous.visible, false);
  assert.equal(frameAt({ kind: 'cut' }, 1).next.visible, true);
});

test('fade ramps the new page in over a fully opaque old one', () => {
  assert.equal(frameAt({ kind: 'fade' }, 0).next.alpha, 0);
  assert.equal(frameAt({ kind: 'fade' }, 0.5).next.alpha, 0.5);
  assert.equal(frameAt({ kind: 'fade' }, 1).next.alpha, 1);
  assert.equal(frameAt({ kind: 'fade' }, 0.5).previous.alpha, 1);
});

test('push moves both pages, the new one arriving from the opposite edge', () => {
  const start = frameAt({ direction: 'u', kind: 'push' }, 0);
  const end = frameAt({ direction: 'u', kind: 'push' }, 1);

  assert.equal(start.next.dy, H);
  assert.equal(start.previous.dy, 0);
  assert.equal(end.next.dy, 0);
  assert.equal(end.previous.dy, -H);
});

test('push to the left arrives from the right', () => {
  const start = frameAt({ direction: 'l', kind: 'push' }, 0);

  assert.equal(start.next.dx, W);
  assert.equal(frameAt({ direction: 'l', kind: 'push' }, 1).previous.dx, -W);
});

test('cover moves only the new page; uncover moves only the old, and paints it on top', () => {
  const cover = frameAt({ direction: 'r', kind: 'cover' }, 0);

  assert.equal(cover.next.dx, -W);
  assert.equal(cover.previous.dx, 0);
  assert.equal(cover.previousOnTop, false);

  const uncover = frameAt({ direction: 'r', kind: 'uncover' }, 1);

  assert.equal(uncover.previous.dx, W);
  assert.equal(uncover.next.dx, 0);
  assert.equal(uncover.previousOnTop, true);
});

test('wipe grows a band from the edge the motion travels away from', () => {
  const up = frameAt({ direction: 'u', kind: 'wipe' }, 0.5);

  // Moving up uncovers from the bottom.
  assert.deepEqual(
    { height: up.next.clipA.height, y: up.next.clipA.y },
    { height: H / 2, y: H / 2 },
  );

  const right = frameAt({ direction: 'r', kind: 'wipe' }, 0.5);

  assert.deepEqual({ width: right.next.clipA.width, x: right.next.clipA.x }, { width: W / 2, x: 0 });
  assert.equal(frameAt({ direction: 'u', kind: 'wipe' }, 0).next.clipA.height, 0);
  assert.equal(frameAt({ direction: 'u', kind: 'wipe' }, 1).next.clipA.height, H);
});

test('split out opens one band from the centre', () => {
  const half = frameAt({ direction: 'd', kind: 'split' }, 0.5);

  assert.equal(half.next.clipA.height, H / 2);
  assert.equal(half.next.clipA.y, H / 4);
  assert.equal(half.next.clipB.active, false);
  assert.equal(frameAt({ direction: 'd', kind: 'split' }, 1).next.clipA.height, H);
});

test('split in closes two bands from both edges', () => {
  const half = frameAt({ direction: 'd', kind: 'split', option: 'in' }, 0.5);

  assert.equal(half.next.clipA.active, true);
  assert.equal(half.next.clipB.active, true);
  assert.equal(half.next.clipA.y, 0);
  assert.equal(half.next.clipA.height, H / 4);
  assert.equal(half.next.clipB.y, H - H / 4);
});

test('orient decides the split axis, over any direction', () => {
  // OOXML: a horizontal split LINE means the halves move vertically.
  assert.equal(isVerticalSplit({ kind: 'split', orient: 'horz' }), true);
  assert.equal(isVerticalSplit({ kind: 'split', orient: 'vert' }), false);
  // orient wins even when the direction says otherwise.
  assert.equal(isVerticalSplit({ direction: 'l', kind: 'split', orient: 'horz' }), true);
  assert.equal(isVerticalSplit({ direction: 'u', kind: 'split', orient: 'vert' }), false);
  // No orient: fall back to the direction, and to PowerPoint's own default when there is none.
  assert.equal(isVerticalSplit({ direction: 'r', kind: 'split' }), false);
  assert.equal(isVerticalSplit({ kind: 'split' }), true);
});

test('split vertical inward closes two bands along the x axis', () => {
  const half = frameAt({ kind: 'split', option: 'in', orient: 'vert' }, 0.5);

  assert.equal(half.next.clipA.active, true);
  assert.equal(half.next.clipB.active, true);
  assert.equal(half.next.clipA.x, 0);
  assert.equal(half.next.clipA.width, W / 4);
  assert.equal(half.next.clipA.height, H);
  assert.equal(half.next.clipB.x, W - W / 4);
});

test('split horizontal outward opens one band along the y axis', () => {
  const half = frameAt({ kind: 'split', orient: 'horz' }, 0.5);

  assert.equal(half.next.clipA.height, H / 2);
  assert.equal(half.next.clipA.y, H / 4);
  assert.equal(half.next.clipB.active, false);
});

test('zoom reads in and out from option, ignoring direction', () => {
  const zoomOut = frameAt({ direction: 'u', kind: 'zoom', option: 'out' }, 0);

  assert.ok(zoomOut.next.scale > 1);
  assert.equal(zoomOut.next.alpha, 0);

  const zoomIn = frameAt({ direction: 'u', kind: 'zoom', option: 'in' }, 0);

  assert.ok(zoomIn.next.scale < 1);
  assert.equal(frameAt({ kind: 'zoom', option: 'out' }, 0.5).next.alpha, 0.5);
});

test('split follows the axis of its direction', () => {
  const horizontal = frameAt({ direction: 'l', kind: 'split' }, 0.5);

  assert.equal(horizontal.next.clipA.width, W / 2);
  assert.equal(horizontal.next.clipA.height, H);
});

test('zoom grows the new page in, or drops it in oversized', () => {
  const growIn = frameAt({ kind: 'zoom' }, 0);

  assert.ok(growIn.next.scale < 1);
  assert.equal(frameAt({ kind: 'zoom' }, 1).next.scale, 1);

  const dropIn = frameAt({ kind: 'zoom', option: 'out' }, 0);

  assert.ok(dropIn.next.scale > 1);
  assert.equal(frameAt({ kind: 'zoom', option: 'out' }, 1).next.scale, 1);
});

test('an exotic kind is laid out exactly like a fade', () => {
  const exotic = frameAt({ direction: 'u', kind: 'newsflash' }, 0.5);
  const fade = frameAt({ kind: 'fade' }, 0.5);

  assert.equal(exotic.next.alpha, fade.next.alpha);
  assert.equal(exotic.next.dx, 0);
  assert.equal(exotic.next.dy, 0);
  assert.equal(exotic.next.clipA.active, false);
});

test('every kind lands on the identity layout at progress 1', () => {
  for (const kind of ['fade', 'push', 'cover', 'uncover', 'wipe', 'split', 'zoom'] as const) {
    const end = frameAt({ direction: 'u', kind }, 1);

    assert.equal(end.next.alpha, 1, `${kind} alpha`);
    assert.equal(end.next.dx, 0, `${kind} dx`);
    assert.equal(end.next.dy, 0, `${kind} dy`);
    assert.equal(end.next.scale, 1, `${kind} scale`);
  }
});

test('the frame object is reused rather than reallocated', () => {
  const frame = createTransitionFrame();

  assert.equal(resolveTransitionFrame({ kind: 'fade' }, 0.25, W, H, frame), frame);
  assert.equal(frame.next.alpha, 0.25);
  // A clip set by one kind must not leak into the next frame's layout.
  resolveTransitionFrame({ direction: 'u', kind: 'wipe' }, 0.5, W, H, frame);
  assert.equal(frame.next.clipA.active, true);
  resolveTransitionFrame({ kind: 'fade' }, 0.5, W, H, frame);
  assert.equal(frame.next.clipA.active, false);
});
