// Pure helpers for the class library: week grouping, and note markdown prep
// deck. Unit-tested (library.test.ts).
import type { LibraryDoc, LibraryKind } from '@/lib/api/types';

export interface WeekGroup {
  /** null = not tied to a week (textbook, syllabus). */
  week: number | null;
  docs: LibraryDoc[];
}

const KIND_ORDER: Record<LibraryKind, number> = { note: 0, pdf: 1, image: 2 };

/** Weeks ascending, the week-less docs last; notes before PDFs before images, then by title. */
export function groupByWeek(docs: LibraryDoc[]): WeekGroup[] {
  const groups = new Map<number | null, LibraryDoc[]>();

  for (const doc of docs) {
    const list = groups.get(doc.week) ?? [];

    list.push(doc);
    groups.set(doc.week, list);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER))
    .map(([week, list]) => ({
      week,
      docs: [...list].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title)),
    }));
}

export function filterDocs(docs: LibraryDoc[], kind: LibraryKind | 'all', text: string): LibraryDoc[] {
  const needle = text.trim().toLowerCase();

  return docs.filter(
    (doc) =>
      (kind === 'all' || doc.kind === kind) &&
      (!needle || doc.title.toLowerCase().includes(needle) || doc.path.toLowerCase().includes(needle)),
  );
}

/**
 * The backend rewrites a note's image refs to `![alt](<signed url>)`; the bank's Markdown renderer
 * wants a bare url and an image on a line of its own. Unwrap the angle brackets, lift every image
 * onto its own paragraph and drop thematic breaks.
 */
export function prepareNoteMarkdown(markdown: string): string {
  return markdown
    .replace(/(!?\[[^\]]*\])\(<([^>]+)>((?:\s+"[^"]*")?)\)/g, (_all, text: string, url: string, title: string) => {
      return `${text}(${url.replace(/\s/g, '%20')}${title})`;
    })
    .replace(/[ \t]*(!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))[ \t]*/g, '\n\n$1\n\n')
    // Thematic breaks (`* * *`, `---`): the renderer would read `* * *` as an empty bullet.
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
