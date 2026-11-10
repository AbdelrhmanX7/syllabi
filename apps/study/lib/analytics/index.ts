// The app's usage counts (see ./core for the privacy rules). Configured at build time by
// NEXT_PUBLIC_POSTHOG_KEY / NEXT_PUBLIC_POSTHOG_HOST; with no key every call here is a no-op.

import type { AnalyticsClient, AnalyticsProps } from './core';

import pkg from '../../package.json';

import { createAnalytics, screenClass } from './core';

import { getMockMode, getStudyBackendBaseUrl } from '@/lib/backend-settings';
import { isTauriAndroid } from '@/lib/platform/runtime';

export { errorReason, megabyteBucket, pageBucket } from './core';
export type { AnalyticsProps } from './core';

// Literal `process.env.NEXT_PUBLIC_*` reads: Next inlines them into the bundle at build time.
const KEY = (process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '').trim();
const HOST = (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? '').trim() || 'https://us.i.posthog.com';
const LAST_VERSION_KEY = 'study_last_version';

function superProps(): AnalyticsProps {
  if (typeof window === 'undefined') return {};

  return {
    app_version: pkg.version,
    platform: isTauriAndroid() ? 'android' : 'web',
    screen_class: screenClass(window.innerWidth),
    backend_mode: getStudyBackendBaseUrl() && getMockMode() !== 'mock' ? 'server' : 'demo',
  };
}

const analytics = createAnalytics({
  key: KEY,
  host: HOST,
  // Lazy: the client is only downloaded after the first screen, and never without a key.
  load: () => import('posthog-js').then((mod) => mod.default as unknown as AnalyticsClient),
  storage: () => (typeof window === 'undefined' ? null : window.localStorage),
  superProps,
});

/** Whether this build has a project key (the Settings switch only shows then). */
export const analyticsConfigured = analytics.enabled;

export const track = (event: string, props?: AnalyticsProps): void => analytics.track(event, props);
export const identify = (userId: string | null | undefined): void => analytics.identify(userId);
export const reset = (): void => analytics.reset();
export const trackPageview = (route: string): void => analytics.pageview(route);
export const usageSharingOn = (): boolean => analytics.sharing();
export const setUsageSharing = (on: boolean): void => analytics.setSharing(on);

const currentRoute = () => (typeof window === 'undefined' ? '' : window.location.pathname);

export function captureError(error: unknown, context: AnalyticsProps = {}): void {
  analytics.captureError(error, { route: currentRoute(), ...context });
}

let installed = false;

/**
 * Call once on the client. Hooks uncaught errors right away (they queue), sends `app_opened` (and
 * `app_updated` when the version changed since the last launch), and loads the client after
 * `delayMs` so it never competes with the first screen.
 */
export function installAnalytics(options: { userId?: string | null; delayMs?: number } = {}): () => void {
  if (!analytics.enabled || installed || typeof window === 'undefined') return () => undefined;
  installed = true;

  const onError = (event: ErrorEvent) => captureError(event.error ?? event.message, { source: 'onerror' });
  const onRejection = (event: PromiseRejectionEvent) => captureError(event.reason, { source: 'unhandledrejection' });

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  try {
    const previous = window.localStorage.getItem(LAST_VERSION_KEY);

    if (previous && previous !== pkg.version) track('app_updated', { from_version: previous, to_version: pkg.version });
    window.localStorage.setItem(LAST_VERSION_KEY, pkg.version);
  } catch {
    // private mode
  }
  track('app_opened');
  identify(options.userId);

  const timer = window.setTimeout(() => void analytics.start(), options.delayMs ?? 2_000);

  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    installed = false;
  };
}
