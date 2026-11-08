import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  buildClipboard,
  CLIPBOARD_STORAGE_KEY,
  colorAlpha,
  lassoSelects,
  parseClipboard,
  placeClipboard,
  placeSelectionBar,
  planSelectionRaster,
  readClipboard,
  rectsOverlap,
  recolorObject,
  resetClipboardMemory,
  restrokeObject,
  withAlpha,
  writeClipboard,
} from './selectionClipboard';

import type { ClipboardItem, RecolorableObject, WbClipboard } from './selectionClipboard';

type Fake = RecolorableObject & Record<string, unknown>;

function fake(props: Record<string, unknown>, children?: Fake[]): Fake {
  const object: Fake = {
    ...props,
    set(key: string, value: unknown) {
      object[key] = value;

      return object;
    },
  };

  if (children) object.getObjects = () => children;

  return object;
}

const item = (json: Record<string, unknown>): ClipboardItem => ({ json: { type: 'Path', ...json }, originX: 'left', originY: 'top' });

describe('recolorObject', () => {
  it('recolours ink by its stroke and leaves its empty fill alone', () => {
    const stroke = fake({ type: 'Path', stroke: '#000000', strokeWidth: 4, fill: null });

    assert.equal(recolorObject(stroke, '#EF4444'), 1);
    assert.equal(stroke.stroke, '#EF4444');
    assert.equal(stroke.fill, null);
  });

  it('recolours filled ink (calligraphy/marker outlines) by its fill', () => {
    const outline = fake({ type: 'Path', stroke: null, strokeWidth: 0, fill: '#111111' });

    recolorObject(outline, '#3B82F6');

    assert.equal(outline.fill, '#3B82F6');
    assert.equal(outline.stroke, null);
  });

  it('keeps a highlighter translucent', () => {
    const highlight = fake({ type: 'Path', stroke: 'rgba(255, 235, 59, 0.4)', strokeWidth: 24, fill: '' });

    recolorObject(highlight, '#22C55E');

    assert.equal(highlight.stroke, 'rgba(34, 197, 94, 0.4)');
  });

  it('recolours a shape outline and re-tints a translucent fill, but not a transparent one', () => {
    const washed = fake({ type: 'Rect', stroke: '#000000', strokeWidth: 2, fill: 'rgba(0, 0, 0, 0.2)' });
    const hollow = fake({ type: 'Circle', stroke: '#000000', strokeWidth: 2, fill: 'transparent' });

    recolorObject(washed, '#8B5CF6');
    recolorObject(hollow, '#8B5CF6');

    assert.equal(washed.stroke, '#8B5CF6');
    assert.equal(washed.fill, 'rgba(139, 92, 246, 0.2)');
    assert.equal(hollow.stroke, '#8B5CF6');
    assert.equal(hollow.fill, 'transparent');
  });

  it('recolours text by fill and walks into groups, skipping images', () => {
    const text = fake({ type: 'Textbox', fill: '#000000' });
    const arrowLine = fake({ type: 'Line', stroke: '#000000', strokeWidth: 3 });
    const arrowHead = fake({ type: 'Triangle', stroke: '#000000', strokeWidth: 3, fill: '#000000' });
    const group = fake({ type: 'Group' }, [arrowLine, arrowHead]);
    const image = fake({ type: 'Image', stroke: null, fill: 'rgb(0,0,0)' });

    assert.equal(recolorObject(text, '#EC4899'), 1);
    assert.equal(recolorObject(group, '#EC4899'), 2);
    assert.equal(recolorObject(image, '#EC4899'), 0);
    assert.equal(text.fill, '#EC4899');
    assert.equal(arrowLine.stroke, '#EC4899');
    assert.equal(arrowHead.fill, '#EC4899');
    assert.equal(image.fill, 'rgb(0,0,0)');
  });

  it('thickens stroked leaves only', () => {
    const stroke = fake({ type: 'Path', stroke: '#000', strokeWidth: 2 });
    const outline = fake({ type: 'Path', stroke: null, strokeWidth: 0, fill: '#000' });

    assert.equal(restrokeObject(stroke, 8), 1);
    assert.equal(restrokeObject(outline, 8), 0);
    assert.equal(stroke.strokeWidth, 8);
    assert.equal(outline.strokeWidth, 0);
  });
});

