// Data for lecture notes: the class's lectures (modules + concept maps), its meeting days (Class.meetings,
// else the A plan), the default pick, and the create / attach actions (page + lecture fields on the
// backend once it has them, the device record always, and the concept-map link).
import type { LectureNoteMeta, LecturePick, LectureRef } from './lib/lectures';
import type { APlanResponse } from '@/features/aplan/types';
import type { Page, StudyClass } from '@/lib/api/types';
import type { QueryClient } from '@tanstack/react-query';

import { useEffect, useMemo } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  deriveLectures,
  lectureFields,
  linksToMigrate,
  mergeLectureMetas,
  notesForLecture,
  pageFieldsSupported,
  pickWithSession,
  sessionLecture,
} from './lib/lectures';
import { resolveMeetingDays } from './lib/meetings';
import { useLectureNoteMetas, writeLectureNoteMeta } from './store';

import { aplanKeys, getAPlan } from '@/features/aplan/api';
import { toMeetings } from '@/features/aplan/lib/normalize';
import { isBuilding } from '@/features/aplan/lib/poll';
import { listConceptMaps } from '@/features/conceptmaps/api';
import { conceptMapKeys, useConceptMaps } from '@/features/conceptmaps/hooks';
import { type MapWithNotes, saveNotesPageIds } from '@/features/conceptmaps/notes/api';
import {
  addLink,
  browserStore,
  pageIdsOf,
  readLinks,
  serverPageIds,
  writeLinks,
} from '@/features/conceptmaps/notes/links';
import { localIso, termStartFor } from '@/features/guide/lib/schedule';
import { createPage, patchPage } from '@/lib/api/endpoints';
import { studyKeys, useClassModules, usePages } from '@/lib/api/hooks';
import { rememberPages } from '@/lib/notebooks/pages-cache';

export { useLectureNoteMetas };

/** Every lecture the class names (Canvas modules + concept maps), by week. */
export function useClassLectures(classId: string) {
  const modules = useClassModules(classId);
  const maps = useConceptMaps(classId);
  const lectures = useMemo(() => deriveLectures(modules.data ?? [], maps.data ?? []), [maps.data, modules.data]);

  return { lectures, isLoading: modules.isLoading && !modules.data };
}

const aPlanQuery = (classId: string) => ({
  queryKey: aplanKeys.aPlan(classId),
  queryFn: () => getAPlan(classId),
  enabled: !!classId,
  staleTime: 60_000,
  retry: false,
});

/** Weekdays (0 = Sun) the class meets, from its A plan; [] while unknown. */
export const meetingDaysOf = (data: APlanResponse | undefined): number[] =>
  data && !isBuilding(data)
    ? [...new Set((toMeetings(data.meetings ?? null)?.slots ?? []).map((slot) => slot.day))]
    : [];

/** A backend that sends `Class.meetings` decides; the A plan is only asked when it does not. */
const needsAPlan = (cls: StudyClass | undefined) => !!cls && !('meetings' in cls);

/** Weekdays (0 = Sun) the class meets: Class.meetings, else its A plan; [] = unknown. */
export function useMeetingDays(cls: StudyClass | undefined): number[] {
  const { data } = useQuery({ ...aPlanQuery(cls?.id ?? ''), enabled: needsAPlan(cls) });
  const aPlanDays = useMemo(() => meetingDaysOf(data), [data]);

  return useMemo(() => (cls ? resolveMeetingDays(cls, aPlanDays).days : []), [aPlanDays, cls]);
}

/** Meeting days for many classes at once (Today). */
export function useMeetingDaysByClass(classes: readonly StudyClass[]): Map<string, number[]> {
  const aPlanDays = useQueries({
    queries: classes.map((cls) => ({ ...aPlanQuery(cls.id), enabled: needsAPlan(cls) })),
    combine: (results) => results.map((result) => meetingDaysOf(result.data)),
  });
  const signature = JSON.stringify(aPlanDays);

  return useMemo(
    () => new Map(classes.map((cls, index) => [cls.id, resolveMeetingDays(cls, aPlanDays[index] ?? []).days])),
    [classes, signature],
  );
}

