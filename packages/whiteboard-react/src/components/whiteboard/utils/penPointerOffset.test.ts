import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { penOffsetToCanvasDelta } from './penPointerOffset';

/**
 * The contract is not "does the arithmetic look right" — it is "does applying this delta land the point
 * exactly where Fabric would have put a client coordinate that was already shifted by it". So the
 * reference here is a straight transcription of `_getPointerImpl`'s POINT path (fabric 7.2.0), and every
 * test asserts
 *
 *     reference(client + clientDelta) === reference(client) + penOffsetToCanvasDelta(clientDelta)
 *
 * which is the property the patched pointer resolution actually relies on.
 */
type Setup = {
  fromViewport: boolean;
  viewportTransform: number[];
  retinaScaling: number;
  cssScale: { x: number; y: number };
  offset: { left: number; top: number };
};

/** `_getPointerImpl`'s point path, transcribed. */
function referencePoint(client: { x: number; y: number }, setup: Setup): { x: number; y: number } {
  let x = client.x - setup.offset.left;
  let y = client.y - setup.offset.top;

  if (!setup.fromViewport) {
    // sendPointToPlane(point, undefined, vpt) === transformPoint(point, invertTransform(vpt))
    const [a, b, c, d, e, f] = setup.viewportTransform;
    const determinant = a * d - b * c;
    const inverse = [
      d / determinant,
      -b / determinant,
      -c / determinant,
      a / determinant,
      (c * f - d * e) / determinant,
      (b * e - a * f) / determinant,
    ];
    const nextX = x * inverse[0] + y * inverse[2] + inverse[4];
    const nextY = x * inverse[1] + y * inverse[3] + inverse[5];

    x = nextX;
    y = nextY;
  }

  if (setup.retinaScaling !== 1) {
    x /= setup.retinaScaling;
    y /= setup.retinaScaling;
  }

  return { x: x * setup.cssScale.x, y: y * setup.cssScale.y };
}

function assertMatchesReference(setup: Setup, client: { x: number; y: number }, delta: { x: number; y: number }) {
  const base = referencePoint(client, setup);
  const shifted = referencePoint({ x: client.x + delta.x, y: client.y + delta.y }, setup);
  const applied = penOffsetToCanvasDelta({
    clientDelta: delta,
    fromViewport: setup.fromViewport,
    viewportTransform: setup.viewportTransform,
    retinaScaling: setup.retinaScaling,
    cssScale: setup.cssScale,
  });

  assert.ok(
    Math.abs(base.x + applied.x - shifted.x) < 1e-9 && Math.abs(base.y + applied.y - shifted.y) < 1e-9,
    `expected (${base.x + applied.x}, ${base.y + applied.y}) to equal (${shifted.x}, ${shifted.y})`,
  );
}

const CLIENT = { x: 731, y: 402 };
const NIB_LIFT = { x: -1.4, y: -2.6 };

describe('penOffsetToCanvasDelta', () => {
  it('matches a pre-shifted client point at zoom 1', () => {
    assertMatchesReference(
      {
        fromViewport: false,
        viewportTransform: [1, 0, 0, 1, 0, 0],
        retinaScaling: 1,
        cssScale: { x: 1, y: 1 },
        offset: { left: 12, top: 30 },
      },
      CLIENT,
      NIB_LIFT,
    );
  });

  it('matches under zoom and pan — the correction must shrink as the board zooms in', () => {
    const setup: Setup = {
      fromViewport: false,
      viewportTransform: [1.8, 0, 0, 1.8, -240, -95],
      retinaScaling: 1,
      cssScale: { x: 1, y: 1 },
      offset: { left: 12, top: 30 },
    };

    assertMatchesReference(setup, CLIENT, NIB_LIFT);

    // A 2px lift on screen must be 2/1.8 px in the scene, or the nib correction would grow with zoom.
    const applied = penOffsetToCanvasDelta({
      clientDelta: { x: 0, y: -2 },
      fromViewport: false,
      viewportTransform: setup.viewportTransform,
      retinaScaling: 1,
      cssScale: { x: 1, y: 1 },
    });

    assert.ok(Math.abs(applied.y - -2 / 1.8) < 1e-9, `expected -1.111…, got ${applied.y}`);
  });

  it('matches under a ROTATED viewport (page rotation), where x and y mix', () => {
    const angle = Math.PI / 7;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    assertMatchesReference(
      {
        fromViewport: false,
        viewportTransform: [1.3 * cos, 1.3 * sin, -1.3 * sin, 1.3 * cos, 60, -18],
        retinaScaling: 1,
        cssScale: { x: 1, y: 1 },
        offset: { left: 12, top: 30 },
      },
      CLIENT,
      NIB_LIFT,
    );
  });

  it('matches with retina scaling and a CSS/backing-store mismatch', () => {
    assertMatchesReference(
      {
        fromViewport: false,
        viewportTransform: [1.25, 0, 0, 1.25, 40, 12],
        retinaScaling: 2,
        cssScale: { x: 1.37, y: 1.37 },
        offset: { left: 12, top: 30 },
      },
      CLIENT,
      NIB_LIFT,
    );
  });

  it('skips the viewport transform when the caller asked for viewport coordinates', () => {
    assertMatchesReference(
      {
        fromViewport: true,
        viewportTransform: [2.4, 0, 0, 2.4, -300, -140],
        retinaScaling: 2,
        cssScale: { x: 1.1, y: 0.9 },
        offset: { left: 12, top: 30 },
      },
      CLIENT,
      NIB_LIFT,
    );
  });

  it('is a no-op for a zero correction', () => {
    const applied = penOffsetToCanvasDelta({
      clientDelta: { x: 0, y: 0 },
      fromViewport: false,
      viewportTransform: [1.8, 0, 0, 1.8, -240, -95],
      retinaScaling: 2,
      cssScale: { x: 1.37, y: 1.37 },
    });

    assert.deepEqual(applied, { x: 0, y: 0 });
  });

  it('never emits NaN from a singular viewport transform', () => {
    const applied = penOffsetToCanvasDelta({
      clientDelta: NIB_LIFT,
      fromViewport: false,
      viewportTransform: [0, 0, 0, 0, 0, 0],
      retinaScaling: 1,
      cssScale: { x: 1, y: 1 },
    });

    assert.ok(Number.isFinite(applied.x) && Number.isFinite(applied.y), `got ${applied.x}, ${applied.y}`);
  });
});
