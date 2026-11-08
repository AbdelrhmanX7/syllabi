import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrameMeter, frameStats, isJanky, RateLimiter } from './frames';
import {
  chromeMajor,
  describeTarget,
  errorKey,
  filterEventEntries,
  LOAF_MAX_SCRIPTS,
  parseError,
  parseEventTiming,
  parseLoaf,
  parseLongTask,
  shortenUrl,
  topOfStack,
} from './parse';
import { PerfRollup } from './rollup';

test('parseLoaf: epoch time, blocking, work/layout split, top scripts by duration', () => {
  const scripts = [
    {
      sourceURL: 'https://study.app/_next/static/chunks/a.js?v=2',
      sourceFunctionName: 'small',
      invoker: 'X',
      invokerType: 'user-callback',
      duration: 6,
    },
    {
      sourceURL: 'https://study.app/_next/static/chunks/fabric.js',
      sourceFunctionName: 'renderAll',
      invoker: 'Window.requestAnimationFrame',
      invokerType: 'user-callback',
      duration: 80.44,
      forcedStyleAndLayoutDuration: 12.3,
    },
    { sourceURL: 'x', duration: 2 },
    ...Array.from({ length: 8 }, (_, index) => ({ sourceURL: `s${index}.js`, duration: 10 + index })),
  ];
  const event = parseLoaf(
    { startTime: 1000, duration: 120, blockingDuration: 70, renderStart: 1100, styleAndLayoutStart: 1105, scripts },
    1_700_000_000_000,
  );

  assert.equal(event.k, 'loaf');
  assert.equal(event.t, 1_700_000_001_000);
  assert.equal(event.dur, 120);
  assert.equal(event.blk, 70);
  assert.equal(event.work, 100);
  assert.equal(event.layout, 15);
  assert.equal(event.scripts.length, LOAF_MAX_SCRIPTS);
  assert.deepEqual(event.scripts[0], {
    src: '/_next/static/chunks/fabric.js',
    fn: 'renderAll',
    inv: 'Window.requestAnimationFrame',
    it: 'user-callback',
    dur: 80.4,
    fsl: 12.3,
  });
  assert.ok(event.scripts.every((script) => script.dur >= 5));
});

test('parseLoaf tolerates entries without scripts/renderStart (older WebViews)', () => {
  const event = parseLoaf({ startTime: 0, duration: 60 }, 0);

  assert.deepEqual(event.scripts, []);
  assert.equal(event.blk, 0);
  assert.equal(event.work, 60);
  assert.equal(event.layout, 0);
});

test('parseLongTask + parseEventTiming', () => {
  const task = parseLongTask({ startTime: 5, duration: 75.55, attribution: [{ containerType: 'window' }] }, 100);

  assert.deepEqual(task, { k: 'longtask', t: 105, dur: 75.6, attr: 'window' });
  const target = {
    tagName: 'CANVAS',
    id: '',
    className: 'upper-canvas absolute inset-0',
    getAttribute: () => null,
  };
  const event = parseEventTiming(
    { name: 'pointerdown', startTime: 10, duration: 96, processingStart: 40, processingEnd: 90, target },
    0,
  );

  assert.deepEqual(event, {
    k: 'event',
    t: 10,
    name: 'pointerdown',
    dur: 96,
    delay: 30,
    proc: 50,
    tgt: 'canvas.upper-canvas',
  });
});

test('describeTarget: id, label, never text; utility classes skipped', () => {
  assert.equal(describeTarget({ tagName: 'BUTTON', id: 'save', getAttribute: () => null }), 'button#save');
  assert.equal(
    describeTarget({
      tagName: 'BUTTON',
      className: 'h-9 px-3 hover:bg-x',
      getAttribute: (name: string) => (name === 'aria-label' ? 'Undo' : null),
    }),
    'button[Undo]',
  );
  assert.equal(describeTarget(null), undefined);
  assert.equal(describeTarget({}), undefined);
});

test('shortenUrl drops origin + query, keeps the tail', () => {
  assert.equal(shortenUrl('tauri://localhost/_next/a.js?x#y'), '/_next/a.js');
  assert.equal(shortenUrl(''), '');
  const long = shortenUrl(`https://h/${'d/'.repeat(100)}file.js`);

  assert.equal(long.length, 120);
  assert.ok(long.endsWith('file.js'));
});

