import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  contrastRatio,
  createStrokeInkContrast,
  ensureInkContrast,
  inkColorToOklch,
  MIN_INK_CONTRAST,
  PAPER_LUMINANCE,
  parseInkColor,
  relativeLuminance,
  sampleCanvasLuminance,
} from './inkContrast';

/** The contrast a stroke of `color` (at its own alpha × `opacity`) reads at over `background`. */
function seenContrast(color: string, background: number, opacity = 1): number {
  const rgba = parseInkColor(color);

  assert.ok(rgba, `${color} parses`);

  const alpha = rgba.a * opacity;
  const composite = alpha * relativeLuminance(rgba) + (1 - alpha) * background;

  return contrastRatio(composite, background);
}

/** Hue distance on the circle, degrees. */
const hueDelta = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;

  return d > 180 ? 360 - d : d;
};

const NEAR_BLACK = relativeLuminance({ r: 18, g: 18, b: 18 });

describe('ensureInkContrast', () => {
  it('leaves black on white alone', () => {
    assert.equal(ensureInkContrast('#000000', PAPER_LUMINANCE), '#000000');
    assert.equal(ensureInkContrast('rgb(0, 0, 0)', PAPER_LUMINANCE), 'rgb(0, 0, 0)');
  });

  it('leaves any colour that already reads at 3:1 alone', () => {
    for (const color of ['#1e3a8a', '#dc2626', '#047857', '#808080']) {
      assert.ok(seenContrast(color, PAPER_LUMINANCE) >= MIN_INK_CONTRAST, `${color} is already legible`);
      assert.equal(ensureInkContrast(color, PAPER_LUMINANCE), color);
    }
  });

  it('turns yellow on white into a darker yellow of the same hue', () => {
    const adjusted = ensureInkContrast('#ffff00', PAPER_LUMINANCE);
    const before = inkColorToOklch('#ffff00');
    const after = inkColorToOklch(adjusted);

    assert.ok(before && after);
    assert.ok(seenContrast(adjusted, PAPER_LUMINANCE) >= MIN_INK_CONTRAST, `${adjusted} reaches 3:1`);
    assert.ok(after.l < before.l, 'darker');
    assert.ok(hueDelta(after.h, before.h) < 6, `hue kept (${before.h.toFixed(1)} → ${after.h.toFixed(1)})`);
    // Still clearly a yellow: red and green stay together and well above blue.
    const rgba = parseInkColor(adjusted);

    assert.ok(rgba && Math.abs(rgba.r - rgba.g) < 40 && rgba.r > rgba.b + 80, `${adjusted} is an ochre, not a grey`);
  });

  it('turns cyan on white into a darker cyan', () => {
    const adjusted = ensureInkContrast('#00ffff', PAPER_LUMINANCE);
    const before = inkColorToOklch('#00ffff');
    const after = inkColorToOklch(adjusted);

    assert.ok(before && after);
    assert.ok(seenContrast(adjusted, PAPER_LUMINANCE) >= MIN_INK_CONTRAST);
    assert.ok(after.l < before.l);
    assert.ok(hueDelta(after.h, before.h) < 6);
  });

  it('moves no further than it has to', () => {
    const adjusted = ensureInkContrast('#ffff00', PAPER_LUMINANCE);
    const ratio = seenContrast(adjusted, PAPER_LUMINANCE);

    assert.ok(ratio >= MIN_INK_CONTRAST && ratio < MIN_INK_CONTRAST + 0.15, `just over the line: ${ratio.toFixed(3)}`);
  });

  it('lightens dark blue on a near-black region, keeping it blue', () => {
    const adjusted = ensureInkContrast('#1e3a8a', NEAR_BLACK);
    const before = inkColorToOklch('#1e3a8a');
    const after = inkColorToOklch(adjusted);

    assert.ok(before && after);
    assert.ok(seenContrast(adjusted, NEAR_BLACK) >= MIN_INK_CONTRAST, `${adjusted} reaches 3:1 on near-black`);
    assert.ok(after.l > before.l, 'lighter');
    assert.ok(hueDelta(after.h, before.h) < 8, `hue kept (${before.h.toFixed(1)} → ${after.h.toFixed(1)})`);
  });

  it('leaves white on a dark region alone and lightens a too-dark grey there', () => {
    assert.equal(ensureInkContrast('#ffffff', NEAR_BLACK), '#ffffff');

    const adjusted = ensureInkContrast('#333333', NEAR_BLACK);
    const rgba = parseInkColor(adjusted);

    assert.ok(rgba);
    assert.ok(seenContrast(adjusted, NEAR_BLACK) >= MIN_INK_CONTRAST);
    assert.ok(rgba.r > 0x33, 'lighter');
    assert.ok(rgba.r === rgba.g && rgba.g === rgba.b, 'a grey stays a grey');
  });

  it('darkens a light grey on white just enough, as a grey', () => {
    assert.ok(seenContrast('#a0a0a0', PAPER_LUMINANCE) < MIN_INK_CONTRAST);

    const adjusted = ensureInkContrast('#a0a0a0', PAPER_LUMINANCE);
    const rgba = parseInkColor(adjusted);

    assert.ok(rgba);
    assert.ok(seenContrast(adjusted, PAPER_LUMINANCE) >= MIN_INK_CONTRAST);
    assert.ok(rgba.r < 0xa0 && rgba.r > 0x80, `a little darker, not black: ${adjusted}`);
    assert.ok(Math.abs(rgba.r - rgba.g) <= 1 && Math.abs(rgba.g - rgba.b) <= 1);
  });

  it('on a mid-grey background picks the side with more headroom and reaches the ratio', () => {
    const midGrey = relativeLuminance({ r: 119, g: 119, b: 119 });

    // Same grey as the background: invisible. Either direction works; the result must be legible.
    const sameGrey = ensureInkContrast('#777777', midGrey);

    assert.notEqual(sameGrey, '#777777');
    assert.ok(seenContrast(sameGrey, midGrey) >= MIN_INK_CONTRAST);

    // A light background (luminance above the ~0.18 balance point) darkens the ink …
    const lightGrey = relativeLuminance({ r: 200, g: 200, b: 200 });
    const onLight = inkColorToOklch(ensureInkContrast('#999999', lightGrey));
    const grey = inkColorToOklch('#999999');

    assert.ok(onLight && grey && onLight.l < grey.l);

    // … and a dark one lightens it.
    const darkGrey = relativeLuminance({ r: 60, g: 60, b: 60 });
    const onDark = inkColorToOklch(ensureInkContrast('#555555', darkGrey));
    const ink = inkColorToOklch('#555555');

    assert.ok(onDark && ink && onDark.l > ink.l);
  });

  it('keeps translucent ink translucent and measures the composited stroke', () => {
    const marker = 'rgba(255, 255, 0, 0.82)';
    const adjusted = ensureInkContrast(marker, PAPER_LUMINANCE);
    const rgba = parseInkColor(adjusted);

    assert.ok(rgba);
    assert.equal(rgba.a, 0.82, 'alpha kept');
    assert.ok(adjusted.startsWith('rgba('), 'notation kept');
    assert.ok(seenContrast(adjusted, PAPER_LUMINANCE) >= MIN_INK_CONTRAST, 'the composited stroke reads at 3:1');
    // Translucent ink has to go darker than opaque ink of the same hue to read the same.
    const opaque = parseInkColor(ensureInkContrast('#ffff00', PAPER_LUMINANCE));

    assert.ok(opaque && rgba.r < opaque.r);
  });

  it('folds the pen opacity slider into the measurement', () => {
    // At 85% opacity a colour that passes opaque no longer does …
    const passesOpaque = '#808080';

    assert.ok(seenContrast(passesOpaque, PAPER_LUMINANCE) >= MIN_INK_CONTRAST);
    assert.ok(seenContrast(passesOpaque, PAPER_LUMINANCE, 0.85) < MIN_INK_CONTRAST);

    const adjusted = ensureInkContrast(passesOpaque, PAPER_LUMINANCE, { opacity: 0.85 });

    assert.notEqual(adjusted, passesOpaque);
    assert.ok(seenContrast(adjusted, PAPER_LUMINANCE, 0.85) >= MIN_INK_CONTRAST);
    // … while the same colour at full opacity is left alone.
    assert.equal(ensureInkContrast(passesOpaque, PAPER_LUMINANCE, { opacity: 1 }), passesOpaque);
  });

  it('leaves a wash that no shade could make legible as it is', () => {
    // Highlighter-grade translucency: even black at 22% cannot reach 3:1 on white.
    assert.equal(ensureInkContrast('rgba(255, 255, 0, 0.22)', PAPER_LUMINANCE), 'rgba(255, 255, 0, 0.22)');
    assert.equal(ensureInkContrast('#ffff00', PAPER_LUMINANCE, { opacity: 0.2 }), '#ffff00');
  });

  it('writes hex in as hex out and preserves 8-digit alpha', () => {
    assert.match(ensureInkContrast('#ff0', PAPER_LUMINANCE), /^#[0-9a-f]{6}$/);
    assert.match(ensureInkContrast('#ffff00cc', PAPER_LUMINANCE), /^rgba\(\d+, \d+, \d+, 0\.8\)$/);
  });

  it('passes colours it cannot read through untouched', () => {
    assert.equal(ensureInkContrast('yellow', PAPER_LUMINANCE), 'yellow');
    assert.equal(ensureInkContrast('hsl(60 100% 50%)', PAPER_LUMINANCE), 'hsl(60 100% 50%)');
    assert.equal(ensureInkContrast('', PAPER_LUMINANCE), '');
  });

  it('is cheap enough to run on every pen-down', () => {
    const start = performance.now();

    for (let index = 0; index < 1000; index += 1) {
      ensureInkContrast('#ffff00', PAPER_LUMINANCE);
      ensureInkContrast('#1e3a8a', NEAR_BLACK);
    }

    const perCall = (performance.now() - start) / 2000;

    assert.ok(perCall < 0.5, `${perCall.toFixed(3)} ms per adjustment`);
  });
});

describe('parseInkColor', () => {
  it('reads every notation the brushes produce', () => {
    assert.deepEqual(parseInkColor('#ffff00'), { r: 255, g: 255, b: 0, a: 1, format: 'hex' });
    assert.deepEqual(parseInkColor('#ff0'), { r: 255, g: 255, b: 0, a: 1, format: 'hex' });
    assert.deepEqual(parseInkColor('rgb(255, 255, 0)'), { r: 255, g: 255, b: 0, a: 1, format: 'rgb' });
    assert.deepEqual(parseInkColor('rgba(255, 255, 0, 0.82)'), { r: 255, g: 255, b: 0, a: 0.82, format: 'rgb' });
    assert.equal(parseInkColor('#ffff00ff')?.a, 1);
    assert.equal(parseInkColor('#12345'), null);
    assert.equal(parseInkColor('rgb(1, 2)'), null);
  });
});

describe('sampleCanvasLuminance', () => {
  type Fill = (left: number, top: number, size: number) => number[];

  /** A canvas stub whose `getImageData` is served by `fill` and counted. */
  function makeCanvas(width: number, height: number, fill: Fill) {
    let reads = 0;
    const canvas = {
      width,
      height,
      getContext: () => ({
        getImageData(left: number, top: number, w: number, h: number) {
          reads += 1;

          assert.equal(w, h);
          assert.ok(left >= 0 && top >= 0 && left + w <= width && top + h <= height, 'inside the canvas');

          return { data: new Uint8ClampedArray(fill(left, top, w)) };
        },
      }),
    } as unknown as HTMLCanvasElement;

    return { canvas, reads: () => reads };
  }

  const solid = (r: number, g: number, b: number, a = 255): Fill => (_left, _top, size) =>
    Array.from({ length: size * size }, () => [r, g, b, a]).flat();

  it('reads a white page as paper and a black region as dark', () => {
    const white = makeCanvas(400, 300, solid(255, 255, 255));
    const black = makeCanvas(400, 300, solid(0, 0, 0));

    assert.equal(sampleCanvasLuminance(white.canvas, 200, 150, 0), 1);
    assert.equal(sampleCanvasLuminance(black.canvas, 200, 150, 0), 0);
  });

  it('takes the median, so a thin dark glyph under the pen does not darken a white page', () => {
    // 7×7 window with one 1-px-wide black column (7 of 49 pixels dark).
    const glyph: Fill = (_left, _top, size) => {
      const out: number[] = [];

      for (let row = 0; row < size; row += 1) {
        for (let col = 0; col < size; col += 1) {
          const dark = col === 3;

          out.push(dark ? 0 : 255, dark ? 0 : 255, dark ? 0 : 255, 255);
        }
      }

      return out;
    };
    const { canvas } = makeCanvas(400, 300, glyph);

    assert.equal(sampleCanvasLuminance(canvas, 200, 150, 0), 1);
  });

  it('clamps the window inside the canvas at the edges', () => {
    const { canvas } = makeCanvas(400, 300, solid(128, 128, 128));

    assert.ok(sampleCanvasLuminance(canvas, 0, 0, 0) !== null);
    assert.ok(sampleCanvasLuminance(canvas, 399, 299, 100) !== null);
  });

  it('shares one reading between stroke starts in quick succession', () => {
    const { canvas, reads } = makeCanvas(400, 300, solid(255, 255, 255));

    sampleCanvasLuminance(canvas, 10, 10, 1000);
    sampleCanvasLuminance(canvas, 300, 200, 1010);
    sampleCanvasLuminance(canvas, 300, 200, 1040);
    assert.equal(reads(), 1);

    sampleCanvasLuminance(canvas, 300, 200, 1100);
    assert.equal(reads(), 2);
  });

  it('returns null, rather than throwing, on a canvas that refuses to be read', () => {
    const tainted = {
      width: 400,
      height: 300,
      getContext: () => ({
        getImageData() {
          throw new DOMException('tainted', 'SecurityError');
        },
      }),
    } as unknown as HTMLCanvasElement;

    assert.equal(sampleCanvasLuminance(tainted, 10, 10, 0), null);
  });

  it('in a browser, copies the window to a scratch canvas and never reads the live canvas back', () => {
    // A readback of the GPU background canvas moves it to software rendering — every scroll frame of
    // the PDF layout then paid for it. The source may only be DRAWN from.
    const sourceReads: number[] = [];
    const draws: number[][] = [];
    const scratchContexts: { willReadFrequently?: boolean }[] = [];
    const source = {
      width: 400,
      height: 300,
      getContext: () => ({
        getImageData() {
          sourceReads.push(1);

          return { data: new Uint8ClampedArray(49 * 4) };
        },
      }),
    } as unknown as HTMLCanvasElement;
    const scratchCanvas = { width: 0, height: 0 } as { width: number; height: number; getContext?: unknown };

    scratchCanvas.getContext = (_kind: string, options: { willReadFrequently?: boolean }) => {
      scratchContexts.push(options);

      return {
        canvas: scratchCanvas,
        clearRect: () => undefined,
        drawImage: (_image: unknown, ...args: number[]) => draws.push(args),
        getImageData: (_l: number, _t: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(Array.from({ length: w * h }, () => [0, 0, 0, 255]).flat()),
        }),
      };
    };

    const globals = globalThis as unknown as { document?: unknown };
    const previous = globals.document;

    globals.document = { createElement: () => scratchCanvas };

    try {
      assert.equal(sampleCanvasLuminance(source, 200, 150, 50_000), 0);
      assert.equal(sourceReads.length, 0);
      assert.deepEqual(draws, [[197, 147, 7, 7, 0, 0, 7, 7]]);
      assert.deepEqual(scratchContexts, [{ willReadFrequently: true }]);
    } finally {
      globals.document = previous;
    }
  });
});

