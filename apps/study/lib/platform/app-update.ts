/**
 * In-app updates for the sideloaded Android build — the store behind the update banner and the
 * Settings "App updates" card.
 *
 * - The feed is read by the native shell (`invoke('update_feed')`, src-tauri/src/lib.rs): the bucket
 *   sends no CORS headers, so the WebView cannot fetch it itself.
 * - The installed versionCode comes from the activity (`window.StudyUpdater`, AppUpdater.kt), falling
 *   back to the value scripts/android-release.mjs baked into the export.
 * - "Update now" hands the release to AppUpdater.kt: download into the app cache, sha256 check,
 *   package/versionCode check, then the system installer (same signing key → data kept). It reports
 *   back as `study-update` CustomEvents. Off Android it opens the download page.
 */
import type { ReleaseFeed, Snooze } from './update-check';

import { BUILD_STAMP } from './runtime';
import {
  DOWNLOAD_PAGE_URL,
  isCheckDue,
  isSnoozed,
  isUpdateAvailable,
  parseBuildStamp,
  parseFeed,
  parseSnooze,
  RESUME_CHECK_GAP_MS,
  snoozeFor,
  UPDATE_FEED_URL,
} from './update-check';

interface NativeUpdater {
  versionCode(): number;
  start(url: string, sha256: string, versionCode: string): boolean;
}

interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    StudyUpdater?: NativeUpdater;
  }
}

export type InstallPhase = 'idle' | 'downloading' | 'verifying' | 'permission' | 'installing' | 'error';

export interface UpdateState {
  installedVersionCode: number | null;
  installedVersion: string;
  installedSha: string;
  feed: ReleaseFeed | null;
  available: boolean;
  snoozed: boolean;
  checking: boolean;
  lastChecked: number | null;
  checkError: string | null;
  phase: InstallPhase;
  received: number;
  total: number;
  installError: string | null;
}

const SNOOZE_KEY = 'study.update.snooze';
const LAST_CHECKED_KEY = 'study.update.lastChecked';
const BAKED_VERSION_CODE = Number(process.env.NEXT_PUBLIC_VERSION_CODE) || null;

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode / blocked storage — the value just does not persist
  }
}

function nativeUpdater(): NativeUpdater | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.StudyUpdater;

  return bridge && typeof bridge.start === 'function' ? bridge : null;
}

function installedVersionCode(): number | null {
  const bridge = nativeUpdater();

  if (bridge) {
    try {
      const code = Number(bridge.versionCode());

      if (Number.isSafeInteger(code) && code > 0) return code;
    } catch {
      // fall through to the baked value
    }
  }

  return BAKED_VERSION_CODE;
}

const stamp = parseBuildStamp(BUILD_STAMP);

let state: UpdateState = {
  installedVersionCode: null,
  installedVersion: stamp.version,
  installedSha: stamp.sha,
  feed: null,
  available: false,
  snoozed: false,
  checking: false,
  lastChecked: null,
  checkError: null,
  phase: 'idle',
  received: 0,
  total: 0,
  installError: null,
};
let initialised = false;
const listeners = new Set<() => void>();

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function recompute(feed: ReleaseFeed | null): Partial<UpdateState> {
  const installed = state.installedVersionCode;

  return {
    feed,
    available: isUpdateAvailable(feed, installed),
    snoozed: isSnoozed(parseSnooze(readStorage(SNOOZE_KEY)), feed, Date.now()),
  };
}

interface NativeEventDetail {
  state?: string;
  received?: number;
  total?: number;
  message?: string;
}

function onNativeEvent(event: Event): void {
  const detail = ((event as CustomEvent<NativeEventDetail>).detail ?? {}) as NativeEventDetail;

  switch (detail.state) {
    case 'resume':
      void checkForUpdates({ ifOlderThan: RESUME_CHECK_GAP_MS });
      break;
    case 'downloading':
      setState({ phase: 'downloading', received: detail.received ?? 0, total: detail.total ?? 0, installError: null });
      break;
    case 'verifying':
    case 'permission':
    case 'installing':
      setState({ phase: detail.state, installError: null });
      break;
    case 'error':
      setState({ phase: 'error', installError: detail.message || 'The update failed.' });
      break;
  }
}

function init(): void {
  if (initialised || typeof window === 'undefined') return;
  initialised = true;
  const lastChecked = Number(readStorage(LAST_CHECKED_KEY)) || null;

  state = { ...state, installedVersionCode: installedVersionCode(), lastChecked };
  window.addEventListener('study-update', onNativeEvent);
}

export function subscribeUpdates(listener: () => void): () => void {
  init();
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function getUpdateSnapshot(): UpdateState {
  return state;
}

export function getServerUpdateSnapshot(): UpdateState {
  return state;
}

async function fetchFeed(): Promise<unknown> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

  if (internals && typeof internals.invoke === 'function') {
    return internals.invoke<unknown>('update_feed');
  }

  const response = await fetch(`${UPDATE_FEED_URL}?t=${Date.now()}`, { cache: 'no-store' });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  return response.json();
}

let inFlight: Promise<void> | null = null;

/**
 * Reads the feed. Automatic callers pass `ifOlderThan` so a burst of triggers costs one
 * request; the Settings button passes nothing and always checks.
 */
export function checkForUpdates(options: { ifOlderThan?: number } = {}): Promise<void> {
  init();
  if (typeof window === 'undefined' || state.installedVersionCode === null) return Promise.resolve();
  if (inFlight) return inFlight;

  const gap = options.ifOlderThan;

  if (gap !== undefined && !isCheckDue(state.lastChecked, Date.now(), gap)) return Promise.resolve();

  setState({ checking: true, checkError: null });
  inFlight = (async () => {
    try {
      const feed = parseFeed(await fetchFeed());
      const now = Date.now();

      writeStorage(LAST_CHECKED_KEY, String(now));
      setState({
        ...recompute(feed),
        checking: false,
        lastChecked: now,
        checkError: feed ? null : 'The update feed is not valid.',
      });
    } catch (error) {
      setState({ checking: false, checkError: error instanceof Error ? error.message : String(error) });
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function snoozeUpdate(): void {
  if (!state.feed) return;
  writeStorage(SNOOZE_KEY, JSON.stringify(snoozeFor(state.feed, Date.now()) satisfies Snooze));
  setState(
    state.phase === 'downloading' || state.phase === 'verifying'
      ? { snoozed: true }
      : { snoozed: true, phase: 'idle', installError: null },
  );
}

export function startUpdate(): void {
  const feed = state.feed;
  const bridge = nativeUpdater();

  if (!feed) return;

  if (!bridge) {
    window.open(DOWNLOAD_PAGE_URL, '_blank', 'noopener');

    return;
  }

  if (state.phase === 'downloading' || state.phase === 'verifying') return;

  setState({ phase: 'downloading', received: 0, total: feed.size, installError: null });
  try {
    if (!bridge.start(feed.url, feed.sha256, String(feed.versionCode))) {
      setState({ phase: 'error', installError: 'The update could not start.' });
    }
  } catch (error) {
    setState({ phase: 'error', installError: error instanceof Error ? error.message : String(error) });
  }
}

/** Whether "Update now" installs in place (Android shell) or opens the download page. */
export function canInstallInApp(): boolean {
  return nativeUpdater() !== null;
}
