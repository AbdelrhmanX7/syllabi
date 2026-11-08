import assert from 'node:assert/strict';
import { test } from 'node:test';

import { darkBoardInkColor, inkColorToOklch } from './inkContrast';

const l = (color: string) => inkColorToOklch(color)!.l;

test('dark ink flips to the light side of its hue on a dark board', () => {
  assert.ok(l(darkBoardInkColor('#000000')) > 0.9);
  assert.ok(l(darkBoardInkColor('#1e3a8a')) > 0.7);
  const red = inkColorToOklch(darkBoardInkColor('#991b1b'))!;
  assert.ok(Math.abs(red.h - inkColorToOklch('#991b1b')!.h) < 8);
});

test('light ink, alpha and unparseable colours are kept', () => {
  assert.equal(darkBoardInkColor('#facc15'), '#facc15');
  assert.match(darkBoardInkColor('rgba(0, 0, 0, 0.4)'), /0\.4\)$/);
  assert.equal(darkBoardInkColor('red'), 'red');
});