test('errors: message, top 3 frames without origins, dedupe key', () => {
  const error = new TypeError('x is undefined');

  error.stack =
    'TypeError: x is undefined\n    at a (https://h/_next/a.js:1:2)\n    at b (https://h/b.js:3:4)\n    at c (c.js)\n    at d (d.js)';
  const event = parseError('error', error, 5, { filename: 'https://h/_next/a.js', lineno: 1, colno: 2 });

  assert.equal(event.msg, 'TypeError: x is undefined');
  assert.equal(event.stack, 'at a (/_next/a.js:1:2)\nat b (/b.js:3:4)\nat c (c.js)');
  assert.equal(event.src, '/_next/a.js:1:2');
  assert.equal(errorKey(event), 'TypeError: x is undefined|at a (/_next/a.js:1:2)');
  assert.equal(parseError('rejection', 'plain', 1).msg, 'plain');
  assert.equal(topOfStack(undefined), undefined);
});

test('chromeMajor', () => {
  assert.equal(
    chromeMajor(
      'Mozilla/5.0 (Linux; Android 13; SM-T505) AppleWebKit/537.36 Chrome/138.0.7204.63 Mobile Safari/537.36',
    ),
    138,
  );
  assert.equal(chromeMajor('Firefox'), undefined);
});

test('frame stats: drops at 60 Hz, worst, slow, jank threshold', () => {
  const smooth = frameStats([16.7, 16.6, 17, 20, 16.7]);

  assert.equal(smooth.dropped, 0);
  assert.equal(isJanky(smooth), false);
  const janky = frameStats([16.7, 50, 16.7, 100]);

  assert.equal(janky.frames, 4);
  assert.equal(janky.dropped, 2 + 5);
  assert.equal(janky.worst, 100);
  assert.equal(janky.slow, 1);
  assert.equal(janky.pct, Math.round((7 / 11) * 1000) / 10);
  assert.equal(isJanky(janky), true);
  const meter = new FrameMeter();

  meter.add(0);
  meter.add(Number.NaN);
  assert.equal(meter.stats().frames, 0);
});

test('rate limiter: fixed window per key', () => {
  const rate = new RateLimiter(2, 1000);

  assert.equal(rate.allow('a', 0), true);
  assert.equal(rate.allow('a', 10), true);
  assert.equal(rate.allow('a', 20), false);
  assert.equal(rate.allow('b', 20), true);
  assert.equal(rate.allow('a', 1000), true);
});

test('rollup: smooth gestures + skips become one gsum; repeated errors fold into n', () => {
  const rollup = new PerfRollup();

  assert.deepEqual(rollup.drain(1), []);
  rollup.smoothGesture('pen', { frames: 30, dropped: 1, pct: 3, worst: 30, slow: 0 });
  rollup.smoothGesture('pen', { frames: 10, dropped: 0, pct: 0, worst: 17, slow: 0 });
  rollup.skip('loaf');
  const error = parseError('error', new Error('boom'), 1);

  assert.ok(rollup.error(error));
  assert.equal(rollup.error({ ...error, t: 2 }), null);
  assert.equal(rollup.error({ ...error, t: 3 }), null);
  const out = rollup.drain(9);

  assert.deepEqual(out[0], { k: 'gsum', t: 9, n: { pen: 2 }, frames: 40, dropped: 1, sk: { loaf: 1 } });
  assert.equal(out[1].k, 'error');
  assert.equal((out[1] as { n?: number }).n, 2);
  assert.deepEqual(rollup.drain(10), []);
});

test('filterEventEntries drops enter/leave noise and dedupes interactions and twins', () => {
  const kept = filterEventEntries([
    { name: 'pointerenter', startTime: 10, duration: 48 },
    { name: 'pointerleave', startTime: 10, duration: 48 },
    { name: 'gotpointercapture', startTime: 10, duration: 48 },
    { name: 'pointerdown', startTime: 10, duration: 48, interactionId: 7 },
    { name: 'pointerup', startTime: 30, duration: 64, interactionId: 7 },
    { name: 'click', startTime: 31, duration: 56, interactionId: 7 },
    { name: 'touchstart', startTime: 90, duration: 40, interactionId: 0 },
    { name: 'touchstart', startTime: 90, duration: 40, interactionId: 0 },
    { name: 'touchmove', startTime: 90, duration: 40 },
  ]);

  assert.deepEqual(
    kept.map((entry) => entry.name),
    ['pointerup', 'touchstart', 'touchmove'],
  );
});
