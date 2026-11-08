import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOARD_PX_PER_MM,
  boardPatternSpacingPx,
  boardPxToMm,
  LEGACY_PATTERN_SPACING_PX,
  mmToBoardPx,
  resolveDefaultPaperSpacingMm,
  sheetPatternPitch,
  SHEET_WIDTH_MM,
  spacingPresetsFor,
} from './paperSpacing';
import { sheetRuleLineYs, sheetRulePitch } from './pdfScrollLayout';

const near = (actual: number, expected: number, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≠ ${expected}`);

test('board scale: 96 CSS px per inch, the scale the PDF export prints at', () => {
  near(BOARD_PX_PER_MM, 96 / 25.4);
  near(mmToBoardPx(25.4), 96);
  near(boardPxToMm(96), 25.4);
  near(mmToBoardPx(7.1), 26.834645669, 1e-6);
  // The original 30 px pattern is ≈ 7.94 mm on this scale.
  near(boardPxToMm(LEGACY_PATTERN_SPACING_PX), 7.9375);
});

test('board page: absent or invalid spacing keeps the original 30 px', () => {
  assert.equal(boardPatternSpacingPx(undefined), 30);
  assert.equal(boardPatternSpacingPx({}), 30);
  assert.equal(boardPatternSpacingPx({ paperSpacingMm: 0 }), 30);
  assert.equal(boardPatternSpacingPx({ paperSpacingMm: 99 }), 30);
  near(boardPatternSpacingPx({ paperSpacingMm: 5 }), 5 * BOARD_PX_PER_MM);
  near(boardPatternSpacingPx({ paperSpacingMm: 8.7 }), 8.7 * BOARD_PX_PER_MM);
});

test('inserted sheet: the page is 210 mm wide, so the pitch is a fraction of its width on any screen', () => {
  near(sheetPatternPitch(2100, 7.1), 71);
  near(sheetPatternPitch(1480, 7.1), (1480 * 7.1) / SHEET_WIDTH_MM);
  // Same physical rule → same number of lines per page on a big and a small screen.
  near(2100 / sheetPatternPitch(2100, 6), 1480 / sheetPatternPitch(1480, 6));
  // Absent keeps the original width / 28.
  near(sheetPatternPitch(2100), 75);
  near(sheetRulePitch(2100), 75);
  near(sheetRulePitch(2100, 10), 100);
});

test('sheet ruling honours the spacing', () => {
  const ys = sheetRuleLineYs({ height: 2970, top: 0 }, 2100, -Infinity, Infinity, 10);

  near(ys[0]!, 200);
  near(ys[1]! - ys[0]!, 100);
  assert.ok(ys.length > 20);
});

test('presets per paper', () => {
  assert.deepEqual(spacingPresetsFor('lined').map((preset) => preset.mm), [6, 7.1, 8.7]);
  assert.deepEqual(spacingPresetsFor('grid').map((preset) => preset.mm), [5, 7, 10]);
  assert.deepEqual(spacingPresetsFor('dotted').map((preset) => preset.mm), [5, 7, 10]);
  assert.deepEqual(spacingPresetsFor('blank'), []);
});

test('host defaults: per paper, dotted shares grid, blank and junk get none', () => {
  assert.equal(resolveDefaultPaperSpacingMm({ lined: 7.1, grid: 5 }, 'lined'), 7.1);
  assert.equal(resolveDefaultPaperSpacingMm({ lined: 7.1, grid: 5 }, 'dotted'), 5);
  assert.equal(resolveDefaultPaperSpacingMm({ lined: 7.1 }, 'grid'), undefined);
  assert.equal(resolveDefaultPaperSpacingMm({ lined: 7.1 }, 'blank'), undefined);
  assert.equal(resolveDefaultPaperSpacingMm({ lined: 40 }, 'lined'), undefined);
  assert.equal(resolveDefaultPaperSpacingMm(undefined, 'lined'), undefined);
});
