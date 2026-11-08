import type { WhiteboardPage } from './types';

export function insertWhiteboardPageAt(
  pages: WhiteboardPage[],
  page: WhiteboardPage,
  insertAt: number,
): {
  insertedIndex: number;
  pages: WhiteboardPage[];
} {
  const safeInsertAt = Math.max(0, Math.min(insertAt, pages.length));

  return {
    insertedIndex: safeInsertAt,
    pages: [...pages.slice(0, safeInsertAt), page, ...pages.slice(safeInsertAt)],
  };
}

export function insertWhiteboardPageRelative(
  pages: WhiteboardPage[],
  page: WhiteboardPage,
  index: number,
  position: 'after' | 'before',
): {
  insertedIndex: number;
  pages: WhiteboardPage[];
} {
  return insertWhiteboardPageAt(pages, page, position === 'before' ? index : index + 1);
}

export function appendWhiteboardPages(
  pages: WhiteboardPage[],
  nextPages: WhiteboardPage[],
): {
  firstInsertedIndex: number;
  pages: WhiteboardPage[];
} {
  return {
    firstInsertedIndex: pages.length,
    pages: [...pages, ...nextPages],
  };
}

export function reorderWhiteboardPages(pages: WhiteboardPage[], fromIndex: number, toIndex: number): WhiteboardPage[] {
  if (fromIndex === toIndex) {
    return pages;
  }

  if (fromIndex < 0 || toIndex < 0 || fromIndex >= pages.length || toIndex >= pages.length) {
    return pages;
  }

  const updatedPages = [...pages];
  const [movedPage] = updatedPages.splice(fromIndex, 1);

  if (!movedPage) {
    return pages;
  }

  updatedPages.splice(toIndex, 0, movedPage);

  return updatedPages;
}
