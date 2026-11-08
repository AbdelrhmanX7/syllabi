// A note's name follows the PDF it holds — unless somebody typed a name of their own.
// «MATH-192-1396 — Week 8 · Sun Oct 18» (class + week + date) and «Lecture 8 — Earthquakes» are
// generated; once a PDF is on the board the note is called after the file instead.

/** «lecture-8.final.pdf» → «lecture-8.final»; null when nothing usable is left. */
export function pdfNoteTitle(fileName: string | null | undefined): string | null {
  const name = (fileName ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(pdf|pptx?|key)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return name || null;
}

const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \\d{1,2}';
// «<course> — [Week N · ]Mon Oct 5» (sessionLecture), «Lecture 8 — topic» / «Week 8 — topic» (lectureNoteTitle).
const AUTO_TITLE = new RegExp(
  `^(?:.+ — (?:Week \\d+ · )?${DAY}|(?:Lecture|Lab|Session|Recitation|Week) (?:\\d+|\\?)(?: — .+)?|Notebook|Untitled)$`,
);

/** True for a name the app generated (safe to replace), false for anything a person may have typed. */
export function isAutoNoteTitle(title: string | null | undefined): boolean {
  const value = (title ?? '').trim();

  return value === '' || AUTO_TITLE.test(value);
}

/**
 * The name a note should take when a PDF lands in it: the PDF's name when the current name is the
 * generated default, else null (keep what is there).
 */
export function retitleForPdf(
  currentTitle: string | null | undefined,
  fileName: string | null | undefined,
): string | null {
  const next = pdfNoteTitle(fileName);

  if (!next || !isAutoNoteTitle(currentTitle) || next === (currentTitle ?? '').trim()) return null;

  return next;
}
