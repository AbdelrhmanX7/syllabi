/**
 * Where the backend lives, and whether the API layer answers from the mock instead.
 *
 * Resolution order for the base URL: the per-device override saved from Settings → the build-time
 * `NEXT_PUBLIC_API`. With neither (a fresh self-hosted install, or a build made without a server),
 * the app runs in demo mode on the in-memory mock until a server URL is saved in Settings.
 *
 * Every setting here is a tiny `useSyncExternalStore`-friendly store: one frozen snapshot per write,
 * so a Settings toggle re-renders the shell without a reload.
 */

const BACKEND_URL_STORAGE_KEY = 'study_backend_url';
/** `'1'` forces the mock, `'0'` forces the live backend, absent = auto (probe `/study/canvas/connection`). */
const MOCK_MODE_STORAGE_KEY = 'study_mock';

export type MockMode = 'auto' | 'mock' | 'live';

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // private mode / quota — the in-memory snapshot still updates for this session
  }
}

export function getBuildTimeApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API?.trim() ?? '';
}

export interface BackendSettings {
  /** The saved override, '' when none. */
  backendUrlOverride: string;
  /** The URL requests actually go to. */
  backendUrl: string;
  mockMode: MockMode;
}

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function compute(): BackendSettings {
  const override = normalizeUrl(readStorage(BACKEND_URL_STORAGE_KEY) ?? '');
  const mockRaw = readStorage(MOCK_MODE_STORAGE_KEY);
  const backendUrl = override || normalizeUrl(getBuildTimeApiBaseUrl());

  return Object.freeze({
    backendUrlOverride: override,
    backendUrl,
    // No server configured → demo mode: everything answers from the mock.
    mockMode: mockRaw === '1' || !backendUrl ? 'mock' : mockRaw === '0' ? 'live' : 'auto',
  });
}

const SERVER_SNAPSHOT: BackendSettings = Object.freeze({
  backendUrlOverride: '',
  backendUrl: normalizeUrl(getBuildTimeApiBaseUrl()),
  mockMode: normalizeUrl(getBuildTimeApiBaseUrl()) ? 'auto' : 'mock',
});

let snapshot: BackendSettings | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = compute();
  Array.from(listeners).forEach((listener) => {
    try {
      listener();
    } catch {
      // one broken subscriber must not stop the others
    }
  });
}

export function getBackendSettingsSnapshot(): BackendSettings {
  if (!snapshot) {
    snapshot = compute();
  }

  return snapshot;
}

export function getBackendSettingsServerSnapshot(): BackendSettings {
  return SERVER_SNAPSHOT;
}

export function subscribeBackendSettings(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** The effective backend base URL (no trailing slash). */
export function getStudyBackendBaseUrl(): string {
  return getBackendSettingsSnapshot().backendUrl;
}

export function saveBackendUrlOverride(url: string): void {
  const normalized = normalizeUrl(url);

  writeStorage(BACKEND_URL_STORAGE_KEY, normalized ? normalized : null);
  publish();
}

export function getMockMode(): MockMode {
  return getBackendSettingsSnapshot().mockMode;
}

/** The raw stored choice ('1' forced mock, '0' forced live, null auto), whatever demo mode computes. */
export function getStoredMockMode(): string | null {
  return readStorage(MOCK_MODE_STORAGE_KEY);
}

export function saveMockMode(mode: MockMode): void {
  writeStorage(MOCK_MODE_STORAGE_KEY, mode === 'mock' ? '1' : mode === 'live' ? '0' : null);
  publish();
}
