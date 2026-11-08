/**
 * The Android app's side of sign-in links (tauri-plugin-deep-link + tauri-plugin-opener, see
 * src-tauri/tauri.conf.json). Reached through the globals Tauri injects, never a static `@tauri-apps/*`
 * import, so the web bundle stays free of it. Every function is a no-op (or null) outside the app.
 */

import { isTauri } from './runtime';

type Unlisten = () => void;

interface TauriGlobals {
  __TAURI_INTERNALS__?: { invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
  __TAURI__?: {
    event?: { listen?: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<Unlisten> };
  };
}

function globals(): TauriGlobals {
  return window as unknown as TauriGlobals;
}

function asLinks(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];

  return list.filter((link): link is string => typeof link === 'string' && link.length > 0);
}

/** The link that started (or last resumed) the app, if any. Android keeps returning it until another arrives. */
export async function currentAppLinks(): Promise<string[]> {
  const invoke = isTauri() ? globals().__TAURI_INTERNALS__?.invoke : undefined;

  if (typeof invoke !== 'function') return [];
  try {
    return asLinks(await invoke<unknown>('plugin:deep-link|get_current'));
  } catch {
    return [];
  }
}

/** Calls `handler` for every link that opens the app while it is running. Returns the unsubscribe. */
export function onAppLink(handler: (link: string) => void): Unlisten {
  const listen = isTauri() ? globals().__TAURI__?.event?.listen : undefined;

  if (typeof listen !== 'function') return () => {};
  let stopped = false;
  let unlisten: Unlisten | null = null;

  listen<unknown>('deep-link://new-url', (event) => asLinks(event.payload).forEach(handler))
    .then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
    })
    .catch(() => {});

  return () => {
    stopped = true;
    unlisten?.();
  };
}

/** Opens an https page in the system browser (Google refuses sign-in inside the app's own web view). */
export async function openInSystemBrowser(url: string): Promise<boolean> {
  const invoke = isTauri() ? globals().__TAURI_INTERNALS__?.invoke : undefined;

  if (typeof invoke !== 'function') return false;
  try {
    await invoke('plugin:opener|open_url', { url });

    return true;
  } catch {
    return false;
  }
}
