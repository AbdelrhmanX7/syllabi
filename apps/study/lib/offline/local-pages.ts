// Note pages made while offline. The page gets a temporary `local-…` id and opens on the board at once
// (the board keeps its ink in the device's whiteboard store under that id, like any page). When the
// server can be reached, the outbox creates the real page, then MOVES the board to the server id
// (`rekeyWhiteboard`, one atomic transaction), marks it unsent and uploads it. The move never happens
// while that board is open: it waits until the student leaves it.
import type { Page, PageKind } from '@/lib/api/types';

export const LOCAL_PAGE_PREFIX = 'local-';

export function isLocalPageId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(LOCAL_PAGE_PREFIX);
}

export interface NewPageBody {
  classId: string | null;
  itemId?: string | null;
  title: string;
  kind: PageKind;
}

/** The Page record a temporary page shows under until the server's arrives. */
export function localPageRecord(id: string, body: NewPageBody, now = new Date()): Page {
  return {
    id,
    classId: body.classId ?? null,
    itemId: body.itemId ?? null,
    lectureId: null,
    title: body.title,
    kind: body.kind,
    updatedAt: now.toISOString(),
    version: 0,
    thumbUrl: null,
  };
}

/* ---------------------------------------------------------------- local id → server id redirects */

const REDIRECTS_KEY = 'study_page_redirects';
const MAX_REDIRECTS = 200;

function readRedirects(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(REDIRECTS_KEY);

    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Remember where a temporary page went, so an old link (Back, a recent list) still opens it. */
export function rememberPageRedirect(localId: string, serverId: string): void {
  if (typeof window === 'undefined') return;
  const map = readRedirects();

  map[localId] = serverId;
  const keys = Object.keys(map);

  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REDIRECTS))) delete map[key];
  try {
    window.localStorage.setItem(REDIRECTS_KEY, JSON.stringify(map));
  } catch {
    // quota: the link just won't redirect
  }
}

export function pageRedirect(localId: string): string | null {
  return readRedirects()[localId] ?? null;
}

/** Whether the board for `pageId` is on screen right now (then its move to the server id waits). */
export function isPageOpen(pageId: string): boolean {
  if (typeof window === 'undefined') return false;
  const { pathname, search } = window.location;

  if (!pathname.startsWith('/notebook')) return false;

  return new URLSearchParams(search).get('id') === pageId;
}

/** Event the notebook route listens to, so a page whose id changed while it was closed reopens right. */
export const PAGE_ID_SWAPPED_EVENT = 'study:page-id-swapped';
