import { MAX_PDF_IMPORT_FILE_SIZE, MAX_PDF_IMPORT_PAGE_COUNT } from '@repo/whiteboard-core';
import { isUserFacingError, WB_STRINGS, wbT, type WbLocale, type WbStringKey } from '../../../i18n/strings';

/**
 * Teacher-facing copy for every way a PDF import can fail.
 *
 * pdf.js talks in English engine-speak — `Bounding box is required.`, `PasswordException`,
 * `InvalidPDFException`, a bare `Failed to fetch` when the worker does not load. A teacher on a
 * tablet used to get that raw string on a red line and had no idea what to do with it, so this
 * maps the failure to: what happened, and the next thing to try. The original string is kept in
 * `detail` (shown behind a «Technical details» disclosure) so a real diagnosis is still possible.
 *
 * Messages that are ALREADY teacher copy — the board's own UI sentences, the resilient importer's
 * "every page failed" error, the PowerPoint converter — pass through untouched: they were written
 * for the teacher in the first place and re-wording them here would fight the source of truth.
 */

export type PdfImportErrorKind =
  | 'corrupt-file'
  | 'empty-selection'
  | 'file-too-large'
  | 'network'
  | 'out-of-memory'
  | 'password-protected'
  | 'too-many-pages'
  | 'unknown'
  | 'unreadable-format'
  | 'user-facing';

export interface PdfImportErrorCopy {
  /** The untouched technical string, demoted behind a disclosure. `null` when it IS the message. */
  detail: string | null;
  /** The concrete next step. Empty when the message already carries one. */
  hint: string;
  kind: PdfImportErrorKind;
  message: string;
  title: string;
}

const MAX_FILE_SIZE_MB = Math.round(MAX_PDF_IMPORT_FILE_SIZE / (1024 * 1024));

/** Literal characters (placeholders removed) an entry needs before it can claim a message. */
const MIN_OWN_COPY_LITERAL = 12;

let englishCopyPatterns: RegExp[] | null = null;

/** True when `message` is one of the board's own English UI sentences (placeholders filled in). */
function isOwnEnglishCopy(message: string): boolean {
  // Entries that are mostly placeholders («{done} of {total}», «{n}s») would match any engine string.
  englishCopyPatterns ??= (Object.values(WB_STRINGS) as string[])
    .filter((entry) => entry.replace(/\{\w+\}/g, '').trim().length >= MIN_OWN_COPY_LITERAL)
    .map(
      (entry) =>
        new RegExp(
          `^${entry
            .split(/\{\w+\}/)
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.+?')}$`,
        ),
    );

  return englishCopyPatterns.some((pattern) => pattern.test(message));
}

/**
 * Substrings matched against the lowercased failure message, in order — the first hit wins, so the
 * specific families sit above the broad ones. Our own size/page-count/canvas guards are matched
 * here too: their text still deserves a tailored hint.
 */
const ERROR_PATTERNS: Array<{ kind: PdfImportErrorKind; patterns: string[] }> = [
  {
    kind: 'file-too-large',
    patterns: ['file size exceeds', 'file too large', 'exceeds the maximum file size'],
  },
  {
    kind: 'too-many-pages',
    patterns: ['selected page count', 'too many pages', 'exceeds the maximum page count'],
  },
  {
    kind: 'out-of-memory',
    patterns: [
      'drawing surface',
      'out of memory',
      'oom',
      'allocation failed',
      'array buffer allocation',
      'canvas',
      'createimagebitmap',
      'maximum call stack',
      'quotaexceeded',
      'quota exceeded',
      'insufficient resources',
    ],
  },
  {
    kind: 'password-protected',
    patterns: ['password', 'passwordexception', 'encrypted', 'no password given'],
  },
  {
    kind: 'corrupt-file',
    patterns: [
      'invalidpdfexception',
      'invalid pdf',
      'is not a pdf',
      'no pdf header',
      'missing pdf header',
      'corrupt',
      'file is empty',
      'unexpected end of file',
    ],
  },
  {
    kind: 'unreadable-format',
    patterns: [
      'bounding box',
      'formaterror',
      'malformed',
      'bad xref',
      'xref',
      'invalid object',
      'invalid stream',
      'unknown encoding',
      'unsupported',
      'cannot read properties',
      'is not a function',
      'unexpected token',
    ],
  },
  {
    kind: 'network',
    patterns: [
      'failed to fetch',
      'networkerror',
      'network error',
      'load failed',
      'worker',
      'importing a module script failed',
      'dynamically imported module',
      'unexpectedresponse',
      'missing pdf',
      'err_',
      'timeout',
      'aborted',
    ],
  },
  {
    kind: 'empty-selection',
    patterns: ['subset would be empty', 'no pages selected'],
  },
];

