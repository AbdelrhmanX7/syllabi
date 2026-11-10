import { useEffect, useSyncExternalStore } from 'react';

import {
  checkForUpdates,
  getServerUpdateSnapshot,
  getUpdateSnapshot,
  subscribeUpdates,
} from '@/lib/platform/app-update';
import { SELF_UPDATE_ENABLED } from '@/lib/platform/store';
import { CHECK_INTERVAL_MS, RESUME_CHECK_GAP_MS } from '@/lib/platform/update-check';

export function useAppUpdate() {
  return useSyncExternalStore(subscribeUpdates, getUpdateSnapshot, getServerUpdateSnapshot);
}

/** Mounted once (AppShell): checks on launch, on resume and every 6 h while the app is open. Never in the Play build. */
export function useUpdateWatcher() {
  useEffect(() => {
    if (!SELF_UPDATE_ENABLED) return;
    void checkForUpdates({ ifOlderThan: 0 });

    const onVisible = () => {
      if (document.visibilityState === 'visible') void checkForUpdates({ ifOlderThan: RESUME_CHECK_GAP_MS });
    };
    const timer = window.setInterval(() => void checkForUpdates({ ifOlderThan: CHECK_INTERVAL_MS }), 30 * 60 * 1000);

    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, []);
}
