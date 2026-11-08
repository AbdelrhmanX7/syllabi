import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCallbackUrl,
  buildGoogleStartUrl,
  describeAuthError,
  isLegacyAuthStatus,
  LEGACY_AUTH_CONFIG,
  normalizeAuthConfig,
  parseLoginTab,
  RATE_LIMIT_MESSAGE,
  readAuthError,
  readTokenFromHash,
  readTokenFromSearch,
  validateCredentials,
} from './auth-url';

test('readTokenFromSearch reads ?token= with or without the ?', () => {
  assert.equal(readTokenFromSearch('?token=abc'), 'abc');
  assert.equal(readTokenFromSearch('token=abc&x=1'), 'abc');
  assert.equal(readTokenFromSearch('?token=a%2Bb'), 'a+b');
  assert.equal(readTokenFromSearch(''), null);
  assert.equal(readTokenFromSearch('?token='), null);
});

test('readTokenFromHash reads #token= (a JWT keeps its dots)', () => {
  assert.equal(readTokenFromHash('#token=aa.bb.cc'), 'aa.bb.cc');
  assert.equal(readTokenFromHash('token=x'), 'x');
  assert.equal(readTokenFromHash('#'), null);
  assert.equal(readTokenFromHash(''), null);
});

test('readAuthError prefers the fragment, then the query', () => {
  assert.equal(readAuthError('?error=q', '#error=h'), 'h');
  assert.equal(readAuthError('?error=q', ''), 'q');
  assert.equal(readAuthError('', ''), null);
});

test('buildGoogleStartUrl encodes the redirect and trims the server slash', () => {
  const redirect = buildCallbackUrl('https://app.syllabi.studio/');

  assert.equal(redirect, 'https://app.syllabi.studio/auth/callback/');
  assert.equal(
    buildGoogleStartUrl('https://api.example.com//', redirect),
    'https://api.example.com/auth/google/start?redirect=https%3A%2F%2Fapp.syllabi.studio%2Fauth%2Fcallback%2F',
  );
  assert.equal(
    buildGoogleStartUrl('https://api.example.com', 'studio.syllabi.app://auth'),
    'https://api.example.com/auth/google/start?redirect=studio.syllabi.app%3A%2F%2Fauth',
  );
});

test('normalizeAuthConfig fills missing fields as off; legacy statuses fall back', () => {
  assert.deepEqual(normalizeAuthConfig({ registration: 'open', google: true, magicLink: true }), {
    registration: 'open',
    google: true,
    magicLink: true,
    emailVerification: false,
    legacy: false,
  });
  assert.equal(normalizeAuthConfig(null).registration, 'closed');
  assert.equal(normalizeAuthConfig({ google: 'yes' }).google, false);
  assert.equal(LEGACY_AUTH_CONFIG.legacy, true);
  assert.equal(isLegacyAuthStatus(404), true);
  assert.equal(isLegacyAuthStatus(500), false);
  assert.equal(isLegacyAuthStatus(undefined), false);
});

test('parseLoginTab', () => {
  assert.equal(parseLoginTab('create'), 'create');
  assert.equal(parseLoginTab(['create']), 'create');
  assert.equal(parseLoginTab('x'), 'signin');
  assert.equal(parseLoginTab(undefined), 'signin');
});

test('describeAuthError: 400 message, array message, 429, other status, network', () => {
  const res = (status: number, message?: unknown) => ({ response: { status, data: { message } } });

  assert.equal(describeAuthError(res(400, 'Wrong email or password')), 'Wrong email or password');
  assert.equal(describeAuthError(res(400, ['email must be an email'])), 'email must be an email');
  assert.equal(describeAuthError(res(401), 'Nope'), 'Nope');
  assert.equal(describeAuthError(res(429, 'slow down')), RATE_LIMIT_MESSAGE);
  assert.equal(describeAuthError(res(500, 'boom')), 'boom (500)');
  assert.match(describeAuthError({ message: 'Network Error' }), /reach the server/);
});

test('validateCredentials', () => {
  assert.equal(validateCredentials('', 'x'), 'Enter your email and password.');
  assert.match(validateCredentials('nope', 'longenough') ?? '', /email/);
  assert.match(validateCredentials('a@b.co', 'short') ?? '', /8 characters/);
  assert.equal(validateCredentials('a@b.co', 'longenough'), null);
  assert.equal(validateCredentials('a@b.co', 'x', 1), null);
});
