// «Earlier versions» of a notebook page (the owner's board top bar): who saved each version and when,
// and Restore (confirm first). Restoring saves the old board as a NEW version, so the page as it is now
// stays in the list too. Also the chip an editor sees on someone else's page.
import type { PageVersion } from '../api';

import { useState } from 'react';
import { Tooltip, addToast, cn } from '@repo/ui';
import { useWhiteboardStorage } from '@repo/whiteboard-react';
import { useQuery } from '@tanstack/react-query';
import { History, Users } from 'lucide-react';

import { listPageVersions, restorePageVersion } from '../api';

import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { ActionButton, BOARD_CHIP, BOARD_CHIP_OVERRIDE } from '@/components/ui/primitives';
import { Sheet } from '@/features/inbox/components/Sheet';
import { readSyncedVersion } from '@/lib/notebooks/pages-cache';
import { replaceWithRemote, uploadNotebookDocument } from '@/lib/notebooks/sync';

const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.');

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;

function versionLine(v: PageVersion): string {
  const who = v.by ? (v.by.isOwner ? 'You' : v.by.name) : null;
  const parts = [who, when(v.at), v.restoredFrom ? `brought back version ${v.restoredFrom}` : null].filter(Boolean);

  return parts.length ? parts.join(' · ') : 'Not set';
}

function VersionsSheet({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const { storage } = useWhiteboardStorage();
  const { data, isLoading, error } = useQuery({
    queryKey: ['study', 'page-versions', pageId],
    queryFn: () => listPageVersions(pageId),
    staleTime: 0,
  });
  const [picked, setPicked] = useState<PageVersion | null>(null);
  const [busy, setBusy] = useState(false);

  const restore = async (target: PageVersion) => {
    if (!storage) return addToast({ title: 'The board is still loading. Try again in a moment.', color: 'warning' });
    setBusy(true);
    try {
      // Unsaved ink on this device goes up first, so it stays one of the earlier versions.
      if (readSyncedVersion(pageId)?.dirty) await uploadNotebookDocument(pageId, storage);
      const { current } = await listPageVersions(pageId);

      await restorePageVersion(pageId, target.version, current);
      await replaceWithRemote(pageId, storage);
      addToast({ title: `Brought back version ${target.version}`, color: 'success' });
      window.location.reload();
    } catch (e) {
      addToast({ title: errorText(e), color: 'danger' });
      setBusy(false);
    }
  };

  return (
    <>
      <Sheet subtitle='Restoring keeps the page as it is now in this list.' title='Earlier versions' onClose={onClose}>
        {isLoading ? (
          <p className='text-st-muted text-sm'>Loading…</p>
        ) : error ? (
          <p className='text-st-danger text-sm'>{errorText(error)}</p>
        ) : !data?.items.length ? (
          <p className='text-st-muted text-sm'>Nothing saved yet.</p>
        ) : (
          <ul className='divide-st-line flex flex-col divide-y'>
            {data.items.map((v) => (
              <li key={v.version} className='flex min-h-11 items-center gap-3 py-1'>
                <div className='min-w-0 flex-1'>
                  <p className='text-st-fg truncate text-sm'>
                    Version {v.version}
                    {v.version === data.current ? ' · Now' : ''}
                  </p>
                  <p className='text-st-muted truncate text-xs'>{versionLine(v)}</p>
                </div>
                {v.version !== data.current && (
                  <ActionButton className='shrink-0' disabled={busy} variant='ghost' onClick={() => setPicked(v)}>
                    Restore
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </Sheet>
      {picked && (
        <ConfirmSheet
          confirmLabel='Restore'
          title={`Bring back version ${picked.version}?`}
          onClose={() => setPicked(null)}
          onConfirm={() => void restore(picked)}
        >
          The page changes to how it was then, for everyone it is shared with. The page as it is now stays in Earlier versions.
        </ConfirmSheet>
      )}
    </>
  );
}

/** The owner's top-bar chip that opens «Earlier versions». */
export function PageVersionsButton({ pageId }: { pageId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip content='Earlier versions'>
        <span className='inline-flex'>
          <ActionButton aria-label='Earlier versions' className={BOARD_CHIP_OVERRIDE} onClick={() => setOpen(true)}>
            <History className='h-4 w-4 shrink-0' />
          </ActionButton>
        </span>
      </Tooltip>
      {open && <VersionsSheet pageId={pageId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** On someone else's page shared with me to edit: "Maya's · Can edit" (text from lg up). */
export function SharedEditChip({ ownerName, className }: { ownerName: string; className?: string }) {
  const text = `${ownerName}’s notebook · Can edit`;

  return (
    <Tooltip content={text}>
      <span aria-label={text} className={cn(BOARD_CHIP, 'max-w-[16rem] cursor-default', className)} role='note'>
        <Users className='h-4 w-4 shrink-0' />
        <span className='hidden truncate lg:inline'>{text}</span>
      </span>
    </Tooltip>
  );
}
