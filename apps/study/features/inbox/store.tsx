// One inbox for the whole app: the Rail badge, the Inbox page, the board's «Insert from phone» sheet
// and the arrival toast all read this module store. `useInboxWatcher` (mounted once in AppShell)
// fills it from `GET /inbox` and keeps it live (SSE, or polling as the fallback).
import type { InboxLiveMode } from './lib/live';
import type { InboxAction, InboxState } from './lib/reducer';
import type { InboxItem } from './types';

import { useEffect, useSyncExternalStore } from 'react';
import { addToast } from '@repo/ui';
import Link from 'next/link';

import { deleteInboxItem, fetchInboxFile, getInboxItem, listInbox, markInboxUsed, openInboxStream } from './api';
import { startInboxLive } from './lib/live';
import { inboxReducer, initialInboxState, latestCreatedAt, newArrivals, unreadCount } from './lib/reducer';

import { useBackendSettings } from '@/hooks/useBackendSettings';

const SEEN_KEY = 'study_inbox_seen_at';

interface Snapshot extends InboxState {
  mode: InboxLiveMode;
  unread: number;
}

const SERVER_SNAPSHOT: Snapshot = { ...initialInboxState(), mode: 'stopped', unread: 0 };
let snapshot: Snapshot = SERVER_SNAPSHOT;
const listeners = new Set<() => void>();

function publish(next: Snapshot): void {
  if (next === snapshot) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

export function dispatchInbox(action: InboxAction): void {
  const reduced = inboxReducer(snapshot, action);

  if (reduced === snapshot) return;
  publish({ ...reduced, mode: snapshot.mode, unread: unreadCount(reduced) });
}

function setMode(mode: InboxLiveMode): void {
  if (snapshot.mode !== mode) publish({ ...snapshot, mode });
}

export const getInboxSnapshot = () => snapshot;

const subscribe = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

export function useInbox(): Snapshot {
  return useSyncExternalStore(subscribe, getInboxSnapshot, () => SERVER_SNAPSHOT);
}

/** First run: nothing that arrived before this device ever looked counts as unread. */
function readSeenAt(): string {
  try {
    const stored = window.localStorage.getItem(SEEN_KEY);

    if (stored && !Number.isNaN(Date.parse(stored))) return stored;
    const now = new Date().toISOString();

    window.localStorage.setItem(SEEN_KEY, now);

    return now;
  } catch {
    return new Date().toISOString();
  }
}

/** The Inbox page is open: everything there now is read. */
export function markInboxSeen(): void {
  const newest = latestCreatedAt(snapshot.items);
  const at = new Date(Math.max(Date.now(), newest ? Date.parse(newest) : 0)).toISOString();

  dispatchInbox({ type: 'seen', at });
  try {
    window.localStorage.setItem(SEEN_KEY, at);
  } catch {
    // the in-memory mark still clears the badge this session
  }
}

export async function removeInboxItem(id: string): Promise<void> {
  await deleteInboxItem(id);
  dispatchInbox({ type: 'removed', id });
}

/** Mark an item used (board insert, notes, bank). Local first; the PATCH is best-effort. */
export async function markItemUsed(id: string): Promise<void> {
  const usedAt = new Date().toISOString();

  dispatchInbox({ type: 'used', id, usedAt });
  await markInboxUsed(id, usedAt).catch(() => undefined);
}

/** Signed `url`/`thumbUrl` live 1 h; the list is re-read well before that while the app is open. */
export const URL_REFRESH_MS = 40 * 60_000;
let lastFullLoad = 0;

async function reloadInbox(): Promise<InboxItem[]> {
  const items = await listInbox();

  lastFullLoad = Date.now();
  dispatchInbox({ type: 'loaded', items });

  return items;
}

/**
 * The item's file. A signed URL older than an hour fails: fetch the item for a fresh one (`GET
 * /inbox/:id`; the list on a 404 / an older backend — a page queue item may not be in it) and try once
 * more.
 */
export async function loadInboxFile(item: InboxItem): Promise<File> {
  try {
    return await fetchInboxFile(item);
  } catch (error) {
    const byId = await getInboxItem(item.id).catch(() => null);
    const fresh =
      byId?.id === item.id ? byId : (await reloadInbox().catch(() => [])).find((candidate) => candidate.id === item.id);

    if (!fresh || fresh.url === item.url) throw error;

    return fetchInboxFile(fresh);
  }
}

function toastArrival(items: InboxItem[]): void {
  const first = items[0];
  const many = items.length > 1;

  addToast({
    title: many
      ? `📱 ${items.length} new photos from iPhone`
      : `📱 New ${first.kind === 'pdf' ? 'PDF' : 'photo'} from iPhone`,
    description: first.note ?? 'In your Inbox — put it on a board, in notes or in the bank.',
    timeout: 6_000,
    endContent: (
      <Link className='text-st-accent shrink-0 text-sm font-semibold underline underline-offset-2' href='/inbox/'>
        Open
      </Link>
    ),
  });
}

/** Loads the inbox and keeps it live while `enabled`; toasts every arrival. Mount once. */
export function useInboxWatcher(enabled: boolean): void {
  const { mockMode, backendUrl } = useBackendSettings();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    dispatchInbox({ type: 'reset' });
    dispatchInbox({ type: 'seen', at: readSeenAt() });
    void reloadInbox().catch(() => undefined);
    // Fresh signed URLs: on a timer while open, and on return to the app after a long absence.
    const refreshIfStale = () => {
      if (!cancelled && document.visibilityState === 'visible' && Date.now() - lastFullLoad > URL_REFRESH_MS) {
        void reloadInbox().catch(() => undefined);
      }
    };
    const timer = window.setInterval(refreshIfStale, 60_000);

    document.addEventListener('visibilitychange', refreshIfStale);

    const stop = startInboxLive({
      stream: openInboxStream,
      poll: (since) => listInbox(since),
      getSince: () => latestCreatedAt(snapshot.items),
      onItems: (items) => {
        const fresh = newArrivals(snapshot.items, items);

        dispatchInbox({ type: 'arrived', items });
        // Before the first listing every item looks new — that is a load, not an arrival.
        if (fresh.length && snapshot.loaded) toastArrival(fresh);
      },
      onMode: setMode,
    });

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfStale);
      stop();
    };
  }, [backendUrl, enabled, mockMode]);
}
