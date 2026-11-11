// Which notebooks the Notes page lists under «My notes»: every notebook outside a class, whatever its
// kind. A copy someone added from a share link has no class and keeps the original's kind (a Library
// PDF notebook is `pdf`), so a `note`-only filter hid it. Unit-tested (my-notes.test.ts).
import type { Page } from '@/lib/api/types';

export const isMyNote = (page: Pick<Page, 'classId'>): boolean => !page.classId;

/**
 * Notebooks the phone inbox can drop a photo or PDF into: handwritten notes, and PDF notebooks that open
 * on the notebook screen (a copy added from a share link, a PDF imported as a notebook). A PDF tied to a
 * class item or a Library document opens on that screen instead, so it isn't offered.
 */
export const takesInboxItems = (page: Pick<Page, 'kind' | 'itemId' | 'libraryId'>): boolean =>
  page.kind === 'note' || (page.kind === 'pdf' && !page.itemId && !page.libraryId);
