import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aiEnabledFrom } from './access';

const base = { demo: false, signedIn: true };

test('demo mode and signed out always show AI', () => {
  assert.equal(aiEnabledFrom({ ...base, demo: true, account: { role: 'user', premium: false } }), true);
  assert.equal(aiEnabledFrom({ ...base, signedIn: false, account: { role: 'user', premium: false } }), true);
});

test('hidden only when the server says premium: false', () => {
  assert.equal(aiEnabledFrom({ ...base, account: { role: 'user', premium: false } }), false);
  assert.equal(aiEnabledFrom({ ...base, account: { role: 'user', premium: true } }), true);
  // Older server: no flag, or no /auth at all.
  assert.equal(aiEnabledFrom({ ...base, account: { role: 'user' } }), true);
  assert.equal(aiEnabledFrom({ ...base, account: null }), true);
});

test('the owner (either role name) always has AI', () => {
  assert.equal(aiEnabledFrom({ ...base, account: { role: 'owner', premium: false } }), true);
  assert.equal(aiEnabledFrom({ ...base, account: { role: 'admin', premium: false } }), true);
});

test('while loading, the user saved at sign-in decides', () => {
  assert.equal(aiEnabledFrom({ ...base, account: undefined, stored: { role: 'user', premium: false } }), false);
  assert.equal(aiEnabledFrom({ ...base, account: undefined, stored: { role: 'user', premium: true } }), true);
  assert.equal(aiEnabledFrom({ ...base, account: undefined, stored: null }), true);
  // The live answer wins over the saved one.
  assert.equal(aiEnabledFrom({ ...base, account: { role: 'user', premium: true }, stored: { role: 'user', premium: false } }), true);
});
