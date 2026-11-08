// Settings → Reminders. Per device (localStorage), off until the student turns it on. Every storage
// access is wrapped: private windows and old WebViews can throw on localStorage.
import type { CustomReminder, DueLead, Repeat } from './plan';

import { useSyncExternalStore } from 'react';

import { DEFAULT_DUE_LEADS, DUE_LEADS } from './plan';

const STORAGE_KEY = 'study_reminders';

/** Own reminders kept at most. */
export const MAX_CUSTOM = 50;

export interface ReminderSettings {
  enabled: boolean;
  due: boolean;
  flashcards: boolean;
  leads: DueLead[];
  custom: CustomReminder[];
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = Object.freeze({
  enabled: false,
  due: true,
  flashcards: true,
  leads: DEFAULT_DUE_LEADS,
  custom: [],
}) as ReminderSettings;

const REPEATS: Repeat[] = ['none', 'daily', 'weekly'];
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Stored JSON → settings; anything malformed falls back field by field. */
export function parseReminderSettings(raw: string | null): ReminderSettings {
  if (!raw) return DEFAULT_REMINDER_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof ReminderSettings, unknown>>;
    const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
    const leads = Array.isArray(value.leads)
      ? DUE_LEADS.filter((lead) => (value.leads as unknown[]).includes(lead))
      : DEFAULT_REMINDER_SETTINGS.leads;
    const custom = (Array.isArray(value.custom) ? value.custom : [])
      .filter(
        (r): r is CustomReminder =>
          !!r &&
          typeof r === 'object' &&
          typeof (r as CustomReminder).id === 'string' &&
          typeof (r as CustomReminder).text === 'string' &&
          typeof (r as CustomReminder).at === 'string' &&
          LOCAL_TIME.test((r as CustomReminder).at),
      )
      .map((r) => ({ id: r.id, text: r.text.slice(0, 120), at: r.at, repeat: REPEATS.includes(r.repeat) ? r.repeat : 'none' }))
      .slice(0, MAX_CUSTOM);

    return {
      enabled: bool(value.enabled, false),
      due: bool(value.due, true),
      flashcards: bool(value.flashcards, true),
      leads,
      custom,
    };
  } catch {
    return DEFAULT_REMINDER_SETTINGS;
  }
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: ReminderSettings = DEFAULT_REMINDER_SETTINGS;

function readRaw(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getReminderSettings(): ReminderSettings {
  const raw = readRaw();

  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseReminderSettings(raw);
  }

  return cached;
}

export function saveReminderSettings(patch: Partial<ReminderSettings>): ReminderSettings {
  const next = { ...getReminderSettings(), ...patch };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: keep the in-memory value for this session.
    cachedRaw = undefined;
    cached = next;
  }
  listeners.forEach((listener) => listener());

  return next;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };

  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);

  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export const subscribeReminderSettings = subscribe;

export function useReminderSettings(): ReminderSettings {
  return useSyncExternalStore(subscribe, getReminderSettings, () => DEFAULT_REMINDER_SETTINGS);
}

/* ------------------------------------------------------------------ small per-device lists */

/** A JSON string array in localStorage (shown news ids, fired web reminders, scheduled phone ids). */
export function readList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;

    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function writeList(key: string, values: string[], max = 200) {
  try {
    localStorage.setItem(key, JSON.stringify(values.slice(-max)));
  } catch {
    // ignore
  }
}
