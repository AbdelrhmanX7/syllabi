// Mounted once in `_app.tsx`, inside the QueryClientProvider: restores the saved query cache before
// queries run (IsRestoringProvider), keeps saving it, watches the network and sends the outbox.
import type { ReactNode } from 'react';
import type { PersistContext } from './persist';

import { IsRestoringProvider, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

import { flushOutbox, installOfflineJobs } from './jobs';
import { installNetworkWatch } from './network';
import { offlineOwner } from './owner';
import { PERSIST_SCHEMA, restoreQueryCache, startPersisting } from './persist';

import { getBackendSettingsSnapshot } from '@/lib/backend-settings';
import { BUILD_STAMP } from '@/lib/platform/runtime';

/** The longest start-up waits for the saved cache before queries run anyway. */
const RESTORE_TIMEOUT_MS = 1_500;

export function persistContext(): PersistContext {
  const { backendUrl, mockMode } = getBackendSettingsSnapshot();

  return {
    buster: `${PERSIST_SCHEMA}|${BUILD_STAMP || 'dev'}|${backendUrl}|${mockMode}`,
    owner: offlineOwner(),
  };
}

function probeUrl(): string | null {
  const { backendUrl, mockMode } = getBackendSettingsSnapshot();

  return mockMode === 'mock' || !backendUrl ? null : `${backendUrl}/`;
}

export function OfflineRoot({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    installNetworkWatch(probeUrl);
    let stopPersisting: (() => void) | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setRestoring(false);
      stopPersisting = startPersisting(queryClient, persistContext);
    };
    const timer = window.setTimeout(finish, RESTORE_TIMEOUT_MS);

    void restoreQueryCache(queryClient, persistContext()).finally(() => {
      window.clearTimeout(timer);
      finish();
    });
    const stopJobs = installOfflineJobs(queryClient);

    return () => {
      window.clearTimeout(timer);
      stopPersisting?.();
      stopJobs();
    };
  }, [queryClient]);

  // Leaving a board lets a note made offline move to its server id.
  useEffect(() => {
    const onRoute = () => void flushOutbox().catch(() => undefined);

    router.events.on('routeChangeComplete', onRoute);

    return () => router.events.off('routeChangeComplete', onRoute);
  }, [router.events]);

  return <IsRestoringProvider value={restoring}>{children}</IsRestoringProvider>;
}
