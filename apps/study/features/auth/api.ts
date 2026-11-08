/**
 * Hosted-accounts API (`/auth`, docs/accounts.md). These calls ALWAYS go to the real server through the
 * axios `api` (bare backend base URL, Bearer from the session cookie) — never through the `/study`
 * transport or the in-browser mock: a mock sign-in would be meaningless. Callers must check
 * `hasAuthServer()` first; with no backend URL the app is in demo mode and there is nobody to sign in to.
 */
import type { StudyAdminUser } from '@/lib/auth';
import type { AuthConfig } from './lib/auth-url';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';

import { isLegacyAuthStatus, LEGACY_AUTH_CONFIG, normalizeAuthConfig } from './lib/auth-url';

import { useBackendSettings } from '@/hooks/useBackendSettings';
import { api, STUDY_USER_KEY, useAuthCookie } from '@/lib/auth';
import { getStudyBackendBaseUrl } from '@/lib/backend-settings';

export type AccountUser = StudyAdminUser & {
  _id: string;
  email?: string;
  role: string;
  isVerified?: boolean;
  providers?: ('password' | 'google' | 'magic')[];
};

export interface SessionResponse {
  token: string;
  user: AccountUser;
}

export function hasAuthServer(): boolean {
  return Boolean(getStudyBackendBaseUrl());
}

function requireServer(): void {
  if (!hasAuthServer()) throw new Error('Sign-in needs a Syllabi server — add one in Settings.');
}

const data = <T>(promise: Promise<{ data: T }>): Promise<T> => promise.then((response) => response.data);

/** `GET /auth/config`; an old server without the module answers 404 → the legacy `/admin/login` form. */
export async function fetchAuthConfig(): Promise<AuthConfig> {
  requireServer();
  try {
    return normalizeAuthConfig(await data(api.get('/auth/config')));
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;

    if (isLegacyAuthStatus(status)) return LEGACY_AUTH_CONFIG;
    throw error;
  }
}

export function loginWithPassword(body: { email: string; password: string }): Promise<SessionResponse> {
  requireServer();

  return data(api.post('/auth/login', body));
}

export function register(body: { name?: string; email: string; password: string }): Promise<SessionResponse> {
  requireServer();

  return data(api.post('/auth/register', body));
}

export function verifyEmail(token: string): Promise<SessionResponse> {
  requireServer();

  return data(api.post('/auth/verify-email', { token }));
}

export function resendVerification(): Promise<{ message: string }> {
  requireServer();

  return data(api.post('/auth/resend-verification'));
}

export function requestMagicLink(email: string, redirect?: string): Promise<{ message: string }> {
  requireServer();

  return data(api.post('/auth/magic-link', redirect ? { email, redirect } : { email }));
}

export function consumeMagicLink(token: string): Promise<SessionResponse> {
  requireServer();

  return data(api.post('/auth/magic-link/consume', { token }));
}

export function forgotPassword(email: string): Promise<{ message: string }> {
  requireServer();

  return data(api.post('/auth/forgot-password', { email }));
}

export function resetPassword(token: string, password: string): Promise<SessionResponse> {
  requireServer();

  return data(api.post('/auth/reset-password', { token, password }));
}

/** `GET /auth/me`; pass `token` when it is not stored yet (the Google callback). */
export async function fetchMe(token?: string): Promise<{ user: AccountUser }> {
  requireServer();
  if (!token) return data(api.get('/auth/me'));
  // Plain fetch: the axios interceptor would replace this header with an older session's cookie.
  const res = await fetch(`${getStudyBackendBaseUrl()}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as { user?: AccountUser; message?: string };

  if (!res.ok || !body.user) {
    throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { response: { status: res.status, data: body } });
  }

  return { user: body.user };
}

export function changePassword(body: { currentPassword?: string; newPassword: string }): Promise<{ message: string }> {
  requireServer();

  return data(api.post('/auth/me/password', body));
}

export function deleteAccount(password?: string): Promise<unknown> {
  requireServer();

  return data(api.delete('/auth/me', { data: password ? { password } : {} }));
}

export const authKeys = {
  config: (server: string) => ['auth', 'config', server] as const,
  me: (server: string) => ['auth', 'me', server] as const,
};

/** Which sign-in options this server offers. Disabled in demo mode (no server). */
export function useAuthConfig() {
  const { backendUrl } = useBackendSettings();

  return useQuery({
    queryKey: authKeys.config(backendUrl),
    queryFn: fetchAuthConfig,
    enabled: Boolean(backendUrl),
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
      try {
        localStorage.setItem(STUDY_USER_KEY, JSON.stringify(session.user));
      } catch {
        // private mode: the cookie still carries the session
      }
      setAuthToken(session.token);
      api.defaults.headers.common['Authorization'] = `Bearer ${session.token}`;
      // A different account may have signed in: nothing cached belongs to it.
      queryClient.clear();
      if (options.navigate !== false) await router.replace('/');
    },
    [queryClient, router, setAuthToken],
  );
}
