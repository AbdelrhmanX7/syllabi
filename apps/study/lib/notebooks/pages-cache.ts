// A small local index of notebook Page records keyed by id. The contract lists pages by class/item
// and has no `GET /pages/:id`, so the notebook route finds its record here first; it is refreshed by
// every list/create the shell performs. Also remembers which page version this device last synced.
import type { Page } from '@/lib/api/types';

const PAGES_KEY = 'study_pages_cache';
const VERSIONS_KEY = 'study_page_versions';

type PageMap = Record<string, Page>;
type VersionMap = Record<string, { version: number; syncedAt: number; dirty?: boolean }>;

function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;

  try {
    const raw = window.localStorage.getItem(key);

    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota — the cache is a convenience, not the source of truth
  }
}

export function rememberPages(pages: Page[]): void {
  if (pages.length === 0) return;
  const map = read<PageMap>(PAGES_KEY, {});

  for (const page of pages) map[page.id] = page;
  write(PAGES_KEY, map);
}

export function forgetPage(pageId: string): void {
  const map = read<PageMap>(PAGES_KEY, {});

  delete map[pageId];
  write(PAGES_KEY, map);
  const versions = read<VersionMap>(VERSIONS_KEY, {});

  delete versions[pageId];
  write(VERSIONS_KEY, versions);
}

export function readCachedPage(pageId: string): Page | null {
  return read<PageMap>(PAGES_KEY, {})[pageId] ?? null;
}

export function readAllCachedPages(): Page[] {
  return Object.values(read<PageMap>(PAGES_KEY, {})).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readSyncedVersion(pageId: string): { version: number; syncedAt: number; dirty?: boolean } | null {
  return read<VersionMap>(VERSIONS_KEY, {})[pageId] ?? null;
}

export function writeSyncedVersion(pageId: string, version: number, dirty = false): void {
  const versions = read<VersionMap>(VERSIONS_KEY, {});

  versions[pageId] = { version, syncedAt: Date.now(), dirty };
  write(VERSIONS_KEY, versions);
}

/** Pages whose latest local edit never reached the backend (offline, or the upload failed). */
export function readDirtyPageIds(): string[] {
  return Object.entries(read<VersionMap>(VERSIONS_KEY, {}))
    .filter(([, entry]) => entry.dirty)
    .map(([pageId]) => pageId);
}
