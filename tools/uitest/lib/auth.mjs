/**
 * Per-app auth seeding.
 *
 * Each app carries its OWN cookie name and localStorage keys, so seeding is a
 * registry, not one shared helper. The token is never verified in the browser —
 * the API is mocked — but it must survive whatever the client-side guard does
 * to it before the page renders.
 */

const base64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

const base64url = (obj) => base64(obj).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * A JWT the client-side guards accept.
 *
 * FOOTGUN: `isTokenExpired` in `@repo/auth` decodes the payload with `atob()`,
 * which is STRICT base64 — it throws on base64url's `-` and `_`. A token that
 * happens to encode with either character makes the guard treat the session as
 * broken and bounce to /login, and the failure looks like "the page redirected"
 * rather than "the token was malformed". So: nudge a nonce until the encoding
 * uses neither character, and keep the length out of the `% 4 === 1` bucket
 * that `atob` also rejects.
 */
export function makeJwt(payload = {}, { ttlSeconds = 60 * 60 * 24 * 30 } = {}) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const header = base64url({ alg: 'HS256', typ: 'JWT' });

  for (let n = 0; n < 5000; n++) {
    const body = base64url({ iat: exp - ttlSeconds, exp, ...payload, n });

    if (!/[-_]/.test(body) && !/[-_]/.test(header) && body.length % 4 !== 1 && header.length % 4 !== 1) {
      return `${header}.${body}.uitestsignature`;
    }
  }

  throw new Error('could not build an atob-safe token');
}

const OWNER_ID = '65a0000000000000000000a1';

/**
 * `usehooks-ts` (and the app's own storage helpers) JSON.parse what they read,
 * so BOTH the token and the user object are stored as JSON — a bare token
 * string in localStorage throws on parse and reads as "signed out".
 */
export const APP_AUTH = {
  // apps/study (Syllabi): `study_token` cookie + localStorage mirror, `study_user` (lib/auth.ts).
  study: {
    cookie: 'study_token',
    defaults: () => ({
      user: { _id: OWNER_ID, name: 'Test Owner', username: 'Test Owner', email: 'owner@example.com', role: 'admin' },
      token: makeJwt({ _id: OWNER_ID, role: 'admin', username: 'Test Owner' }),
    }),
    seed: ({ token, user }) => ({ study_token: JSON.stringify(token), study_user: JSON.stringify(user) }),
  },
};

/**
 * Seed a signed-in session into a browser context. Call BEFORE `newPage()` —
 * init scripts only run on pages created after they are registered.
 *
 * FOOTGUN: the init script runs on EVERY page load, so it re-writes the session after any full
 * navigation. That is right for ordinary scenarios — a reload should still find you signed in —
 * and it is a FALSE FAILURE for any scenario asserting that the app SIGNED SOMEONE OUT across a
 * hard redirect: the app clears storage, the browser loads `/login`, the init script puts the
 * token straight back, and the app's own `useAuthInit` then restores the cookie from it. The
 * sign-out looks broken while the app did exactly the right thing.
 *
 * Pass `{ once: true }` for those. The seed is then applied to the FIRST page load only,
 * recorded with a sessionStorage sentinel that lives as long as the tab.
 *
 * @returns {Promise<{token:string, user:object}>}
 */
export async function seedAuth(context, appName, overrides = {}) {
  const entry = APP_AUTH[appName];

  if (!entry) throw new Error(`no auth recipe for '${appName}' — add one to tools/uitest/lib/auth.mjs`);

  const defaults = entry.defaults();
  const session = { token: overrides.token ?? defaults.token, user: { ...defaults.user, ...overrides.user } };
  const values = { ...entry.seed(session), ...(overrides.storage ?? {}) };
  const once = !!overrides.once;

  await context.addCookies([
    { name: entry.cookie, value: session.token, domain: 'localhost', path: '/', sameSite: 'Lax' },
  ]);

  await context.addInitScript(
    ({ seeded, seedOnce }) => {
      try {
        if (seedOnce) {
          if (window.sessionStorage.getItem('__uitest_seeded')) return;
          window.sessionStorage.setItem('__uitest_seeded', '1');
        }

        for (const [key, value] of Object.entries(seeded)) window.localStorage.setItem(key, value);
      } catch {
        /* storage disabled — the page's own guard reports it */
      }
    },
    { seeded: values, seedOnce: once },
  );

  return session;
}
