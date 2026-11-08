// The professor's concept list for a map that came without one (an in-class map, or an assigned map
// the import found no terms for). Saved with PATCH /concept-maps/:id {promptTerms}; until the backend
// accepts that, the list lives on this device keyed by map id and is retried on the next open.
import type { KeyValueStore } from './links';

import { parseTermList } from '../lib/terms';

export const TERMS_KEY = 'study_cm_terms';

type TermTable = Record<string, string[]>;

function readTable(store: KeyValueStore | null): TermTable {
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(TERMS_KEY) ?? '{}') as unknown;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const table: TermTable = {};

    for (const [mapId, terms] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(terms)) {
        const clean = terms.filter((term): term is string => typeof term === 'string' && term.trim().length > 0);

        if (clean.length > 0) table[mapId] = clean;
      }
    }

    return table;
  } catch {
    return {};
  }
}

export function readLocalTerms(store: KeyValueStore | null, mapId: string): string[] {
  return readTable(store)[mapId] ?? [];
}

/** An empty list clears the entry (the backend has it now). */
export function writeLocalTerms(store: KeyValueStore | null, mapId: string, terms: string[]): void {
  if (!store) return;
  try {
    const table = readTable(store);

    if (terms.length === 0) delete table[mapId];
    else table[mapId] = terms;
    store.setItem(TERMS_KEY, JSON.stringify(table));
  } catch {
    // refused: the list is lost on reload, the PATCH may still have landed
  }
}

/**
 * The map as the screens should see it: the backend's terms when it has any, else the list saved on
 * this device — so Practice, Compare («Draw it» / reference) and grading work before the PATCH lands.
 */
export function withLocalTerms<T extends { id: string; promptTerms: string[] }>(
  map: T,
  store: KeyValueStore | null,
): T {
  if (map.promptTerms.length > 0) return map;
  const local = readLocalTerms(store, map.id);

  return local.length > 0 ? { ...map, promptTerms: local } : map;
}

/** Terms on the device that the backend still lacks — the retry list on open. */
export function pendingTerms(map: { id: string; promptTerms: string[] }, store: KeyValueStore | null): string[] {
  return map.promptTerms.length > 0 ? [] : readLocalTerms(store, map.id);
}

/**
 * The model's reply to «list the concept terms on this slide» → a term list. Copes with bullets,
 * numbering, a lead-in line ending in a colon, bold markers and «and»/«&» before the last term.
 */
export function termsFromReply(text: string): string[] {
  const body = text
    .replace(/\*\*|__|`/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    // «Here are the terms:» and similar lead-ins.
    .filter((line) => line.length > 0 && !/:\s*$/.test(line))
    .map((line) => line.replace(/^(?:[-*•·]|\d+[.)])\s*/, ''))
    .join('\n')
    .replace(/,?\s+(?:and|&)\s+(?=[^,\n]+$)/i, ', ');

  return parseTermList(body)
    .map((term) => term.replace(/[.;:]+$/, '').trim())
    .filter((term) => term.length > 0 && term.length <= 60);
}
