import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Point } from 'fabric';

import type { Canvas } from 'fabric';

import { createStrokeInkContrast, PAPER_LUMINANCE } from '../utils/inkContrast';
import { LowLatencyPencilBrush } from './LowLatencyPencilBrush';

/**
 * Smart ink contrast as the BRUSH applies it: the adjusted shade must be in place before Fabric paints
 * the first dot of the live preview, must be what the committed path is created with, and must be gone
 * again — the palette's own colour back on `color` — once the stroke is committed. The colour maths
 * itself is covered in `utils/inkContrast.test.ts`; this is about when the brush consults it.
 */

class RecordingContext {
  strokeStyles: string[] = [];
  strokeStyle = '';

  save() {}
  restore() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  stroke() {
    this.strokeStyles.push(String(this.strokeStyle));
  }
  clearRect() {}
  transform() {}
  setLineDash() {}
}

function makeCanvas() {
  const ctx = new RecordingContext();
  const added: { stroke?: string | null }[] = [];
  const canvas = {
    contextTop: ctx,
    width: 1920,
    height: 1080,
    viewportTransform: [1, 0, 0, 1, 0, 0] as const,
    clearContext() {},
    _isMainEvent: () => true,
    getScenePoint: (point: Point) => point,
    getZoom: () => 1,
    getRetinaScaling: () => 1,
    requestRenderAll: () => {},
    fire: () => {},
    add: (object: { stroke?: string | null }) => {
      added.push(object);
    },
  };

  return { canvas: canvas as unknown as Canvas, ctx, added };
}

const EVENT = { e: {} } as unknown as Parameters<LowLatencyPencilBrush['onMouseDown']>[1];

function makeContrast({ enabled = true, background = PAPER_LUMINANCE }: { enabled?: boolean; background?: number | null } = {}) {
  const samples: [number, number][] = [];
  const contrast = createStrokeInkContrast<Canvas>({
    isEnabled: () => enabled,
    sampleBackground: (_surface, x, y) => {
      samples.push([x, y]);

      return background;
    },
    getOpacity: () => 1,
  });

  return { contrast, samples };
}

function drawStroke(brush: LowLatencyPencilBrush) {
  brush.onMouseDown(new Point(10, 10), EVENT);
  brush.onMouseMove(new Point(60, 20), EVENT);
  brush.onMouseMove(new Point(120, 40), EVENT);
  brush.onMouseUp(EVENT);
}

describe('LowLatencyPencilBrush smart ink contrast', () => {
  it('paints yellow on white as a darker yellow, then hands the palette colour back', () => {
    const { canvas, ctx, added } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);
    const { contrast, samples } = makeContrast();

    brush.inkContrast = contrast;
    brush.color = '#ffff00';

    drawStroke(brush);

    // Sampled once, at the stroke's first point.
    assert.deepEqual(samples, [[10, 10]]);

    // Every segment of the live preview used the adjusted shade — the first one included.
    assert.ok(ctx.strokeStyles.length >= 1);
    assert.ok(ctx.strokeStyles.every((style) => style === ctx.strokeStyles[0]));
    assert.notEqual(ctx.strokeStyles[0], '#ffff00');
    assert.match(ctx.strokeStyles[0], /^#[0-9a-f]{6}$/);

    // The committed path carries the same shade …
    assert.equal(added.length, 1);
    assert.equal(added[0].stroke, ctx.strokeStyles[0]);

    // … and the brush reports the palette colour again between strokes.
    assert.equal(brush.color, '#ffff00');
  });

  it('leaves black on white exactly as it is', () => {
    const { canvas, ctx, added } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);

    brush.inkContrast = makeContrast().contrast;
    brush.color = '#000000';

    drawStroke(brush);

    assert.ok(ctx.strokeStyles.every((style) => style === '#000000'));
    assert.equal(added[0].stroke, '#000000');
    assert.equal(brush.color, '#000000');
  });

  it('does nothing while the setting is off, and samples nothing', () => {
    const { canvas, ctx, added } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);
    const { contrast, samples } = makeContrast({ enabled: false });

    brush.inkContrast = contrast;
    brush.color = '#ffff00';

    drawStroke(brush);

    assert.equal(samples.length, 0);
    assert.ok(ctx.strokeStyles.every((style) => style === '#ffff00'));
    assert.equal(added[0].stroke, '#ffff00');
  });

  it('does nothing on a brush without the hook (the highlighter)', () => {
    const { canvas, ctx, added } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);

    brush.color = 'rgba(255, 255, 0, 0.22)';

    drawStroke(brush);

    assert.ok(ctx.strokeStyles.every((style) => style === 'rgba(255, 255, 0, 0.22)'));
    assert.equal(added[0].stroke, 'rgba(255, 255, 0, 0.22)');
  });

  it('keeps the adjustment through a mid-stroke recolour made with setStrokeColor', () => {
    const { canvas, added } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);

    brush.inkContrast = makeContrast().contrast;
    brush.color = '#000000';

    brush.onMouseDown(new Point(10, 10), EVENT);
    brush.onMouseMove(new Point(60, 20), EVENT);
    // The colour barrel button / the dual-tip head revision: cyan, on the same white background.
    brush.setStrokeColor('#00ffff');
    brush.onMouseMove(new Point(120, 40), EVENT);
    brush.onMouseUp(EVENT);

    assert.notEqual(added[0].stroke, '#00ffff', 'the raw cyan would be illegible');
    assert.match(String(added[0].stroke), /^#[0-9a-f]{6}$/);
    // Between strokes the brush reports the colour it was last ASKED for.
    assert.equal(brush.color, '#00ffff');
  });

  it('respects a bare `color =` written by someone else mid-stroke at restore time', () => {
    const { canvas } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);

    brush.inkContrast = makeContrast().contrast;
    brush.color = '#ffff00';

    brush.onMouseDown(new Point(10, 10), EVENT);
    brush.color = '#ff0000';
    brush.onMouseMove(new Point(60, 20), EVENT);
    brush.onMouseUp(EVENT);

    // Not put back to yellow: the later write is the newer truth.
    assert.equal(brush.color, '#ff0000');
  });

  it('between strokes setStrokeColor is a plain assignment', () => {
    const { canvas } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);

    brush.inkContrast = makeContrast().contrast;
    brush.setStrokeColor('#ffff00');

    assert.equal(brush.color, '#ffff00');
  });

  it('reads the background afresh on every stroke', () => {
    const { canvas, added } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);
    let background = PAPER_LUMINANCE;
    const contrast = createStrokeInkContrast<Canvas>({
      isEnabled: () => true,
      sampleBackground: () => background,
      getOpacity: () => 1,
    });

    brush.inkContrast = contrast;
    brush.color = '#1e3a8a';

    // Dark blue on white: fine as it is.
    drawStroke(brush);
    assert.equal(added[0].stroke, '#1e3a8a');

    // The next stroke lands on a near-black region of the page: lightened.
    background = 0.01;
    drawStroke(brush);
    assert.notEqual(added[1].stroke, '#1e3a8a');
    assert.equal(brush.color, '#1e3a8a');
  });

  it('leaves the colour alone when the background cannot be read', () => {
    const { canvas, added } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);

    brush.inkContrast = makeContrast({ background: null }).contrast;
    brush.color = '#ffff00';

    drawStroke(brush);

    assert.equal(added[0].stroke, '#ffff00');
  });
});
