import assert from 'node:assert/strict';
import { test } from 'node:test';

import { opaqueHex } from './windowPaint';

test('opaqueHex reads solid colours and skips see-through ones', () => {
  assert.equal(opaqueHex('rgb(25, 33, 72)'), '#192148');
  assert.equal(opaqueHex('rgba(251, 250, 246, 1)'), '#fbfaf6');
  assert.equal(opaqueHex('rgb(9 13 32 / 100%)'), '#090d20');
  assert.equal(opaqueHex('rgba(0, 0, 0, 0)'), null);
  assert.equal(opaqueHex('rgba(25, 33, 72, 0.5)'), null);
  assert.equal(opaqueHex('transparent'), null);
});
