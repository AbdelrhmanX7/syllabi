// Transport for the owner's glyph bank: GET / PUT `/study/handwriting/bank` through the Study
// transport (LIVE since BE #635; force-mock answers from `./mock`, which emulates the same contract).
// Optimistic concurrency on `version`, carried in `If-Match` (the ETag is `"<version>"`).
//
//   GET /study/handwriting/bank → 200 { version, etag, bank } (+ ETag header) | 404 = no bank yet
//   PUT /study/handwriting/bank  { bank }  If-Match: "<version>" (omitted when we hold none)
//       → 200 { version, etag } (no bank echoed — ours was stored as sent)
//       | 412 stale If-Match (or an If-Match with no bank) | 428 no If-Match but a bank exists
//       | 413 over 2 MB
// 412/428 carry no copy: `GlyphBankConflictError(null)` makes the sync pull again and re-merge.
// 401/403/405/501 and a bare 404 (no route) → `GlyphBankUnavailableError` (device-only).
import type { GlyphBank, GlyphBankRemoteSnapshot } from '@repo/whiteboard-react';

import { EMPTY_GLYPH_BANK, GlyphBankConflictError, GlyphBankUnavailableError } from '@repo/whiteboard-react';

import { isStudyApiError } from '@/lib/api/errors';
import { studyGet, studyPut } from '@/lib/api/http';
import { stripSample } from '@/lib/api/sample';

export const HANDWRITING_BANK_PATH = '/handwriting/bank';

/** GET answer. */
export interface HandwritingBankWire {
  version: number;
  etag?: string;
  bank: GlyphBank;
}

/** PUT answer — no bank echoed. */
export interface HandwritingBankSaved {
  version: number;
  etag?: string;
}

/** Thrown for a 413: the bank is over the server's 2 MB cap (a sync error, not "unavailable"). */
export class GlyphBankTooLargeError extends Error {
  constructor() {
    super('Your handwriting is over the server limit (2 MB) — saved on this tablet only');
    this.name = 'GlyphBankTooLargeError';
  }
}

function isBank(value: unknown): value is GlyphBank {
  return Boolean(value && typeof value === 'object' && typeof (value as GlyphBank).glyphs === 'object');
}

/** The server body → a snapshot; a body without a bank reads as «no bank yet». */
export function parseBankWire(value: unknown): GlyphBankRemoteSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const body = stripSample(value as Partial<HandwritingBankWire>);

  if (!isBank(body.bank)) {
    // A stored bank we cannot read still has a version: keep it so the next PUT's If-Match matches.
    return typeof body.version === 'number' && body.version > 0
      ? { bank: { ...EMPTY_GLYPH_BANK, version: body.version }, version: body.version }
      : null;
  }
  const version = typeof body.version === 'number' ? body.version : body.bank.version;

  return { bank: { ...EMPTY_GLYPH_BANK, ...body.bank, version }, version };
}

const UNAVAILABLE = new Set([401, 403, 405, 501]);

function rethrow(error: unknown): never {
  if (isStudyApiError(error)) {
    if (UNAVAILABLE.has(error.status)) throw new GlyphBankUnavailableError();
    // 412 stale / 428 missing If-Match: the server sends no copy — the sync pulls again.
    if (error.status === 412 || error.status === 428) throw new GlyphBankConflictError(null);
    if (error.status === 413) throw new GlyphBankTooLargeError();
    // The real PUT never 404s: a 404 means a backend without the route.
    if (error.status === 404) throw new GlyphBankUnavailableError();
  }
  throw error;
}

export async function getHandwritingBank(): Promise<GlyphBankRemoteSnapshot | null> {
  try {
    return parseBankWire(await studyGet<unknown>(HANDWRITING_BANK_PATH));
  } catch (error) {
    // The route's own 404 (`code: NOT_FOUND`) = «no bank yet». A bare 404 (Express «Cannot GET» from
    // a backend without #635) = the route is missing → device-only.
    if (isStudyApiError(error, 404)) {
      if (error.code === 'NOT_FOUND') return null;
      throw new GlyphBankUnavailableError();
    }

    return rethrow(error);
  }
}

/** `If-Match` for a write expecting `version`; none for 0 (create). */
export function ifMatchHeaders(version: number): Record<string, string> | undefined {
  return version > 0 ? { 'If-Match': `"${version}"` } : undefined;
}

export async function putHandwritingBank(bank: GlyphBank, version: number): Promise<GlyphBankRemoteSnapshot> {
  try {
    const saved = stripSample(
      ((await studyPut<unknown>(HANDWRITING_BANK_PATH, { bank }, ifMatchHeaders(version))) ??
        {}) as Partial<HandwritingBankSaved>,
    );
    const next = typeof saved.version === 'number' && saved.version > 0 ? saved.version : version + 1;

    return { bank: { ...bank, version: next }, version: next };
  } catch (error) {
    return rethrow(error);
  }
}
