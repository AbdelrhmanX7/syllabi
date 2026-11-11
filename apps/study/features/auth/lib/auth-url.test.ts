import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  APK_AUTH_DEEP_LINK,
  buildCallbackUrl,
  deepLinkToAppPath,
  OFFICIAL_SERVER,
  pickOfficialServer,
  resolveAuthServer,
  signInSwitch,
  SYLLABI_HOSTED_SERVER,
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

test('official server: hosted default, overridable by NEXT_PUBLIC_DEFAULT_API, trailing slash trimmed', () => {
  assert.equal(SYLLABI_HOSTED_SERVER, 'https://api.syllabi.studio');
  assert.equal(pickOfficialServer(undefined), SYLLABI_HOSTED_SERVER);
  assert.equal(pickOfficialServer('   '), SYLLABI_HOSTED_SERVER);
  assert.equal(pickOfficialServer('https://study.example.org/'), 'https://study.example.org');
  assert.equal(OFFICIAL_SERVER, pickOfficialServer(process.env.NEXT_PUBLIC_DEFAULT_API));
});

test('auth server: the configured backend wins, demo mode falls back to the official server', () => {
  assert.equal(resolveAuthServer('https://mine.example.com/', 'https://official.test'), 'https://mine.example.com');
  assert.equal(resolveAuthServer('', 'https://official.test'), 'https://official.test');
  assert.equal(resolveAuthServer('  '), OFFICIAL_SERVER);
});

test('sign-in switch: demo mode adopts the auth server and lifts a forced mock; a configured device is left alone', () => {
  assert.deepEqual(signInSwitch({ backendUrl: '', storedMock: '1' }, 'https://official.test'), {
    saveUrl: 'https://official.test',
    clearForcedMock: true,
  });
  assert.deepEqual(signInSwitch({ backendUrl: '', storedMock: null }, 'https://official.test'), {
    saveUrl: 'https://official.test',
    clearForcedMock: false,
  });
  assert.deepEqual(signInSwitch({ backendUrl: 'https://mine.example.com', storedMock: '1' }, 'https://mine.example.com'), {
    saveUrl: null,
    clearForcedMock: false,
  });
});

test('deepLinkToAppPath: emailed https links go to the matching in-app page, token kept', () => {
  assert.equal(deepLinkToAppPath('https://app.syllabi.studio/auth/magic/?token=abc'), '/auth/magic/?token=abc');
  assert.equal(deepLinkToAppPath('https://app.syllabi.studio/auth/verify?token=a.b-c'), '/auth/verify/?token=a.b-c');
  assert.equal(deepLinkToAppPath('https://APP.syllabi.studio/auth/reset/?token=x'), '/auth/reset/?token=x');
});

test('deepLinkToAppPath: a share link opens the shared page in the app', () => {
  const token = 'abcDEF0123456789_-abcDEF0123456789_-abcDEF0';

  assert.equal(deepLinkToAppPath(`https://app.syllabi.studio/shared/?id=${token}`), `/shared/?id=${token}`);
  assert.equal(deepLinkToAppPath(`https://app.syllabi.studio/shared?id=${token}`), `/shared/?id=${token}`);
  assert.equal(deepLinkToAppPath('https://evil.example.com/shared/?id=x'), null);
  assert.equal(deepLinkToAppPath('https://app.syllabi.studio/shared/extra?id=x'), null);
});

test('deepLinkToAppPath: the Google return (custom scheme) goes to the callback page with its fragment', () => {
  assert.equal(deepLinkToAppPath(`${APK_AUTH_DEEP_LINK}#token=h.p.s`), '/auth/callback/#token=h.p.s');
  assert.equal(deepLinkToAppPath('studio.syllabi.app://auth/#error=access_denied'), '/auth/callback/#error=access_denied');
  assert.equal(deepLinkToAppPath('studio.syllabi.app://auth?error=google_error'), '/auth/callback/?error=google_error');
  assert.equal(deepLinkToAppPath('studio.syllabi.app://auth/magic?token=t1'), '/auth/magic/?token=t1');
});

test('deepLinkToAppPath: anything else is ignored', () => {
  for (const link of [
    'http://app.syllabi.studio/auth/magic/?token=abc',
    'https://evil.example.com/auth/magic/?token=abc',
    'https://app.syllabi.studio.evil.com/auth/magic/?token=abc',
    'https://app.syllabi.studio/auth/callback/#token=abc',
    'https://app.syllabi.studio/auth/magic/extra?token=abc',
    'https://app.syllabi.studio/today/',
    'studio.syllabi.app://other#token=abc',
    'studio.syllabi.app://auth/unknown?token=abc',
    'not a url',
    '',
    null,
    42,
  ]) {
    assert.equal(deepLinkToAppPath(link), null, String(link));
  }
});
