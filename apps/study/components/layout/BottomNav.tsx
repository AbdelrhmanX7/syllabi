import type { RailLink } from './Rail';

import { useState } from 'react';
import { cn } from '@repo/ui';
import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { ALL_LINKS, RailItem, SignUpCta, isLinkActive } from './Rail';

import { useBackendSettings, useResolvedMode } from '@/hooks/useBackendSettings';
import { useSession } from '@/hooks/useSession';
import { Sheet } from '@/features/inbox/components/Sheet';
import { useInbox } from '@/features/inbox/store';

/** The four bar destinations (by Rail href); everything else in the Rail lands in «More». */
const PRIMARY: { href: string; short?: string }[] = [
  { href: '/' },
  { href: '/classes/' },
  { href: '/calendar/' },
  { href: '/bank/', short: 'Bank' },
];

const ITEM_CLASS = 'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] leading-tight';

function BarIcon({ icon: Icon, active }: { icon: RailLink['icon']; active: boolean }) {
  return (
    <span
      className={cn(
        'flex h-7 w-12 items-center justify-center rounded-md transition-colors',
        active && 'bg-st-accent-soft text-st-accent',
      )}
    >
      <Icon className='h-5 w-5' strokeWidth={active ? 2 : 1.75} />
    </span>
  );
}

/**
 * Phone shell (< md): a fixed bottom bar with the four main places + «More» (a sheet with every other
 * Rail destination). The Rail itself is hidden below md, so tablets (≥ 768) never see this.
 */
export function BottomNav() {
  const router = useRouter();
  const pathname = router.pathname.replace(/\/$/, '') || '/';
  const [moreOpen, setMoreOpen] = useState(false);
  const { unread } = useInbox();
  const mode = useResolvedMode();
  const session = useSession();
  const { backendUrl } = useBackendSettings();

  const primaryHrefs = new Set(PRIMARY.map((p) => p.href));
  const primary = PRIMARY.flatMap((p) => {
    const link = ALL_LINKS.find((l) => l.href === p.href);

    return link ? [{ link, label: p.short ?? link.label }] : [];
  });
  const more = ALL_LINKS.filter((l) => !primaryHrefs.has(l.href));
  const moreActive = more.some((l) => isLinkActive(l, pathname));
  const inboxInMore = more.some((l) => l.href === '/inbox/');

  return (
    <>
      <nav
        aria-label='Primary'
        className='st-no-select border-st-line bg-st-surface fixed inset-x-0 bottom-0 z-30 flex border-t pb-[env(safe-area-inset-bottom)] md:hidden'
      >
        {primary.map(({ link, label }) => {
          const active = isLinkActive(link, pathname);

          return (
            <Link
              key={link.href}
              aria-current={active ? 'page' : undefined}
              className={cn(ITEM_CLASS, 'min-h-16', active ? 'text-st-fg font-semibold' : 'text-st-muted font-medium')}
              href={link.href}
            >
              <BarIcon active={active} icon={link.icon} />
              <span className='max-w-full truncate'>{label}</span>
            </Link>
          );
        })}
        <button
          aria-expanded={moreOpen}
          aria-haspopup='dialog'
          className={cn(ITEM_CLASS, 'relative min-h-16', moreActive ? 'text-st-fg font-semibold' : 'text-st-muted font-medium')}
          type='button'
          onClick={() => setMoreOpen(true)}
        >
          <BarIcon active={moreActive} icon={MoreHorizontal} />
          <span className='max-w-full truncate'>More</span>
          {inboxInMore && unread > 0 && (
            <span
              aria-label={`${unread} new in Inbox`}
              className='border-st-star-lip bg-st-star absolute right-[calc(50%-1.75rem)] top-1.5 h-2.5 w-2.5 rounded-full border'
            />
          )}
        </button>
      </nav>

      {moreOpen && (
        <Sheet
          subtitle={[
            mode === 'mock' ? 'Demo mode' : '',
            session.state === 'signed-in' ? session.name || 'Signed in' : session.state === 'signed-out' ? 'Signed out' : '',
          ]
            .filter(Boolean)
            .join(' · ')}
          // Demo mode: the sign-up button sits in the sheet's footer (outside the scroll box, so its lip is never cut).
          footer={backendUrl ? undefined : <SignUpCta />}
          title='More'
          onClose={() => setMoreOpen(false)}
        >
          {/* Flat one-line rows (inside the sheet's scroll box: no lips). */}
          <div className='flex flex-col gap-1'>
            {more.map((link) => (
              <RailItem
                key={link.href}
                active={isLinkActive(link, pathname)}
                badge={link.href === '/inbox/' ? unread : 0}
                link={link}
                onClick={() => setMoreOpen(false)}
              />
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
