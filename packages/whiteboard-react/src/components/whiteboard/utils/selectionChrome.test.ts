import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ActiveSelection, FabricImage, Path, Point, Rect } from 'fabric';

import type { FabricObject } from 'fabric';

import {
  applyModernSelectionStyle,
  HALO_COLOR,
  HALO_WIDTH_PX,
  haloLineWidth,
  installModernSelectionChrome,
  MODERN_FRAME_PADDING,
  MODERN_TOUCH_CORNER_SIZE,
  pointerInsideFrame,
  ROTATE_HANDLE_REACH,
  showsHalo, shownAngle } from './selectionChrome';

/** Selects `object` on a minimal canvas stand-in (identity viewport at `zoom`), so Fabric's own `findControl` runs. */
function select<T extends FabricObject>(object: T, zoom = 1): T {
  const canvas = {
    getActiveObject: () => object,
    viewportTransform: [zoom, 0, 0, zoom, 0, 0],
    getZoom: () => zoom,
    getRetinaScaling: () => 1,
  };

  (object as unknown as { canvas: unknown }).canvas = canvas;
  applyModernSelectionStyle(object);
  object.setCoords();

  return object;
}

const word = () => new Path('M 100 100 L 200 100 L 200 130', { originX: 'left', originY: 'top', fill: null, stroke: 'navy', strokeWidth: 2 });

describe('modern selection handles — grips outside the frame, the body always moves', () => {
  it('a touch just inside a corner of a selected word moves it (no handle)', () => {
    const path = select(word());
    const tl = path.getCoords()[0]!;

    // 4 px inside the word's own box: the old 44 px touch square reached 22 px from the frame corner.
    assert.equal(path.findControl(new Point(tl.x + 4, tl.y + 4), true), undefined);
    assert.equal(path.findControl(new Point(tl.x + 1, tl.y + 1), true), undefined, 'even right at the box corner');
    assert.ok(pointerInsideFrame(path, new Point(tl.x + 4, tl.y + 4)));
  });

  it('the corner grip still answers on its outer side, for touch and for a pen/mouse', () => {
    const path = select(word());
    const corner = path.oCoords.tl;

    assert.equal(path.findControl(new Point(corner.x - 4, corner.y - 4), true)?.key, 'tl');
    assert.equal(path.findControl(new Point(corner.x - 4, corner.y - 4), false)?.key, 'tl');
    assert.equal(path.findControl(new Point(corner.x - MODERN_TOUCH_CORNER_SIZE, corner.y - 4), true), undefined, 'a grip, not a zone');
  });

  it('the frame is the object box plus the padding', () => {
    const path = select(word());
    const [tl] = path.getCoords();

    assert.ok(pointerInsideFrame(path, new Point(tl!.x - MODERN_FRAME_PADDING + 1, tl!.y + 10)));
    assert.ok(!pointerInsideFrame(path, new Point(tl!.x - MODERN_FRAME_PADDING - 2, tl!.y + 10)));
  });

  it('a small shape shows its corners only; a big one keeps its side grips, which also answer outside only', () => {
    const small = select(new Rect({ left: 0, top: 0, originX: 'left', originY: 'top', width: 30, height: 30, fill: 'transparent', stroke: 'navy' }));
    const big = select(new Rect({ left: 0, top: 0, originX: 'left', originY: 'top', width: 300, height: 200, fill: 'transparent', stroke: 'navy' }));

    assert.equal(small.isControlVisible('ml'), false);
    assert.equal(small.isControlVisible('tl'), true);
    assert.equal(big.isControlVisible('ml'), true);

    const ml = big.oCoords.ml;

    assert.equal(big.findControl(new Point(ml.x - 5, ml.y), true)?.key, 'ml');
    assert.equal(big.findControl(new Point(ml.x + 5, ml.y), true), undefined, 'inside the frame: the body');
  });

  it('an image scales by its corners only — no side grip to stretch it out of proportion', () => {
    const element = { width: 400, height: 300, naturalWidth: 400, naturalHeight: 300 } as unknown as HTMLImageElement;
    const image = select(new FabricImage(element, { left: 0, top: 0, originX: 'left', originY: 'top' }));

    assert.equal(image.isControlVisible('ml'), false);
    assert.equal(image.isControlVisible('mt'), false);
    assert.equal(image.isControlVisible('br'), true);
    assert.equal(image.isControlVisible('mtr'), true);
  });

  it('a big shape zoomed out to a small one on screen loses its side grips', () => {
    const rect = select(new Rect({ left: 0, top: 0, originX: 'left', originY: 'top', width: 120, height: 120, fill: 'transparent', stroke: 'navy' }), 0.25);

    assert.equal(rect.isControlVisible('ml'), false);
  });

  it('wraps each handle once, however often the selection is re-dressed', () => {
    const path = select(word());
    const first = path.controls.tl;

    applyModernSelectionStyle(path);
    assert.equal(path.controls.tl, first);
  });
});

