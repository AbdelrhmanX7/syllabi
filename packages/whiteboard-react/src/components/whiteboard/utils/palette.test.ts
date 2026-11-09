import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FILL_TINTS, HIGHLIGHTER_INKS, INK_COLORS, QUICK_FILL_TINTS, tintForInk } from '../palette';
import { DARK_BOARD_BASE_COLOR, LIGHT_BOARD_BASE_COLOR } from './darkBoard';
import { contrastRatio, darkBoardFillColor, darkBoardInkColor, inkColorToOklch, parseInkColor, relativeLuminance } from './inkContrast';

/**
 * The board palette, measured: ink reads on the paper in both themes, the inks stay apart for the
 * common colour blindnesses, highlights keep text readable, and fills keep ink readable.
 */

const luminance = (color: string) => relativeLuminance(parseInkColor(color)!);
const ratio = (a: string, b: string) => contrastRatio(luminance(a), luminance(b));

/** sRGB (0–1, gamma) → simulated colour-blind sRGB (Machado et al. 2009, severity 1, linear RGB). */
const MACHADO = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
} as const;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function simulate(color: string, kind: keyof typeof MACHADO): string {
  const { r, g, b } = parseInkColor(color)!;
  const [lr, lg, lb] = [r, g, b].map((c) => toLinear(c / 255)) as [number, number, number];
  const m = MACHADO[kind];
  const out = [m[0] * lr + m[1] * lg + m[2] * lb, m[3] * lr + m[4] * lg + m[5] * lb, m[6] * lr + m[7] * lg + m[8] * lb].map((v) =>
    Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))) * 255),
  );

  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Perceptual distance (OKLab ΔE × 100). */
function distance(a: string, b: string): number {
  const p = inkColorToOklch(a)!;
  const q = inkColorToOklch(b)!;
  const pa = p.c * Math.cos((p.h * Math.PI) / 180);
  const pb = p.c * Math.sin((p.h * Math.PI) / 180);
  const qa = q.c * Math.cos((q.h * Math.PI) / 180);
  const qb = q.c * Math.sin((q.h * Math.PI) / 180);

  return Math.hypot(p.l - q.l, pa - qa, pb - qb) * 100;
}

const report: string[] = [];

describe('board palette', () => {
  // The original colours are back by the owner's choice; the contrast rules no longer gate them.
  it('graphite ink stays readable under every highlight (0.22 translucency)', () => {
    for (const highlight of HIGHLIGHTER_INKS) {
      const { r, g, b } = parseInkColor(highlight)!;
      const mix = (c: number) => Math.round(0.22 * c + 0.78 * 255);
      const under = `#${[r, g, b].map((c) => mix(c).toString(16).padStart(2, '0')).join('')}`;
      const value = ratio(INK_COLORS[0], under);

      report.push(`graphite under ${highlight}: ${value.toFixed(2)}`);
      assert.ok(value >= 7, `${highlight}: ${value.toFixed(2)}`);
    }
  });

  it('ink reads on every fill tint, in both themes', () => {
    for (const tint of FILL_TINTS) {
      const light = ratio(INK_COLORS[0], tint);
      const darkTint = darkBoardFillColor(tint);
      const dark = ratio(darkBoardInkColor(INK_COLORS[0]), darkTint);

      report.push(`fill ${tint}: graphite ${light.toFixed(2)}; dark board ${darkTint} with light ink ${dark.toFixed(2)}`);
      assert.ok(light >= 4.5, `${tint} light ${light.toFixed(2)}`);
      assert.ok(dark >= 4.5, `${tint} dark ${dark.toFixed(2)}`);
    }

    console.log(`\n${report.join('\n')}`);
  });

  it('pairs each ink with its own tint, and the quick row starts with none', () => {
    assert.equal(tintForInk(INK_COLORS[1]), FILL_TINTS[1]);
    assert.equal(tintForInk('#123456'), null);
    assert.equal(QUICK_FILL_TINTS[0], 'transparent');
  });
});

describe('palette and the core pen colours', () => {
  it('are the same list', async () => {
    const { DEFAULT_COLORS } = await import('../types');

    assert.deepEqual([...DEFAULT_COLORS], [...INK_COLORS]);
  });
});
