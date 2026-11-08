// Pure state for the notes + map workspace: the professor's concept chips he ticks as he places
// each term, the leading questions for the lecture, and the split ratio. Device-only, keyed by map.
import type { KeyValueStore } from './links';

/* ------------------------------------------------------------------ concept chips */

export const TICKS_KEY = 'study_cm_ticks';

export const normTerm = (term: string) => term.trim().toLowerCase().replace(/\s+/g, ' ');

/** Ticked terms for a map, as typed on the map (case and spacing do not matter). */
export function readTicks(store: KeyValueStore | null, mapId: string): string[] {
  if (!store) return [];
  try {
    const table = JSON.parse(store.getItem(TICKS_KEY) ?? '{}') as Record<string, unknown>;
    const rows = table?.[mapId];

    return Array.isArray(rows) ? rows.filter((row): row is string => typeof row === 'string') : [];
  } catch {
    return [];
  }
}

export function writeTicks(store: KeyValueStore | null, mapId: string, ticked: string[]): void {
  if (!store) return;
  try {
    const table = JSON.parse(store.getItem(TICKS_KEY) ?? '{}') as Record<string, string[]>;

    if (ticked.length === 0) delete table[mapId];
    else table[mapId] = ticked;
    store.setItem(TICKS_KEY, JSON.stringify(table));
  } catch {
    // a refused write only loses the ticks on reload
  }
}

export function toggleTick(ticked: string[], term: string): string[] {
  const key = normTerm(term);

  return ticked.some((row) => normTerm(row) === key)
    ? ticked.filter((row) => normTerm(row) !== key)
    : [...ticked, term];
}

export type ChipState = 'placed' | 'todo' | 'missing-from-notes';

export interface ConceptChip {
  term: string;
  state: ChipState;
  /** The digest found this term in his notes but worded differently from the professor. */
  differs: boolean;
}

/**
 * One chip per professor term, in her order. Ticked = placed on the map. Not yet placed and listed
 * by the digest as absent from his notes = flagged, so he knows to take it from the slide instead.
 */
export function conceptChips(
  terms: string[],
  ticked: string[],
  digest?: { missingFromNotes?: string[]; concepts?: { term: string; matchesProfessor: boolean }[] } | null,
): ConceptChip[] {
  const done = new Set(ticked.map(normTerm));
  const missing = new Set((digest?.missingFromNotes ?? []).map(normTerm));
  const differs = new Set(
    (digest?.concepts ?? []).filter((row) => !row.matchesProfessor).map((row) => normTerm(row.term)),
  );
  const seen = new Set<string>();

  return terms.flatMap((term) => {
    const key = normTerm(term);

    if (!key || seen.has(key)) return [];
    seen.add(key);

    return [
      {
        term: term.trim(),
        state: done.has(key) ? 'placed' : missing.has(key) ? 'missing-from-notes' : 'todo',
        differs: differs.has(key),
      },
    ];
  });
}

export function chipProgress(chips: ConceptChip[]): { placed: number; total: number } {
  return { placed: chips.filter((chip) => chip.state === 'placed').length, total: chips.length };
}

/* ------------------------------------------------------------------ leading questions */

/** "Lecture 4", "L4", "lecture_4" → 4. */
export function lectureNumber(lecture: string | null | undefined): number | null {
  const match = /\b(?:lecture|lec|l)[\s_#-]*(\d{1,2})\b/i.exec(lecture ?? '');

  return match ? Number(match[1]) : null;
}

const QUESTION_LINE = /^\s*(?:[-*+]|\d+[.)])?\s*(?:\*\*)?(?:Q\d*[:.]\s*)?(.+?\?)(?:\*\*)?\s*$/;

/**
 * The professor's leading questions for a lecture, from the class guide markdown. Questions are the
 * lines ending in «?» under a heading that names the lecture (number or title) or the week; lines
 * outside any matching section are ignored, so another lecture's questions never leak in.
 */
export function leadingQuestions(
  markdown: string | null | undefined,
  target: { week?: number | null; lecture?: string | null },
): string[] {
  if (!markdown) return [];
  const number = lectureNumber(target.lecture);
  const title = (target.lecture ?? '')
    .replace(/^\s*(?:lecture|lec|l)[\s_#-]*\d+\s*[:.-]?\s*/i, '')
    .trim()
    .toLowerCase();
  const headingMatches = (heading: string) => {
    const text = heading.toLowerCase();

    if (number !== null && new RegExp(`\\b(?:lecture|lec|l)[\\s_#-]*${number}\\b`, 'i').test(text)) return true;
    if (title.length >= 4 && text.includes(title)) return true;
    if (target.week != null && new RegExp(`\\bweek\\s*${target.week}\\b`, 'i').test(text)) return true;

    return false;
  };
  const out: string[] = [];
  let inSection = false;
  let sectionLevel = 0;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);

    if (heading) {
      const level = heading[1]!.length;

      if (inSection && level > sectionLevel) continue;
      inSection = headingMatches(heading[2]!);
      sectionLevel = level;
      continue;
    }
    if (!inSection) continue;
    const question = QUESTION_LINE.exec(line);

    if (question) {
      const text = question[1]!.replace(/\*\*/g, '').trim();

      if (text.length > 3 && !out.includes(text)) out.push(text);
    }
  }

  return out;
}

/** Guide questions first, then the digest's (from his own notes), without repeats. */
export function mergeQuestions(guide: string[], fromNotes: string[]): string[] {
  const seen = new Set<string>();

  return [...guide, ...fromNotes].filter((question) => {
    const key = normTerm(question);

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
}

/* ------------------------------------------------------------------ split */

export const SPLIT_KEY = 'study_cm_split';
export const SPLIT_MIN = 0.25;
export const SPLIT_MAX = 0.75;

export const clampSplit = (ratio: number) =>
  Number.isFinite(ratio) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio)) : 0.5;

export function readSplit(store: KeyValueStore | null): number {
  if (!store) return 0.5;
  try {
    const raw = store.getItem(SPLIT_KEY);

    return raw === null ? 0.5 : clampSplit(Number(raw));
  } catch {
    return 0.5;
  }
}

export function writeSplit(store: KeyValueStore | null, ratio: number): void {
  try {
    store?.setItem(SPLIT_KEY, String(Math.round(clampSplit(ratio) * 1000) / 1000));
  } catch {
    // a refused write just resets the divider next time
  }
}
