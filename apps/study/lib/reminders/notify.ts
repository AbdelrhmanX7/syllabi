// Delivering reminders. Android app: scheduled ahead on the tablet through the notification plugin, so
// they fire with the app closed (cancel ours + re-add on every change). Web: the browser's notifications,
// only while the tab is open (a one-minute tick). Plugin calls go through the globals Tauri injects
// (like lib/platform/app-links.ts); only the tap listener loads the plugin's JS, lazily.
//
// Plugin notes (tauri-plugin-notification 2.4, read from its Kotlin source):
// - `batch` is the call that schedules AND records the notification; `show` fires one right away.
// - Android 13+: the permission request never answers when permission is already granted, so check first
//   and race the request against a timer.
// - A tap fires `actionPerformed`, but the plugin doesn't pass which notification it was, so we open the
//   page of the newest reminder of ours that has gone off and is no longer in the tray.
import type { PlannedReminder } from './plan';

import { reminderId } from './plan';
import { readList, writeList } from './settings';

import { isTauriAndroid } from '@/lib/platform/runtime';

export const CHANNEL_ID = 'syllabi_reminders_v1';
const ICON = 'ic_stat_syllabi';
const ACCENT = '#2F5BEA';
const SCHEDULED_KEY = 'study_reminders_scheduled';
const FIRED_KEY = 'study_reminders_fired';
/** Web: a reminder older than this when the tab ticks is skipped, not shown late. */
const WEB_LATE_MS = 10 * 60_000;

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function nativeInvoke(): Invoke | null {
  if (!isTauriAndroid()) return null;
  const invoke = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;

  return typeof invoke === 'function' ? invoke : null;
}

function webNotification(): typeof Notification | null {
  if (typeof window === 'undefined' || isTauriAndroid()) return null;
  // Android Chrome has the constructor but always throws (it only shows notifications from a service worker).
  if (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)) return null;
  const N = (window as unknown as { Notification?: typeof Notification }).Notification;

  return typeof N === 'function' ? N : null;
}

/** Whether this device can show reminders at all. */
export function remindersSupported(): boolean {
  return nativeInvoke() !== null || webNotification() !== null;
}

/** Granted already (no prompt). */
export async function hasPermission(): Promise<boolean> {
  const invoke = nativeInvoke();

  if (invoke) {
    try {
      const res = await invoke<{ permissionState?: string }>('plugin:notification|permission_state');

      return res?.permissionState === 'granted';
    } catch {
      return false;
    }
  }
  const N = webNotification();

  return !!N && N.permission === 'granted';
}

