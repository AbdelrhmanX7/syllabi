// Where «back» on a notebook goes. A notebook opened from the Notes page (a bookmark row or a cover)
// carries `&from=notes` and goes back there; otherwise a shared page goes to Shared, a class notebook to
// its class, anything else back in history (or home). Only known `from` values are honoured, never a
// path from the url. Unit-tested (back.test.ts).

/** Screens a notebook link can say it came from, and where back goes for each. */
const FROM_PATH = { notes: '/notes/' } as const;

export type NotebookFrom = keyof typeof FROM_PATH;

/** `href` with `from=<screen>` added (unchanged when `from` is not given). */
export function withFrom(href: string, from?: NotebookFrom): string {
  if (!from) return href;

  return `${href}${href.includes('?') ? '&' : '?'}from=${from}`;
}

/** A path to push, or 'history' to go back one step. */
export function notebookBackTarget(
  page: { shared?: unknown; classId?: string | null },
  from: string | null | undefined,
  hasHistory: boolean,
): string | 'history' {
  if (from && Object.prototype.hasOwnProperty.call(FROM_PATH, from)) return FROM_PATH[from as NotebookFrom];
  if (page.shared) return '/shared/';
  if (page.classId) return `/class/?id=${encodeURIComponent(page.classId)}`;

  return hasHistory ? 'history' : '/';
}
