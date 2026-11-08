import type { InboxItem } from './types';

import { useEffect, useState } from 'react';
import { BookOpen, Inbox, Network, NotebookPen, Radio, Settings, Smartphone, Trash2 } from 'lucide-react';
import Head from 'next/head';

import { BankExtractSheet } from './components/BankExtractSheet';
import { InboxThumb } from './components/InboxThumb';
import { NotebookPickerSheet } from './components/NotebookPickerSheet';
import { Sheet } from './components/Sheet';
import { simulateMockArrival } from './mock';
import { loadInboxFile, markInboxSeen, markItemUsed, removeInboxItem, useInbox } from './store';

import { PageHeader } from '@/components/layout/PageHeader';
import { SampleDataBanner } from '@/components/ui/SampleDataBanner';
import { ActionButton, Badge, EmptyState, ErrorNote, LinkButton, LoadingRows } from '@/components/ui/primitives';
import { useBackendSettings } from '@/hooks/useBackendSettings';
import { describeError } from '@/lib/api/errors';
import { useSampleRoute } from '@/lib/api/hooks';
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format';

type Action = { kind: 'notes' | 'map' | 'bank' | 'view'; item: InboxItem } | null;

function LiveChip({ mode }: { mode: ReturnType<typeof useInbox>['mode'] }) {
  const live = mode === 'sse';

  return (
    <span className='border-st-line bg-st-surface text-st-muted inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium'>
      <Radio className={live ? 'text-st-ok h-3.5 w-3.5' : 'h-3.5 w-3.5'} />
      {live ? 'Live' : mode === 'poll' ? 'Checking every 10 s' : mode === 'connecting' ? 'Connecting…' : 'Offline'}
    </span>
  );
}

function InboxCard({
  item,
  unread,
  onAction,
}: {
  item: InboxItem;
  unread: boolean;
  onAction: (action: Exclude<Action, null>) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <li className='rounded-st-lg border-st-clay-edge bg-st-surface shadow-clay flex flex-col overflow-hidden border-2'>
      <button
        className='relative block'
        title='View full size'
        type='button'
        onClick={() => onAction({ kind: 'view', item })}
      >
        <InboxThumb className='aspect-[4/3] w-full' item={item} />
        {unread && (
          <span className='bg-st-accent text-st-bg absolute left-2 top-2 rounded-sm px-2 py-0.5 text-[11px] font-semibold'>
            New
          </span>
        )}
      </button>
      <div className='flex flex-1 flex-col gap-2 p-3'>
        <div className='flex items-center gap-2 text-xs'>
          <span className='text-st-fg font-medium' title={formatDateTime(item.createdAt)}>
            {formatRelative(item.createdAt)}
          </span>
          <span className='text-st-muted'>
            · {item.kind === 'pdf' ? 'PDF' : item.width && item.height ? `${item.width}×${item.height}` : 'Photo'} ·{' '}
            {formatBytes(item.bytes)}
          </span>
          {item.usedAt && (
            <Badge className='ml-auto' tone='ok'>
              Used
            </Badge>
          )}
        </div>
        <p className={item.note ? 'text-st-fg line-clamp-2 text-sm' : 'text-st-muted text-sm italic'}>
          {item.note ?? 'No note'}
        </p>
        {error && <ErrorNote message={error} />}
        <div className='mt-auto flex flex-wrap gap-2 pt-1'>
          <ActionButton className='min-h-9 px-3 text-xs' onClick={() => onAction({ kind: 'notes', item })}>
            <NotebookPen className='h-3.5 w-3.5' /> Add to notes
          </ActionButton>
          {item.kind === 'image' && (
            <ActionButton className='min-h-9 px-3 text-xs' onClick={() => onAction({ kind: 'map', item })}>
              <Network className='h-3.5 w-3.5' /> Concept map
            </ActionButton>
          )}
          <ActionButton
            className='min-h-9 px-3 text-xs'
            disabled={item.kind !== 'image'}
            onClick={() => onAction({ kind: 'bank', item })}
          >
            <BookOpen className='h-3.5 w-3.5' /> Use in bank
          </ActionButton>
          <ActionButton
            aria-label='Delete'
            className='ml-auto min-h-9 px-3 text-xs'
            loading={deleting}
            variant='danger'
            onClick={async () => {
              setDeleting(true);
              setError(null);
              try {
                await removeInboxItem(item.id);
              } catch (err) {
                setError(describeError(err));
                setDeleting(false);
              }
            }}
          >
            <Trash2 className='h-3.5 w-3.5' />
          </ActionButton>
        </div>
      </div>
    </li>
  );
}