describe('colour helpers', () => {
  it('reads alpha from rgba, #rrggbbaa and transparent', () => {
    assert.equal(colorAlpha('rgba(1, 2, 3, 0.4)'), 0.4);
    assert.equal(colorAlpha('#00000080'), 128 / 255);
    assert.equal(colorAlpha('transparent'), 0);
    assert.equal(colorAlpha('#123456'), null);
  });

  it('expands short hex', () => {
    assert.equal(withAlpha('#f00', 0.5), 'rgba(255, 0, 0, 0.5)');
  });
});

describe('copy → paste frames', () => {
  it('a paged copy pastes at the same size, centred on the paste point', () => {
    const clip = buildClipboard([item({ left: 110, top: 220, scaleX: 1, scaleY: 1 })], { left: 100, top: 200, width: 20, height: 40 }, { scale: 1, dx: 0, dy: 0 });
    const placed = placeClipboard(clip, { scale: 1, dx: 0, dy: 0 }, { x: 500, y: 500 });

    assert.deepEqual(placed.bounds, { left: 490, top: 480, width: 20, height: 40 });
    assert.equal(placed.items[0]!.json.left, 500);
    assert.equal(placed.items[0]!.json.top, 500);
    assert.equal(placed.items[0]!.json.scaleX, 1);
  });

  it('a copy from a scrolled PDF page is stored page-local and pastes at the target page scale', () => {
    // Source page drawn at half size in the scene, 1000 px down the column.
    const source = { scale: 0.5, dx: 0, dy: 1000 };
    const clip = buildClipboard(
      [item({ left: 60, top: 1060, scaleX: 0.5, scaleY: 0.5, strokeWidth: 4 })],
      { left: 50, top: 1050, width: 20, height: 20 },
      source,
    );

    // Page-local: undo the half scale and the column offset.
    assert.deepEqual(clip.bounds, { left: 100, top: 100, width: 40, height: 40 });
    assert.equal(clip.items[0]!.json.left, 120);
    assert.equal(clip.items[0]!.json.top, 120);
    assert.equal(clip.items[0]!.json.scaleX, 1);
    assert.equal(clip.items[0]!.json.strokeWidth, 4, 'stroke width scales through scaleX, never rewritten');

    // Into a paged notebook (identity): full page-local size.
    const paged = placeClipboard(clip, { scale: 1, dx: 0, dy: 0 }, { x: 0, y: 0 });

    assert.deepEqual(paged.bounds, { left: -20, top: -20, width: 40, height: 40 });
    assert.equal(paged.items[0]!.json.scaleX, 1);

    // Into another scroll page drawn at 0.25: a quarter of page-local size.
    const quarter = placeClipboard(clip, { scale: 0.25, dx: 0, dy: 5000 }, { x: 300, y: 5100 });

    assert.deepEqual(quarter.bounds, { left: 295, top: 5095, width: 10, height: 10 });
    assert.equal(quarter.items[0]!.json.scaleX, 0.25);
    assert.equal(quarter.items[0]!.json.left, 300);
  });

  it('a paste drops the source lecture stroke clock so the copy is stamped as new ink', () => {
    const clip = buildClipboard([item({ left: 0, top: 0, t: 12_345 })], { left: 0, top: 0, width: 1, height: 1 }, { scale: 1, dx: 0, dy: 0 });

    assert.equal(clip.items[0]!.json.t, 12_345);
    assert.equal('t' in placeClipboard(clip, { scale: 1, dx: 0, dy: 0 }, { x: 0, y: 0 }).items[0]!.json, false);
  });
});

describe('clipboard store', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    resetClipboardMemory();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  });

  const sample: WbClipboard = {
    version: 1,
    items: [item({ left: 1, top: 2, path: [['M', 0, 0], ['L', 4, 4]] })],
    bounds: { left: 0, top: 0, width: 4, height: 4 },
    copiedAt: 7,
  };

  it('round-trips through localStorage, so a copy survives switching notebooks', () => {
    writeClipboard(sample);
    resetClipboardMemory();

    assert.deepEqual(readClipboard(), sample);
    assert.ok(store.has(CLIPBOARD_STORAGE_KEY));
  });

  it('survives storage that throws', () => {
    (globalThis as { window?: unknown }).window = {
      get localStorage(): Storage {
        throw new Error('denied');
      },
    };

    writeClipboard(sample);

    assert.deepEqual(readClipboard(), sample);
  });

  it('rejects junk', () => {
    assert.equal(parseClipboard('not json'), null);
    assert.equal(parseClipboard(JSON.stringify({ version: 2, items: [] })), null);
    assert.equal(parseClipboard(JSON.stringify({ ...sample, items: [{ json: {} }] })), null);
    assert.equal(parseClipboard(JSON.stringify({ ...sample, bounds: { left: 'x' } })), null);
  });
});

