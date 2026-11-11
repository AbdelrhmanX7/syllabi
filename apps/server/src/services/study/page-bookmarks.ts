/**
 * Page bookmarks of a notebook, read out of its board JSON at every commit and kept on the page row
 * (`StudyPage.bookmarks`), so «all my bookmarks» lists them without downloading every board.
 *
 * The board stores a bookmark on the page itself (`pages[i].bookmark = {at, label?}`, whiteboard-core
 * types.ts). The label each page shows in the pager («3», «3a» for a blank sheet among PDF pages)
 * follows whiteboard-core inserted-sheets.ts `resolvePageLabels`; the same rule lives in
 * apps/study/lib/notebooks/bookmarks.ts for demo mode: change them together.
 */

export const BOOKMARKS_MAX = 200;
export const BOOKMARK_LABEL_MAX = 60;

export interface BoardBookmark {
  /** 0-based position in the board's page list when it was saved. */
  index: number;
  /** The board page's own id (survives inserts/deletes before it). */
  boardPageId: string;
  /** What the pager shows for that page: «3», «3a». */
  pageLabel: string;
  /** The short name the student typed; "" = none. */
  label: string;
  /** When it was bookmarked (ms since epoch). */
  at: number;
}

type BoardPageLike = {
  id?: unknown;
  bookmark?: unknown;
  pdfAssetId?: unknown;
  pdfImageUrl?: unknown;
  pdfPageIndex?: unknown;
  pdfSourcePageNumber?: unknown;
  sheetAspect?: unknown;
  boardRuled?: unknown;
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const hasBackground = (p: BoardPageLike) => Boolean(p.pdfAssetId || p.pdfImageUrl);
const isLetteredSheet = (p: BoardPageLike) => !hasBackground(p) && finite(p.sheetAspect) && p.sheetAspect > 0 && p.boardRuled !== true;

function sheetSuffix(count: number): string {
  let n = count;
  let out = "";
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** The pager label of every page (whiteboard-core `resolvePageLabels`). */
export function pageLabels(pages: BoardPageLike[]): string[] {
  let ordinal = 0;
  let anchor = "0";
  let sheets = 0;
  return pages.map((p) => {
    if (isLetteredSheet(p)) return `${anchor}${sheetSuffix(sheets++)}`;
    ordinal += 1;
    sheets = 0;
    const own = hasBackground(p) ? (finite(p.pdfSourcePageNumber) ? p.pdfSourcePageNumber : finite(p.pdfPageIndex) ? p.pdfPageIndex + 1 : undefined) : undefined;
    anchor = String(own !== undefined && own >= 1 ? Math.floor(own) : ordinal);
    return anchor;
  });
}

/** The bookmarks in a board JSON, in page order; [] for anything unreadable. */
export function boardBookmarks(body: Buffer | string | unknown): BoardBookmark[] {
  let doc: unknown = body;
  try {
    if (typeof body === "string") doc = JSON.parse(body);
    else if (Buffer.isBuffer(body)) doc = JSON.parse(body.toString("utf8"));
  } catch {
    return [];
  }
  const pages = (doc as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(pages)) return [];
  const list = pages.map((p) => (p && typeof p === "object" ? (p as BoardPageLike) : {}));
  const labels = pageLabels(list);
  const out: BoardBookmark[] = [];
  list.forEach((p, index) => {
    const mark = p.bookmark as { at?: unknown; label?: unknown } | undefined;
    if (!mark || typeof mark !== "object" || !finite(mark.at)) return;
    if (typeof p.id !== "string" || !p.id) return;
    if (out.length >= BOOKMARKS_MAX) return;
    const label = typeof mark.label === "string" ? mark.label.trim().slice(0, BOOKMARK_LABEL_MAX) : "";
    out.push({ index, boardPageId: p.id.slice(0, 100), pageLabel: labels[index], label, at: mark.at });
  });
  return out;
}

/** The API shape of one stored bookmark. */
export const bookmarkDto = (b: BoardBookmark) => ({
  boardPageId: b.boardPageId,
  index: b.index,
  pageLabel: b.pageLabel,
  label: b.label || null,
  at: new Date(b.at).toISOString(),
});

/**
 * Notebooks saved before the row kept bookmarks (no `bookmarks` field yet): read each stored board once
 * and fill the field, so «all my bookmarks» shows them without waiting for the next save. A few per call
 * (the background poll calls it); the write is skipped when a save moved the page meanwhile, and never
 * moves `updatedAt`. Returns how many rows it filled.
 */
export async function backfillPageBookmarks(limit = 25): Promise<number> {
  const { StudyPage } = await import("@/models/study/page");
  const { getStudyObject } = await import("@/services/study/storage");
  const rows = await StudyPage.find(
    { deletedAt: null, contentKey: { $ne: null }, bookmarks: { $exists: false } },
    { _id: 1, contentKey: 1 }
  )
    .limit(limit)
    .lean<{ _id: unknown; contentKey: string }[]>();
  let filled = 0;
  for (const row of rows) {
    // An unreadable board counts as none: the row is not picked again.
    const board = await getStudyObject(row.contentKey).catch(() => null);
    const res = await StudyPage.updateOne(
      { _id: row._id, contentKey: row.contentKey, bookmarks: { $exists: false } },
      { $set: { bookmarks: board ? boardBookmarks(board) : [] } },
      { timestamps: false }
    );
    filled += res.modifiedCount;
  }
  return filled;
}
