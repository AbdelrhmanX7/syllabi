// Lecture notes — which lecture is which, and which note belongs to it. Pure: the class's lecture
// list comes from the Canvas modules («Week 6: …» modules holding «Lecture 8 …» items) and the concept
// maps (week + «L8 Volcanoes»); today's lecture comes from the A-plan meeting days and the term start.

/** Just what the derivation reads off a Canvas module. */
export interface ModuleLike {
  id: string;
  name: string;
  items: { id: string; title: string }[];
}

/** Just what the derivation reads off a concept map. */
export interface MapLike {
  id: string;
  week: number | null;
  lecture: string | null;
  number?: number | null;
  source?: string;
}

/** What a class calls its numbered sessions; `Session` = a dated note for a class with none that day. */
export type SessionKind = 'Lecture' | 'Lesson' | 'Lab' | 'Session';

export interface LectureRef {
  /**
   * `L8` lecture, `LS12` lesson, `LB6` lab, `W8` a week with no numbers yet, `2026-10-05` a dated
   * session note.
   */
  key: string;
  /** Absent = Lecture (older records). */
  kind?: SessionKind;
  /** A dated session's full title («MATH 101 — Week 7 · Mon Oct 5»). */
  title?: string;
  week: number | null;
  lecture: number | null;
  topic: string | null;
  moduleId: string | null;
  mapId: string | null;
  /** Canvas items that name this lecture («Lecture 8 Worksheet», «Lecture 8 videos»). */
  itemIds: string[];
}

const DAY_MS = 86_400_000;

