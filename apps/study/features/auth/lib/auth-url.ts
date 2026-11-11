/**
 * Pure helpers for the hosted-accounts flows (docs/accounts.md): reading tokens off email-link and
 * OAuth-callback URLs, normalising `GET /auth/config`, building redirects, and turning server errors into
 * one English line. No window / React / axios here so node:test can load it directly.
 */

/** The project's hosted server, used when a build doesn't name another one. */
export const SYLLABI_HOSTED_SERVER = 'https://api.syllabi.studio';

/** `raw` (an env value) trimmed without trailing slashes, or the hosted server when empty/unset. */
export function pickOfficialServer(raw: string | undefined | null): string {
  return (raw ?? '').trim().replace(/\/+$/, '') || SYLLABI_HOSTED_SERVER;
}

/**
 * The official server: what /login signs in to (and creates accounts on) when the device runs in demo mode
 * with no server configured. Override at build time with `NEXT_PUBLIC_DEFAULT_API`.
 */
export const OFFICIAL_SERVER = pickOfficialServer(process.env.NEXT_PUBLIC_DEFAULT_API);

/** Where auth calls go: the configured backend, or the official server in demo mode. */
export function resolveAuthServer(backendUrl: string, official: string = OFFICIAL_SERVER): string {
  return backendUrl.trim().replace(/\/+$/, '') || official;
}

/**
 * What a successful sign-in must change on this device. In demo mode (no backend) the account lives on the
 * official server, so the device switches to it (saved like Settings → API base URL) and a forced mock is
 * lifted so the app shows live data. A device that already has a server keeps its settings.
 */
export function signInSwitch(
  current: { backendUrl: string; storedMock: string | null },
  authServer: string,
): { saveUrl: string | null; clearForcedMock: boolean } {
  if (current.backendUrl.trim()) return { saveUrl: null, clearForcedMock: false };

  return { saveUrl: authServer, clearForcedMock: current.storedMock === '1' };
}

/** Custom-scheme link the APK registers (tauri.conf.json → plugins.deep-link): Google sends the app back here. */
export const APK_AUTH_DEEP_LINK = 'studio.syllabi.app://auth';

/** Host whose emailed links open the APK (verified App Links; public/.well-known/assetlinks.json). */
export const APP_LINK_HOST = 'app.syllabi.studio';

const EMAIL_LINK_KINDS = new Set(['magic', 'verify', 'reset']);

/** `magic`, `verify`, `reset` (or `callback` when allowed) from `auth/<kind>[/]`; null otherwise. */
function authKind(path: string, allowCallback: boolean): string | null {
  const match = /^\/?auth\/([a-z]+)\/?$/.exec(path);
  const kind = match?.[1] ?? '';

  return EMAIL_LINK_KINDS.has(kind) || (allowCallback && kind === 'callback') ? kind : null;
}

/**
 * Where a link that opened the APK should go inside the app, or null to ignore it:
 * - `https://app.syllabi.studio/auth/magic/?token=X` → `/auth/magic/?token=X` (same for verify / reset);
 * - `studio.syllabi.app://auth#token=…` (Google's return) → `/auth/callback/#token=…`;
 * - `studio.syllabi.app://auth/magic?token=X` → `/auth/magic/?token=X`;
 * - `https://app.syllabi.studio/shared/?id=X` (a share link) → `/shared/?id=X`.
 * The custom scheme is split by hand: older Android WebViews parse `scheme://host` URLs of unknown
 * schemes with an empty host, so `new URL().host` can't be trusted there.
 */
export function deepLinkToAppPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const link = raw.trim();
  const scheme = `${APK_AUTH_DEEP_LINK.split('://')[0]}://`;

  if (link.toLowerCase().startsWith(scheme)) {
    const rest = link.slice(scheme.length);
    const hashAt = rest.indexOf('#');
    const beforeHash = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
    const hash = hashAt >= 0 ? rest.slice(hashAt) : '';
    const queryAt = beforeHash.indexOf('?');
    const path = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
    const query = queryAt >= 0 ? beforeHash.slice(queryAt) : '';
    const [host, ...segments] = path.split('/');

    if (host.toLowerCase() !== 'auth') return null;
    const sub = segments.filter(Boolean);

    if (sub.length === 0) return `/auth/callback/${query}${hash}`;
    const kind = authKind(`auth/${sub.join('/')}`, true);

    return kind ? `/auth/${kind}/${query}${hash}` : null;
  }

  let url: URL;

  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== APP_LINK_HOST) return null;
  if (/^\/shared\/?$/.test(url.pathname)) return `/shared/${url.search}`;
  const kind = authKind(url.pathname, false);

  return kind ? `/auth/${kind}/${url.search}${url.hash}` : null;
}

