// Page bookmarks outside the board: what a saved board holds (demo mode does what the server does at
// each commit, apps/server services/study/page-bookmarks.ts) and the list of every bookmark across
// notebooks for the Notes page. Unit-tested (bookmarks.test.ts).
import type { Page, PageBookmarkRef } from '@/lib/api/types';
import type { NotebookFrom } from './back';

import { resolvePageLabels } from '@repo/whiteboard-core';

const LABEL_MAX = 60;
const MAX = 200;

type BoardPage = {
  id?: unknown;
  bookmark?: { at?: unknown; label?: unknown } | null;
  pdfAssetId?: string;
  pdfImageUrl?: string;
  pdfPageIndex?: number;
  pdfSourcePageNumber?: number;
  sheetAspect?: number;
  boardRuled?: boolean;
};

/** The bookmarked pages of a board JSON, in page order; [] for anything unreadable. */
export function boardBookmarks(json: string | unknown): PageBookmarkRef[] {
  let doc: unknown = json;

  if (typeof json === 'string') {
    try {
      doc = JSON.parse(json);
    } catch {
      return [];
    }
  }
  const pages = (doc as { pages?: unknown } | null)?.pages;

  if (!Array.isArray(pages)) return [];
  const list = pages.map((page) => (page && typeof page === 'object' ? (page as BoardPage) : ({} as BoardPage)));
  const labels = resolvePageLabels(list);
  const out: PageBookmarkRef[] = [];

  list.forEach((page, index) => {
    const at = page.bookmark?.at;

    if (typeof at !== 'number' || !Number.isFinite(at) || typeof page.id !== 'string' || !page.id || out.length >= MAX) return;
    const label = typeof page.bookmark?.label === 'string' ? page.bookmark.label.trim().slice(0, LABEL_MAX) : '';

    out.push({ boardPageId: page.id, index, pageLabel: labels[index], label: label || null, at: new Date(at).toISOString() });
  });

  return out;
}

export interface BookmarkEntry {
  page: Page;
  bookmark: PageBookmarkRef;
}

/** Every bookmark across notebooks: newest notebook first (the list order), then page order inside it. */
export function allBookmarks(pages: readonly Page[]): BookmarkEntry[] {
  return pages.flatMap((page) => (page.bookmarks ?? []).map((bookmark) => ({ page, bookmark })));
}

/** The notebook route opened on the bookmarked page. */
export function bookmarkHref(
  page: Pick<Page, 'id' | 'classId'>,
  bookmark: Pick<PageBookmarkRef, 'boardPageId'>,
  from?: NotebookFrom,
): string {
  const params = new URLSearchParams({ id: page.id, page: bookmark.boardPageId });

  if (page.classId) params.set('classId', page.classId);
  // Back on the notebook returns to the screen the bookmark was picked on (lib/notebooks/back.ts).
  if (from) params.set('from', from);

  return `/notebook/?${params.toString()}`;
}
