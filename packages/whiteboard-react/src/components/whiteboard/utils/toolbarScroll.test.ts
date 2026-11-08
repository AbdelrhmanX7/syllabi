import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDragScroll, scrollEdges } from './toolbarScroll';

describe('scrollEdges', () => {
  it('shows no fade when the row fits (sub-pixel overflow included)', () => {
    assert.deepEqual(scrollEdges(0, 600, 600), { start: false, end: false });
    assert.deepEqual(scrollEdges(0, 600.6, 600), { start: false, end: false });
  });

  it('hints the end at the start, both mid-way, the start at the end', () => {
    assert.deepEqual(scrollEdges(0, 1200, 400), { start: false, end: true });
    assert.deepEqual(scrollEdges(300, 1200, 400), { start: true, end: true });
    assert.deepEqual(scrollEdges(800, 1200, 400), { start: true, end: false });
  });

  it('reads an RTL row (negative scrollLeft) from its start edge', () => {
    assert.deepEqual(scrollEdges(-800, 1200, 400), { start: true, end: false });
  });
});

describe('createDragScroll', () => {
  it('stays a tap under the threshold', () => {
    const drag = createDragScroll(6);

    drag.down(1, 100, 0);
    assert.equal(drag.move(1, 105), null);
    assert.equal(drag.move(1, 95), null);
    assert.equal(drag.isDragging, false);
    assert.equal(drag.up(1), false, 'no drag: the click goes through');
  });

  it('crosses the threshold once, then the content follows the pointer', () => {
    const drag = createDragScroll(6);

    drag.down(7, 300, 40);
    assert.deepEqual(drag.move(7, 290), { scrollLeft: 50, started: true });
    assert.deepEqual(drag.move(7, 200), { scrollLeft: 140, started: false });
    assert.deepEqual(drag.move(7, 350), { scrollLeft: -10, started: false }, 'RTL-negative offsets pass through untouched');
    assert.equal(drag.isDragging, true);
    assert.equal(drag.up(7), true, 'a drag: the click after it is swallowed');
    assert.equal(drag.isDragging, false);
  });

  it('ignores other pointers and resets on cancel', () => {
    const drag = createDragScroll(6);

    drag.down(1, 0, 0);
    assert.equal(drag.move(2, 100), null, 'a second pointer does not drive the row');
    assert.equal(drag.up(2), false);
    drag.cancel();
    assert.equal(drag.move(1, 100), null, 'nothing after a cancel');
    assert.equal(drag.up(1), false);
  });
});