export interface AuthConfig {
  registration: 'open' | 'closed';
  google: boolean;
  magicLink: boolean;
  emailVerification: boolean;
  /** True when the server has no `/auth` module (an old build): only `/admin/login` works. */
  legacy: boolean;
}

/** What an old server (404 on `/auth/config`) supports: the password form against `/admin/login`. */
export const LEGACY_AUTH_CONFIG: AuthConfig = Object.freeze({
  registration: 'closed',
  google: false,
  magicLink: false,
  emailVerification: false,
  legacy: true,
}) as AuthConfig;

/** Coerce whatever `/auth/config` returned into a full config (unknown/missing fields = off). */
export function normalizeAuthConfig(raw: unknown): AuthConfig {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  return {
    registration: body.registration === 'open' ? 'open' : 'closed',
    google: body.google === true,
    magicLink: body.magicLink === true,
    emailVerification: body.emailVerification === true,
    legacy: false,
  };
}

/** Whether a failed `/auth/config` means «old server» (fall back) rather than «server down» (show error). */
export function isLegacyAuthStatus(status: number | undefined): boolean {
  return status === 404 || status === 405 || status === 501;
}

function cleanToken(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();

  return value ? value : null;
}

/** `?token=` from a location.search string (with or without the leading `?`). */
export function readTokenFromSearch(search: string): string | null {
  return cleanToken(new URLSearchParams(search.replace(/^\?/, '')).get('token'));
}

/** `#token=` from a location.hash string (with or without the leading `#`); also reads `#error=`. */
export function readTokenFromHash(hash: string): string | null {
  return cleanToken(new URLSearchParams(hash.replace(/^#/, '')).get('token'));
}

/** `#error=` / `?error=` the server may append when the Google flow fails. */
export function readAuthError(search: string, hash: string): string | null {
  return (
    cleanToken(new URLSearchParams(hash.replace(/^#/, '')).get('error')) ??
    cleanToken(new URLSearchParams(search.replace(/^\?/, '')).get('error'))
  );
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Where the server sends the browser after Google: `<origin>/auth/callback/`. */
export function buildCallbackUrl(appOrigin: string): string {
  return `${trimSlash(appOrigin)}/auth/callback/`;
}

/** `${server}/auth/google/start?redirect=<redirect>` — the browser navigates here. */
export function buildGoogleStartUrl(server: string, redirect: string): string {
  return `${trimSlash(server)}/auth/google/start?redirect=${encodeURIComponent(redirect)}`;
}

/** `/login?tab=create` → 'create'; anything else → 'signin'. */
export function parseLoginTab(raw: unknown): 'signin' | 'create' {
  const value = Array.isArray(raw) ? raw[0] : raw;

  return value === 'create' ? 'create' : 'signin';
}

export const RATE_LIMIT_MESSAGE = 'Too many tries — wait a minute, then try again.';

interface ErrorLike {
  code?: string;
  message?: string;
  response?: { status?: number; data?: { message?: unknown; code?: unknown } };
}

/** The server's `message` (string, or the first of a class-validator array). */
function serverMessage(error: ErrorLike): string | undefined {
  const raw = error?.response?.data?.message;
  const text = Array.isArray(raw) ? raw.find((part) => typeof part === 'string') : raw;

  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

/** One line for any auth-call failure (axios-shaped errors). `fallback` covers a bare 400/401. */
export function describeAuthError(error: unknown, fallback = 'Something went wrong — try again.'): string {
  const axiosLike = (error ?? {}) as ErrorLike;
  const status = axiosLike.response?.status;
  const message = serverMessage(axiosLike);

  if (status === 429) return RATE_LIMIT_MESSAGE;
  if (status === 400 || status === 401 || status === 403 || status === 409 || status === 410) {
    return message || fallback;
  }
  if (typeof status === 'number') return `${message || 'The server refused the request.'} (${status})`;
  if (typeof axiosLike.message === 'string' && /network/i.test(axiosLike.message)) {
    return 'Can’t reach the server — check your internet and try again.';
  }

  return axiosLike.message || fallback;
}

/** Light client-side check before a round trip; the server stays the authority. */
export function validateCredentials(email: string, password: string, minPassword = 8): string | null {
  if (!email.trim() || !password) return 'Enter your email and password.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'That email doesn’t look right.';
  if (password.length < minPassword) return `Use at least ${minPassword} characters for the password.`;

  return null;
}
