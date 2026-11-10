import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mathSymbolLocalPoints,
  mathSymbolStretchIndex,
  normalizeMathSymbolParams,
  recognizeArrow,
  recognizeBrace,
  recognizeBracket,
  recognizeIntegral,
  recognizeMathSymbol,
  recognizeParen,
  stretchMathSymbol,
} from './mathSymbols';
import type { MathSymbolKind, MathSymbolParams, MathSymbolShape, RecognizeMathSymbolOptions, SymbolVec as Vec } from './mathSymbols';
import { recognizeRadical } from './radicalSign';

// ---------------------------------------------------------------------------------------------------
// Synthetic hand-drawn strokes (seeded wobble + jitter, rounded corners), as in radicalSign.test.
// ---------------------------------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 2 ** 32;
  };
}

function roundCorners(path: Vec[], radius: number): Vec[] {
  const out: Vec[] = [path[0]];

  for (let i = 1; i < path.length - 1; i += 1) {
    const [a, b, c] = [path[i - 1], path[i], path[i + 1]];
    const lab = Math.hypot(b.x - a.x, b.y - a.y);
    const lbc = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, lab * 0.3, lbc * 0.3);
    const p = { x: b.x + ((a.x - b.x) * r) / lab, y: b.y + ((a.y - b.y) * r) / lab };
    const q = { x: b.x + ((c.x - b.x) * r) / lbc, y: b.y + ((c.y - b.y) * r) / lbc };

    for (let k = 0; k <= 6; k += 1) {
      const t = k / 6;

      out.push({
        x: (1 - t) ** 2 * p.x + 2 * (1 - t) * t * b.x + t * t * q.x,
        y: (1 - t) ** 2 * p.y + 2 * (1 - t) * t * b.y + t * t * q.y,
      });
    }
  }

  out.push(path[path.length - 1]);

  return out;
}

