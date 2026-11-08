import type { LucideIcon } from 'lucide-react';

import { cn } from '@repo/ui';
import { BookOpen, CalendarDays, GalleryVerticalEnd, Home, Inbox, Layers, Library, Mic, Network, Search, Settings, Sparkles, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { classHref } from '@/components/classes/ClassCard';
import { LinkButton } from '@/components/ui/primitives';
import { useBackendSettings, useResolvedMode } from '@/hooks/useBackendSettings';
import { useSession } from '@/hooks/useSession';
import { useInbox } from '@/features/inbox/store';
import { useClasses } from '@/lib/api/hooks';

export interface RailLink {
  href: string;
  label: string;
  icon: LucideIcon;
  match?: (pathname: string) => boolean;
}

export const TOP_LINKS: RailLink[] = [
  { href: '/', label: 'Today', icon: Home, match: (pathname) => pathname === '/' },
  { href: '/calendar/', label: 'Calendar', icon: CalendarDays },
  {
    href: '/classes/',
    label: 'Classes',
    icon: Layers,
    match: (pathname) => pathname.startsWith('/classes') || pathname.startsWith('/class'),
  },
];

export const TOOL_LINKS: RailLink[] = [
  { href: '/inbox/', label: 'Inbox', icon: Inbox },
  { href: '/bank/', label: 'Question Bank', icon: BookOpen },
  { href: '/flashcards/', label: 'Flashcards', icon: GalleryVerticalEnd },
  { href: '/concept-maps/', label: 'Concept Maps', icon: Network },
  { href: '/library/', label: 'Library', icon: Library },
  { href: '/lectures/', label: 'Lectures', icon: Mic },
  { href: '/tutor/', label: 'Tutor', icon: Sparkles },
  { href: '/search/', label: 'Search', icon: Search },
];

export const SETTINGS_LINK: RailLink = { href: '/settings/', label: 'Settings', icon: Settings };

/** Every nav destination in Rail order: the phone bottom bar and its More sheet derive from this. */
export const ALL_LINKS: RailLink[] = [...TOP_LINKS, ...TOOL_LINKS, SETTINGS_LINK];

export function isLinkActive(link: RailLink, pathname: string): boolean {
  return link.match ? link.match(pathname) : pathname === link.href.replace(/\/$/, '');
}

export function RailItem({
  link,
  active,
  badge = 0,
  onClick,
}: {
  link: RailLink;
  active: boolean;
  badge?: number;
  onClick?: () => void;
}) {
  const Icon = link.icon;

  return (
    <Link
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-st flex min-h-11 items-center gap-3 border-2 px-3 text-sm font-medium transition-colors',
        active
          ? 'border-st-clay-edge bg-st-accent-soft text-st-fg font-semibold'
          : 'text-st-fg hover:bg-st-raised border-transparent',
      )}
      href={link.href}
      onClick={onClick}
    >
      <Icon className={cn('h-5 w-5 shrink-0', active && 'text-st-accent')} strokeWidth={active ? 2 : 1.75} />
      <span className='truncate'>{link.label}</span>
      {badge > 0 && (
        <span
          aria-label={`${badge} new`}
          className={cn(
            'ml-auto min-w-5 rounded-sm px-1.5 text-center text-xs font-semibold tabular-nums leading-5',
            'border-st-star-lip bg-st-star text-st-star-fg border',
          )}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  );
}

/**
 * Demo-mode call to action: nothing leaves this device until there is an account on a server. A real
 * clay button (full width) with a one-line hint under it — the lip needs the 8px below it, so the hint
 * sits `mt-2` past the 4px lip.
 */
export function SignUpCta({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col', className)}>
      <LinkButton
        className='w-full'
        href='/login/?tab=create'
        variant='primary'
      >
        <UserPlus className='h-4 w-4 shrink-0' />
        <span className='truncate'>Create account</span>
      </LinkButton>
      <p className='text-st-muted mt-2 truncate text-center text-xs'>Keep your data on every device</p>
    </div>
  );
}

export function Rail() {
  const router = useRouter();
  const pathname = router.pathname.replace(/\/$/, '') || '/';
  const { data: classes } = useClasses();
  const mode = useResolvedMode();
  const session = useSession();
  const { backendUrl } = useBackendSettings();
  const { unread } = useInbox();
  const activeClassId = pathname === '/class' ? String(router.query.id ?? '') : '';
  const isActive = (link: RailLink) => isLinkActive(link, pathname);

  return (
    <nav
      aria-label='Primary'
      className='st-no-select border-st-line bg-st-surface hidden h-full w-60 md:flex shrink-0 flex-col border-r'
    >
      <div className='flex items-center gap-2 px-4 pb-3 pt-5'>
        {/* The Syllabi mark (star bookmark), public/logo-mark.svg. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt='' className='h-8 w-8 shrink-0' height={32} src='/logo-mark.svg' width={32} />
        <span className='text-st-fg font-display text-lg font-bold tracking-tight'>Syllabi</span>
        {mode === 'mock' && (
          <span className='border-st-warn/30 bg-st-warn/10 text-st-warn ml-auto rounded-sm border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide'>
            mock
          </span>
        )}
      </div>

      <div className='flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3'>
        {TOP_LINKS.map((link) => (
          <RailItem key={link.href} active={isActive(link)} link={link} />
        ))}

        {classes && classes.length > 0 && (
          <div className='mt-1 flex flex-col gap-1 pl-2'>
            {classes.map((cls) => {
              const active = activeClassId === cls.id;

              return (
                <Link
                  key={cls.id}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-st flex min-h-10 items-center gap-2.5 border-2 px-3 text-sm transition-colors',
                    active
                      ? 'border-st-clay-edge bg-st-accent-soft text-st-fg font-semibold'
                      : 'text-st-fg/90 hover:bg-st-raised border-transparent',
                  )}
                  href={classHref(cls)}
                  title={cls.name}
                >
                  <span className='h-2.5 w-2.5 shrink-0 rounded-sm' style={{ backgroundColor: cls.color }} />
                  <span className='truncate'>{cls.code}</span>
                  {cls.counts.overdue + cls.counts.due > 0 && (
                    <span
                      className={cn(
                        'ml-auto text-xs tabular-nums',
                        cls.counts.overdue > 0 ? 'text-st-danger' : 'text-st-muted',
                      )}
                    >
                      {cls.counts.overdue + cls.counts.due}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}

        <div className='border-st-line my-2 border-t' />

        {TOOL_LINKS.map((link) => (
          <RailItem key={link.href} active={isActive(link)} badge={link.href === '/inbox/' ? unread : 0} link={link} />
        ))}
      </div>

      <div className='border-st-line border-t p-3'>
        <RailItem active={pathname === '/settings'} link={SETTINGS_LINK} />
        {/* Demo mode: nothing leaves this device until there is an account on a server. */}
        {!backendUrl ? (
          <SignUpCta className='mt-2' />
        ) : (
          <p className='text-st-muted mt-2 truncate px-3 text-xs'>
            {session.state === 'signed-in'
              ? session.name || 'Signed in'
              : session.state === 'signed-out'
                ? 'Signed out'
                : ''}
          </p>
        )}
      </div>
    </nav>
  );
}
