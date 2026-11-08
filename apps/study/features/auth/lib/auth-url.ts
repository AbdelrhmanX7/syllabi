/**
 * Pure helpers for the hosted-accounts flows (docs/accounts.md): reading tokens off email-link and
 * OAuth-callback URLs, normalising `GET /auth/config`, building redirects, and turning server errors into
 * one English line. No window / React / axios here so node:test can load it directly.
 */

/**
 * The server the app offers to switch to when it runs in demo mode (no backend configured). Empty until the
 * project's hosted server exists; set `NEXT_PUBLIC_DEFAULT_API` at build time to enable the offer.
 */
export const DEFAULT_SERVER_URL = process.env.NEXT_PUBLIC_DEFAULT_API ?? '';

/** Custom-scheme deep link the APK registers for Google sign-in (Tauri deep-link plugin, not installed yet). */
export const APK_AUTH_DEEP_LINK = 'studio.syllabi.app://auth';

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
