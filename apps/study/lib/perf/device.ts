// Device + app header sent with every batch (not repeated per event). Read once per app launch; every
// navigator field is feature-detected (deviceMemory is Chrome-only, hardwareConcurrency can be absent).

import type { PerfApp, PerfDevice } from './types';

import { chromeMajor } from './parse';

import { BUILD_STAMP, isTauriAndroid } from '@/lib/platform/runtime';
import { parseBuildStamp } from '@/lib/platform/update-check';

const DEVICE_ID_KEY = 'study.perf.deviceId';

export function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(16));

      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // fall through
  }

  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** A random id persisted per install, so the owner read can follow one tablet across sessions. */
export function perfDeviceId(): string {
  try {
    const stored = window.localStorage.getItem(DEVICE_ID_KEY);

    if (stored) return stored;
    const next = randomId();

    window.localStorage.setItem(DEVICE_ID_KEY, next);

    return next;
  } catch {
    return 'no-storage';
  }
}

export function readPerfDevice(): PerfDevice {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ua = nav.userAgent ?? '';
  const device: PerfDevice = {
    id: perfDeviceId(),
    ua,
    screen: [Math.round(window.screen?.width ?? 0), Math.round(window.screen?.height ?? 0)],
    dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
    platform: isTauriAndroid() ? 'android' : 'web',
  };

  if (typeof nav.hardwareConcurrency === 'number') device.cores = nav.hardwareConcurrency;
  if (typeof nav.deviceMemory === 'number') device.mem = nav.deviceMemory;
  const chrome = chromeMajor(ua);

  if (chrome) device.chrome = chrome;

  return device;
}

/** Version + sha from the android-release stamp; versionCode from the activity bridge, else the baked one. */
export function readPerfApp(): PerfApp {
  const stamp = parseBuildStamp(BUILD_STAMP);
  let versionCode: number | null = Number(process.env.NEXT_PUBLIC_VERSION_CODE) || null;

  try {
    const bridge = (window as Window & { StudyUpdater?: { versionCode?: () => unknown } }).StudyUpdater;
    const code = Number(bridge?.versionCode?.());

    if (Number.isSafeInteger(code) && code > 0) versionCode = code;
  } catch {
    // baked value stands
  }

  return { version: stamp.version, sha: stamp.sha, versionCode };
}
