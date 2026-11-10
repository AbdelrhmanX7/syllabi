import type { WhiteboardPage, WhiteboardStorage } from '@repo/whiteboard-react';

import { pageInkKey } from '@repo/whiteboard-react';

import { commitPageRenders, getPageRenders, putPageRender } from '@/lib/api/endpoints';
import { isStudyApiError } from '@/lib/api/errors';
import { maybeAutoDescribe } from '@/lib/notebooks/auto-describe';

/**
 * Page images for the Study MCP — what lets Claude SEE a notebook (grade it, export it). The backend
 * cannot draw a page itself (PDF backgrounds live only on the device that imported them), so after a
 * synced version this device renders each CHANGED board page (paper + ink over its PDF page) and
 * uploads it; unchanged pages are only re-stamped to the new version through the commit's `hashes`.
 *
 * Contract: ka-bridge thread m_mvpodlco6fdced. GET renders → PUT /renders/:index per changed page →
 * POST /renders/commit { pageCount, version, hashes }.
 */

/** Long edge of an uploaded page image, px (the backend downsizes for the MCP). */
const RENDER_LONG_EDGE = 1600;
/** Bumped when the picture of an unchanged page would change (renderer fixes), forcing a re-upload. */
const RENDER_FORMAT = 'r1';

export type PageImageRenderer = (page: WhiteboardPage, longEdge: number) => Promise<Blob>;

/** What decides a page's picture. Opaque to the backend; only echoed back for this diff. */
export function pageRenderHash(page: WhiteboardPage): string {
  return [
    RENDER_FORMAT,
    pageInkKey(page.canvasJSON),
    page.backgroundType,
    `${page.pdfAssetId ?? ''}:${page.pdfPageIndex ?? ''}:${page.pdfRotation ?? 0}:${page.pdfImageUrl ? 'img' : ''}`,
    page.canvasWidthPx ?? '',
    page.sheetAspect ?? '',
    page.paperSpacingMm ?? '',
  ].join('|');
}

const yieldToInput = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

// One run per notebook at a time; a request during a run re-runs once it ends (latest version wins).
const running = new Map<string, Promise<void>>();
const queued = new Map<string, { version: number; storage: WhiteboardStorage; render: PageImageRenderer }>();

async function run(
  pageId: string,
  version: number,
  storage: WhiteboardStorage,
  render: PageImageRenderer,
): Promise<void> {
  const doc = await storage.loadWhiteboard(pageId).catch(() => null);

  if (!doc) return;
  const pages = doc.pages;
  let remote;

  try {
    remote = await getPageRenders(pageId);
  } catch (error) {
    // 404: a backend without the renders routes yet — nothing to do, the notebook itself synced.
    if (isStudyApiError(error, 404)) return;
    throw error;
  }

  const stored = new Map(remote.renders.map((entry) => [entry.index, entry.hash]));
  const hashes = pages.map(pageRenderHash);

  for (let index = 0; index < pages.length; index += 1) {
    if (stored.get(index) === hashes[index]) continue;
    await yieldToInput();
    const image = await render(pages[index], RENDER_LONG_EDGE);

    try {
      await putPageRender(pageId, index, image, { hash: hashes[index], version, boardPageId: pages[index].id });
    } catch (error) {
      // 409 STALE_VERSION: the notebook moved on (the next sync re-renders); 413: too big to keep.
      // Either way only this page waits — the rest still go up, and the commit still runs.
      if (!isStudyApiError(error, 409) && !isStudyApiError(error, 413)) throw error;
    }
  }

  try {
    await commitPageRenders(pageId, { pageCount: pages.length, version, hashes });
  } catch (error) {
    // 409 STALE_VERSION: a newer sync already committed; this one has nothing left to say.
    if (!isStudyApiError(error, 409)) throw error;

    return;
  }
  // The pictures AI reads are up: name / describe the notebook when it is due (quiet, gated).
  maybeAutoDescribe(pageId, version, pages);
}

/**
 * Bring the notebook's page images up to `version` (the content version that was just committed).
 * Never throws: a failure only means Claude sees the previous images until the next sync.
 */
export function syncPageRenders(
  pageId: string,
  version: number,
  storage: WhiteboardStorage,
  render: PageImageRenderer,
): Promise<void> {
  const inFlight = running.get(pageId);

  if (inFlight) {
    queued.set(pageId, { version, storage, render });

    return inFlight;
  }

  const task = run(pageId, version, storage, render)
    // eslint-disable-next-line no-console -- a failed render sync is retried next sync; the log is the only trace
    .catch((error) => console.warn('[page-renders]', pageId, error))
    .finally(() => {
      running.delete(pageId);
      const next = queued.get(pageId);

      queued.delete(pageId);
      if (next) void syncPageRenders(pageId, next.version, next.storage, next.render);
    });

  running.set(pageId, task);

  return task;
}