describe('lassoSelects', () => {
  const loop = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it('takes an object whose centre is inside the loop', () => {
    assert.equal(lassoSelects(loop, { left: 60, top: 60, width: 60, height: 20 }), true);
  });

  it('leaves an object outside the loop', () => {
    assert.equal(lassoSelects(loop, { left: 150, top: 10, width: 20, height: 20 }), false);
  });

  it('treats a straight diagonal drag as the rectangle it spans', () => {
    const diagonal = [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 100 },
    ];

    assert.equal(lassoSelects(diagonal, { left: 70, top: 10, width: 10, height: 10 }), true);
  });
});

describe('placeSelectionBar', () => {
  const container = { width: 1000, height: 800 };
  const bar = { width: 300, height: 52 };

  it('sits centred above the selection', () => {
    assert.deepEqual(placeSelectionBar({ left: 400, top: 300, width: 200, height: 100 }, bar, container), { left: 350, top: 236, below: false });
  });

  it('flips below when the selection hugs the top, and clamps inside the view', () => {
    const spot = placeSelectionBar({ left: 950, top: 20, width: 40, height: 40 }, bar, container, { topInset: 64 });

    assert.equal(spot.below, true);
    assert.equal(spot.top, 72);
    assert.equal(spot.left, 1000 - 300 - 8);
  });

  it('prefer below: sits under the selection with its own gap, clear of the frame', () => {
    const spot = placeSelectionBar({ left: 400, top: 300, width: 200, height: 100 }, bar, container, {
      prefer: 'below',
      gapAbove: 62,
      gapBelow: 22,
    });

    assert.deepEqual(spot, { left: 350, top: 422, below: true });
  });

  it('prefer below: goes above (past the rotate handle) when the bottom has no room', () => {
    const spot = placeSelectionBar({ left: 400, top: 600, width: 200, height: 150 }, bar, container, {
      prefer: 'below',
      gapAbove: 62,
      gapBelow: 22,
    });

    assert.deepEqual(spot, { left: 350, top: 600 - 62 - 52, below: false });
  });

  it('prefer below: a selection taller than the view pins the bar to the roomier edge', () => {
    const spot = placeSelectionBar({ left: 400, top: 40, width: 200, height: 700 }, bar, container, {
      prefer: 'below',
      topInset: 64,
    });

    assert.deepEqual(spot, { left: 350, top: 800 - 52 - 8, below: true });
  });
});

describe('planSelectionRaster', () => {
  it('pads the bounds and keeps the long side within 2000 px', () => {
    const plan = planSelectionRaster({ left: 100, top: 200, width: 3000, height: 1000 }, { padding: 20 });

    assert.deepEqual(plan.region, { left: 80, top: 180, width: 3040, height: 1040 });
    assert.equal(plan.width, 2000);
    assert.ok(plan.height <= 2000 && plan.height === Math.round(1040 * (2000 / 3040)));
  });

  it('never blows a small selection up past maxScale', () => {
    const plan = planSelectionRaster({ left: 0, top: 0, width: 100, height: 40 }, { padding: 0, maxScale: 3 });

    assert.equal(plan.scale, 3);
    assert.equal(plan.width, 300);
    assert.equal(plan.height, 120);
  });

  it('a tall map caps its height, not its width', () => {
    const plan = planSelectionRaster({ left: 0, top: 0, width: 600, height: 2400 }, { padding: 0 });

    assert.equal(plan.height, 2000);
    assert.equal(plan.width, 500);
  });

  it('a degenerate (dot) selection still yields a picture', () => {
    const plan = planSelectionRaster({ left: 5, top: 5, width: 0, height: 0 }, { padding: 0 });

    assert.ok(plan.width >= 1 && plan.height >= 1);
  });
});

describe('rectsOverlap', () => {
  it('detects overlap and touching-free separation', () => {
    assert.equal(rectsOverlap({ left: 0, top: 0, width: 10, height: 10 }, { left: 5, top: 5, width: 10, height: 10 }), true);
    assert.equal(rectsOverlap({ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 5, height: 5 }), false);
  });
});
