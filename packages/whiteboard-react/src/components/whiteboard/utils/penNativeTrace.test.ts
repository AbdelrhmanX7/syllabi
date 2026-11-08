import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNativeMoveRateMeter } from './penNativeTrace';

test('the MOVE rate meter yields one line per elapsed second and flushes the partial window', () => {
  const meter = createNativeMoveRateMeter();
  const lines: string[] = [];

  meter.reset(1000);

  // 60 Hz for 2.5 s, two samples per frame.
  for (let t = 1016; t <= 3500; t += 16) {
    const line = meter.frame(2, t);

    if (line) lines.push(line);
  }

  assert.equal(lines.length, 2, `expected one line per second, got ${JSON.stringify(lines)}`);
  assert.match(lines[0], /^MOVE 63 frames \/ 126 samples in 1008 ms \(63\/s\)$/);

  const tail = meter.flush(3500);

  assert.ok(tail && /^MOVE \d+ frames/.test(tail), 'the partial window was not flushed');
  assert.equal(meter.flush(3600), null, 'an empty window must not log');
});