export const todayIso = () => localIso(new Date());

export const termStartOf = (cls: StudyClass | undefined) =>
  cls ? termStartFor(cls as unknown as { term: string } & Record<string, unknown>) : null;

/**
 * The sheet's default: today's lecture on a meeting day, else the next or the latest — and today's
 * dated session note («MATH 101 — Week 7 · Mon Oct 5») whenever no lecture fits, so a note can
 * always start.
 */
export function useDefaultLecture(
  cls: StudyClass | undefined,
  lectures: readonly LectureRef[],
): { pick: LecturePick; session: LectureRef } {
  const meetingDays = useMeetingDays(cls);
  const termStart = termStartOf(cls);
  const code = cls?.code ?? 'Class';
  const today = todayIso();

  return useMemo(() => {
    const session = sessionLecture(code, termStart, today);

    return { pick: pickWithSession(lectures, { meetingDays, termStart, today }, session), session };
  }, [code, lectures, meetingDays, termStart, today]);
}

/**
 * Whether the backend keeps the lecture fields on Page: null until a listing with pages shows it.
 * While false / unknown the device record is the only copy (the title is the cross-device fallback).
 */
let fieldsSupported: boolean | null = null;

export const pageFieldsKnown = () => fieldsSupported;

function noteSupport(pages: readonly Page[]) {
  const seen = pageFieldsSupported(pages);

  if (seen !== null) fieldsSupported = seen;
}

/** Device-only links already pushed this session (one PATCH per page, even with many hosts mounted). */
const migrated = new Set<string>();

/**
 * Pages of a class and their lecture links: the server's fields when the backend has them, this
 * device's records otherwise. The first listing that shows the fields pushes device-only links up once.
 */
export function useLectureNotesOf(classId: string) {
  const queryClient = useQueryClient();
  const pages = usePages({ classId });
  const device = useLectureNoteMetas();
  const list = useMemo(() => pages.data ?? [], [pages.data]);
  const supported = useMemo(() => pageFieldsSupported(list), [list]);
  const metas = useMemo(() => mergeLectureMetas(list, device, classId), [classId, device, list]);

  useEffect(() => {
    noteSupport(list);
    if (supported !== true) return;
    const todo = linksToMigrate(list, device).filter(({ page }) => !migrated.has(page.id));

    if (todo.length === 0) return;
    todo.forEach(({ page }) => migrated.add(page.id));
    void Promise.allSettled(todo.map(({ page, meta }) => patchPage(page.id, lectureFields(meta)))).then(() =>
      queryClient.invalidateQueries({ queryKey: studyKeys.pages(classId) }),
    );
  }, [classId, device, list, queryClient, supported]);

  return { pages: list, metas, supported, isLoading: pages.isLoading && !pages.data };
}

/** The lecture a page is filed under: its server fields, else this device's record. */
export function usePageLecture(page: Page | null): LectureNoteMeta | null {
  const device = useLectureNoteMetas();

  return useMemo(
    () => (page ? (mergeLectureMetas([page], device, page.classId ?? '')[page.id] ?? null) : null),
    [device, page],
  );
}

export const metaFor = (classId: string, lecture: LectureRef): LectureNoteMeta => ({
  classId,
  key: lecture.key,
  week: lecture.week,
  lecture: lecture.lecture,
  topic: lecture.topic,
  moduleId: lecture.moduleId,
  mapId: lecture.mapId,
  date: todayIso(),
});

/**
 * Adds the page to the lecture's concept map: this device's link table first (the notes workspace
 * reads it, lined paper and all), then PATCH {notesPageIds} with the ids already on the map kept.
 */
