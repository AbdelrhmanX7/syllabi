import type { GenerateVersionConflictBody, GenerateVersionResponse } from '@repo/whiteboard-core';

import { wbT, type WbLocale } from '../../../i18n/strings';

/**
 * Copy for the on-demand download in the PDF library, keyed on what the backend now tells us
 * (BE #412/#413) rather than on guesswork.
 *
 * A download request with no `pages` used to end in one of two ways the teacher could not tell
 * apart: a file, or a 409. The 409 had two causes — a merge already running, or a board that had
 * never sent its edits — and the file could silently be the last publish, missing everything drawn
 * since. Both answers now carry a label (`source`, `reason`); this is where the labels become
 * sentences.
 */

/** What a `done` download without a merge job actually is; `undefined` for a real merge. */
export function describeReadyDownload(
  job: Pick<GenerateVersionResponse, 'fileName' | 'source' | 'versionNumber'>,
  locale: WbLocale = 'en',
): string | undefined {
  if (job.source === 'published-version') {
    return job.versionNumber ? wbT(locale, 'merge.publishedN', { n: job.versionNumber }) : wbT(locale, 'merge.published');
  }

  if (job.source === 'source-pdf') {
    return job.fileName ? wbT(locale, 'merge.sourceNamed', { name: job.fileName }) : wbT(locale, 'merge.source');
  }

  return undefined;
}

/** The sentence for a 409 from `generateVersion`, split on the backend's `reason` when it sends one. */
export function describeGenerateConflict(error: unknown, locale: WbLocale = 'en'): string {
  return wbT(locale, readConflictReason(error) === 'no_staged_edits' ? 'merge.noStagedEdits' : 'merge.conflictUnknown');
}

function readConflictReason(error: unknown): GenerateVersionConflictBody['reason'] | undefined {
  if (error && typeof error === 'object' && 'body' in error) {
    const body = (error as { body?: unknown }).body;

    if (body && typeof body === 'object' && 'reason' in body) {
      const reason = (body as { reason?: unknown }).reason;

      return reason === 'no_staged_edits' ? reason : undefined;
    }
  }

  return undefined;
}
