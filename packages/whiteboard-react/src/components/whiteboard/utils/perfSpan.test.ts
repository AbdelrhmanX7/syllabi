import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPerfSpanRecorderInstalled, perfMark, perfSpan, setPerfSpanRecorder } from './perfSpan';

type Recorded = { label: string; ms: number; detail?: string };

function install(): Recorded[] {
  const recorded: Recorded[] = [];

  setPerfSpanRecorder((label, ms, detail) => {
    recorded.push({ label, ms, detail });
  });

  return recorded;
}

test('perfSpan(): without a recorder it is a pass-through and never measures', () => {
  setPerfSpanRecorder(null);

  assert.equal(isPerfSpanRecorderInstalled(), false);
  assert.equal(
    perfSpan('noop', () => 42),
    42,
  );
});

test('perfSpan(): reports a synchronous span at or above the floor, passes the result through', () => {
  const recorded = install();
  const value = perfSpan('busy', () => {
    const until = performance.now() + 6;

    while (performance.now() < until) {
      // spin ~6 ms
    }

    return 'done';
  });

  assert.equal(value, 'done');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.label, 'busy');
  assert.ok((recorded[0]?.ms ?? 0) >= 4, `ms=${recorded[0]?.ms}`);
  setPerfSpanRecorder(null);
});

test('perfSpan(): measures an async span until it settles, resolved or rejected', async () => {
  const recorded = install();

  const resolved = await perfSpan(
    'async-ok',
    () => new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 8)),
  );

  assert.equal(resolved, 'ok');

  await assert.rejects(
    perfSpan('async-fail', () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('boom')), 8))),
    /boom/,
  );

  assert.deepEqual(
    recorded.map((entry) => entry.label),
    ['async-ok', 'async-fail'],
  );
  assert.ok(recorded.every((entry) => entry.ms >= 4));
  setPerfSpanRecorder(null);
});

test('perfMark(): drops sub-floor and non-finite durations, and a throwing recorder is contained', () => {
  const recorded = install();

  perfMark('tiny', 1);
  perfMark('nan', Number.NaN);
  perfMark('big', 12.34, 'x=1');

  assert.deepEqual(recorded, [{ label: 'big', ms: 12.3, detail: 'x=1' }]);

  setPerfSpanRecorder(() => {
    throw new Error('recorder broke');
  });
  assert.doesNotThrow(() => perfMark('still-fine', 50));
  setPerfSpanRecorder(null);
});