function hand(path: Vec[], { seed = 1, wobble = 0.008, jitter = 0.6, scale = 100, round = true } = {}): Vec[] {
  const random = rng(seed);
  const source = round ? roundCorners(path, scale * 0.06) : path;
  const out: Vec[] = [];
  let travelled = 0;
  const phase = random() * Math.PI * 2;

  for (let i = 1; i < source.length; i += 1) {
    const a = source[i - 1];
    const b = source[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / (length || 1);
    const ny = (b.x - a.x) / (length || 1);

    for (let t = 0; t < length; t += 1.5 + random() * 2.5) {
      const w = Math.sin(phase + (travelled + t) / 23) * wobble * scale;

      out.push({
        x: a.x + ((b.x - a.x) * t) / length + nx * w + (random() - 0.5) * jitter,
        y: a.y + ((b.y - a.y) * t) / length + ny * w + (random() - 0.5) * jitter,
      });
    }

    travelled += length;
  }

  out.push({ ...source[source.length - 1] });

  return out;
}

/** Scale/translate a unit path (drawn in a 1×1 box) to height `h` at (x, y). */
const place = (path: Vec[], h: number, x = 300, y = 200): Vec[] => path.map((p) => ({ x: x + p.x * h, y: y + p.y * h }));

const flipX = (path: Vec[]): Vec[] => path.map((p) => ({ x: -p.x, y: p.y }));

/** A curve sampled from f(t), t ∈ [0, 1]. */
const curve = (f: (t: number) => Vec, steps = 40): Vec[] => Array.from({ length: steps + 1 }, (_, i) => f(i / steps));

// --- Symbol samples (unit height) -------------------------------------------------------------------

/** «(» as a circular arc of depth `bow` (unit height), or (flat = true) a flatter arc: round ends, straighter middle. */
const parenPath = (bow: number, flat = false): Vec[] => {
  const r = 0.25 / (2 * bow) + bow / 2;
  const phi = Math.asin(0.5 / r);

  return curve((t) => {
    const a = Math.PI + phi - 2 * phi * t;
    const x = r - bow + r * Math.cos(a);

    return { x: flat ? -bow * Math.pow(-x / bow, 0.7) : x, y: 0.5 + r * Math.sin(a) };
  });
};

const bracketPath = (arm: number): Vec[] => [
  { x: arm, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 1 },
  { x: arm, y: 1 },
];

/** A sketchy «{»: curls at the ends, straight runs, a pointed middle. */
const bracePath = (depth: number, cusp = 0.5): Vec[] => [
  { x: 0, y: 0 },
  { x: -0.5 * depth, y: 0.07 },
  { x: -0.5 * depth, y: cusp - 0.1 },
  { x: -depth, y: cusp },
  { x: -0.5 * depth, y: cusp + 0.1 },
  { x: -0.5 * depth, y: 0.93 },
  { x: 0, y: 1 },
];

/** A ∫ drawn from the top hook down. */
const integralPath = (hook = 0.13): Vec[] => [
  { x: 0.03 + hook, y: 0.08 },
  { x: 0.03 + hook * 0.7, y: 0 },
  { x: 0.05, y: 0.04 },
  { x: 0.03, y: 0.25 },
  { x: -0.03, y: 0.75 },
  { x: -0.05, y: 0.96 },
  { x: -0.03 - hook * 0.7, y: 1 },
  { x: -0.03 - hook, y: 0.92 },
];

/** A one-stroke arrow along `angle` (degrees): shaft, barb, back to the tip, the other barb. */
function arrowPath(angleDeg: number, length = 1, head = 0.25, barbDeg = 30): Vec[] {
  const a = (angleDeg * Math.PI) / 180;
  const tip = { x: length * Math.cos(a), y: length * Math.sin(a) };
  const barb = (s: number) => {
    const t = a + Math.PI + (s * barbDeg * Math.PI) / 180;

    return { x: tip.x + head * Math.cos(t), y: tip.y + head * Math.sin(t) };
  };

  return [{ x: 0, y: 0 }, tip, barb(1), { ...tip }, barb(-1)];
}

const HOLD: RecognizeMathSymbolOptions = { minSize: 20 };
const LIFT: RecognizeMathSymbolOptions = { minSize: 20, strict: true };

type Recognizer = (input: readonly Vec[], options: RecognizeMathSymbolOptions) => MathSymbolShape | null;

const RECOGNIZERS: Record<MathSymbolKind, Recognizer> = {
  paren: recognizeParen,
  bracket: recognizeBracket,
  brace: recognizeBrace,
  integral: recognizeIntegral,
  arrow: recognizeArrow,
};

interface Sample {
  label: string;
  kind: MathSymbolKind;
  points: (seed: number) => Vec[];
  /** Also snaps on lift (false for the hold-only integral). */
  lift: boolean;
  side?: 'left' | 'right';
}

const SAMPLES: Sample[] = [
  { label: '( small', kind: 'paren', side: 'left', lift: true, points: (seed) => hand(place(parenPath(0.18), 40), { seed, scale: 40, round: false }) },
  { label: '( tall', kind: 'paren', side: 'left', lift: true, points: (seed) => hand(place(parenPath(0.14), 200), { seed, scale: 200, round: false }) },
  { label: '( flat middle', kind: 'paren', side: 'left', lift: true, points: (seed) => hand(place(parenPath(0.2, true), 90), { seed, scale: 90, round: false }) },
  { label: ') drawn bottom-up', kind: 'paren', side: 'right', lift: true, points: (seed) => hand(place(flipX(parenPath(0.2)).reverse(), 90), { seed, scale: 90, round: false }) },
  { label: '[', kind: 'bracket', side: 'left', lift: true, points: (seed) => hand(place(bracketPath(0.25), 100), { seed }) },
  { label: '[ tall, short serifs', kind: 'bracket', side: 'left', lift: true, points: (seed) => hand(place(bracketPath(0.15), 240), { seed, scale: 240 }) },
  { label: ']', kind: 'bracket', side: 'right', lift: true, points: (seed) => hand(place(flipX(bracketPath(0.25)), 100), { seed }) },
  { label: '{', kind: 'brace', side: 'left', lift: true, points: (seed) => hand(place(bracePath(0.3), 120), { seed, scale: 120 }) },
  { label: '{ tall', kind: 'brace', side: 'left', lift: true, points: (seed) => hand(place(bracePath(0.22), 260), { seed, scale: 260 }) },
  { label: '} drawn bottom-up', kind: 'brace', side: 'right', lift: true, points: (seed) => hand(place(flipX(bracePath(0.3)).reverse(), 120), { seed, scale: 120 }) },
  { label: '∫', kind: 'integral', lift: false, points: (seed) => hand(place(integralPath(), 150), { seed, scale: 150 }) },
  { label: '∫ wide hooks', kind: 'integral', lift: false, points: (seed) => hand(place(integralPath(0.16), 220), { seed, scale: 220 }) },
  { label: '→', kind: 'arrow', lift: true, points: (seed) => hand(place(arrowPath(0), 150), { seed, scale: 150 }) },
  { label: '↓', kind: 'arrow', lift: true, points: (seed) => hand(place(arrowPath(90), 120), { seed, scale: 120 }) },
  { label: '↖ (any direction)', kind: 'arrow', lift: true, points: (seed) => hand(place(arrowPath(-140, 1, 0.3, 35), 130), { seed, scale: 130 }) },
  { label: '→ drawn head first', kind: 'arrow', lift: true, points: (seed) => hand(place(arrowPath(20).reverse(), 150), { seed, scale: 150 }) },
];

const SEEDS = [1, 2, 3, 4];

// ---------------------------------------------------------------------------------------------------
// Positives
// ---------------------------------------------------------------------------------------------------

describe('math symbols — drawn symbols are recognised', () => {
  for (const sample of SAMPLES) {
    it(`recognises ${sample.label} on hold${sample.lift ? ' and on lift' : ''}`, () => {
      for (const seed of SEEDS) {
        const points = sample.points(seed);
        const hold = recognizeMathSymbol(points, HOLD);

        assert.ok(hold, `seed ${seed}: expected a ${sample.kind}`);
        assert.equal(hold.params.kind, sample.kind, `seed ${seed}`);
        if (sample.side) assert.equal((hold.params as { side: string }).side, sample.side, `seed ${seed}`);

        const lift = recognizeMathSymbol(points, LIFT);

        if (sample.lift) assert.equal(lift?.params.kind, sample.kind, `seed ${seed}: lift`);
        else assert.equal(lift, null, `seed ${seed}: never on lift`);
      }
    });
  }

  it('sizes the clean symbol to the drawing', () => {
    const paren = recognizeParen(hand(place(parenPath(0.18), 100, 50, 60), { round: false }), HOLD);

    assert.ok(paren && paren.params.kind === 'paren');
    assert.ok(Math.abs(paren.params.height - 100) < 8, `height ${paren.params.height}`);
    assert.ok(Math.abs(paren.params.bow - 18) < 5, `bow ${paren.params.bow}`);
    assert.ok(Math.abs(paren.anchor.y - 60) < 5);

    const bracket = recognizeBracket(hand(place(bracketPath(0.25), 100, 50, 60)), HOLD);

    assert.ok(bracket && bracket.params.kind === 'bracket');
    assert.ok(Math.abs(bracket.params.height - 100) < 8);
    assert.ok(Math.abs(bracket.params.arm - 25) < 6);
    assert.ok(Math.abs(bracket.anchor.x - 75) < 6, `anchor ${bracket.anchor.x}`);

    const arrow = recognizeArrow(hand(place(arrowPath(0), 150, 10, 10), { scale: 150 }), HOLD);

    assert.ok(arrow && arrow.params.kind === 'arrow');
    assert.equal(arrow.params.angle, 0, 'snapped to horizontal');
    assert.ok(Math.abs(arrow.params.length - 150) < 10);
    assert.ok(Math.abs(arrow.anchor.x - 10) < 4);
  });

  it('is independent of where on the page it is drawn', () => {
    for (const [x, y] of [
      [0, 0],
      [-4000, 12000],
      [1e5, 1e5],
    ]) {
      assert.equal(recognizeMathSymbol(hand(place(bracePath(0.3), 120, x, y), { scale: 120 }), HOLD)?.params.kind, 'brace', `at ${x},${y}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Each recogniser claims only its own symbol
// ---------------------------------------------------------------------------------------------------

describe('math symbols — no recogniser claims another symbol', () => {
  for (const sample of SAMPLES) {
    it(`only the ${sample.kind} recogniser takes ${sample.label}`, () => {
      for (const seed of SEEDS) {
        const points = sample.points(seed);

        for (const [kind, recognize] of Object.entries(RECOGNIZERS)) {
          if (kind === sample.kind) continue;
          assert.equal(recognize(points, HOLD), null, `${kind} took it (seed ${seed})`);
        }
      }
    });
  }

  it('leaves a square root to the radical recogniser', () => {
    const radical = [
      { x: 0, y: 70 },
      { x: 20, y: 100 },
      { x: 30, y: 0 },
      { x: 180, y: 0 },
    ];

    for (const seed of SEEDS) {
      const points = hand(radical, { seed });

      assert.ok(recognizeRadical(points, HOLD), 'precondition: a radical');
      assert.equal(recognizeMathSymbol(points, HOLD), null, `seed ${seed}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Negatives: ordinary writing stays ink — on hold, and (stricter) on lift
// ---------------------------------------------------------------------------------------------------

describe('math symbols — conservative: ordinary letters and digits stay ink', () => {
  const rejects = (label: string, path: Vec[], { round = true, scale = 100 } = {}) =>
    it(`leaves ${label} alone`, () => {
      for (const seed of SEEDS) {
        const points = hand(path, { seed, round, scale });

        assert.equal(recognizeMathSymbol(points, LIFT), null, `lift, seed ${seed}`);
        assert.equal(recognizeMathSymbol(points, HOLD), null, `hold, seed ${seed}`);
      }
    });

  const arcPath = (from: number, to: number, rx: number, ry: number) =>
    curve((t) => {
      const a = ((from + (to - from) * t) * Math.PI) / 180;

      return { x: rx * Math.cos(a), y: ry * Math.sin(a) };
    });

  rejects('a "c"', place(arcPath(-50, -310, 0.5, 0.5), 50), { round: false, scale: 50 });
  rejects('a "C"', place(arcPath(-45, -315, 0.45, 0.5), 120), { round: false, scale: 120 });
  rejects('a narrow "C"', place(arcPath(-60, -300, 0.3, 0.5), 120), { round: false, scale: 120 });
  rejects('an "l"', place([{ x: 0.05, y: 0 }, { x: 0, y: 1 }], 100));
  rejects('a slightly curved "l"', place(curve((t) => ({ x: -0.04 * Math.sin(Math.PI * t), y: t })), 100), { round: false });
  rejects('an "l" with a hook at the foot', place([{ x: 0, y: 0 }, { x: 0, y: 0.85 }, { x: 0.08, y: 1 }, { x: 0.2, y: 0.95 }], 100));
  rejects('a "1" with a flag', place([{ x: -0.25, y: 0.2 }, { x: 0, y: 0 }, { x: 0, y: 1 }], 100));
  rejects('a "1" with a flag and a foot', place([{ x: -0.25, y: 0.2 }, { x: 0, y: 0 }, { x: 0, y: 1 }, { x: -0.2, y: 1 }, { x: 0.2, y: 1 }], 100));
  rejects('an "f" stem (top hook only)', place([{ x: 0.3, y: 0.1 }, { x: 0.2, y: 0 }, { x: 0.05, y: 0.05 }, { x: 0, y: 0.3 }, { x: 0, y: 1 }], 120), { scale: 120 });
  rejects('an "S"', place(curve((t) => ({ x: 0.3 * Math.cos(Math.PI * 2 * t + Math.PI / 4) * (t < 0.5 ? 1 : -1), y: t })), 100), { round: false });
  rejects('a "J"', place([{ x: 0.15, y: 0 }, { x: 0.15, y: 0.8 }, { x: 0.05, y: 1 }, { x: -0.15, y: 0.9 }], 100));
  rejects('a "J" with a top bar', place([{ x: -0.1, y: 0 }, { x: 0.25, y: 0 }, { x: 0.15, y: 0.02 }, { x: 0.15, y: 0.8 }, { x: 0.05, y: 1 }, { x: -0.15, y: 0.9 }], 100));
  rejects('a "v"', place([{ x: 0, y: 0 }, { x: 0.3, y: 0.6 }, { x: 0.6, y: 0 }], 100));
  rejects('a ✓ check mark', place([{ x: 0, y: 0.5 }, { x: 0.25, y: 0.8 }, { x: 0.9, y: 0 }], 100));
  rejects('a tall ✓', place([{ x: 0, y: 0.7 }, { x: 0.15, y: 1 }, { x: 0.4, y: 0 }], 100));
  rejects('an "L"', place([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0.4, y: 1 }], 100));
  rejects('a "7"', place([{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.15, y: 1 }], 100));
  rejects('a "Z"', place([{ x: 0, y: 0 }, { x: 0.4, y: 0 }, { x: 0, y: 1 }, { x: 0.4, y: 1 }], 100));
  rejects('a "<"', place([{ x: 0.3, y: 0 }, { x: 0, y: 0.5 }, { x: 0.3, y: 1 }], 100));
  rejects('a tall narrow "<"', place([{ x: 0.2, y: 0 }, { x: 0, y: 0.5 }, { x: 0.2, y: 1 }], 100));
  rejects('a "3"', place(curve((t) => ({ x: Math.sin(2 * Math.PI * t) ** 2 * 0.35 + 0.05 * Math.sin(Math.PI * t * 2) ** 2, y: t }), 60), 100), { round: false });
  rejects('an "ε"', place(curve((t) => ({ x: 0.35 - Math.sin(2 * Math.PI * t) ** 2 * 0.35, y: t }), 60), 100), { round: false });
  rejects('a "k" in one stroke', place([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 0.6 }, { x: 0.4, y: 0.3 }, { x: 0.05, y: 0.6 }, { x: 0.4, y: 1 }], 100));
  rejects('a "W"', place([{ x: 0, y: 0 }, { x: 0.2, y: 0.8 }, { x: 0.45, y: 0.2 }, { x: 0.7, y: 0.8 }, { x: 0.9, y: 0 }], 100));
  rejects('an "N"', place([{ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 0.7, y: 1 }, { x: 0.7, y: 0 }], 100));
  rejects('a "4" in one stroke', place([{ x: 0.4, y: 0 }, { x: 0, y: 0.6 }, { x: 0.5, y: 0.6 }], 100));
  rejects('a straight line', place([{ x: 0, y: 0 }, { x: 2, y: 0 }], 100));
  rejects('a tilted straight line', place([{ x: 0, y: 0 }, { x: 0.3, y: 1 }], 100));

  it('leaves a circle and a rectangle alone', () => {
    const circle = curve((t) => ({ x: 50 * Math.cos(2 * Math.PI * t), y: 50 * Math.sin(2 * Math.PI * t) }), 80);
    const rect = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
      { x: 0, y: 0 },
    ];

    for (const seed of SEEDS) {
      assert.equal(recognizeMathSymbol(hand(circle, { seed, round: false }), HOLD), null);
      assert.equal(recognizeMathSymbol(hand(rect, { seed }), HOLD), null);
    }
  });

  it('a one-stroke italic "f" body never snaps on lift (the integral is hold-only)', () => {
    for (const seed of SEEDS) {
      assert.equal(recognizeMathSymbol(hand(place(integralPath(), 150), { seed, scale: 150 }), LIFT), null);
    }
  });

  it('ignores strokes below the minimum size', () => {
    assert.equal(recognizeMathSymbol(hand(place(bracketPath(0.25), 10)), HOLD), null);
  });
});

// ---------------------------------------------------------------------------------------------------
// Geometry and stretching
// ---------------------------------------------------------------------------------------------------

describe('math symbols — clean geometry', () => {
  const kinds: MathSymbolParams[] = [
    { kind: 'paren', side: 'left', height: 100, bow: 18 },
    { kind: 'bracket', side: 'right', height: 100, arm: 20 },
    { kind: 'brace', side: 'left', height: 120, depth: 30 },
    { kind: 'integral', height: 150, hook: 20 },
    { kind: 'arrow', length: 150, angle: 0.3, head: 30 },
  ];

  for (const params of kinds) {
    it(`${params.kind}: starts at the anchor, finite, and stretches without changing its fixed part`, () => {
      const points = mathSymbolLocalPoints(params);

      assert.deepEqual(points[0], { x: 0, y: 0 });
      assert.ok(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

      const index = mathSymbolStretchIndex(params);
      const handle = points[index];
      const stretched = stretchMathSymbol(params, { x: handle.x * 1.5, y: handle.y * 1.5 + (params.kind === 'arrow' ? 0 : 60) });
      const after = mathSymbolLocalPoints(stretched);

      assert.equal(after.length, points.length, 'same number of points');
      assert.deepEqual(after[0], { x: 0, y: 0 });

      if (params.kind === 'arrow' && stretched.kind === 'arrow') {
        assert.ok(stretched.length > params.length);
        assert.equal(stretched.head, params.head);
        assert.ok(Math.abs(stretched.angle - params.angle) < 1e-9);
      } else {
        const tall = (p: MathSymbolParams) => (p as { height: number }).height;

        assert.ok(tall(stretched) > tall(params));
        // The bottom end follows the handle.
        assert.ok(Math.abs(after[index].y - (handle.y * 1.5 + 60)) < 1e-6, `${after[index].y}`);
      }
    });
  }

  it('the bracket and brace mirror for the closing side', () => {
    const left = mathSymbolLocalPoints({ kind: 'bracket', side: 'left', height: 100, arm: 20 });
    const right = mathSymbolLocalPoints({ kind: 'bracket', side: 'right', height: 100, arm: 20 });

    assert.ok(left[1].x < 0 && right[1].x > 0);
  });

  it('never shrinks below its fixed part', () => {
    const tiny = normalizeMathSymbolParams({ kind: 'brace', side: 'left', height: 1, depth: 30 });

    assert.ok(tiny.kind === 'brace' && tiny.height >= 30 * 2.4);
    assert.ok(normalizeMathSymbolParams({ kind: 'arrow', length: -5, angle: NaN, head: 20 }).kind === 'arrow');
  });

  it('round-trips through the recogniser: a clean symbol is recognised as itself', () => {
    for (const params of kinds) {
      const points = mathSymbolLocalPoints(params).map((p) => ({ x: p.x + 400, y: p.y + 300 }));
      const result = recognizeMathSymbol(hand(points, { round: params.kind !== 'paren', scale: 150 }), HOLD);

      assert.equal(result?.params.kind, params.kind, params.kind);
    }
  });
});
