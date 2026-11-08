import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compactCanvasJson, serializeCanvasJson } from './canvasJson';

test('path segment coordinates are rounded to two decimals, commands untouched', () => {
  const json = {
    objects: [
      { type: 'Path', path: [['M', 832.2351643440477, -262.69931663013267], ['Q', 1.006, 2.004999, 3, 4.1], ['Z']] },
    ],
  };

  compactCanvasJson(json);

  assert.deepEqual(json.objects[0].path, [['M', 832.24, -262.7], ['Q', 1.01, 2, 3, 4.1], ['Z']]);
});

test('polyline points and nested group children are rounded; other props are left alone', () => {
  const json = {
    objects: [
      { type: 'Polyline', left: 10.123456, points: [{ x: 1.23456, y: 9.87654 }] },
      { type: 'Group', objects: [{ type: 'Path', path: [['L', 5.555, 6.666]] }] },
    ],
  };

  compactCanvasJson(json);

  assert.equal((json.objects[0] as { left: number }).left, 10.123456);
  assert.deepEqual((json.objects[0] as { points: unknown }).points, [{ x: 1.23, y: 9.88 }]);
  assert.deepEqual(((json.objects[1] as { objects: { path: unknown }[] }).objects[0]).path, [['L', 5.56, 6.67]]);
});

test('serializeCanvasJson shrinks a full-precision stroke by more than half', () => {
  const segments = Array.from({ length: 200 }, (_, index) => [
    'Q',
    100 + index * 1.3333333333333333,
    -50 - index * 0.7777777777777777,
    101 + index * 1.3333333333333333,
    -51 - index * 0.7777777777777777,
  ]);
  const canvas = { toJSON: () => ({ objects: [{ type: 'Path', path: segments.map((segment) => [...segment]) }] }) };
  const raw = JSON.stringify(canvas.toJSON());
  const compact = serializeCanvasJson(canvas);

  assert.ok(compact.length < raw.length / 2, `${compact.length} vs ${raw.length}`);
  assert.equal(JSON.parse(compact).objects[0].path.length, 200);
});
