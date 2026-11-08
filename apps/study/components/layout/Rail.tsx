import type { LucideIcon } from 'lucide-react';

import { useSyncExternalStore } from 'react';
import { Button, Tooltip, cn } from '@repo/ui';
import {
  BookOpen,
  CalendarDays,
  GalleryVerticalEnd,
  Home,
  Inbox,
  Layers,
  Library,
  Mic,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sparkles,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { SignOutButton } from './SignOutButton';

import { classHref } from '@/components/classes/ClassCard';
import { LinkButton } from '@/components/ui/primitives';
import { useBackendSettings, useResolvedMode } from '@/hooks/useBackendSettings';
import { useSession } from '@/hooks/useSession';
import { useAiEnabled } from '@/hooks/useAiEnabled';
import { useInbox } from '@/features/inbox/store';
import { useClasses } from '@/lib/api/hooks';

export interface RailLink {
  href: string;
  label: string;
  icon: LucideIcon;
  match?: (pathname: string) => boolean;
  /** Only with an account on a server (hidden in demo mode / signed out): `visibleLinks`. */
  serverOnly?: boolean;
  /** An AI page: hidden for accounts the server has no AI for (`useAiEnabled`). */
  ai?: boolean;
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
  { href: '/tutor/', label: 'Tutor', icon: Sparkles, ai: true },
  { href: '/search/', label: 'Search', icon: Search },
  { href: '/shared/', label: 'Shared', icon: Users, serverOnly: true },
];

export const SETTINGS_LINK: RailLink = { href: '/settings/', label: 'Settings', icon: Settings };

/** Every nav destination in Rail order: the phone bottom bar and its More sheet derive from this. */
export const ALL_LINKS: RailLink[] = [...TOP_LINKS, ...TOOL_LINKS, SETTINGS_LINK];

/**
 * Links for this session: `serverOnly` ones need a signed-in account on a server (not demo mode);
 * `ai` ones need an account with AI.
 */
export function visibleLinks(links: RailLink[], onServer: boolean, aiOn = true): RailLink[] {
  return links.filter((link) => (onServer || !link.serverOnly) && (aiOn || !link.ai));
}

/* ------------------------------------------------------------- collapse state (per device) */

const RAIL_COLLAPSED_KEY = 'study_rail_collapsed';
const railListeners = new Set<() => void>();

function readRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function subscribeRail(listener: () => void) {
  railListeners.add(listener);

  return () => {
    railListeners.delete(listener);
  };
}

export function setRailCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // private window / blocked storage: the toggle still works for this session below
  }
  memoryCollapsed = collapsed;
  railListeners.forEach((listener) => listener());
}

let memoryCollapsed: boolean | null = null;

/** Collapsed rail? Expanded on the server snapshot (static export), then the device's choice. */
export function useRailCollapsed(): boolean {
  return useSyncExternalStore(
    subscribeRail,
    () => memoryCollapsed ?? readRailCollapsed(),
    () => false,
  );
}

export function isLinkActive(link: RailLink, pathname: string): boolean {
  return link.match ? link.match(pathname) : pathname === link.href.replace(/\/$/, '');
}

