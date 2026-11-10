// After a sync's page pictures are up, ask AI (quietly) to name / describe / tag the notebook and make
// its cover — only for the owner's own notebooks with something written or a PDF on them, when never
// described or ≥ 5 versions moved since, at most once per notebook per 10 minutes, and never offline.
import type { WhiteboardPage } from '@repo/whiteboard-react';
import type { DescribedPage, Page } from '@/lib/api/types';

import { describePage } from '@/lib/api/endpoints';
import { isStudyApiError } from '@/lib/api/errors';
import { isOnline } from '@/lib/offline/network';
import { refreshPageLists, updatePageInLists } from '@/lib/offline/jobs';
import { readCachedPage, rememberPages } from '@/lib/notebooks/pages-cache';
import { boardHasContent, claimDescribeSlot, wantsAutoDescribe } from '@/lib/notebooks/page-meta';

/** Fired with the fresh Page after AI described it (an open notebook picks up its new name and tags). */
export const PAGE_DESCRIBED_EVENT = 'study:page-described';

/** How long a cover picture usually takes before the lists are worth reloading. */
const COVER_WAIT_MS = 45_000;

/** A described page lands in the caches; a pending cover picture reloads the lists a little later. */
export function adoptDescribed(described: DescribedPage): Page {
  const { coverPending, ...page } = described;

  rememberPages([page]);
  updatePageInLists(page);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<Page>(PAGE_DESCRIBED_EVENT, { detail: page }));
  if (coverPending) setTimeout(refreshPageLists, COVER_WAIT_MS);

  return page;
}

const pdfKey = (pageId: string) => `study_pdf_name:${pageId}`;

/** The last PDF imported into a notebook, so AI can use its file name as a hint. */
export function rememberPdfName(pageId: string, fileName: string): void {
  try {
    window.localStorage.setItem(pdfKey(pageId), fileName.slice(0, 200));
  } catch {
    // Storage off: AI just goes without the hint.
  }
}

function readPdfName(pageId: string): string | null {
  try {
    return window.localStorage.getItem(pdfKey(pageId));
  } catch {
    return null;
  }
}

/** AI is off for this account (403): stop asking for the rest of the session. */
let aiOff = false;

/** Fire-and-forget; every failure stays quiet (the next sync tries again after the 10-minute gap). */
export function maybeAutoDescribe(pageId: string, version: number, pages: readonly WhiteboardPage[]): void {
  if (aiOff || !isOnline()) return;
  const cached = readCachedPage(pageId);

  if (!cached) return;
  if (!wantsAutoDescribe({ ...cached, version: Math.max(version, cached.version ?? 0) }, boardHasContent(pages))) return;
  if (!claimDescribeSlot(pageId)) return;
  const fileName = readPdfName(pageId);

  describePage(pageId, fileName ? { fileName } : {})
    .then(adoptDescribed)
    .catch((error) => {
      if (isStudyApiError(error, 403)) aiOff = true;
    });
}