describe('createStrokeInkContrast', () => {
  type Host = Parameters<typeof createStrokeInkContrast<string>>[0];

  function makeHost(overrides: Partial<Host> = {}) {
    const calls: [string, number, number][] = [];
    const host: Host = {
      isEnabled: () => true,
      sampleBackground: (surface: string, x: number, y: number) => {
        calls.push([surface, x, y]);

        return PAPER_LUMINANCE;
      },
      getOpacity: () => 1,
      ...overrides,
    };

    return { host, calls };
  }

  it('samples once at stroke start and maps every colour of the stroke against that reading', () => {
    const { host, calls } = makeHost();
    const contrast = createStrokeInkContrast(host);

    contrast.strokeStart('page', 12, 34);
    assert.deepEqual(calls, [['page', 12, 34]]);

    const first = contrast.adjust('#ffff00');
    const second = contrast.adjust('#00ffff');

    assert.notEqual(first, '#ffff00');
    assert.notEqual(second, '#00ffff');
    assert.equal(contrast.adjust('#000000'), '#000000');
    assert.equal(calls.length, 1, 'no second read');
  });

  it('does nothing — and reads nothing — while the setting is off', () => {
    const { host, calls } = makeHost({ isEnabled: () => false });
    const contrast = createStrokeInkContrast(host);

    contrast.strokeStart('page', 1, 2);
    assert.equal(calls.length, 0);
    assert.equal(contrast.adjust('#ffff00'), '#ffff00');
  });

  it('leaves the colour alone when the background is unknown, and after the stroke ends', () => {
    const { host } = makeHost({ sampleBackground: () => null });
    const contrast = createStrokeInkContrast(host);

    contrast.strokeStart('page', 1, 2);
    assert.equal(contrast.adjust('#ffff00'), '#ffff00');

    const live = createStrokeInkContrast(makeHost().host);

    live.strokeStart('page', 1, 2);
    assert.notEqual(live.adjust('#ffff00'), '#ffff00');
    live.strokeEnd();
    assert.equal(live.adjust('#ffff00'), '#ffff00');
  });

  it('hands the pen opacity to the measurement', () => {
    const { host } = makeHost({ getOpacity: () => 0.85 });
    const contrast = createStrokeInkContrast(host);

    contrast.strokeStart('page', 0, 0);
    assert.notEqual(contrast.adjust('#808080'), '#808080');
  });
});
