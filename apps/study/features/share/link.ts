// Share links ("Anyone with the link can get a copy"). Pure helpers, no window / React, so node:test
// loads them directly. Contract: apps/server/src/routes/share-public.ts (preview) + routes/share.ts.
import type { ShareResourceType } from './types';

/** A link token: 32 random bytes in base64url (43 chars). A share id is 24 hex, so they never overlap. */
export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const isLinkToken = (id: unknown): id is string => typeof id === 'string' && LINK_TOKEN_RE.test(id);

/** What someone who isn't signed in may see about a link. */
export interface LinkPreview {
  title: string;
  resourceType: ShareResourceType;
  /** The owner's first name only ("Someone" when they never set one). */
  ownerName: string;
}

const TYPES: readonly ShareResourceType[] = ['notebook', 'deck', 'questions', 'conceptMap'];

/** The server's preview answer, checked; null for anything else. */
export function readLinkPreview(raw: unknown): LinkPreview | null {
  const p = raw && typeof raw === 'object' ? (raw as { preview?: unknown }).preview : null;

  if (!p || typeof p !== 'object') return null;
  const { title, resourceType, ownerName } = p as Record<string, unknown>;

  if (typeof title !== 'string' || typeof ownerName !== 'string') return null;
  if (typeof resourceType !== 'string' || !TYPES.includes(resourceType as ShareResourceType)) return null;

  return { title, resourceType: resourceType as ShareResourceType, ownerName };
}

/** The no-account preview url on `server` (the app's transport puts live routes under /study). */
export function linkPreviewUrl(server: string, token: string): string {
  return `${server.trim().replace(/\/+$/, '')}/study/share/preview/${encodeURIComponent(token)}`;
}

/** Where the link opens in the app: back here after signing in or creating an account. */
export const sharedPath = (idOrToken: string) => `/shared/?id=${encodeURIComponent(idOrToken)}`;

/** /login on the right tab, coming back to the link afterwards. */
export function loginHref(idOrToken: string, tab: 'signin' | 'create'): string {
  const next = encodeURIComponent(sharedPath(idOrToken));

  return tab === 'create' ? `/login/?tab=create&next=${next}` : `/login/?next=${next}`;
}
