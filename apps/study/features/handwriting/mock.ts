// In-memory glyph bank for force-mock mode, emulating the live `/handwriting/bank` contract (BE #635).
// The shell's mock transport calls `handwritingMockRoutes.json` before its own switch; `undefined` =
// not this path. One bank for the session, in memory only: the device copy in IndexedDB is the
// durable one, and a reload exercising «pull from the server» is exactly what the real route does.
//
//   GET → 200 { version, etag, bank } | 404 when there is no bank yet
//   PUT { bank } + If-Match: "<version>" (W/ and * accepted)
//       → 200 { version, etag }   no If-Match + no bank = create v1
//       → 428 no If-Match while a bank exists; 412 stale If-Match (or an If-Match with no bank)
import type { GlyphBank } from '@repo/whiteboard-react';

import { StudyApiError } from '@/lib/api/errors';

type Body = Record<string, unknown> | undefined;

interface StoredBank {
  version: number;
  bank: GlyphBank;
}

let current: StoredBank | null = null;

/** Tests: start from nothing. */
export function resetHandwritingMock(): void {
  current = null;
}

const etagOf = (version: number) => `"${version}"`;

/** Same rule as the backend: `"3"`, `W/"3"`, `3` → 3; `*` → '*'; garbage → null (never matches). */
function parseIfMatch(raw: string | undefined): number | '*' | null | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();

  if (value === '*') return '*';
  const match = /^(?:W\/)?"?(\d{1,15})"?$/.exec(value);

  return match ? Number(match[1]) : null;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());

  return key === undefined ? undefined : headers[key];
}

function route(
  method: string,
  path: string,
  body: Body,
  headers?: Record<string, string>,
): { value: unknown } | undefined {
  const segments = path.split('?')[0].split('/').filter(Boolean);

  if (segments[0] !== 'handwriting') return undefined;
  if (segments[1] !== 'bank' || segments.length !== 2) throw new StudyApiError(404, 'Not found', 'NOT_FOUND');

  if (method === 'GET') {
    if (!current) throw new StudyApiError(404, 'No glyph bank yet', 'NOT_FOUND');

    return { value: { version: current.version, etag: etagOf(current.version), bank: current.bank } };
  }

  if (method === 'PUT') {
    const bank = body?.bank;

    if (!bank || typeof bank !== 'object') throw new StudyApiError(400, 'Body must be { bank }', 'VALIDATION');
    const ifMatch = parseIfMatch(headerValue(headers, 'If-Match'));
    let version: number;

    if (ifMatch === undefined) {
      if (current) throw new StudyApiError(428, 'If-Match is required', 'PRECONDITION_REQUIRED');
      version = 1;
    } else {
      if (!current || ifMatch === null || (ifMatch !== '*' && ifMatch !== current.version)) {
        throw new StudyApiError(412, 'If-Match does not match the current version', 'PRECONDITION_FAILED');
      }
      version = current.version + 1;
    }
    current = { version, bank: bank as GlyphBank };

    return { value: { version, etag: etagOf(version) } };
  }

  if (method === 'DELETE') {
    current = null;

    return { value: undefined };
  }

  throw new StudyApiError(405, `${method} not allowed`, 'METHOD_NOT_ALLOWED');
}

export const handwritingMockRoutes = {
  /** `undefined` = not a handwriting path; otherwise the answer (or a thrown StudyApiError). */
  json(method: string, path: string, body?: Body, headers?: Record<string, string>): { value: unknown } | undefined {
    return route(method, path, body, headers);
  },
};
