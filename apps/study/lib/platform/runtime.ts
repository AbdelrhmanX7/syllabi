/**
 * Runtime detection. The app runs as the Tauri 2 Android shell (static export) and as a plain web
 * page (dev server). Tauri is detected through the globals the runtime injects — never through a
 * static `@tauri-apps/*` import, so the web bundle stays free of it. Everything here is SSR-safe.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  }
}

export function isTauri(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.__TAURI_INTERNALS__ != null || window.__TAURI__ != null;
}

export function isTauriAndroid(): boolean {
  if (!isTauri() || typeof navigator === 'undefined') {
    return false;
  }

  return /Android/i.test(navigator.userAgent);
}

/** Whether this bundle was built as the Android static export (`ANDROID_BUILD=1`). */
export const IS_ANDROID_BUILD = process.env.NEXT_PUBLIC_ANDROID_BUILD === '1';

/** "<version> · <sha> · <yyyyMMdd-HHmm>" stamped by scripts/android-release.mjs; empty in dev. */
export const BUILD_STAMP = process.env.NEXT_PUBLIC_BUILD_STAMP ?? '';
