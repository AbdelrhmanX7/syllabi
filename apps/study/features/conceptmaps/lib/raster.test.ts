import assert from 'node:assert/strict';
import { test } from 'node:test';

import { b64Bytes, contentBounds, fitWithin } from './raster';

/** A w×h picture filled with `bg`, with `marks` painted in `ink`. */
function picture(
  w: number,
  h: number,
  bg: [number, number, number],
  ink: [number, number, number],
  marks: [number, number][],
) {
  const data = new Uint8ClampedArray(w * h * 4);

  for (let i = 0; i < w * h; i += 1) {
    data[i * 4] = bg[0];
    data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2];
    data[i * 4 + 3] = 255;
  }
  for (const [x, y] of marks) {
    const offset = (y * w + x) * 4;

    data[offset] = ink[0];
    data[offset + 1] = ink[1];
    data[offset + 2] = ink[2];
  }

  return data;
}

test('contentBounds: white paper with black ink, padded and clamped', () => {
  const data = picture(
    100,
    80,
    [255, 255, 255],
    [0, 0, 0],
    [
      [10, 20],
      [60, 50],
    ],
  );

  assert.deepEqual(contentBounds(data, 100, 80, { pad: 5 }), { x: 5, y: 15, w: 61, h: 41 });
  assert.deepEqual(contentBounds(data, 100, 80, { pad: 50 }), { x: 0, y: 0, w: 100, h: 80 });
});

test('contentBounds: dark Samsung Notes background with coloured ink', () => {
  const data = picture(
    40,
    40,
    [17, 17, 19],
    [249, 115, 22],
    [
      [3, 3],
      [30, 10],
    ],
  );

  assert.deepEqual(contentBounds(data, 40, 40, { pad: 0 }), { x: 3, y: 3, w: 28, h: 8 });
});

test('contentBounds: faint grid lines under the threshold are background; blank is null', () => {
  const faint = picture(20, 20, [255, 255, 255], [230, 230, 230], [[5, 5]]);

  assert.equal(contentBounds(faint, 20, 20), null);
  assert.equal(contentBounds(new Uint8ClampedArray(0), 0, 0), null);
});

test('fitWithin never upscales', () => {
  assert.deepEqual(fitWithin(4000, 3000, 2000), { w: 2000, h: 1500 });
  assert.deepEqual(fitWithin(800, 600, 2000), { w: 800, h: 600 });
});

test('b64Bytes', () => {
  assert.equal(b64Bytes('AAAA'), 3);
  assert.equal(b64Bytes(''), 0);
});