export async function linkPageToMap(
  queryClient: QueryClient,
  classId: string,
  mapId: string,
  page: Pick<Page, 'id' | 'title'>,
  fresh = false,
) {
  const store = browserStore();
  const links = addLink(readLinks(store, mapId), {
    kind: 'page',
    pageId: page.id,
    title: page.title,
    // A note started here opens on lined paper wherever the map workspace seeds it.
    ...(fresh ? { paper: 'lined' as const } : {}),
  });

  writeLinks(store, mapId, links);
  const maps = await queryClient
    .fetchQuery({ queryKey: conceptMapKeys.list(classId), queryFn: () => listConceptMaps(classId), staleTime: 30_000 })
    .catch(() => []);
  const map = maps.find((row) => row.id === mapId);
  const existing = (map && serverPageIds(map as MapWithNotes)) ?? [];
  const ids = [...new Set([...existing, ...pageIdsOf(links)])];

  try {
    const saved = await saveNotesPageIds(mapId, ids);

    if (saved) void queryClient.invalidateQueries({ queryKey: conceptMapKeys.list(classId) });
  } catch {
    // The device link holds; the notes workspace pushes it up on its next change.
  }
}

/**
 * Files the page under the lecture (and renames it when `title` differs): the device record always,
 * the backend's fields unless it is known not to have them, then the concept-map link.
 */
export async function attachPageToLecture(
  queryClient: QueryClient,
  classId: string,
  page: Pick<Page, 'id' | 'title'>,
  lecture: LectureRef,
  title?: string,
): Promise<Pick<Page, 'id' | 'title'>> {
  const meta = metaFor(classId, lecture);
  const rename = title?.trim() && title.trim() !== page.title ? title.trim() : undefined;
  let filed: Pick<Page, 'id' | 'title'> = page;

  writeLectureNoteMeta(page.id, meta);
  if (fieldsSupported !== false) {
    try {
      const saved = await patchPage(page.id, { ...lectureFields(meta), ...(rename ? { title: rename } : {}) });

      if (saved && typeof saved === 'object' && 'id' in saved) {
        rememberPages([saved]);
        filed = saved;
      }
      void queryClient.invalidateQueries({ queryKey: studyKeys.pages(classId) });
    } catch {
      // No PATCH route yet: the device record holds the link; it goes up once the backend has the fields.
    }
  }
  if (lecture.mapId) await linkPageToMap(queryClient, classId, lecture.mapId, filed);

  return filed;
}

/** «New lecture note»: a lined note page titled for the lecture, recorded and linked. */
export async function createLectureNote(
  queryClient: QueryClient,
  { classId, lecture, title }: { classId: string; lecture: LectureRef; title: string },
): Promise<Page> {
  const meta = metaFor(classId, lecture);
  let page = await createPage({
    classId,
    title: title.trim() || 'Lecture notes',
    kind: 'note',
    // Only a backend known to keep them gets the fields on create (an older one may reject them).
    ...(fieldsSupported === true ? lectureFields(meta) : {}),
  });

  if ('week' in page) fieldsSupported = true;
  // The first note of a class with no pages yet: the reply shows the fields — file it right away.
  if (fieldsSupported === true && !page.lecture) {
    page = await patchPage(page.id, lectureFields(meta)).catch(() => page);
  }
  rememberPages([page]);
  writeLectureNoteMeta(page.id, meta);
  void queryClient.invalidateQueries({ queryKey: studyKeys.pages(classId) });
  if (lecture.mapId) void linkPageToMap(queryClient, classId, lecture.mapId, page, true);

  return page;
}

/** Today's note for a lecture, when one exists (a week entry only counts one started today). */
export function findLectureNote(
  pages: readonly Page[],
  metas: Readonly<Record<string, LectureNoteMeta>>,
  lecture: LectureRef,
): Page | null {
  return notesForLecture(pages, metas, lecture, todayIso())[0] ?? null;
}

export const notebookHref = (page: Pick<Page, 'id'>) => `/notebook/?id=${encodeURIComponent(page.id)}`;
