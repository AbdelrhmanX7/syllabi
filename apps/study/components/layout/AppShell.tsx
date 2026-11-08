import type { ReactNode } from 'react';

import { cn } from '@repo/ui';
import { CloudOff, LogIn } from 'lucide-react';
import Link from 'next/link';

import { BottomNav } from './BottomNav';
import { Rail } from './Rail';
import { UpdateBanner } from './UpdateBanner';

import { useUpdateWatcher } from '@/hooks/useAppUpdate';
import { useSession } from '@/hooks/useSession';
import { useResolvedMode } from '@/hooks/useBackendSettings';
import { SharedToStudy } from '@/features/inbox/components/SharedToStudy';
import { useInboxWatcher } from '@/features/inbox/store';
import { useCanvasSyncWatcher, useStudyQueriesEnabled } from '@/lib/api/hooks';

/** Routes that own the whole screen: no rail, no padding (the board is edge to edge). */
export const FULLSCREEN_ROUTES = new Set(['/login', '/notebook']);

/** Sign-in screens (/login and the /auth/* email + Google finishers): full screen, no study watchers. */
export function isAuthRoute(route: string): boolean {
  return route === '/login' || route.startsWith('/auth/');
}

export function AppShell({ children, pathname }: { children: ReactNode; pathname: string }) {
  const route = pathname.replace(/\/$/, '') || '/';
  const session = useSession();
  const mode = useResolvedMode();

  // Refetches classes/today/items when a Canvas sync completes, whatever page is open. Not on the
  // login screen or the board, and never signed out: a 401 there would only churn the session.
  useCanvasSyncWatcher(session.state === 'signed-in' && !FULLSCREEN_ROUTES.has(route) && !isAuthRoute(route));
  // Phone inbox: live on every route (boards too — «Insert from phone» and the arrival toast need it).
  useInboxWatcher(useStudyQueriesEnabled() && !isAuthRoute(route));
  // Sideloaded APK: launch / resume / 6-hourly check of the release feed, on every route.
  useUpdateWatcher();

  if (FULLSCREEN_ROUTES.has(route) || isAuthRoute(route)) {
    return (
      <div className='bg-st-bg h-screen w-screen overflow-hidden'>
        {children}
        {!isAuthRoute(route) && <SharedToStudy />}
        <UpdateBanner />
      </div>
    );
  }

  return (
    // `st-shell`: below md it sets --st-nav-offset (bottom bar height + safe area) for content padding
    // and the fixed banners/toasts, so nothing hides behind the phone bottom bar.
    <div className='st-shell st-full-h bg-st-bg flex w-screen overflow-hidden'>
      <Rail />
      <main className='relative flex min-w-0 flex-1 flex-col overflow-y-auto'>
        {session.state === 'signed-out' && mode !== 'mock' && (
          <Link
            className='border-st-warn/30 bg-st-warn/10 text-st-warn flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-sm md:px-6'
            href='/login/'
          >
            <CloudOff className='h-4 w-4' />
            <span className='font-medium'>Signed out.</span>
            <span>Your notes stay on this tablet; sign in to sync and pull Canvas.</span>
            <span className='ml-auto inline-flex items-center gap-1 font-medium underline underline-offset-2'>
              <LogIn className='h-4 w-4' /> Sign in
            </span>
          </Link>
        )}
        <div
          className={cn(
            'mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 pb-[calc(1.5rem+var(--st-nav-offset,0px))] pt-4',
            'md:px-6 md:pb-16 md:pt-6 lg:px-10',
          )}
        >
          {children}
        </div>
      </main>
      <BottomNav />
      {/* Android share target: «Shared to Study» for files shared in from another app. */}
      <SharedToStudy />
      <UpdateBanner />
    </div>
  );
}
