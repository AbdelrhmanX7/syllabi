// Which lecture notes a concept map is drawn from. The backend field (`notesPageIds` on the map,
// PATCH /concept-maps/:id {notesPageIds}) is the truth once it ships; until then the links live on
// this device, keyed by map id. Pure functions over a Storage-like store so the tests need no DOM.

/**
 * One linked note. `page` = a Study notebook page (a library PDF or a picked PDF becomes one too, so
 * the backend's page-id list covers it). `library` = a typed library note (markdown) — no notebook
 * page behind it, so it stays a device-only link.
 */
export type NoteLink =
  | {
      kind: 'page';
      pageId: string;
      title: string;
      libraryId?: string;
      fileName?: string;
      /** A page started here for writing in class: opens on lined paper. */
      paper?: 'lined';
    }
  | { kind: 'library'; libraryId: string; title: string };

export interface KeyValueStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const LINKS_KEY = 'study_cm_note_links';

type LinkTable = Record<string, NoteLink[]>;

function isLink(value: unknown): value is NoteLink {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;

  if (typeof row.title !== 'string') return false;
  if (row.kind === 'page') return typeof row.pageId === 'string' && row.pageId.length > 0;
  if (row.kind === 'library') return typeof row.libraryId === 'string' && row.libraryId.length > 0;

  return false;
}

function readTable(store: KeyValueStore | null): LinkTable {
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(LINKS_KEY) ?? '{}') as unknown;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const table: LinkTable = {};

    for (const [mapId, rows] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(rows)) table[mapId] = rows.filter(isLink);
    }

    return table;
  } catch {
    return {};
  }
}

export const linkKey = (link: NoteLink) => (link.kind === 'page' ? `page:${link.pageId}` : `library:${link.libraryId}`);

export function readLinks(store: KeyValueStore | null, mapId: string): NoteLink[] {
  return readTable(store)[mapId] ?? [];
}

/** False when the store refused (private mode, quota) — the caller keeps its in-memory copy. */
export function writeLinks(store: KeyValueStore | null, mapId: string, links: NoteLink[]): boolean {
  if (!store) return false;
  try {
    const table = readTable(store);

    if (links.length === 0) delete table[mapId];
    else table[mapId] = links;
    store.setItem(LINKS_KEY, JSON.stringify(table));

    return true;
  } catch {
    return false;
  }
}

/** Adds (or refreshes the title of) a link; order is the order he linked them in. */
export function addLink(links: NoteLink[], link: NoteLink): NoteLink[] {
  const key = linkKey(link);
  const at = links.findIndex((row) => linkKey(row) === key);

  if (at < 0) return [...links, link];
  const next = [...links];

  next[at] = { ...next[at]!, ...link } as NoteLink;

  return next;
}

export function removeLink(links: NoteLink[], key: string): NoteLink[] {
  return links.filter((row) => linkKey(row) !== key);
}

export function pageIdsOf(links: NoteLink[]): string[] {
  return links.flatMap((row) => (row.kind === 'page' ? [row.pageId] : []));
}

/** The map's backend field — present (even empty) once the backend ships it. */
export function serverPageIds(map: { notesPageIds?: unknown }): string[] | null {
  return Array.isArray(map.notesPageIds)
    ? map.notesPageIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : null;
}

export interface ResolvedLinks {
  links: NoteLink[];
  /** Where the page-id list comes from: the map record, or this device until the backend has the field. */
  source: 'server' | 'device';
  /** Device links the server does not have yet — pushed once on the first load after the switch-over. */
  toMigrate: string[];
}

/**
 * The links to show for a map. Server mode: the map's ids decide which pages are linked (ids linked
 * on another device show under a placeholder title); device rows supply titles and the PDF origin,
 * and device-only page links are reported for a one-time PATCH. Typed library notes always come
 * from the device.
 */
export function resolveLinks(map: { notesPageIds?: unknown }, local: NoteLink[]): ResolvedLinks {
  const server = serverPageIds(map);

  if (server === null) return { links: local, source: 'device', toMigrate: [] };
  const byPage = new Map(local.flatMap((row) => (row.kind === 'page' ? [[row.pageId, row] as const] : [])));
  const pages: NoteLink[] = server.map(
    (pageId) => byPage.get(pageId) ?? { kind: 'page', pageId, title: 'Lecture notes' },
  );
  const serverSet = new Set(server);
  const toMigrate = pageIdsOf(local).filter((id) => !serverSet.has(id));
  const migrated: NoteLink[] = toMigrate.map((id) => byPage.get(id)!);
  const library = local.filter((row) => row.kind === 'library');

  return { links: [...pages, ...migrated, ...library], source: 'server', toMigrate };
}

/** `localStorage`, or null where it throws (SSR, blocked site data). */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
