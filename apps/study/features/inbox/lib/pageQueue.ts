// The «waiting from Claude» queue of one note page: inbox items Claude filed into it
// (`add_inbox_to_page` sets `pageId`, clears `usedAt`). Two sources feed it — the page's own
// `GET /inbox?pageId=` (uncapped, read when the board opens) and the live inbox store (SSE frames
// as Claude files more; capped at the newest 50, so it cannot stand in for the listing).
import type { InboxItem } from '../types';

export interface PageQueueInput {
  pageId: string;
  /** `GET /inbox?pageId=` as read when the board opened. */
  fetched: readonly InboxItem[];
  /** The live inbox store's items (SSE + listings + local `used` marks). */
  live: readonly InboxItem[];
  /** Ids this board already appended (or is appending) — never offered twice in one visit. */
  appended: ReadonlySet<string>;
}

const byOldest = (a: InboxItem, b: InboxItem) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * What is still to append, oldest first: merged by id (the store's copy wins — it carries a local
 * `usedAt` the PATCH has not landed for, and a `pageId` moved elsewhere), queued for `pageId`, not
 * used, not appended here already, and an image or PDF.
 */
export function pageQueue({ pageId, fetched, live, appended }: PageQueueInput): InboxItem[] {
  const byId = new Map<string, InboxItem>();

  for (const item of fetched) byId.set(item.id, item);
  for (const item of live) byId.set(item.id, { ...byId.get(item.id), ...item });

  return Array.from(byId.values())
    .filter(
      (item) =>
        item.pageId === pageId &&
        !item.usedAt &&
        !appended.has(item.id) &&
        (item.kind === 'image' || item.kind === 'pdf'),
    )
    .sort(byOldest);
}
