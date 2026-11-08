import type { WhiteboardStorage } from '@repo/whiteboard-core';
import type { InboxItem } from './types';

import { getInboxItem, listInbox } from './api';
import { inboxIdFromPdfFileName, inboxPdfFileName } from './lib/links';

import { restorePdfAsset } from '@/lib/notebooks/pdf-import';

/**
 * A PDF appended to a note from the phone inbox (board → «From phone», or Inbox → «Add to notes» on an
 * existing note) is stored on the importing device only, like every board PDF. Its pages carry the
 * file name `phone-<itemId>.pdf`, so another device re-downloads it from the inbox here. False when
 * the asset is not an inbox PDF (the host's own restore handles it) or the item is gone.
 */
export async function restoreInboxPdfAsset(
  storage: WhiteboardStorage,
  assetId: string,
  sourceName: string | null | undefined,
): Promise<boolean> {
  const itemId = inboxIdFromPdfFileName(sourceName);

  if (!itemId) return false;
  // A fresh signed URL (the one in the live store may have expired): the item itself — found even once
  // deleted from the inbox — or, on a 404 / an older backend, the listing.
  const byId = await getInboxItem(itemId).catch(() => null);
  const item: InboxItem | undefined =
    byId?.id === itemId ? byId : (await listInbox()).find((candidate) => candidate.id === itemId);

  if (!item || item.kind !== 'pdf') return false;
  await restorePdfAsset({ assetId, fileUrl: item.url, fileName: inboxPdfFileName(itemId), storage });

  return true;
}
