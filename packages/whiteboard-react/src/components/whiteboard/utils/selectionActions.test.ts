import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ActiveSelection, Path } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { captureSelection, deleteSelection, pasteClipboard, recolorSelection } from './selectionActions';

/**
 * A canvas reduced to what the actions touch, recording every mutation event. The editor's undo
 * history records one checkpoint per burst of mutation events that lands in one synchronous run, so
 * "one undo entry per action" means: every event an action fires, fires inside that one run.
 */
function fakeCanvas(objects: FabricObject[]) {
  let active: FabricObject | null = null;
  const events: string[] = [];
  const list = [...objects];
  const canvas = {
    events,
    getObjects: () => list,
    getActiveObject: () => active,
    getActiveObjects: () => (!active ? [] : active instanceof ActiveSelection ? active.getObjects() : [active]),
    setActiveObject: (object: FabricObject) => {
      active = object;
    },
    discardActiveObject: () => {
      if (active instanceof ActiveSelection) {
        // Fabric hands the members back their absolute transforms when the selection dissolves.
        for (const member of active.getObjects()) active.exitGroup(member);
      }

      active = null;
    },
    add: (...added: FabricObject[]) => {
      list.push(...added);
      added.forEach(() => events.push('object:added'));
    },
    remove: (...removed: FabricObject[]) => {
      for (const object of removed) list.splice(list.indexOf(object), 1);
      removed.forEach(() => events.push('object:removed'));
    },
    // Only the events the undo history listens to; layout chatter from ActiveSelection is not one.
    fire: (name: string) => void (/^object:(added|removed|modified)$/.test(name) && events.push(name)),
    requestRenderAll: () => undefined,
  };

  return canvas as typeof canvas & Canvas;
}

const stroke = (d: string, color = '#000000') => new Path(d, { fill: null, stroke: color, strokeWidth: 4 });

describe('selection actions', () => {
  it('copies a multi-selection in absolute coordinates and pastes it at the new spot', async () => {
    const a = stroke('M 100 100 L 140 100');
    const b = stroke('M 100 200 L 140 200');
    const canvas = fakeCanvas([a, b]);
    const centreBefore = { a: a.getCenterPoint(), b: b.getCenterPoint() };

    canvas.setActiveObject(new ActiveSelection([a, b]));

    const clip = await captureSelection(canvas, () => ({ scale: 1, dx: 0, dy: 0 }));

    assert.ok(clip);
    assert.equal(clip.items.length, 2);
    assert.ok(Math.abs((clip.items[0]!.json.left as number) - centreBefore.a.x) < 0.01, 'member stored at its own scene centre');
    assert.ok(Math.abs((clip.items[1]!.json.top as number) - centreBefore.b.y) < 0.01);

    canvas.events.length = 0;

    const clipCentre = { x: clip.bounds.left + clip.bounds.width / 2, y: clip.bounds.top + clip.bounds.height / 2 };
    const pasted = await pasteClipboard(canvas, clip, { x: clipCentre.x + 500, y: clipCentre.y + 50 }, { scale: 1, dx: 0, dy: 0 });

    assert.equal(pasted.length, 2);
    assert.deepEqual(canvas.events, ['object:added', 'object:added']);
    assert.equal(pasted[0]!.originX, a.originX, 'origin restored after the centre-origin round trip');

    const moved = pasted[0]!.getCenterPoint();

    assert.ok(Math.abs(moved.x - (centreBefore.a.x + 500)) < 0.01);
    assert.ok(Math.abs(moved.y - (centreBefore.a.y + 50)) < 0.01);
    assert.equal(canvas.getObjects().length, 4);
  });

  it('recolours every selected stroke in one run and announces each as modified', () => {
    const a = stroke('M 0 0 L 10 0');
    const b = stroke('M 0 10 L 10 10');
    const canvas = fakeCanvas([a, b]);

    canvas.setActiveObject(new ActiveSelection([a, b]));

    assert.equal(recolorSelection(canvas, '#EF4444'), 2);
    assert.equal(a.stroke, '#EF4444');
    assert.equal(b.stroke, '#EF4444');
    assert.deepEqual(canvas.events, ['object:modified', 'object:modified']);
  });

  it('deletes the selection in one run', () => {
    const a = stroke('M 0 0 L 10 0');
    const b = stroke('M 0 10 L 10 10');
    const keep = stroke('M 0 20 L 10 20');
    const canvas = fakeCanvas([a, b, keep]);

    canvas.setActiveObject(new ActiveSelection([a, b]));

    assert.equal(deleteSelection(canvas), 2);
    assert.deepEqual(canvas.getObjects(), [keep]);
    assert.deepEqual(canvas.events, ['object:removed', 'object:removed']);
  });

  it('pastes into a scroll page at that page scale', async () => {
    const a = stroke('M 0 0 L 40 0');
    const canvas = fakeCanvas([a]);

    canvas.setActiveObject(a);

    const clip = await captureSelection(canvas, () => ({ scale: 1, dx: 0, dy: 0 }));

    assert.ok(clip);

    const [copy] = await pasteClipboard(canvas, clip, { x: 1000, y: 3000 }, { scale: 0.5, dx: 0, dy: 2800 });

    assert.ok(copy);
    assert.equal(copy.scaleX, 0.5);
    assert.ok(Math.abs(copy.getScaledWidth() - a.getScaledWidth() / 2) < 0.01);
    assert.ok(Math.abs(copy.getCenterPoint().x - 1000) < 0.01);
  });
});
