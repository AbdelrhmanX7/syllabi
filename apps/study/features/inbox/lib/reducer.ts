// The inbox list on this device: newest first, de-duplicated by id (an SSE frame and the poll that
// follows a reconnect may carry the same upload), capped like the backend's `GET /inbox`.
import type { InboxItem } from '../types';

export const INBOX_LIMIT = 50;

export interface InboxState {
  items: InboxItem[];
  /** Whether the first listing has arrived. */
  loaded: boolean;
  /** ISO time the Inbox page was last open; newer unused items are unread. */
  seenAt: string | null;
}

export type InboxAction =
  | { type: 'loaded'; items: InboxItem[] }
  | { type: 'arrived'; items: InboxItem[] }
  | { type: 'removed'; id: string }
  | { type: 'used'; id: string; usedAt: string }
  | { type: 'seen'; at: string }
  | { type: 'reset' };

export const initialInboxState = (seenAt: string | null = null): InboxState => ({ items: [], loaded: false, seenAt });

const byNewest = (a: InboxItem, b: InboxItem) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

/**
 * A server copy queued for a note page (`pageId` set) says what its `usedAt` is even when it leaves
 * the key out: Claude's `add_inbox_to_page` re-queues by clearing it, so absent = null there.
 */
const withQueueUsedAt = (item: InboxItem): InboxItem =>
  item.pageId && item.usedAt === undefined ? { ...item, usedAt: null } : item;

function merge(current: InboxItem[], incoming: InboxItem[]): InboxItem[] {
  const map = new Map(current.map((item) => [item.id, item]));

  for (const item of incoming) map.set(item.id, { ...map.get(item.id), ...withQueueUsedAt(item) });

  return Array.from(map.values()).sort(byNewest).slice(0, INBOX_LIMIT);
}

export function inboxReducer(state: InboxState, action: InboxAction): InboxState {
  switch (action.type) {
    case 'loaded':
      // A full listing replaces the list (deletes made elsewhere disappear) but keeps a local usedAt the
      // PATCH has not landed for yet — except on an item queued for a note page: Claude re-queues one by
      // clearing usedAt, so there the server's null wins (the board's own appended set stops a repeat).
      return {
        ...state,
        loaded: true,
        items: merge(
          [],
          action.items.map((item) => {
            const known = state.items.find((candidate) => candidate.id === item.id);

            return known?.usedAt && !item.usedAt && !item.pageId ? { ...item, usedAt: known.usedAt } : item;
          }),
        ),
      };
    case 'arrived':
      return action.items.length ? { ...state, items: merge(state.items, action.items) } : state;
    case 'removed':
      return { ...state, items: state.items.filter((item) => item.id !== action.id) };
    case 'used':
      return {
        ...state,
        items: state.items.map((item) => (item.id === action.id ? { ...item, usedAt: action.usedAt } : item)),
      };
    case 'seen':
      return state.seenAt && Date.parse(state.seenAt) >= Date.parse(action.at)
        ? state
        : { ...state, seenAt: action.at };
    case 'reset':
      return initialInboxState(state.seenAt);
    default:
      return state;
  }
}

/** Unused items that arrived after the Inbox was last open. */
export function unreadCount(state: InboxState): number {
  const seen = state.seenAt ? Date.parse(state.seenAt) : -Infinity;

  return state.items.filter((item) => !item.usedAt && Date.parse(item.createdAt) > seen).length;
}

/** Items in `next` that `prev` did not have — what deserves a toast. */
export function newArrivals(prev: InboxItem[], next: InboxItem[]): InboxItem[] {
  const known = new Set(prev.map((item) => item.id));

  return next.filter((item) => !known.has(item.id));
}

/** The `since` cursor for the next poll: the newest createdAt we hold. */
export function latestCreatedAt(items: InboxItem[]): string | null {
  return items.reduce<string | null>(
    (latest, item) => (!latest || Date.parse(item.createdAt) > Date.parse(latest) ? item.createdAt : latest),
    null,
  );
}

/** What a board can take (images, plus PDFs when the host appends PDF pages): unused before used, newest first. */
export function boardCandidates(items: InboxItem[], { pdfs = false }: { pdfs?: boolean } = {}): InboxItem[] {
  return items
    .filter((item) => item.kind === 'image' || (pdfs && item.kind === 'pdf'))
    .sort((a, b) => Number(!!a.usedAt) - Number(!!b.usedAt) || byNewest(a, b));
}