/** Asks once (call it from the switch's tap). True when reminders may show. */
export async function requestPermission(): Promise<boolean> {
  if (await hasPermission()) return true;
  const invoke = nativeInvoke();

  if (invoke) {
    const timeout = new Promise((resolve) => setTimeout(resolve, 60_000));

    await Promise.race([invoke('plugin:notification|request_permission').catch(() => null), timeout]);

    return hasPermission();
  }
  const N = webNotification();

  if (!N || N.permission === 'denied') return false;
  try {
    return (await N.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

let channelReady: Promise<void> | null = null;

/** Our own channel: «Syllabi reminders», the soft chime from res/raw, blue light. Android fixes a channel's
 *  sound once created, so a new sound needs a new id (`_v2`). */
function ensureChannel(invoke: Invoke): Promise<void> {
  channelReady ??= invoke('plugin:notification|create_channel', {
    id: CHANNEL_ID,
    name: 'Syllabi reminders',
    description: 'Deadlines, flashcards and your own reminders',
    sound: 'chime',
    importance: 4,
    visibility: 0,
    vibration: true,
    lights: true,
    lightsColor: ACCENT,
  })
    .then(() => undefined)
    .catch(() => undefined);

  return channelReady;
}

const nativeNote = (r: Pick<PlannedReminder, 'id' | 'title' | 'body' | 'url'>, at?: number) => ({
  id: r.id,
  title: r.title,
  body: r.body,
  channelId: CHANNEL_ID,
  icon: ICON,
  iconColor: ACCENT,
  sound: 'chime',
  autoCancel: true,
  extra: r.url ? { url: r.url } : {},
  ...(at ? { schedule: { at: { date: new Date(at).toISOString(), repeating: false, allowWhileIdle: true } } } : {}),
});

/* ------------------------------------------------------------------ the schedule */

/** Where a tap goes: our reminders by id, newest first. Kept with the schedule. */
interface Scheduled {
  id: number;
  at: number;
  url?: string;
}

function readScheduled(): Scheduled[] {
  try {
    const value = JSON.parse(localStorage.getItem(SCHEDULED_KEY) ?? '[]') as unknown;

    return Array.isArray(value) ? (value as Scheduled[]).filter((s) => typeof s?.id === 'number') : [];
  } catch {
    return [];
  }
}

function writeScheduled(list: Scheduled[]) {
  try {
    localStorage.setItem(SCHEDULED_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

let webPlan: PlannedReminder[] = [];
let webTimer: ReturnType<typeof setInterval> | null = null;
// null: the first call of each session always reconciles (an empty plan still cancels old ones).
let lastNativeSignature: string | null = null;
let openPath: (path: string) => void = () => {};

/** Replace every reminder of ours with `plan` (empty = turn them all off). */
export async function applySchedule(plan: PlannedReminder[]): Promise<void> {
  const invoke = nativeInvoke();

  if (invoke) {
    const signature = plan.map((r) => `${r.id}@${r.at}:${r.title}|${r.body}`).join(',');

    if (signature === lastNativeSignature) return;
    const previous = readScheduled();
    // Keep the ones that already went off (for taps); drop the pending ones we're replacing.
    const now = Date.now();
    const fired = previous.filter((s) => s.at <= now && s.at > now - 3 * 86_400_000);

    try {
      const pendingIds = previous.filter((s) => s.at > now).map((s) => s.id);

      if (pendingIds.length) await invoke('plugin:notification|cancel', { notifications: pendingIds });
      if (plan.length) {
        await ensureChannel(invoke);
        await invoke('plugin:notification|batch', { notifications: plan.map((r) => nativeNote(r, r.at)) });
      }
      lastNativeSignature = signature;
      writeScheduled([...fired, ...plan.map((r) => ({ id: r.id, at: r.at, url: r.url }))]);
    } catch {
      // Plugin missing (older app build) or refused: nothing to do; the next refresh tries again.
    }

    return;
  }

  webPlan = plan;
  if (plan.length && webNotification()) {
    webTimer ??= setInterval(webTick, 60_000);
    webTick();
  } else if (webTimer) {
    clearInterval(webTimer);
    webTimer = null;
  }
}

function webShow(title: string, body: string, tag: string, url?: string) {
  const N = webNotification();

  if (!N || N.permission !== 'granted') return;
  try {
    // Android Chrome throws «Illegal constructor» here (it wants a service worker); desktop is fine.
    const note = new N(title, { body, tag, icon: '/android-chrome-192x192.png' });

    note.onclick = () => {
      try {
        window.focus();
      } catch {
        // ignore
      }
      if (url) openPath(url);
      note.close();
    };
  } catch {
    // ignore
  }
}

function webTick() {
  const now = Date.now();
  const fired = readList(FIRED_KEY);
  const due = webPlan.filter((r) => r.at <= now && r.at > now - WEB_LATE_MS && !fired.includes(r.key));

  if (!due.length) return;
  due.forEach((r) => webShow(r.title, r.body, r.key, r.url));
  writeList(FIRED_KEY, [...fired, ...due.map((r) => r.key)]);
}

/** Show one message right now (team news). */
export async function showNow(note: { key: string; title: string; body: string; url?: string }): Promise<void> {
  const invoke = nativeInvoke();

  if (!invoke) {
    webShow(note.title, note.body, note.key, note.url);

    return;
  }
  const r = { id: reminderId(note.key), title: note.title, body: note.body, url: note.url };

  try {
    await ensureChannel(invoke);
    await invoke('plugin:notification|show', nativeNote(r));
    writeScheduled([...readScheduled(), { id: r.id, at: Date.now(), url: r.url }]);
  } catch {
    // ignore
  }
}

/** Route taps on our notifications to `open(path)`. Returns the unsubscribe. */
export function listenForTaps(open: (path: string) => void): () => void {
  openPath = open;
  const invoke = nativeInvoke();

  if (!invoke) return () => {};
  let stopped = false;
  let unlisten: (() => void) | null = null;

  void import('@tauri-apps/plugin-notification')
    .then(({ onAction }) =>
      onAction(async (payload: unknown) => {
        const extra = (payload as { notification?: { extra?: { url?: unknown } } } | null)?.notification?.extra;

        if (typeof extra?.url === 'string' && extra.url.startsWith('/')) return open(extra.url);
        // The plugin doesn't say which one was tapped: the newest of ours that went off and left the tray.
        let active: number[] = [];

        try {
          active = ((await invoke<{ id: number }[]>('plugin:notification|get_active')) ?? []).map((a) => a.id);
        } catch {
          // ignore
        }
        const now = Date.now();
        const tapped = readScheduled()
          .filter((s) => s.at <= now + 60_000 && !active.includes(s.id))
          .sort((a, b) => b.at - a.at)[0];

        if (tapped?.url) open(tapped.url);
      }),
    )
    .then((listener) => {
      if (stopped) void listener.unregister();
      else unlisten = () => void listener.unregister();
    })
    .catch(() => {});

  return () => {
    stopped = true;
    unlisten?.();
  };
}
