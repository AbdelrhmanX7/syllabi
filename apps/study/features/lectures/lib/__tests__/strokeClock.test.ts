import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Path, StaticCanvas } from 'fabric';
// @ts-expect-error -- no @types/jsdom in the repo; only `JSDOM` is used
import { JSDOM } from 'jsdom';

import { installStrokeClock, setStrokeClock } from '../strokeClock';
import { pageStrokeTimes } from '../timeline';

// Fabric's browser build needs a DOM (jsdom draws through the `canvas` package); strokeClock listens
// for pen-downs on `window`, captured here so the test can fire one.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const listeners: ((event: { pointerType: string }) => void)[] = [];
const globals = globalThis as unknown as Record<string, unknown>;

// Nothing is drawn here; a no-op 2D context keeps Fabric's clears/renders quiet without node-canvas.
const noopContext: unknown = new Proxy(
  {},
  { get: (_target, key) => (key === 'canvas' ? undefined : () => noopContext) },
);

dom.window.HTMLCanvasElement.prototype.getContext = (() => noopContext) as never;
globals.document = dom.window.document;
globals.window = Object.assign(dom.window, {
  addEventListener: (_type: string, fn: (event: { pointerType: string }) => void) => listeners.push(fn),
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

test('new ink is stamped with the pen-down time; revived and pre-stamped objects are not', async () => {
  installStrokeClock();
  const canvas = new StaticCanvas(undefined, { width: 200, height: 200, renderOnAddRemove: false });
  const line = () => new Path('M 0 0 L 10 10');

  canvas.add(line());
  let now = 1000;

  setStrokeClock(() => now);
  listeners.forEach((fn) => fn({ pointerType: 'pen' }));
  now = 2500; // the stroke finishes later; the stamp is the pen-down
  canvas.add(line());
  const keep = line() as unknown as { t: number };

  keep.t = 42;
  canvas.add(keep as never);

  const json = JSON.stringify(canvas.toJSON());

  assert.deepEqual(pageStrokeTimes(json), [null, 1000, 42]);

  // Reload (page switch / undo) while still recording: times survive, untimed stays untimed.
  now = 9000;
  await canvas.loadFromJSON(json);
  assert.deepEqual(pageStrokeTimes(JSON.stringify(canvas.toJSON())), [null, 1000, 42]);

  setStrokeClock(null);
  canvas.add(line());
  assert.equal(pageStrokeTimes(JSON.stringify(canvas.toJSON()))[3], null);
});
