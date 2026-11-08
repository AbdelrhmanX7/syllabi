// The URLs the iPhone needs, and the iOS Shortcut recipe with the real values filled in.

/** `https://api…` without a trailing slash (Settings may hold one). */
function base(backendUrl: string): string {
  return backendUrl.trim().replace(/\/+$/, '');
}

/** The backend's public upload page — what the QR code opens in Safari. */
export function dropUrl(backendUrl: string, token: string): string {
  return `${base(backendUrl)}/study/drop?t=${encodeURIComponent(token)}`;
}

/** Where the Shortcut POSTs the photo (`Authorization: Bearer <token>`). */
export function inboxUploadUrl(backendUrl: string): string {
  return `${base(backendUrl)}/study/inbox`;
}

export const bearerHeader = (token: string) => `Bearer ${token}`;

/** True for a drop-token secret as the backend issues it. */
export const isDropToken = (value: string) => /^sk_drop_[A-Za-z0-9_-]{8,}$/.test(value);

export interface ShortcutValue {
  label: string;
  value: string;
  /** Secret: rendered masked until the token was just created. */
  secret?: boolean;
}

export interface ShortcutStep {
  title: string;
  detail?: string;
  values?: ShortcutValue[];
}

/**
 * The Share-Sheet Shortcut, as the backend documents it (services/study/inbox/README.md): «Get
 * Contents of URL» POSTing the shared file as `file`, one file per request. Without a fresh `token`
 * the secret slot shows a placeholder — the secret is only known right after creation.
 */
export function shortcutSteps(backendUrl: string, token: string | null): ShortcutStep[] {
  const secret = token ?? '<TOKEN>';

  return [
    {
      title: 'In Shortcuts, create a new shortcut (“Send to Study”). In its settings (ⓘ), turn on Show in Share Sheet.',
      detail: 'Set Receive to Images and PDFs.',
    },
    {
      title: 'Add Get Contents of URL. Method POST, Request Body Form.',
      values: [
        { label: 'URL', value: inboxUploadUrl(backendUrl) },
        { label: 'Header', value: 'Authorization' },
        { label: 'Header value', value: bearerHeader(secret), secret: true },
        { label: 'File field', value: 'file' },
        { label: 'Its value', value: 'Shortcut Input' },
      ],
      detail: 'Optional: a Text field named “note” (up to 500 characters), and a Show Notification “Sent to Study”.',
    },
    {
      title: 'Several photos at once: wrap step 2 in Repeat with Each (item = Shortcut Input).',
      detail: 'Then set the “file” field to Repeated Item. The server takes one file per request.',
    },
  ];
}

/** Shortcut text the server gives for a HEIC it could not decode. */
export const HEIC_HINT = 'Add a Convert Image step (format JPEG) before Get Contents of URL in the Shortcut.';

/** Friendly text for an upload the backend refused (`{status, code}` from its `{message, code}` body). */
export function inboxUploadErrorMessage(status: number, code: string | undefined, fallback: string): string {
  if (status === 413 || code === 'PAYLOAD_TOO_LARGE') return 'That file is over 25 MB, the inbox limit.';
  if (code === 'HEIC_UNSUPPORTED') return `The server could not convert this HEIC photo. ${HEIC_HINT}`;
  if (status === 415 || code === 'UNSUPPORTED_TYPE')
    return 'Only JPEG, PNG, HEIC, WebP and PDF files can go to the inbox.';
  if (status === 429) return 'Too many uploads: the limit is 60 every 10 minutes. Try again in a few minutes.';
  if (status === 401) return 'Not signed in, or the drop token was revoked.';

  return fallback;
}

/** The backend caps `note` at 500 characters. */
export const INBOX_NOTE_MAX = 500;

/**
 * The file name an inbox PDF is imported under. It becomes the board asset's `pdfSourceName`, which is
 * how another device knows where to re-download a PDF appended to an existing note.
 */
export const inboxPdfFileName = (itemId: string) => `phone-${itemId}.pdf`;

/** The inbox item behind a board PDF asset, from its `pdfSourceName` (null for any other PDF). */
export function inboxIdFromPdfFileName(name: string | null | undefined): string | null {
  return /^phone-([A-Za-z0-9_-]+)\.pdf$/.exec(name ?? '')?.[1] ?? null;
}
