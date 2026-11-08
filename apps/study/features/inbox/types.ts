// Phone inbox: images (and PDFs) sent from the iPhone land here, then go onto a board, into notes or
// into the question bank. Contract proposed to the backend over the bridge (2026-10-05).

export type InboxKind = 'image' | 'pdf';

export interface InboxItem {
  id: string;
  kind: InboxKind;
  /** Full-size file (HEIC is already converted to JPEG by the backend). */
  url: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
  note: string | null;
  /** Optional class the phone tagged it with (`classId` form field). */
  classId?: string | null;
  createdAt: string;
  /** Set once it was put on a board / into notes / into the bank. */
  usedAt?: string | null;
  /**
   * The note page it is queued for (#661: Claude's `add_inbox_to_page` sets it and clears `usedAt`).
   * The board of that page appends it from its «waiting from Claude» chip. Absent on an older backend.
   */
  pageId?: string | null;
}

/** A drop token as listed — the secret never comes back after creation. */
export interface DropToken {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string | null;
  /** First characters of the secret, when the backend sends them. */
  prefix?: string | null;
}

/** `POST /study/inbox/tokens` — the only response that carries `token`. */
export interface DropTokenCreated extends DropToken {
  token: string;
}