describe('modern selection — a halo that hugs the ink, no box', () => {
  /** A canvas stand-in good enough for `installModernSelectionChrome` and for `render()`'s halo hook. */
  function haloCanvas(active: FabricObject | null) {
    return {
      _activeObject: active,
      skipControlsDrawing: false,
      selectionColor: '',
      selectionBorderColor: '',
      selectionLineWidth: 1,
      getActiveObject() {
        return this._activeObject;
      },
      viewportTransform: [1, 0, 0, 1, 0, 0],
      getZoom: () => 1,
      getRetinaScaling: () => 2,
      on: () => undefined,
      off: () => undefined,
      requestRenderAll: () => undefined,
    };
  }

  /** Records what is painted; its transform is the scene plane at zoom 1 × retina 2. */
  function recordingContext() {
    const calls: string[] = [];
    const state: Record<string, unknown> = {};
    const ctx = new Proxy(state, {
      get(target, key) {
        if (key === 'getTransform') return () => ({ a: 2, b: 0, c: 0, d: 2 });
        if (key in target) return target[key as string];

        return () => {
          calls.push(String(key));
        };
      },
      set(target, key, value) {
        target[key as string] = value;
        calls.push(`${String(key)}=${String(value)}`);

        return true;
      },
    });

    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  }

  it('a thin frame around the selection; none on its members', () => {
    assert.equal(select(word()).hasBorders, true, 'a thin frame joins the grips into a box');

    const a = word();
    const b = word();
    const selection = select(new ActiveSelection([a, b]));

    assert.equal(selection.hasBorders, true);
    assert.equal(a.hasBorders, false);
    assert.equal(b.hasBorders, false);
  });

  it('a line-shaped stroke gets grips at its two ends; a word does not', () => {
    const line = select(new Path('M 0 0 L 300 0', { fill: null, stroke: 'navy', strokeWidth: 2 }));

    assert.equal(line.isControlVisible('ml'), true);
    assert.equal(line.isControlVisible('mr'), true);
    assert.equal(line.isControlVisible('mt'), false);
    assert.equal(select(word()).isControlVisible('ml'), false);
  });

  it('the angle beside the rotate grip reads in whole degrees, −180…180', () => {
    assert.equal(shownAngle(0), 0);
    assert.equal(shownAngle(359.6), 0);
    assert.equal(shownAngle(90.4), 90);
    assert.equal(shownAngle(270), -90);
    assert.equal(shownAngle(-45), -45);
  });

  it('the rotate grip sits close to the ink', () => {
    assert.equal(select(word()).controls.mtr?.offsetY, -ROTATE_HANDLE_REACH);
  });

  it('halo width: the stroke as painted plus the halo on each side, in device px', () => {
    // Plain stroke 4 scene px under a plane scale of 2: 8 device px, + 2 × 5 px × retina 2.
    assert.equal(haloLineWidth({ stroke: 'navy', strokeWidth: 4, strokeUniform: false }, 2, 2, 2), 8 + 4 * HALO_WIDTH_PX);
    // A uniform stroke is painted in scene units, whatever the object's own scale.
    assert.equal(haloLineWidth({ stroke: 'navy', strokeWidth: 4, strokeUniform: true }, 6, 2, 2), 8 + 4 * HALO_WIDTH_PX);
    // A filled outline (no stroke): just the ring.
    assert.equal(haloLineWidth({ stroke: '', strokeWidth: 0, strokeUniform: false }, 2, 2, 2), 4 * HALO_WIDTH_PX);
  });

  it('a selected stroke paints its own outline, wide and translucent, before its ink, and never in an export', () => {
    const path = word();
    const canvas = haloCanvas(path);

    (path as unknown as { canvas: unknown }).canvas = canvas;
    const uninstall = installModernSelectionChrome(canvas as never);

    assert.ok(showsHalo(path));

    const { ctx, calls } = recordingContext();

    path.drawSelectionBackground(ctx);
    assert.ok(calls.includes('moveTo') && calls.includes('lineTo'), 'traced along the stroke');
    assert.ok(!calls.includes('rect') && !calls.includes('fillRect'), 'not a box');
    assert.ok(calls.includes(`strokeStyle=${HALO_COLOR}`));
    assert.equal(calls[calls.length - 2], 'stroke');

    canvas.skipControlsDrawing = true;
    assert.equal(showsHalo(path), false, 'toCanvasElement (exports, thumbnails) skips it');
    canvas.skipControlsDrawing = false;

    canvas._activeObject = null;
    assert.equal(showsHalo(path), false, 'not selected: no halo');
    uninstall();
    canvas._activeObject = path;
    assert.equal(showsHalo(path), false, 'uninstalled: no halo');
  });
});
