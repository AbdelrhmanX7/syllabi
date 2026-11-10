// Usage counts for the owner: which screens get used, what fails, how long things take.
//
// Privacy rules (an open-source student app): only ids, counts, durations and fixed enum values are
// ever sent. Never note or notebook content, question text, file names, emails, course names or
// grades. No auto-captured clicks, no screen recording, no surveys, no URL query strings or fragments
// (a sign-in link carries its token in the fragment).
//
// Pure and injectable so it is tested without a browser: `load` brings in the client lazily, and
// nothing at all happens (no import, no network, no listeners) when there is no project key.

export type AnalyticsValue = string | number | boolean | null | undefined;
export type AnalyticsProps = Record<string, AnalyticsValue>;

/** The slice of the posthog-js client this app uses. */
export interface AnalyticsClient {
  init(key: string, config: Record<string, unknown>): unknown;
  capture(event: string, props?: Record<string, unknown>): unknown;
  identify(id: string): unknown;
  reset(): unknown;
  register(props: Record<string, unknown>): unknown;
  opt_out_capturing(): unknown;
  opt_in_capturing(): unknown;
  has_opted_out_capturing?(): boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AnalyticsOptions {
  key: string;
  host: string;
  load: () => Promise<AnalyticsClient>;
  storage?: () => StorageLike | null;
  /** Properties on every event (re-read on each page view, so a mode change shows up). */
  superProps?: () => AnalyticsProps;
}

/** localStorage key of the Settings switch: '0' = off; anything else (or nothing) = on. */
export const SHARE_USAGE_KEY = 'study_share_usage';
const QUEUE_MAX = 50;
const STACK_MAX = 2_000;
const ERRORS_PER_SESSION = 20;

/** `scheme://host/path` only: no query string, no fragment. */
export function stripUrl(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return value;

  return value.split(/[?#]/)[0];
}

/** Any web address inside free text (an error message) loses its query string and fragment too. */
export function stripUrlsInText(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, '$1');
}

const URL_VALUE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Runs on every event right before it is sent: every web-address value (whatever the property is
 * called, the client adds several) loses its query string and fragment, and the IP is dropped.
 */
export function scrubEvent<T extends { properties?: Record<string, unknown>; $set?: Record<string, unknown>; $set_once?: Record<string, unknown> }>(
  event: T,
): T {
  for (const bag of [event.properties, event.$set, event.$set_once]) {
    if (!bag) continue;
    for (const name of Object.keys(bag)) {
      const value = bag[name];

      if (typeof value === 'string' && URL_VALUE.test(value)) bag[name] = stripUrl(value);
    }
    delete bag.$ip;
  }

  return event;
}

export function pageBucket(pages: number): string {
  if (pages <= 1) return '1';
  if (pages <= 10) return '2-10';
  if (pages <= 50) return '11-50';
  if (pages <= 200) return '51-200';

  return '200+';
}

export function megabyteBucket(bytes: number): string {
  const mb = bytes / 1_048_576;

  if (mb < 1) return '<1';
  if (mb < 5) return '1-5';
  if (mb < 20) return '5-20';
  if (mb < 50) return '20-50';

  return '50+';
}

export function screenClass(width: number): string {
  if (width < 640) return 'sm';
  if (width < 1024) return 'md';
  if (width < 1440) return 'lg';

  return 'xl';
}

/** A coarse, content-free reason for a failure: an HTTP status class, offline, timeout, … */
export function errorReason(error: unknown): string {
  const status = (error as { response?: { status?: number }; status?: number } | null)?.response?.status ?? (error as { status?: number } | null)?.status;

  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 404) return 'not_found';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server';
    if (status >= 400) return 'rejected';
  }
  const name = (error as { name?: string; code?: string } | null)?.name ?? '';
  const code = (error as { code?: string } | null)?.code ?? '';

  if (name === 'AbortError' || code === 'ECONNABORTED' || /timeout/i.test(code)) return 'timeout';
  if (code === 'ERR_NETWORK' || name === 'TypeError') return 'network';

  return 'other';
}

