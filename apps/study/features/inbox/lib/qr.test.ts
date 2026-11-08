import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { encodeQr, penaltyScore, qrSvgPath } from './qr';

type Reference = { create: (text: string, options: object) => { modules: { size: number; data: Uint8Array } } };

// The `qrcode` package sits in the workspace root (another app's dependency); compare against it when it is there.
function loadReference(): Reference | null {
  try {
    return createRequire(import.meta.url)('qrcode') as Reference;
  } catch {
    return null;
  }
}

const reference = loadReference();

const SAMPLES = [
  'hi',
  'https://api.example.com/study/drop?t=sk_drop_3f9a1c2e7b4d5a6f8e0c1b2a3d4e5f60',
  'https://api.example.com/study/inbox',
  'x'.repeat(180), // version ≥ 7: version-info blocks
  'Ünïcödé ✓ 📱',
];

test('matches the qrcode package module-for-module (every mask, every ECC level)', { skip: !reference }, () => {
  for (const text of SAMPLES) {
    for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
      for (let mask = 0; mask < 8; mask++) {
        const ours = encodeQr(text, { ecc, mask });
        const theirs = reference!.create(text, { errorCorrectionLevel: ecc, maskPattern: mask, version: ours.version });

        assert.equal(ours.size, theirs.modules.size, `${text}/${ecc}/${mask} size`);
        const flat = ours.modules.flat().map((dark) => (dark ? 1 : 0));

        assert.deepEqual(
          flat,
          Array.from(theirs.modules.data, (v) => (v ? 1 : 0)),
          `${text.slice(0, 20)}/${ecc}/${mask}`,
        );
      }
    }
  }
});

test('picks the smallest version that fits and the lowest-penalty mask', () => {
  assert.equal(encodeQr('hi', { ecc: 'M' }).version, 1);
  assert.equal(encodeQr('x'.repeat(14), { ecc: 'M' }).version, 1);
  assert.equal(encodeQr('x'.repeat(15), { ecc: 'M' }).version, 2);

  const auto = encodeQr(SAMPLES[1]);
  const scores = Array.from({ length: 8 }, (_, mask) => penaltyScore(encodeQr(SAMPLES[1], { mask }).modules));

  assert.equal(scores[auto.mask], Math.min(...scores));
});

test('finder patterns sit in three corners', () => {
  const { modules, size } = encodeQr(SAMPLES[1]);

  for (const [x, y] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]) {
    assert.ok(modules[y][x] && modules[y + 6][x + 6] && !modules[y + 1][x + 1] && modules[y + 3][x + 3]);
  }
});

test('svg path: one square per dark module, offset by the quiet zone', () => {
  const code = encodeQr('hi');
  const path = qrSvgPath(code, 4);
  const dark = code.modules.flat().filter(Boolean).length;

  assert.equal(path.split('M').length - 1, dark);
  assert.ok(path.startsWith('M4 4h1v1h-1z'));
});

test('rejects text beyond version 40', () => {
  assert.throws(() => encodeQr('x'.repeat(3000), { ecc: 'H' }), /too long/);
});
