import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLongPress } from './longPress';
import { placePasteChip } from './selectionClipboard';

/** A clock the test winds by hand. */
function fakeScheduler() {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let next = 1;

  return {
    scheduler: {
      set: (callback: () => void, ms: number) => {
        const id = next++;

        timers.set(id, { at: now + ms, callback });

        return id;
      },
      clear: (handle: unknown) => void timers.delete(handle as number),
    },
    advance(ms: number) {
      now += ms;

      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

function setup() {
  const clock = fakeScheduler();
  const fired: Array<{ x: number; y: number; data: string }> = [];
  let movedOn = 0;
  const press = createLongPress<string>({
    delayMs: 500,
    slopPx: 8,
    scheduler: clock.scheduler,
    onFire: (event) => fired.push(event),
    onMovedAfterFire: () => (movedOn += 1),
  });

  return { clock, fired, press, movedOn: () => movedOn };
}

describe('createLongPress', () => {
  it('fires after holding still for the delay, at the point it went down', () => {
    const { clock, fired, press } = setup();

    press.down(1, 100, 100, 'a');
    press.move(1, 104, 103);
    clock.advance(499);
    assert.equal(fired.length, 0);
    clock.advance(1);
    assert.deepEqual(fired, [{ x: 100, y: 100, data: 'a' }]);
    assert.deepEqual(press.up(1), { fired: true, movedAfterFire: false });
  });

  it('a move past the slop before the delay cancels it (that is a stroke)', () => {
    const { clock, fired, press } = setup();

    press.down(1, 100, 100, 'a');
    press.move(1, 109, 100);
    clock.advance(600);
    assert.equal(fired.length, 0);
    assert.deepEqual(press.up(1), { fired: false, movedAfterFire: false });
  });

  it('lifting early cancels it', () => {
    const { clock, fired, press } = setup();

    press.down(1, 100, 100, 'a');
    clock.advance(300);
    press.up(1);
    clock.advance(600);
    assert.equal(fired.length, 0);
  });

  it('a second finger landing cancels it (a pinch)', () => {
    const { clock, fired, press } = setup();

    press.down(1, 100, 100, 'a');
    clock.advance(200);
    press.down(2, 300, 300, 'b');
    clock.advance(600);
    assert.equal(fired.length, 0);
  });

  it('moving on after it fired reports a real stroke', () => {
    const { clock, press, movedOn } = setup();

    press.down(1, 100, 100, 'a');
    clock.advance(500);
    press.move(1, 130, 100);
    press.move(1, 160, 100);
    assert.equal(movedOn(), 1);
    assert.deepEqual(press.up(1), { fired: true, movedAfterFire: true });
  });

  it('an untracked pointer never starts a hold', () => {
    const { clock, fired, press } = setup();

    press.down(1, 100, 100, 'a', false);
    clock.advance(800);
    assert.equal(fired.length, 0);
  });
});

describe('placePasteChip', () => {
  const chip = { width: 110, height: 44 };
  const layer = { width: 800, height: 1000 };

  it('sits centred above the press point', () => {
    assert.deepEqual(placePasteChip({ left: 400, top: 500 }, chip, layer), { left: 345, top: 442 });
  });

  it('drops below the point near the top edge, and stays inside the sides', () => {
    assert.deepEqual(placePasteChip({ left: 10, top: 20 }, chip, layer), { left: 8, top: 34 });
    assert.deepEqual(placePasteChip({ left: 795, top: 500 }, chip, layer), { left: 682, top: 442 });
  });
});