export function createAnalytics(options: AnalyticsOptions) {
  const { key, host, load } = options;
  const enabled = Boolean(key);
  const storage = () => {
    try {
      return options.storage?.() ?? null;
    } catch {
      return null;
    }
  };
  let client: AnalyticsClient | null = null;
  let loading: Promise<void> | null = null;
  let queue: Array<(c: AnalyticsClient) => void> = [];
  let errorsSent = 0;
  const seenErrors = new Set<string>();

  const sharing = (): boolean => {
    try {
      return storage()?.getItem(SHARE_USAGE_KEY) !== '0';
    } catch {
      return true;
    }
  };

  const run = (action: (c: AnalyticsClient) => void) => {
    if (!enabled || !sharing()) return;
    if (client) {
      try {
        action(client);
      } catch {
        // counting is best-effort
      }

      return;
    }
    if (queue.length < QUEUE_MAX) queue.push(action);
  };

  /** Loads and starts the client (once). No key or switched off → nothing is loaded at all. */
  const start = (): Promise<void> => {
    if (!enabled || !sharing()) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
      try {
        const loaded = await load();

        loaded.init(key, {
          api_host: host,
          persistence: 'localStorage',
          autocapture: false,
          capture_pageview: false,
          capture_pageleave: false,
          capture_dead_clicks: false,
          capture_heatmaps: false,
          enable_heatmaps: false,
          rageclick: false,
          capture_exceptions: false,
          capture_performance: false,
          disable_session_recording: true,
          disable_surveys: true,
          disable_web_experiments: true,
          disable_product_tours: true,
          disable_conversations: true,
          disable_external_dependency_loading: true,
          advanced_disable_flags: true,
          save_referrer: false,
          mask_all_text: true,
          mask_personal_data_properties: true,
          ip: false,
          before_send: scrubEvent,
        });
        // Switched off earlier, back on now: the client remembers the old opt-out on its own.
        if (loaded.has_opted_out_capturing?.()) loaded.opt_in_capturing();
        client = loaded;
        client.register(options.superProps?.() ?? {});
        const pending = queue;

        queue = [];
        for (const action of pending) {
          try {
            action(loaded);
          } catch {
            // best-effort
          }
        }
      } catch {
        // An old WebView or a blocked script: the app works the same without counts.
        queue = [];
      }
    })();

    return loading;
  };

  const track = (event: string, props: AnalyticsProps = {}) => run((c) => c.capture(event, props));

  return {
    enabled,
    start,
    track,
    pageview: (route: string) =>
      run((c) => {
        c.register(options.superProps?.() ?? {});
        c.capture('$pageview', { route });
      }),
    identify: (userId: string | null | undefined) => {
      if (userId) run((c) => c.identify(userId));
    },
    reset: () => run((c) => c.reset()),
    captureError: (error: unknown, context: AnalyticsProps = {}) => {
      if (!enabled || errorsSent >= ERRORS_PER_SESSION) return;
      const err = error instanceof Error ? error : null;
      const message = stripUrlsInText(err?.message ?? (typeof error === 'string' ? error : 'Unknown error')).slice(0, 300);
      const signature = `${err?.name ?? ''}:${message}`;

      if (seenErrors.has(signature)) return;
      seenErrors.add(signature);
      errorsSent += 1;
      track('app_error', {
        name: err?.name ?? typeof error,
        message,
        stack: err?.stack ? stripUrlsInText(err.stack).slice(0, STACK_MAX) : undefined,
        ...context,
      });
    },
    sharing,
    /** The Settings switch: off stops sending right away; on starts again. */
    setSharing: (on: boolean) => {
      try {
        storage()?.setItem(SHARE_USAGE_KEY, on ? '1' : '0');
      } catch {
        // private mode: the choice lasts this session only
      }
      if (!enabled) return;
      if (on) {
        if (client) client.opt_in_capturing();
        else void start();
      } else {
        queue = [];
        client?.opt_out_capturing();
      }
    },
  };
}

export type Analytics = ReturnType<typeof createAnalytics>;
