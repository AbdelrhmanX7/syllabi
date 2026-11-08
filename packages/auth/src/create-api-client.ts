import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { deleteCookie, getCookie } from 'cookies-next';

import type { AuthConfig } from './types';

/**
 * Returns true when the stored JWT is missing, malformed, or past its expiry.
 * Uses a manual base64 parse to avoid a hard dependency on jwt-decode inside
 * the shared auth package.
 */
function isTokenMissingOrExpired(cookieKey: string): boolean {
  const token = getCookie(cookieKey);

  if (!token) return true;

  try {
    const parts = (token as string).split('.');

    if (parts.length !== 3) return true;

    const payload = JSON.parse(atob(parts[1]));

    return typeof payload.exp === 'number' && payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

export function createApiClient(config: AuthConfig): AxiosInstance {
  const api = axios.create({
    baseURL: process.env.NEXT_PUBLIC_API,
  });

  api.interceptors.request.use((reqConfig) => {
    // Allow apps to re-point the backend at runtime (e.g. a cloud-sync switch) without a
    // rebuild. Only overrides when a non-empty URL is resolved; otherwise keeps the
    // build-time baseURL captured above.
    if (config.apiBaseUrl) {
      const resolvedBaseUrl = config.apiBaseUrl();

      if (resolvedBaseUrl) {
        reqConfig.baseURL = resolvedBaseUrl;
      }
    }

    const token = getCookie(config.cookieKey);

    if (token) {
      reqConfig.headers.Authorization = `Bearer ${token}`;
    }

    return reqConfig;
  });

  api.interceptors.response.use(
    (response) => response,
    (error) => {
      // First-party analytics: emit an `api_error` via an optional global hook.
      // The hook is installed by apps that wire `@repo/analytics` (e.g. web);
      // when absent (e.g. teacher) this is a no-op. Never throws into the app.
      try {
        if (typeof window !== 'undefined') {
          const trackApiError = (
            window as unknown as {
              __kaTrackApiError?: (err: unknown) => void;
            }
          ).__kaTrackApiError;

          trackApiError?.(error);
        }
      } catch {
        // analytics must never break the auth flow
      }

      if (error.response?.status === 401) {
        // Only clear the session and redirect when the token is genuinely
        // missing or expired.  If the token is still valid, the 401 is a
        // backend permission issue (not an auth issue) and should not force
        // the user back to the login page.
        if (isTokenMissingOrExpired(config.cookieKey)) {
          /*
           * Was there a session at all? Read BEFORE the cookie is deleted below,
           * because the two cases this branch lumps together want opposite
           * endings: an EXPIRED token means someone was signed in and has to
           * sign in again, so /login is where they belong. A token that was
           * never there means a GUEST — nobody to sign back in, nothing to
           * restore — and bouncing them is only ever a way to lose a visitor.
           */
          const hadSession = Boolean(getCookie(config.cookieKey));

          deleteCookie(config.cookieKey);

          // Also clear localStorage so useAuthInit doesn't resurrect the stale token.
          if (typeof window !== 'undefined') {
            try {
              localStorage.removeItem(config.tokenStorageKey);
              localStorage.removeItem(config.userStorageKey);
            } catch {
              // storage access may fail in private mode
            }

            /*
             * A guest on a page the app publishes to strangers stays put. Apps
             * opt in by declaring `publicPathname` — omit it and this is the
             * unchanged always-redirect behaviour, which is right for the
             * admin/teacher consoles where every page is behind auth.
             *
             * The predicate is handed `window.location.pathname` — a RESOLVED
             * path (`/exam/t/AbC123/`), not a Next route pattern
             * (`/exam/t/[token]`). An interceptor has no router to ask.
             */
            const guestOnPublicPage = !hadSession && config.publicPathname?.(window.location.pathname) === true;

            // An offline-first app (loginIsOptional) never gets navigated away from what it was
            // showing: the session is cleared above, and its own UI takes it from there.
            if (!config.loginIsOptional && !window.location.pathname.startsWith('/login') && !guestOnPublicPage) {
              window.location.href = '/login';
            }
          }
        }
      }

      return Promise.reject(error);
    },
  );

  return api;
}
