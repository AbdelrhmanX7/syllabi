/**
 * What every «new page» remake reads — «Similar copy» (/remake-page, overlay and baked) and the editable
 * «Editable copy» layout copy: the page BACKGROUND only — the PDF page,
 * the image background, pinned (locked) pictures, the grid — at full resolution, without the
 * teacher's ink, shapes, AI-inserted objects or UI (owner: «send the page to the AI without any
 * handwriting»). The model then reads the printed questions, not the scribbles over them.
 *
 * Exception: a page with no background content (blank or grid) whose questions ARE the teacher's
 * ink — without it there is nothing to remake, so the ink goes too.
 *
 * Analyze-page, lasso ask, classify and concept maps keep the ink (they read handwriting).
 */

export type SnapshotLayers = 'all' | 'background';

export interface PageBackgroundInfo {
  /** A PDF page or an image background behind the page. */
  hasPicture: boolean;
  /** Pinned (locked) pictures on the page — part of the background. */
  lockedImages: number;
}

/** Background content present → background only; a blank/grid page → everything (its ink is the page). */
export function remakeSnapshotLayers(info: PageBackgroundInfo | null | undefined): SnapshotLayers {
  if (!info) return 'all';

  return info.hasPicture || info.lockedImages > 0 ? 'background' : 'all';
}
