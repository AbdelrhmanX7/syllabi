import type { AuthConfig } from '@repo/auth';

import { createApiClient, createAuthCookie, createAuthInit, createGetUserData } from '@repo/auth';

import { getStudyBackendBaseUrl } from './backend-settings';

export interface StudyAdminUser {
  _id?: string;
  name?: string;
  phoneNumber?: string;
  role?: string;
  username?: string;
  email?: string;
  isVerified?: boolean;
  /** AI features on for this account (the owner always). Older servers don't send it. */
  premium?: boolean;
  providers?: ('password' | 'google' | 'magic')[];
  createdAt?: string;
}

/** Storage keys are this app's own so a whiteboard session on the same device never bleeds in. */
export const STUDY_TOKEN_KEY = 'study_token';
export const STUDY_USER_KEY = 'study_user';

const config: AuthConfig<StudyAdminUser> = {
  role: 'admin',
  cookieKey: STUDY_TOKEN_KEY,
  tokenStorageKey: STUDY_TOKEN_KEY,
  userStorageKey: STUDY_USER_KEY,
  defaultUserData: {},
  // Resolved per request so the Settings backend-URL field re-points the API without a rebuild.
  apiBaseUrl: () => getStudyBackendBaseUrl() || undefined,
  // Notes and cached classes stay readable when the JWT dies; the shell shows a sign-in banner
  // instead of yanking the tablet to /login mid-study.
  loginIsOptional: true,
};

export const useAuthCookie = createAuthCookie(config);
export const useGetUserData = createGetUserData<StudyAdminUser>(config, useAuthCookie);
export const api = createApiClient(config);
export const useAuthInit = createAuthInit(config, { useAuthCookie, useGetUserData, apiClient: api });

/** One cookie, read straight off `document.cookie` (no `cookies-next` dependency in this app). */
export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const raw = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];

  if (!raw) {
    return null;
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

interface SessionJwtPayload {
  exp?: number;
  role?: string;
  _id?: string;
}

export function parseJwt(token: string): SessionJwtPayload | null {
  try {
    const parts = token.split('.');

    if (parts.length !== 3) {
      return null;
    }

    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded)) as SessionJwtPayload;

    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Roles a study session may carry: `admin` (older servers), and `owner` / `user` from hosted accounts
 * (docs/accounts.md). The server is the authority on what each may do; this only gates the UI.
 */
export const SESSION_ROLES: readonly string[] = ['admin', 'owner', 'user'];

/** True when a valid, non-expired session token (any account role) is present. */
export function isValidAdminToken(token: string | null | undefined): boolean {
  if (!token) {
    return false;
  }

  const payload = parseJwt(token);

  return Boolean(
    payload && typeof payload.exp === 'number' && payload.exp * 1000 > Date.now() && SESSION_ROLES.includes(payload.role ?? ''),
  );
}

/** The signed-in admin's id (the JWT `_id`), or null — per-user device stores key on it. */
export function readSessionUserId(): string | null {
  const token = readSessionToken();
  const id = token ? parseJwt(token)?._id : null;

  return typeof id === 'string' && id ? id : null;
}

/** The live session token (cookie first, then the localStorage mirror), or null. */
export function readSessionToken(): string | null {
  const fromCookie = readCookie(STUDY_TOKEN_KEY);

  if (fromCookie) {
    return fromCookie;
  }

  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(STUDY_TOKEN_KEY);

    if (!raw) {
      return null;
    }

    // usehooks-ts stores JSON-encoded strings.
    return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  } catch {
    return null;
  }
}

export interface AdminLoginBody {
  /** The sign-in identifier; the server matches it against the account's phone number OR email. */
  phoneNumber?: string;
  email?: string;
  password: string;
}

export interface AdminLoginResponse {
  token: string;
  user: StudyAdminUser & { _id: string; role: string };
}

/** Sign in to the Syllabi server (`POST /admin/login`). */
export async function adminLogin(body: AdminLoginBody): Promise<AdminLoginResponse> {
  return api.post('/admin/login', { ...body, lang: 'en' }).then((response) => response.data);
}