/** `/inbox/` — everything sent from the phone, newest first. Opening it clears the Rail badge. */
export default function InboxPage() {
  const inbox = useInbox();
  const { mockMode } = useBackendSettings();
  const isSample = useSampleRoute('/inbox');
  const [action, setAction] = useState<Action>(null);
  // Unread is judged against the mark as it was when the page opened, so «New» stays visible here.
  const [openedSeenAt, setOpenedSeenAt] = useState<string | null>(null);

  useEffect(() => {
    if (!inbox.loaded) return;
    setOpenedSeenAt((current) => current ?? inbox.seenAt ?? new Date(0).toISOString());
    markInboxSeen();
  }, [inbox.items.length, inbox.loaded]);

  const isUnread = (item: InboxItem) =>
    !item.usedAt && !!openedSeenAt && Date.parse(item.createdAt) > Date.parse(openedSeenAt);

  return (
    <>
      <Head>
        <title>Inbox · Syllabi</title>
      </Head>
      <PageHeader
        actions={
          <div className='flex flex-wrap items-center gap-2'>
            <LiveChip mode={inbox.mode} />
            {mockMode === 'mock' && (
              <ActionButton className='min-h-9 px-3 text-xs' onClick={() => simulateMockArrival()}>
                <Smartphone className='h-3.5 w-3.5' /> Simulate a photo
              </ActionButton>
            )}
            <LinkButton href='/settings/'>
              <Settings className='h-4 w-4' /> Phone setup
            </LinkButton>
          </div>
        }
        subtitle='Photos and PDFs sent from your iPhone.'
        title='Inbox'
      />
      {isSample && <SampleDataBanner className='mb-4' what='phone uploads' />}

      {!inbox.loaded && inbox.items.length === 0 ? (
        inbox.mode === 'stopped' ? (
          <ErrorNote message='Sign in to see your phone inbox.' />
        ) : (
          <LoadingRows rows={3} />
        )
      ) : inbox.items.length === 0 ? (
        <EmptyState
          action={<LinkButton href='/settings/'>Set up the iPhone</LinkButton>}
          hint='Scan the QR code in Settings → Phone inbox with the iPhone camera, or add the Share Sheet shortcut. New photos show up here live.'
          icon={Inbox}
          title='Nothing from your phone yet'
        />
      ) : (
        <ul className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3'>
          {inbox.items.map((item) => (
            <InboxCard key={item.id} item={item} unread={isUnread(item)} onAction={setAction} />
          ))}
        </ul>
      )}

      {action?.kind === 'notes' && <NotebookPickerSheet item={action.item} onClose={() => setAction(null)} />}
      {action?.kind === 'map' && <NotebookPickerSheet makeMap item={action.item} onClose={() => setAction(null)} />}
      {action?.kind === 'bank' && (
        <BankExtractSheet
          source={{
            preview: action.item.thumbUrl ?? action.item.url,
            classId: action.item.classId,
            load: () => loadInboxFile(action.item),
          }}
          onClose={() => setAction(null)}
          onExtracted={() => void markItemUsed(action.item.id)}
        />
      )}
      {action?.kind === 'view' && (
        <Sheet
          wide
          subtitle={formatDateTime(action.item.createdAt)}
          title={action.item.note ?? 'Photo from phone'}
          onClose={() => setAction(null)}
        >
          {action.item.kind === 'pdf' ? (
            <a className='text-st-accent underline' href={action.item.url} rel='noreferrer' target='_blank'>
              Open the PDF
            </a>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- signed B2 / data URL
            <img
              alt={action.item.note ?? 'Photo from phone'}
              className='mx-auto max-h-[70vh] w-auto'
              src={action.item.url}
            />
          )}
        </Sheet>
      )}
    </>
  );
}
