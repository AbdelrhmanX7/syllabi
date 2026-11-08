// Which concept map a lasso of handwriting on a notebook page is an attempt at. Pure, so the order of
// preference is unit-tested: the lecture note's own map → a map already linked to the page → the page's
// week → its lecture number (both from the lecture-note record first, the title second) → the newest
// map he has no score for → the newest map.
import type { ConceptMapRecord } from '../types';

import { lectureNumber } from '../notes/workspace-state';

export type MapPickReason = 'note' | 'linked' | 'week' | 'lecture' | 'unscored' | 'newest';

export interface MapPick {
  map: ConceptMapRecord;
  reason: MapPickReason;
}

/** "Week 5", "wk 5", "W5", "week_05" → 5. */
export function weekFromTitle(title: string | null | undefined): number | null {
  const match = /\b(?:week|wk|w)[\s_#-]*0*(\d{1,2})\b/i.exec(title ?? '');

  return match ? Number(match[1]) : null;
}

/** Newest first: highest number, then latest due date; practice maps after assigned ones. */
export function newestFirst(a: ConceptMapRecord, b: ConceptMapRecord): number {
  const practice = Number(a.source === 'practice') - Number(b.source === 'practice');

  if (practice !== 0) return practice;
  const number = (b.number ?? -1) - (a.number ?? -1);

  if (number !== 0) return number;

  return (b.dueAt ?? '').localeCompare(a.dueAt ?? '');
}

export interface PageContext {
  pageId: string;
  title: string;
  /** The page's lecture-note record (`pageLecture` in features/lecturenotes); each field wins over the title. */
  week?: number | null;
  lecture?: number | null;
  mapId?: string | null;
  /** Map ids this page is linked to (server `notesPageIds` or this device's links). */
  linkedMapIds?: readonly string[];
}

export function pickMapForPage(maps: readonly ConceptMapRecord[], page: PageContext): MapPick | null {
  if (maps.length === 0) return null;
  const sorted = [...maps].sort(newestFirst);
  const own = page.mapId ? sorted.find((map) => map.id === page.mapId) : undefined;

  if (own) return { map: own, reason: 'note' };
  const linked = new Set(page.linkedMapIds ?? []);
  const linkedMap = sorted.find((map) => linked.has(map.id));

  if (linkedMap) return { map: linkedMap, reason: 'linked' };

  const week = page.week ?? weekFromTitle(page.title);
  const byWeek = week !== null ? sorted.find((map) => map.week === week) : undefined;

  if (byWeek) return { map: byWeek, reason: 'week' };

  const lecture = page.lecture ?? lectureNumber(page.title);
  const byLecture =
    lecture !== null ? sorted.find((map) => lectureNumber(map.lecture) === lecture || map.number === lecture) : undefined;

  if (byLecture) return { map: byLecture, reason: 'lecture' };

  const unscored = sorted.find((map) => map.source !== 'practice' && map.score === null);

  if (unscored) return { map: unscored, reason: 'unscored' };

  return { map: sorted[0]!, reason: 'newest' };
}

/** The maps a page is linked to: by the server's `notesPageIds`, else by this device's link table. */
export function mapsLinkedToPage(
  maps: readonly (ConceptMapRecord & { notesPageIds?: unknown })[],
  pageId: string,
  devicePageIds: (mapId: string) => readonly string[],
): string[] {
  return maps
    .filter((map) => {
      const server = Array.isArray(map.notesPageIds) ? (map.notesPageIds as unknown[]) : null;

      return server ? server.includes(pageId) : devicePageIds(map.id).includes(pageId);
    })
    .map((map) => map.id);
}

export const PICK_REASON_TEXT: Record<MapPickReason, string> = {
  note: 'this lecture note’s map',
  linked: 'linked to this page',
  week: 'same week as this page',
  lecture: 'same lecture as this page',
  unscored: 'newest map without a score',
  newest: 'newest map',
};