/** Our own guards: their text is teacher copy that still deserves the tailored hint. */
const GUARD_KINDS = new Set<PdfImportErrorKind>(['file-too-large', 'too-many-pages']);

const ERROR_KEY: Record<Exclude<PdfImportErrorKind, 'user-facing'>, string> = {
  'corrupt-file': 'corrupt',
  'empty-selection': 'emptySelection',
  'file-too-large': 'fileTooLarge',
  network: 'network',
  'out-of-memory': 'outOfMemory',
  'password-protected': 'passwordProtected',
  'too-many-pages': 'tooManyPages',
  unknown: 'unknown',
  'unreadable-format': 'unreadableFormat',
};

function errorCopy(
  kind: Exclude<PdfImportErrorKind, 'user-facing'>,
  locale: WbLocale,
): Omit<PdfImportErrorCopy, 'detail' | 'kind'> {
  const base = `pdferr.${ERROR_KEY[kind]}`;
  const vars = { max: MAX_PDF_IMPORT_PAGE_COUNT, mb: MAX_FILE_SIZE_MB };

  return {
    hint: wbT(locale, `${base}.hint` as WbStringKey, vars),
    message: wbT(locale, `${base}.message` as WbStringKey, vars),
    title: wbT(locale, `${base}.title` as WbStringKey, vars),
  };
}

/** Pull a message out of anything a `catch` can hand us — Error, string, `{ message }`, or junk. */
export function readPdfImportErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error.trim();
  }

  if (error instanceof Error) {
    return error.message.trim();
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;

    return typeof message === 'string' ? message.trim() : '';
  }

  return '';
}

/** Map any caught import/inspect failure to teacher-facing copy. Never returns raw engine text. */
export function describePdfImportError(error: unknown, locale: WbLocale = 'en'): PdfImportErrorCopy {
  const rawMessage = readPdfImportErrorMessage(error);
  const normalizedMessage = rawMessage.toLowerCase();
  // Copy already written for the teacher is English too, so its words («password-protected») must
  // not be read as an engine failure: only the size / page-count guards still gain their hint.
  const isTeacherCopy = isUserFacingError(error) || Boolean(rawMessage && isOwnEnglishCopy(rawMessage));
  const matched = rawMessage
    ? ERROR_PATTERNS.find(
        ({ kind, patterns }) =>
          (!isTeacherCopy || GUARD_KINDS.has(kind)) && patterns.some((pattern) => normalizedMessage.includes(pattern)),
      )
    : undefined;

  if (matched && matched.kind !== 'user-facing') {
    return {
      ...errorCopy(matched.kind, locale),
      detail: rawMessage,
      kind: matched.kind,
    };
  }

  // Already written for the teacher (our guards, the resilient importer, the PowerPoint converter):
  // show it as-is and add no invented hint — there is no technical string left to hide.
  if (isTeacherCopy) {
    return {
      detail: null,
      hint: '',
      kind: 'user-facing',
      message: rawMessage,
      title: wbT(locale, 'pdferr.userFacingTitle'),
    };
  }

  return {
    ...errorCopy('unknown', locale),
    detail: rawMessage || null,
    kind: 'unknown',
  };
}
