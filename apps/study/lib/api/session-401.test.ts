import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSessionDead } from './session-401';

const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
const live = jwt({ _id: 'a', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 });
const old = jwt({ _id: 'a', role: 'admin', exp: Math.floor(Date.now() / 1000) - 10 });

test('a server hiccup on a good token keeps the session', () => {
  assert.equal(isSessionDead(live, 'Operation `admins.findOne()` buffering timed out after 10000ms'), false);
  assert.equal(isSessionDead(live, ''), false);
});

test('a dead token or account signs out', () => {
  assert.equal(isSessionDead(old, 'anything'), true);
  assert.equal(isSessionDead(null, ''), true);
  assert.equal(isSessionDead(live, 'invalid signature'), true);
  assert.equal(isSessionDead(live, 'Account disabled'), true);
  assert.equal(isSessionDead(live, 'حساب غير موجود'), true);
});
