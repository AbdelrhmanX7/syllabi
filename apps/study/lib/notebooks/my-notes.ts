// Which notebooks the Notes page lists under «My notes»: every notebook outside a class, whatever its
// kind. A copy someone added from a share link has no class and keeps the original's kind (a Library
// PDF notebook is `pdf`), so a `note`-only filter hid it. Unit-tested (my-notes.test.ts).
import type { Page } from '@/lib/api/types';

export const isMyNote = (page: Pick<Page, 'classId'>): boolean => !page.classId;
