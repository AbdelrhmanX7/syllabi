/**
 * Hosted-accounts API (`/auth`, docs/accounts.md). These calls ALWAYS go to the real server through the
 * axios `api` (bare backend base URL, Bearer from the session cookie) — never through the `/study`
 * transport or the in-browser mock: a mock sign-in would be meaningless. In demo mode (no backend URL) they
 * go to the official server (`OFFICIAL_SERVER`), and a successful sign-in switches the device to it.
 */
import type { StudyAdminUser } from '@/lib/auth';
import type { AuthConfig } from './lib/auth-url';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';

import { isLegacyAuthStatus, LEGACY_AUTH_CONFIG, normalizeAuthConfig, resolveAuthServer, signInSwitch } from './lib/auth-url';

import { useBackendSettings } from '@/hooks/useBackendSettings';
import { api, STUDY_USER_KEY, useAuthCookie } from '@/lib/auth';
import { getStoredMockMode, getStudyBackendBaseUrl, saveBackendUrlOverride, saveMockMode } from '@/lib/backend-settings';

export type AccountUser = StudyAdminUser & {
  _id: string;
  email?: string;
  role: string;
  isVerified?: boolean;
  premium?: boolean;
  providers?: ('password' | 'google' | 'magic')[];
};

export interface SessionResponse {
  token: string;
  user: AccountUser;
}

/** The server auth calls go to: the configured backend, else the official one (demo mode). */
export function authServer(): string {
  return resolveAuthServer(getStudyBackendBaseUrl());
}

export function hasAuthServer(): boolean {
  return Boolean(authServer());
}

function requireServer(): void {
  if (!hasAuthServer()) throw new Error('Sign-in isn’t available in this version of the app.');
}

const data = <T>(promise: Promise<{ data: T }>): Promise<T> => promise.then((response) => response.data);
/** Explicit base URL: in demo mode the axios interceptor has no backend to point at. */
const at = () => ({ baseURL: authServer() });

/** `GET /auth/config`; an old server without the module answers 404 → the legacy `/admin/login` form. */
export async function fetchAuthConfig(): Promise<AuthConfig> {
  requireServer();
  try {
    return normalizeAuthConfig(await data(api.get('/auth/config', at())));
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;

    if (isLegacyAuthStatus(status)) return LEGACY_AUTH_CONFIG;
    throw error;
  }
}

export function loginWithPassword(body: { email: string; password: string }): Promise<SessionResponse> {
  requireServer();

  return data(api.post('/auth/login', body, at()));
}

export function register(body: { name?: string; email: string; password: string }): Promise<SessionResponse> {
  requireServer();

  return data(api.post('/auth/register', body, at()));
}

export function verifyEmail(token: string): Promise<SessionResponse> {
  requireServer();

  return data(api.post('/auth/verify-email', { token }, at()));
}

export function resendVerification(): Promise<{ message: string }> {
  requireServer();

  return data(api.post('/auth/resend-verification', undefined, at()));
}

export function requestMagicLink(email: string, redirect?: string): Promise<{ message: string }> {
  requireServer();

  return data(api.post('/auth/magic-link', redirect ? { email, redirect } : { email }, at()));
}

export function consumeMagicLink(token: string): Promise<SessionResponse> {
  requireServer();

  return data(api.post('/auth/magic-link/consume', { token }, at()));
}

export function forgotPassword(email: string): Promise<{ message: string }> {
  requireServer();

  return data(api.post('/auth/forgot-password', { email }, at()));
}

export function resetPassword(token: string, password: string): Promise<SessionResponse> {
  requireServer();

  return data(api.post('/auth/reset-password', { token, password }, at()));
}

/** `GET /auth/me`; pass `token` when it is not stored yet (the Google callback). */
export async function fetchMe(token?: string): Promise<{ user: AccountUser }> {
  requireServer();
  if (!token) return data(api.get('/auth/me', at()));
  // Plain fetch: the axios interceptor would replace this header with an older session's cookie.
  const res = await fetch(`${authServer()}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as { user?: AccountUser; message?: string };

  if (!res.ok || !body.user) {
    throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { response: { status: res.status, data: body } });
  }

  return { user: body.user };
}

export function changePassword(body: { currentPassword?: string; newPassword: string }): Promise<{ message: string }> {
  requireServer();

  return data(api.post('/auth/me/password', body, at()));
}

export function deleteAccount(password?: string): Promise<unknown> {
  requireServer();

  return data(api.delete('/auth/me', { ...at(), data: password ? { password } : {} }));
}

export const authKeys = {
  config: (server: string) => ['auth', 'config', server] as const,
  me: (server: string) => ['auth', 'me', server] as const,
};

/** Which sign-in options the auth server offers (the official server in demo mode). */
export function useAuthConfig() {
  const { backendUrl } = useBackendSettings();
  const server = resolveAuthServer(backendUrl);

  return useQuery({
    queryKey: authKeys.config(server),
    queryFn: fetchAuthConfig,
    enabled: Boolean(server),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** `GET /auth/me`; `null` when the server predates `/auth` (404) so Settings shows the basic row. */
export function useAccount(enabled: boolean) {
  const { backendUrl } = useBackendSettings();

  return useQuery({
    queryKey: authKeys.me(backendUrl),
    queryFn: async (): Promise<AccountUser | null> => {
      try {
        return (await fetchMe()).user;
      } catch (error) {
        if (isLegacyAuthStatus((error as { response?: { status?: number } })?.response?.status)) return null;
        throw error;
      }
    },
    enabled: enabled && Boolean(backendUrl),
    // Read by every AI button (useAiEnabled); Settings refetches it after its own changes.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Store a session from any flow (login, register, verify, magic, reset, Google) and optionally go to Today. */
export function useStoreSession() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setAuthToken } = useAuthCookie();

  return useCallback(
    async (session: SessionResponse, options: { navigate?: boolean } = {}) => {
      // Demo mode: the account lives on the official server, so this device now uses it (live data).
      const change = signInSwitch({ backendUrl: getStudyBackendBaseUrl(), storedMock: getStoredMockMode() }, authServer());

      if (change.clearForcedMock) saveMockMode('auto');
      if (change.saveUrl) saveBackendUrlOverride(change.saveUrl);
      try {
        localStorage.setItem(STUDY_USER_KEY, JSON.stringify(session.user));
      } catch {
        // private mode: the cookie still carries the session
      }
      setAuthToken(session.token);
      api.defaults.headers.common['Authorization'] = `Bearer ${session.token}`;
      // A different account may have signed in: nothing cached belongs to it.
      queryClient.clear();
      if (options.navigate !== false) await router.replace(safeNextPath(router.query.next));
    },
    [queryClient, router, setAuthToken],
  );
}

/** `/login/?next=/shared/?id=…`: where to land after signing in. Same-app paths only (no `//host`). */
export function safeNextPath(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}