/** «Week 6: Exam 1», «🥼 Week 1 — Intro», «wk 6» → 6. */
export function weekOfName(name: string | null | undefined): number | null {
  const match = /\b(?:week|wk)[\s_#-]*0*(\d{1,2})\b/i.exec(name ?? '');

  return match ? Number(match[1]) : null;
}

/** «Lecture 8», «Lecture Activity 8», «▶️ Lecture 8 videos», «Lec 8», «L8 Volcanoes» → 8. */
export function lectureOfTitle(title: string | null | undefined): number | null {
  const text = title ?? '';
  const long = /\b(?:lecture|lec)(?:\s+activity)?[\s_#.-]*0*(\d{1,2})\b/i.exec(text);

  if (long) return Number(long[1]);
  const short = /(?:^|\s)L[\s_-]?0*(\d{1,2})\b/.exec(text);

  return short ? Number(short[1]) : null;
}

const KEY_PREFIX: Record<Exclude<SessionKind, 'Session'>, string> = { Lecture: 'L', Lesson: 'LS', Lab: 'LB' };

export const sessionKey = (kind: Exclude<SessionKind, 'Session'>, number: number) => `${KEY_PREFIX[kind]}${number}`;

/**
 * «Lecture 8 Worksheet» / «L8 …» → Lecture 8, «Lesson 14: Rates…» → Lesson 14, «Lab 6 Overview» → Lab 6
 * («Lab Quiz 1» is not a lab number).
 */
export function sessionOfTitle(
  title: string | null | undefined,
): { kind: Exclude<SessionKind, 'Session'>; number: number } | null {
  const text = title ?? '';
  const match = /\b(lecture|lec|lesson|lab)(?:\s+activity)?[\s_#.:-]*0*(\d{1,2})\b/i.exec(text);

  if (match) {
    const word = match[1]!.toLowerCase();

    return { kind: word === 'lesson' ? 'Lesson' : word === 'lab' ? 'Lab' : 'Lecture', number: Number(match[2]) };
  }
  const lecture = lectureOfTitle(text);

  return lecture !== null ? { kind: 'Lecture', number: lecture } : null;
}

/** Emoji and pictographs off, spaces squeezed. */
const clean = (text: string) =>
  text
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/** «🌋 Week 7: Volcanoes» → «Volcanoes»; null when the name is only the week. */
export function moduleTopic(name: string): string | null {
  const text = clean(name)
    .replace(/^.*?\b(?:week|wk)[\s_#-]*\d{1,2}\b\s*[:.\-–—]?\s*/i, '')
    .trim();

  return text || null;
}

/** «Lesson 14: Related Rates (video 2)» → «Related Rates»; «Lab 6: Map Reading I» → «Map Reading I». */
export function sessionTopic(title: string): string | null {
  const text = clean(title)
    .replace(/^.*?\b(?:lecture|lec|lesson|lab)(?:\s+activity)?[\s_#.:-]*\d{1,2}\b\s*[:.\-–—]?\s*/i, '')
    .replace(/\s*\((?:video|part)\s*\d+\)\s*$/i, '')
    .trim();

  return text && !/^(overview|background reading|supplemental videos|supporting videos)$/i.test(text) ? text : null;
}

/** «L8 Volcanoes» / «Lecture 8: Volcanoes» → «Volcanoes». */
export function mapTopic(lecture: string | null): string | null {
  const text = clean(lecture ?? '')
    .replace(/^(?:lecture|lec|l)[\s_#.-]*\d{1,2}\b\s*[:.\-–—]?\s*/i, '')
    .trim();

  return text || null;
}

/**
 * Every lecture the class names, by week. Numbered lectures come from module items and concept maps
 * (a map's own topic wins over the module's); a week module with no lecture number in it still gets
 * one week entry so later weeks can be picked before Canvas posts their activities.
 */
export function deriveLectures(modules: readonly ModuleLike[], maps: readonly MapLike[] = []): LectureRef[] {
  const byNumber = new Map<string, LectureRef & { moduleTopic: string | null }>();
  const weekModules = new Map<number, { id: string; topic: string | null }>();
  const add = (
    session: { kind: Exclude<SessionKind, 'Session'>; number: number },
    fields: {
      week: number | null;
      moduleId: string;
      topic: string | null;
      moduleTopic: string | null;
      itemId?: string;
    },
  ) => {
    const key = sessionKey(session.kind, session.number);
    const entry = byNumber.get(key);

    if (entry) {
      if (fields.itemId) entry.itemIds.push(fields.itemId);
      entry.topic ??= fields.topic;

      return;
    }
    byNumber.set(key, {
      key,
      ...(session.kind === 'Lecture' ? {} : { kind: session.kind }),
      week: fields.week,
      lecture: session.number,
      topic: fields.topic,
      moduleTopic: fields.moduleTopic,
      moduleId: fields.moduleId,
      mapId: null,
      itemIds: fields.itemId ? [fields.itemId] : [],
    });
  };

  for (const mod of modules) {
    const week = weekOfName(mod.name);
    const topic = week !== null ? moduleTopic(mod.name) : null;
    // A module that IS a session («Lab 6: Map Reading I») — listed even before Canvas fills it.
    const own = week === null ? sessionOfTitle(mod.name) : null;

    if (week !== null && !weekModules.has(week)) weekModules.set(week, { id: mod.id, topic });
    if (own && own.kind !== 'Lecture')
      add(own, { week, moduleId: mod.id, topic: sessionTopic(mod.name), moduleTopic: null });
    for (const item of mod.items) {
      const session = sessionOfTitle(item.title);

      if (!session) continue;
      // Lessons carry their topic in the title; lectures / labs take the module's.
      const itemTopic = session.kind === 'Lesson' ? sessionTopic(item.title) : null;

      add(session, { week, moduleId: mod.id, topic: itemTopic, moduleTopic: topic, itemId: item.id });
    }
  }

  // Maps only add lectures to a class Canvas organises by week or lecture number (a lesson-numbered
  // class keeps its own list; a stray map never invents «Lecture 3» there).
  const lectureNumbered = weekModules.size > 0 || [...byNumber.values()].some((entry) => !entry.kind);

  for (const map of maps) {
    if (map.source === 'practice') continue;
    if (!lectureNumbered && !byNumber.has(sessionKey('Lecture', lectureOfTitle(map.lecture) ?? -1))) continue;
    const lecture = lectureOfTitle(map.lecture);

    if (lecture === null) continue;
    const entry = byNumber.get(sessionKey('Lecture', lecture)) ?? {
      key: `L${lecture}`,
      week: map.week,
      lecture,
      topic: null,
      moduleTopic: null,
      moduleId: null,
      mapId: null,
      itemIds: [],
    };

    entry.week ??= map.week;
    entry.topic ??= mapTopic(map.lecture);
    entry.mapId ??= map.id;
    byNumber.set(entry.key, entry);
  }

  const numbered: LectureRef[] = [...byNumber.values()].map(({ moduleTopic: fromModule, ...entry }) => {
    const weekModule = entry.week !== null ? weekModules.get(entry.week) : undefined;

    return {
      ...entry,
      moduleId: entry.moduleId ?? weekModule?.id ?? null,
      topic: entry.topic ?? fromModule ?? weekModule?.topic ?? null,
    };
  });
  const coveredWeeks = new Set(numbered.map((entry) => entry.week));
  const kindRank = (entry: LectureRef) => ['Lecture', 'Lesson', 'Lab'].indexOf(entry.kind ?? 'Lecture');
  const weekOnly: LectureRef[] = [...weekModules.entries()]
    .filter(([week]) => !coveredWeeks.has(week))
    .map(([week, weekMod]) => ({
      key: `W${week}`,
      week,
      lecture: null,
      topic: weekMod.topic,
      moduleId: weekMod.id,
      mapId: null,
      itemIds: [],
    }));

  return [...numbered, ...weekOnly].sort(
    (a, b) => (a.week ?? 99) - (b.week ?? 99) || kindRank(a) - kindRank(b) || (a.lecture ?? 999) - (b.lecture ?? 999),
  );
}

/** «Lecture 8 — Earthquakes» (the note's title); a week entry is «Week 8 — Weathering». */
export function lectureNoteTitle(lecture: LectureRef): string {
  if (lecture.title) return lecture.title;
  const head =
    lecture.lecture !== null ? `${lecture.kind ?? 'Lecture'} ${lecture.lecture}` : `Week ${lecture.week ?? '?'}`;

  return lecture.topic ? `${head} — ${lecture.topic}` : head;
}

/** «Week 6 · Lecture 8 — Earthquakes» (the picker row). */
export function lectureLabel(lecture: LectureRef): string {
  if (lecture.lecture === null || lecture.title) return lectureNoteTitle(lecture);
  const head = lecture.week !== null ? `Week ${lecture.week} · ` : '';

  return `${head}${lectureNoteTitle(lecture)}`;
}

/* ------------------------------------------------------------------ dates */

/** Days since the epoch for a `YYYY-MM-DD` (timezone-free). */
export const dayNumber = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);

  return Math.round(Date.UTC(y!, (m ?? 1) - 1, d ?? 1) / DAY_MS);
};

const isoOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday). */
export const weekdayOf = (iso: string) => (((dayNumber(iso) + 4) % 7) + 7) % 7;

/** Term week of a date: the term-start week is week 1. */
export function termWeek(termStart: string, iso: string): number {
  return Math.floor((dayNumber(iso) - dayNumber(termStart)) / 7) + 1;
}

export interface LecturePick {
  lecture: LectureRef;
  /** `today` = a meeting day and this is its lecture; `next` = the next meeting's; `last` = latest so far. */
  reason: 'today' | 'next' | 'last' | 'first';
  /** The meeting date the pick is for (`today` / `next`). */
  date: string | null;
}

/**
 * The lecture a meeting date covers: the n-th meeting of its week takes the n-th numbered lecture of
 * that week (a spare meeting keeps the week's last one); a week with no numbers yields its week entry.
 */
export function lectureOnDate(
  lectures: readonly LectureRef[],
  meetingDays: readonly number[],
  termStart: string,
  iso: string,
): LectureRef | null {
  const days = [...new Set(meetingDays)].sort((a, b) => a - b);
  const index = days.indexOf(weekdayOf(iso));

  if (index < 0) return null;
  const week = termWeek(termStart, iso);
  const ofWeek = lectures.filter((lecture) => lecture.week === week);
  const numbered = ofWeek.filter((lecture) => lecture.lecture !== null);

  if (numbered.length > 0) return numbered[Math.min(index, numbered.length - 1)]!;

  return ofWeek[0] ?? null;
}

/**
 * The lecture the «New lecture note» sheet opens on. A meeting day → that day's lecture. Otherwise the
 * next meeting's (two weeks ahead at most), else the latest lecture up to this week, else the first.
 */
export function pickDefaultLecture(
  lectures: readonly LectureRef[],
  options: { meetingDays: readonly number[]; termStart: string | null; today: string },
): LecturePick | null {
  if (lectures.length === 0) return null;
  const { meetingDays, termStart, today } = options;

  if (termStart && meetingDays.length > 0) {
    const onToday = lectureOnDate(lectures, meetingDays, termStart, today);

    if (onToday) return { lecture: onToday, reason: 'today', date: today };
    for (let offset = 1; offset <= 14; offset += 1) {
      const date = isoOf(dayNumber(today) + offset);
      const next = lectureOnDate(lectures, meetingDays, termStart, date);

      if (next) return { lecture: next, reason: 'next', date };
    }
  }

  if (termStart) {
    const week = termWeek(termStart, today);
    const sofar = lectures.filter((lecture) => lecture.week !== null && lecture.week <= week);

    if (sofar.length > 0) return { lecture: sofar[sofar.length - 1]!, reason: 'last', date: null };
  }

  return { lecture: lectures[0]!, reason: 'first', date: null };
}

/**
 * A dated note for one class meeting, for a class whose Canvas names no lecture that day:
 * «MATH 101 — Week 7 · Mon Oct 5», keyed by the date.
 */
export function sessionLecture(courseCode: string, termStart: string | null, iso: string): LectureRef {
  const week = termStart ? termWeek(termStart, iso) : null;
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T12:00:00Z`))
    .replace(',', '');

  return {
    key: iso,
    kind: 'Session',
    title: `${courseCode} — ${week !== null && week >= 1 ? `Week ${week} · ` : ''}${day}`,
    week: week !== null && week >= 1 ? week : null,
    lecture: null,
    topic: null,
    moduleId: null,
    mapId: null,
    itemIds: [],
  };
}

/**
 * The default with a dated note to fall back on: on a meeting day, that day's lecture or else today's
 * session note; on other days the next / latest lecture, and the session note when nothing dates one.
 */
export function pickWithSession(
  lectures: readonly LectureRef[],
  options: { meetingDays: readonly number[]; termStart: string | null; today: string },
  session: LectureRef,
): LecturePick {
  const { meetingDays, termStart, today } = options;

  if (meetingDays.includes(weekdayOf(today))) {
    const onToday = termStart ? lectureOnDate(lectures, meetingDays, termStart, today) : null;

    return { lecture: onToday ?? session, reason: 'today', date: today };
  }
  const pick = pickDefaultLecture(lectures, options);

  return pick && pick.reason !== 'first' ? pick : { lecture: session, reason: 'first', date: null };
}

/* ------------------------------------------------------------------ notes ↔ lectures */

/** What this device remembers about a lecture note (the backend has no field for it yet). */
export interface LectureNoteMeta {
  classId: string;
  key: string;
  week: number | null;
  lecture: number | null;
  topic: string | null;
  moduleId: string | null;
  mapId: string | null;
  /** `YYYY-MM-DD` the note was started (a week entry has one note per meeting). */
  date: string;
}

export interface PageLike {
  id: string;
  title: string;
  updatedAt: string;
}

/** The lecture a page belongs to: its device record, else the «Lecture N» in its title. */
export function lectureKeyOf(page: PageLike, meta: LectureNoteMeta | undefined): string | null {
  if (meta) return meta.key;
  const session = sessionOfTitle(page.title);

  return session ? sessionKey(session.kind, session.number) : null;
}

/** The week a page belongs to: device record → its lecture's week → «Week N» in its title. */
export function weekOfPage(
  page: PageLike,
  meta: LectureNoteMeta | undefined,
  lectures: readonly LectureRef[],
): number | null {
  if (meta?.week != null) return meta.week;
  const key = lectureKeyOf(page, meta);
  const lecture = key ? lectures.find((row) => row.key === key) : undefined;

  return lecture?.week ?? weekOfName(page.title);
}

/** Notes of one lecture, newest first. A week entry only counts notes started on `date` when given. */
export function notesForLecture<P extends PageLike>(
  pages: readonly P[],
  metas: Readonly<Record<string, LectureNoteMeta>>,
  lecture: LectureRef,
  date?: string,
): P[] {
  return pages
    .filter((page) => {
      const meta = metas[page.id];

      if (lectureKeyOf(page, meta) !== lecture.key) return false;
      if (lecture.lecture === null && date) return meta?.date === date;

      return true;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Pages grouped by week (pages with no week are left out). */
export function notesByWeek<P extends PageLike>(
  pages: readonly P[],
  metas: Readonly<Record<string, LectureNoteMeta>>,
  lectures: readonly LectureRef[],
): Map<number, P[]> {
  const out = new Map<number, P[]>();

  for (const page of pages) {
    const week = weekOfPage(page, metas[page.id], lectures);

    if (week === null) continue;
    out.set(week, [...(out.get(week) ?? []), page]);
  }

  return out;
}

/* ------------------------------------------------------------------ server fields (Page.week / lecture) */

/** What a Page carries once the backend has the lecture-note fields (`week` present, even null). */
export interface PageWithLecture extends PageLike {
  classId?: string | null;
  week?: number | null;
  moduleId?: string | null;
  lecture?: { number: number | null; key: string; date: string } | null;
}

/** True once a listing shows the fields, false when it shows pages without them, null with no pages. */
export function pageFieldsSupported(pages: readonly PageWithLecture[]): boolean | null {
  if (pages.length === 0) return null;

  return pages.some((page) => 'week' in page || 'lecture' in page);
}

/** The page's own lecture link, as a device-style record (null topic / map: the lectures list has them). */
export function serverLectureMeta(page: PageWithLecture, classId: string): LectureNoteMeta | undefined {
  if (!page.lecture?.key) return undefined;

  return {
    classId: page.classId ?? classId,
    key: page.lecture.key,
    week: page.week ?? null,
    lecture: page.lecture.number ?? null,
    topic: null,
    moduleId: page.moduleId ?? null,
    mapId: null,
    date: page.lecture.date,
  };
}

/**
 * One record per page: the server's link wins (the device copy only fills topic / map when it points
 * at the same lecture); pages the server has not filed keep this device's record.
 */
export function mergeLectureMetas(
  pages: readonly PageWithLecture[],
  device: Readonly<Record<string, LectureNoteMeta>>,
  classId: string,
): Record<string, LectureNoteMeta> {
  const out: Record<string, LectureNoteMeta> = { ...device };

  for (const page of pages) {
    const server = serverLectureMeta(page, classId);

    if (!server) continue;
    const local = device[page.id];

    out[page.id] = local && local.key === server.key ? { ...server, topic: local.topic, mapId: local.mapId } : server;
  }

  return out;
}

/** Pages filed on this device that the backend (which has the fields) does not know about yet. */
export function linksToMigrate<P extends PageWithLecture>(
  pages: readonly P[],
  device: Readonly<Record<string, LectureNoteMeta>>,
): { page: P; meta: LectureNoteMeta }[] {
  return pages.flatMap((page) => {
    const meta = device[page.id];

    return meta && 'week' in page && !page.lecture ? [{ page, meta }] : [];
  });
}

/** The body the backend keeps for a lecture link. */
export const lectureFields = (meta: Pick<LectureNoteMeta, 'week' | 'moduleId' | 'lecture' | 'key' | 'date'>) => ({
  // The backend 400s the whole body on a week outside 1..30 or a lecture number outside 1..200.
  week: meta.week !== null && Number.isInteger(meta.week) && meta.week >= 1 && meta.week <= 30 ? meta.week : null,
  moduleId: meta.moduleId,
  lecture: {
    number: meta.lecture !== null && Number.isInteger(meta.lecture) && meta.lecture >= 1 && meta.lecture <= 200 ? meta.lecture : null,
    key: meta.key.slice(0, 80),
    date: meta.date,
  },
});

/** The short name of a filed page's lecture: «Lecture 8», «Lesson 12», «Lab 6», «Week 8», «Oct 5». */
export function metaLabel(meta: Pick<LectureNoteMeta, 'key' | 'lecture' | 'week' | 'date'>): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(meta.key)) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${meta.key}T12:00:00Z`),
    );
  }
  if (meta.lecture === null) return `Week ${meta.week ?? '?'}`;
  const kind = meta.key.startsWith('LS') ? 'Lesson' : meta.key.startsWith('LB') ? 'Lab' : 'Lecture';

  return `${kind} ${meta.lecture}`;
}
