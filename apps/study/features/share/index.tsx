// Sharing: `/shared` (Shared with me + the viewer with «Make a copy»; Can edit people get the editable
// version, a notebook opens on the board) and the Share button / sheet the notebook, flashcards, bank
// and concept maps mount.
import type { ShareResourceType, SharedWithMeItem } from './types';
import type { LucideIcon } from 'lucide-react';

import { useRef } from 'react';
import { addToast } from '@repo/ui';
import { ChevronRight, Copy, GalleryVerticalEnd, Link2, ListChecks, Network, NotebookPen, Pencil, Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { forkHref, useFork, useForks, useLinkPreview, useSharedView, useSharedWithMe } from './api';
import { isLinkToken, loginHref } from './link';
import { SharedContent } from './components/SharedViews';
import { RESOURCE_LABEL, RESOURCE_NOUN, ROLE_LABEL } from './types';

import { PageHeader } from '@/components/layout/PageHeader';
import { ActionButton, EmptyState, ErrorNote, LinkButton, LoadingRows } from '@/components/ui/primitives';
import { useStudyQueriesEnabled } from '@/lib/api/hooks';
import { isValidAdminToken, readSessionToken } from '@/lib/auth';

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
            {RESOURCE_LABEL[item.resourceType]} · {item.ownerName} · {ROLE_LABEL[item.role]} ·{' '}
            {item.editedBy ? `edited by ${item.editedBy.name}` : 'updated'} {shortWhen(item.updatedAt)}
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
  const forks = useForks();
  // A second tap before the first answer re-renders the button as busy must not send a second copy.
  const forking = useRef(false);

  if (isLoading) return <LoadingRows rows={5} />;
  // Demo mode opening a real link: the demo doesn't know it, so show what the link holds instead.
  if (error && isLinkToken(id) && !isValidAdminToken(readSessionToken())) return <LinkLanding token={id} />;
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
  const canEdit = share.role === 'editor' && !share.isOwner && Boolean(share.resourceId);
  // Opened by link: the button says what it does for them («Add to my Syllabi» = their own copy).
  const byLink = isLinkToken(id) && !share.isOwner;
  // Their copy from this share, if they made one: the button opens it (the server answers with that copy).
  const haveCopy = !share.isOwner && (forks.data ?? []).some((f) => f.forkedFrom.shareId === share.id);
  const makeCopy = () => {
    if (forking.current) return;
    forking.current = true;
    fork.mutate(id, {
      onSuccess: (result) => {
        if (!result.existing) addToast({ title: `Copied to your ${RESOURCE_NOUN[result.resourceType]}s`, color: 'success' });
        void router.push(forkHref(result));
      },
      onError: (e) => {
        forking.current = false;
        addToast({ title: errorText(e), color: 'danger' });
      },
    });
  };

  return (
    <>
      <PageHeader
        actions={
          <div className='flex flex-wrap justify-end gap-3'>
            {canEdit && share.resourceType === 'notebook' && (
              <LinkButton href={`/notebook/?id=${encodeURIComponent(share.resourceId ?? '')}`} variant='primary'>
                <Pencil className='h-4 w-4' /> Open to edit
              </LinkButton>
            )}
            <ActionButton
              loading={fork.isPending}
              variant={canEdit && share.resourceType === 'notebook' ? 'secondary' : 'primary'}
              onClick={makeCopy}
            >
              {haveCopy ? (
                <>
                  <ChevronRight className='h-4 w-4' /> Open my copy
                </>
              ) : byLink ? (
                <>
                  <Plus className='h-4 w-4' /> Add to my Syllabi
                </>
              ) : (
                <>
                  <Copy className='h-4 w-4' /> Make a copy
                </>
              )}
            </ActionButton>
          </div>
        }
        back='/shared/'
        subtitle={`${share.isOwner ? 'Yours' : `${share.ownerName}’s`} ${RESOURCE_NOUN[share.resourceType]} · ${
          canEdit ? ROLE_LABEL.editor : haveCopy ? 'You have your own copy' : byLink ? 'Add it to get your own copy to change' : 'View only'
        } · ${share.editedBy ? `edited by ${share.editedBy.name}` : 'updated'} ${shortWhen(share.updatedAt)}`}
        title={share.title}
      />
      <SharedContent idOrToken={id} view={data} />
    </>
  );
}

/**
 * A share link opened by someone who isn't signed in: what it is (title, kind, the owner's first name,
 * nothing more) and the way in. The copy is made on the server in their account, so it needs one:
 * «Create a free account to add it» (or sign in) comes straight back here, where «Add to my Syllabi»
 * makes the copy.
 */
function LinkLanding({ token }: { token: string }) {
  const { data, isLoading, error, refetch } = useLinkPreview(token);

  if (isLoading) return <LoadingRows rows={3} />;
  if (error || !data) {
    const message = errorText(error);
    const network = /reach the server|Too many/.test(message);

    return (
      <>
        <PageHeader title='Shared link' />
        {network ? (
          <ErrorNote message={message} onRetry={() => void refetch()} />
        ) : (
          <EmptyState hint='Ask the person who sent it for a new link.' icon={Link2} title='This link doesn’t work any more' />
        )}
      </>
    );
  }
  const Icon = ICON[data.resourceType];

  return (
    <>
      <PageHeader eyebrow={`${data.ownerName} shared a ${RESOURCE_NOUN[data.resourceType]}`} title={data.title} />
      <div className='flex flex-col gap-4'>
        <div className='flex items-center gap-3'>
          <Icon className='text-st-accent h-6 w-6 shrink-0' strokeWidth={1.75} />
          <p className='text-st-fg min-w-0 flex-1 text-sm'>
            Add it to get your own copy. Change it however you like; {data.ownerName}’s stays the same.
          </p>
        </div>
        <div className='flex flex-wrap gap-3'>
          <LinkButton href={loginHref(token, 'create')} variant='primary'>
            <Plus className='h-4 w-4' /> Create a free account to add it
          </LinkButton>
          <LinkButton href={loginHref(token, 'signin')}>I have an account</LinkButton>
        </div>
      </div>
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

  if (!enabled) return isLinkToken(id) ? <LinkLanding token={id} /> : <SignInPrompt id={id} />;

  return id ? <SharedViewer id={id} /> : <SharedList />;
}
