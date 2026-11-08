// Force-mock / pre-BE answer for POST /ai/ink-classify, same shape as the real route.
import type { InkLineForCloud } from './types';

import { mockClassifyLine } from './mockRules';

import { StudyApiError } from '@/lib/api/errors';

type Body = Record<string, unknown> | undefined;

export const inkMockRoutes = {
  /** `undefined` = not this path. */
  json(method: string, path: string, body: Body): { value: unknown } | undefined {
    if (path.split('?')[0] !== '/ai/ink-classify') return undefined;
    if (method !== 'POST') throw new StudyApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
    const lines = body?.lines;

    if (!Array.isArray(lines) || lines.length === 0 || lines.length > 20) {
      throw new StudyApiError(400, 'lines must hold 1-20 entries', 'BAD_REQUEST');
    }

    return { value: { results: (lines as InkLineForCloud[]).map((line) => mockClassifyLine(line)) } };
  },
};