export function RailItem({
  link,
  active,
  badge = 0,
  onClick,
  compact = false,
}: {
  link: RailLink;
  active: boolean;
  badge?: number;
  onClick?: () => void;
  /** Collapsed rail: icon only, the label in a tooltip (hover + focus) and the accessible name. */
  compact?: boolean;
}) {
  const Icon = link.icon;

  const item = (
    <Link
      aria-current={active ? 'page' : undefined}
      aria-label={compact ? (badge > 0 ? `${link.label}, ${badge} new` : link.label) : undefined}
      className={cn(
        'rounded-st relative flex min-h-11 items-center border-2 text-sm font-medium transition-colors',
        compact ? 'justify-center px-0' : 'gap-3 px-3',
        active
          ? 'border-st-clay-edge bg-st-accent-soft text-st-fg font-semibold'
          : 'text-st-fg hover:bg-st-raised border-transparent',
      )}
      href={link.href}
      onClick={onClick}
    >
      <Icon className={cn('h-5 w-5 shrink-0', active && 'text-st-accent')} strokeWidth={active ? 2 : 1.75} />
      {compact ? (
        badge > 0 && (
          <span
            aria-hidden='true'
            className='border-st-star-lip bg-st-star absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full border'
          />
        )
      ) : (
        <span className='truncate'>{link.label}</span>
      )}
      {!compact && badge > 0 && (
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

  return compact ? (
    <Tooltip content={link.label} placement='right'>
      {item}
    </Tooltip>
  ) : (
    item
  );
}

/**
 * Demo-mode call to action: nothing leaves this device until there is an account on a server. A real
 * clay button (full width) with a one-line hint under it — the lip needs the 8px below it, so the hint
 * sits `mt-2` past the 4px lip.
 */
export function SignUpCta({ className, compact = false }: { className?: string; compact?: boolean }) {
  const hasServer = Boolean(useBackendSettings().backendUrl);
  if (compact) {
    return (
      <Tooltip content='Create account' placement='right'>
        <span className={cn('inline-flex', className)}>
          <LinkButton aria-label='Create account' className='w-11 px-0' href='/login/?tab=create' variant='primary'>
            <UserPlus className='h-4 w-4 shrink-0' />
          </LinkButton>
        </span>
      </Tooltip>
    );
  }

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
      {hasServer ? (
        <p className='text-st-muted mt-2 truncate text-center text-xs'>
          Have an account?{' '}
          <Link className='text-st-fg font-semibold underline underline-offset-2' href='/login/'>
            Sign in
          </Link>
        </p>
      ) : (
        <p className='text-st-muted mt-2 truncate text-center text-xs'>Keep your data on every device</p>
      )}
    </div>
  );
}

export function Rail() {
  const router = useRouter();
  const pathname = router.pathname.replace(/\/$/, '') || '/';
  const { data: classes } = useClasses();
  const mode = useResolvedMode();
  const session = useSession();
  const { unread } = useInbox();
  const collapsed = useRailCollapsed();
  const activeClassId = pathname === '/class' ? String(router.query.id ?? '') : '';
  const isActive = (link: RailLink) => isLinkActive(link, pathname);
  const signedIn = session.state === 'signed-in';
  const aiOn = useAiEnabled();
  const who = session.email || session.name || 'Signed in';

  return (
    <nav
      aria-label='Primary'
      className={cn(
        'st-no-select border-st-line bg-st-surface hidden h-full shrink-0 flex-col border-r md:flex',
        // A short width step (150ms) — the only property that moves; cheap enough on a Galaxy Tab.
        'transition-[width] duration-150 ease-out motion-reduce:transition-none',
        collapsed ? 'w-16' : 'w-60',
      )}
      data-collapsed={collapsed || undefined}
    >
      <div className={cn('flex items-center gap-2 pb-3 pt-5', collapsed ? 'justify-center px-2' : 'pl-4 pr-3')}>
        {!collapsed && (
          <>
            {/* The Syllabi mark (star bookmark), public/logo-mark.svg. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt='' className='h-8 w-8 shrink-0' height={32} src='/logo-mark.svg' width={32} />
            <span className='text-st-fg font-display truncate text-lg font-bold tracking-tight'>Syllabi</span>
            {mode === 'mock' && (
              <span className='border-st-warn/30 bg-st-warn/10 text-st-warn rounded-sm border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide'>
                mock
              </span>
            )}
          </>
        )}
        <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} placement='right'>
          <Button
            isIconOnly
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn('shrink-0', !collapsed && 'ml-auto')}
            size='sm'
            variant='light'
            onPress={() => setRailCollapsed(!collapsed)}
          >
            {collapsed ? <PanelLeftOpen className='h-5 w-5' /> : <PanelLeftClose className='h-5 w-5' />}
          </Button>
        </Tooltip>
      </div>

      <div className={cn('flex flex-1 flex-col gap-1 overflow-y-auto pb-3', collapsed ? 'px-2' : 'px-3')}>
        {TOP_LINKS.map((link) => (
          <RailItem key={link.href} active={isActive(link)} compact={collapsed} link={link} />
        ))}

        {classes && classes.length > 0 && (
          <div className={cn('mt-1 flex flex-col gap-1', !collapsed && 'pl-2')}>
            {classes.map((cls) => {
              const active = activeClassId === cls.id;
              const pending = cls.counts.overdue + cls.counts.due;
              const row = (
                <Link
                  key={cls.id}
                  aria-current={active ? 'page' : undefined}
                  aria-label={collapsed ? cls.name : undefined}
                  className={cn(
                    'rounded-st flex min-h-10 items-center border-2 text-sm transition-colors',
                    collapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
                    active
                      ? 'border-st-clay-edge bg-st-accent-soft text-st-fg font-semibold'
                      : 'text-st-fg/90 hover:bg-st-raised border-transparent',
                  )}
                  href={classHref(cls)}
                  title={collapsed ? undefined : cls.name}
                >
                  <span
                    className={cn('shrink-0 rounded-sm', collapsed ? 'h-3 w-3' : 'h-2.5 w-2.5')}
                    style={{ backgroundColor: cls.color }}
                  />
                  {!collapsed && <span className='truncate'>{cls.code}</span>}
                  {!collapsed && pending > 0 && (
                    <span
                      className={cn(
                        'ml-auto text-xs tabular-nums',
                        cls.counts.overdue > 0 ? 'text-st-danger' : 'text-st-muted',
                      )}
                    >
                      {pending}
                    </span>
                  )}
                </Link>
              );

              return collapsed ? (
                <Tooltip key={cls.id} content={cls.code || cls.name} placement='right'>
                  {row}
                </Tooltip>
              ) : (
                row
              );
            })}
          </div>
        )}

        <div className='border-st-line my-2 border-t' />

        {visibleLinks(TOOL_LINKS, signedIn && mode !== 'mock', aiOn).map((link) => (
          <RailItem
            key={link.href}
            active={isActive(link)}
            badge={link.href === '/inbox/' ? unread : 0}
            compact={collapsed}
            link={link}
          />
        ))}
      </div>

      <div className={cn('border-st-line flex flex-col border-t', collapsed ? 'items-stretch p-2' : 'p-3')}>
        <RailItem active={pathname === '/settings'} compact={collapsed} link={SETTINGS_LINK} />
        {signedIn ? (
          collapsed ? (
            <div className='mt-2 flex justify-center pb-1'>
              <SignOutButton iconOnly />
            </div>
          ) : (
            <div className='mt-2 flex flex-col gap-2 pb-1'>
              <p className='text-st-muted truncate px-3 text-xs' title={who}>
                {who}
              </p>
              <SignOutButton className='w-full' />
            </div>
          )
        ) : (
          // Signed out (or demo mode): create an account, or sign in to an existing one.
          collapsed ? (
            <div className='mt-2 flex justify-center pb-1'>
              <SignUpCta compact />
            </div>
          ) : (
            <SignUpCta className='mt-2' />
          )
        )}
      </div>
    </nav>
  );
}
