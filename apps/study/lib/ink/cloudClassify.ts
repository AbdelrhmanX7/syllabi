// Cloud classifier client for the auto-colour feature: POST /study/ai/ink-classify (backend runs JEV
// `typesafe/jev-1.13` through OpenRouter). Callers fall back to their local rules on any rejection;
// `InkCloudUnavailableError` means «this backend does not have the route», so they can stop asking.
import type { InkClass, InkCloudClassifier, InkLineForCloud } from './types';

import { isStudyApiError } from '@/lib/api/errors';
import { studyPost } from '@/lib/api/http';

export type { InkClass, InkCloudClassifier, InkLineForCloud } from './types';

export const INK_CLOUD_BATCH = 20;

const CLASSES: readonly InkClass[] = ['heading', 'term', 'definition', 'formula', 'example', 'keypoint', 'plain'];
const UNAVAILABLE_STATUSES = [404, 405, 501];

export class InkCloudUnavailableError extends Error {
  constructor(message = 'ink-classify is not available on this backend') {
    super(message);
    this.name = 'InkCloudUnavailableError';
  }
}

export function isInkCloudUnavailable(error: unknown): error is InkCloudUnavailableError {
  return error instanceof InkCloudUnavailableError;
}

interface InkClassifyResponse {
  results?: Array<{ cls?: unknown; confidence?: unknown }>;
}

function abortError(): Error {
  const error = new Error('aborted');

  error.name = 'AbortError';

  return error;
}

function normalise(raw: { cls?: unknown; confidence?: unknown } | undefined): { cls: InkClass; confidence: number } {
  const cls = CLASSES.find((candidate) => candidate === raw?.cls) ?? 'plain';
  const confidence = typeof raw?.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : 0;

  return { cls, confidence: Math.min(1, Math.max(0, confidence)) };
}

async function classifyBatch(batch: InkLineForCloud[]): Promise<Array<{ cls: InkClass; confidence: number }>> {
  let response: InkClassifyResponse;

  try {
    response = await studyPost<InkClassifyResponse>('/ai/ink-classify', { lines: batch });
  } catch (error) {
    if (isStudyApiError(error) && UNAVAILABLE_STATUSES.includes(error.status)) throw new InkCloudUnavailableError();
    throw error;
  }
  const results = response?.results;

  if (!Array.isArray(results) || results.length !== batch.length) {
    throw new Error('ink-classify returned a malformed answer');
  }

  return results.map(normalise);
}

export const cloudInkClassifier: InkCloudClassifier = {
  async classify(lines, signal) {
    const out: Array<{ cls: InkClass; confidence: number }> = [];

    for (let start = 0; start < lines.length; start += INK_CLOUD_BATCH) {
      if (signal?.aborted) throw abortError();
      out.push(...(await classifyBatch(lines.slice(start, start + INK_CLOUD_BATCH))));
    }
    if (signal?.aborted) throw abortError();

    return out;
  },
};
