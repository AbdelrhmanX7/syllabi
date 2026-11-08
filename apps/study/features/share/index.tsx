// Sharing, phase 1: `/shared` (Shared with me + the read-only viewer with «Make a copy») and the Share
// button / sheet the notebook, flashcards, bank and concept maps mount.
import type { ShareResourceType, SharedWithMeItem } from './types';
import type { LucideIcon } from 'lucide-react';

import { addToast } from '@repo/ui';
import { ChevronRight, Copy, GalleryVerticalEnd, ListChecks, Network, NotebookPen, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { forkHref, useFork, useSharedView, useSharedWithMe } from './api';
import { SharedContent } from './components/SharedViews';
import { RESOURCE_LABEL, RESOURCE_NOUN } from './types';

import { PageHeader } from '@/components/layout/PageHeader';
import { ActionButton, EmptyState, ErrorNote, LinkButton, LoadingRows } from '@/components/ui/primitives';
import { useStudyQueriesEnabled } from '@/lib/api/hooks';

export { ShareButton, ForkedFromNote } from './components/ShareButton';
export type { ShareTarget, ShareResourceType } from './types';

const ICON: Record<ShareResourceType, LucideIcon> = {
  notebook: NotebookPen,
  deck: GalleryVerticalEnd,
  questions: ListChecks,
  conceptMap: Network,
};

const DAY = 86_400_000;

/** "just now" · "5 min ago" · "3 h ago" · "Oct 12" — short, en-US. */
export function shortWhen(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);

  if (!Number.isFinite(t)) return 'Not set';
  const diff = Math.max(0, now - t);

  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < DAY) return `${Math.round(diff / 3_600_000)} h ago`;
  if (diff < 7 * DAY) return `${Math.round(diff / DAY)} d ago`;

  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Something went wrong.');

function SharedRow({ item }: { item: SharedWithMeItem }) {
  const Icon = ICON[item.resourceType];

  return (
    <li>
      <Link
        className='rounded-st text-st-fg hover:bg-st-raised flex min-h-12 items-center gap-3 px-3 py-2 transition-colors'
        href={`/shared/?id=${encodeURIComponent(item.id)}`}
        title={item.title}
      >
        <Icon className='text-st-accent h-5 w-5 shrink-0' strokeWidth={1.75} />
        <span className='min-w-0 flex-1'>
          <span className='block truncate text-sm font-semibold'>{item.title}</span>
          <span className='text-st-muted block truncate text-xs'>
            {RESOURCE_LABEL[item.resourceType]} · {item.ownerName} · updated {shortWhen(item.updatedAt)}
          </span>
        </span>
        <ChevronRight className='text-st-muted h-4 w-4 shrink-0' />
      </Link>
    </li>
  );
}

function SharedList() {
  const { data, isLoading, error, refetch } = useSharedWithMe();

  return (
    <>
      <PageHeader title='Shared with me' />
      {isLoading ? (
        <LoadingRows rows={4} />
      ) : error ? (
        <ErrorNote message={errorText(error)} onRetry={() => void refetch()} />
      ) : !data?.length ? (
        <EmptyState
          hint='When a classmate shares a notebook, deck, question set or concept map with your email, it shows up here.'
          icon={Users}
          title='Nothing shared with you yet'
        />
      ) : (
        <ul className='border-st-line bg-st-surface flex flex-col gap-1 rounded-lg border p-1'>
          {data.map((item) => (
            <SharedRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </>
  );
}

function SharedViewer({ id }: { id: string }) {
  const router = useRouter();
  const { data, isLoading, error } = useSharedView(id);
  const fork = useFork();

  if (isLoading) return <LoadingRows rows={5} />;
  if (error || !data) {
    return (
      <>
        <PageHeader back='/shared/' title='Shared item' />
        <EmptyState
          action={<LinkButton href='/shared/'>Shared with me</LinkButton>}
          hint={error ? errorText(error) : undefined}
          icon={Users}
          title='Can’t open this'
        />
      </>
    );
  }
  const { share } = data;
  const makeCopy = () =>
    fork.mutate(id, {
      onSuccess: (result) => {
        addToast({ title: `Copied to your ${RESOURCE_NOUN[result.resourceType]}s`, color: 'success' });
        void router.push(forkHref(result));
      },
      onError: (e) => addToast({ title: errorText(e), color: 'danger' }),
    });

  return (
    <>
      <PageHeader
        actions={
          <ActionButton loading={fork.isPending} variant='primary' onClick={makeCopy}>
            <Copy className='h-4 w-4' /> Make a copy
          </ActionButton>
        }
        back='/shared/'
        subtitle={`${share.isOwner ? 'Yours' : `${share.ownerName}’s`} ${RESOURCE_NOUN[share.resourceType]} · View only · updated ${shortWhen(share.updatedAt)}`}
        title={share.title}
      />
      <SharedContent view={data} />
    </>
  );
}

/** Signed out (and not in demo mode): shared items need an account; come back here after signing in. */
function SignInPrompt({ id }: { id: string }) {
  const next = id ? `/shared/?id=${encodeURIComponent(id)}` : '/shared/';

  return (
    <>
      <PageHeader title='Shared with me' />
      <EmptyState
        action={
          <LinkButton href={`/login/?next=${encodeURIComponent(next)}`} variant='primary'>
            Sign in
          </LinkButton>
        }
        hint='Sign in with the email it was shared to.'
        icon={Users}
        title='Sign in to open shared material'
      />
    </>
  );
}

export default function SharedHome({ id }: { id: string }) {
  const enabled = useStudyQueriesEnabled();

  if (!enabled) return <SignInPrompt id={id} />;

  return id ? <SharedViewer id={id} /> : <SharedList />;
}
