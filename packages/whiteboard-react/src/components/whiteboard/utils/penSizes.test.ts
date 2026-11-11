import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseBoardPenMemory, serializeBoardPenMemory } from './boardPenMemory';
import { BOARD_PX_PER_MM } from './paperSpacing';
import {
  DEFAULT_HIGHLIGHTER_SIZE_MM,
  DEFAULT_PEN_SIZE_MM,
  formatSizeMm,
  HIGHLIGHTER_SIZES_MM,
  highlighterWidthPx,
  LEGACY_DEFAULT_PEN_WIDTH_PX,
  MAX_HIGHLIGHTER_WIDTH_PX,
  nearestSizeMm,
  normalizeHighlighterWidth,
  PEN_SIZES_MM,
  penMmToPx,
  penPxToMm,
  selectedSizeMm,
} from './penSizes';
import { MAX_STROKE_WIDTH, MIN_STROKE_WIDTH } from '../types';

const near = (actual: number, expected: number, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≠ ${expected}`);

test('mm → board px uses the paper scale (96 dpi), not the screen', () => {
  near(penMmToPx(1), BOARD_PX_PER_MM);
  near(penMmToPx(0.5), 1.889763779527559);
  near(penMmToPx(0.7), 2.645669291338583);
  near(penMmToPx(25.4), 96);
});

test('px → mm round-trips every size', () => {
  for (const mm of [...PEN_SIZES_MM, ...HIGHLIGHTER_SIZES_MM]) near(penPxToMm(penMmToPx(mm)), mm);
});

test('the pen and highlighter size sets', () => {
  assert.deepEqual([...PEN_SIZES_MM], [0.3, 0.5, 0.7, 1, 1.5, 2]);
  assert.deepEqual([...HIGHLIGHTER_SIZES_MM], [3, 4, 6, 8]);
});

test('every pen size is a width the board accepts', () => {
  for (const mm of PEN_SIZES_MM) {
    const px = penMmToPx(mm);
    assert.ok(px >= MIN_STROKE_WIDTH && px <= MAX_STROKE_WIDTH, `${mm} mm = ${px} px`);
  }
});

test('default pen keeps the old 4 px look: 1.0 mm (4 px ≈ 1.06 mm)', () => {
  assert.equal(LEGACY_DEFAULT_PEN_WIDTH_PX, 4);
  assert.equal(nearestSizeMm(4, PEN_SIZES_MM), 1);
  assert.equal(DEFAULT_PEN_SIZE_MM, 1);
  near(penMmToPx(DEFAULT_PEN_SIZE_MM), 3.779527559055118);
});

test('default highlighter is the size nearest its old 24 px (≈ 6.35 mm)', () => {
  assert.equal(nearestSizeMm(24, HIGHLIGHTER_SIZES_MM), DEFAULT_HIGHLIGHTER_SIZE_MM);
});

test('selected chip: nearest size within tolerance, none for an odd custom width', () => {
  assert.equal(selectedSizeMm(penMmToPx(0.5), PEN_SIZES_MM), 0.5);
  assert.equal(selectedSizeMm(4, PEN_SIZES_MM), 1);
  assert.equal(selectedSizeMm(2, PEN_SIZES_MM), 0.5);
  assert.equal(selectedSizeMm(12, PEN_SIZES_MM), null);
  assert.equal(selectedSizeMm(0, PEN_SIZES_MM), null);
  assert.equal(selectedSizeMm(Number.NaN, PEN_SIZES_MM), null);
});

test('labels read like the number on a pen', () => {
  assert.deepEqual(PEN_SIZES_MM.map(formatSizeMm), ['0.3', '0.5', '0.7', '1.0', '1.5', '2.0']);
  assert.deepEqual(HIGHLIGHTER_SIZES_MM.map(formatSizeMm), ['3', '4', '6', '8']);
});

test('highlighter: its own width, else exactly the old max(width × 4, 24)', () => {
  assert.equal(highlighterWidthPx({ width: 4 }), 24);
  assert.equal(highlighterWidthPx({ width: 8 }), 32);
  near(highlighterWidthPx({ width: 4, highlighterWidth: penMmToPx(3) }), penMmToPx(3));
  assert.equal(highlighterWidthPx({ width: 4, highlighterWidth: Number.NaN }), 24);
});

test('stored highlighter width is clamped, junk dropped', () => {
  assert.equal(normalizeHighlighterWidth('12'), undefined);
  assert.equal(normalizeHighlighterWidth(-1), undefined);
  assert.equal(normalizeHighlighterWidth(10_000), MAX_HIGHLIGHTER_WIDTH_PX);
  near(normalizeHighlighterWidth(penMmToPx(6))!, penMmToPx(6));
});

test('board pen memory keeps the highlighter width', () => {
  const fallback = { color: '#111', secondaryColor: '#222', width: 4, opacity: 1 };
  const strokeSettings = { ...fallback, width: penMmToPx(0.5), highlighterWidth: penMmToPx(8) };
  const parsed = parseBoardPenMemory(serializeBoardPenMemory({ tool: 'highlighter', strokeSettings }), fallback);

  assert.ok(parsed);
  near(parsed.strokeSettings.width, penMmToPx(0.5));
  near(parsed.strokeSettings.highlighterWidth!, penMmToPx(8));
  // An older entry without it falls back (to the device setting, here absent).
  const old = parseBoardPenMemory(JSON.stringify({ tool: 'pen', strokeSettings: { width: 6 } }), fallback);
  assert.equal(old?.strokeSettings.highlighterWidth, undefined);
  assert.equal(old?.strokeSettings.width, 6);
});
