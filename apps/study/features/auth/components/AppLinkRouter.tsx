import { useEffect } from 'react';
import { useRouter } from 'next/router';

import { deepLinkToAppPath } from '../lib/auth-url';

import { currentAppLinks, onAppLink } from '@/lib/platform/app-links';
import { isTauri } from '@/lib/platform/runtime';

/** Links already routed, newest last. Sign-in tokens are single use, and Android hands the launch link
 *  back on every reload, so a link is opened once and then ignored. */
const HANDLED_KEY = 'study_handled_app_links';
const HANDLED_MAX = 20;
const handledInMemory = new Set<string>();

function readHandled(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HANDLED_KEY) ?? '[]');

    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** Marks `link` handled; false when it already was. */
function claim(link: string): boolean {
  const handled = readHandled();

  if (handledInMemory.has(link) || handled.includes(link)) return false;
  handledInMemory.add(link);
  try {
    localStorage.setItem(HANDLED_KEY, JSON.stringify([...handled, link].slice(-HANDLED_MAX)));
  } catch {
    // Storage blocked: the in-memory set still stops repeats until the next reload.
  }

  return true;
}

/**
 * Android app only: a sign-in link that opened the app (an emailed magic / verify / reset link, or the
 * return from Google in the browser) goes to the app's own page for it, which finishes the sign-in.
 * A share link (app.syllabi.studio/shared/?id=…) opens the shared page.
 * Renders nothing.
 */
export function AppLinkRouter() {
  const router = useRouter();

  useEffect(() => {
    if (!isTauri()) return;

    const open = (link: string) => {
      const path = deepLinkToAppPath(link);

      if (!path || !claim(link)) return;
      // Already on that page (a second link): its one-shot token reader won't run again, so reload.
      if (path.split(/[?#]/)[0] === window.location.pathname) window.location.replace(path);
      else void router.replace(path);
    };

    const stop = onAppLink(open);

    void currentAppLinks().then((links) => links.forEach(open));

    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once for the app's lifetime
  }, []);

  return null;
}
