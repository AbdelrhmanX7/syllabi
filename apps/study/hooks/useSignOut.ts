import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';

import { reset as resetAnalytics, track } from '@/lib/analytics';
import { STUDY_USER_KEY, useAuthCookie } from '@/lib/auth';
import { forgetOfflineOwner } from '@/lib/offline/owner';
import { clearPersistedQueries } from '@/lib/offline/persist';

/**
 * Sign out: drop the token + cached user and the query cache (and its offline copy), then go to /login. Notebooks and other
 * on-device data are untouched (they sync again on the next sign-in).
 */
export function useSignOut() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { removeAuthToken } = useAuthCookie();

  return async () => {
    track('signed_out');
    resetAnalytics();
    await removeAuthToken();
    try {
      localStorage.removeItem(STUDY_USER_KEY);
    } catch {
      // ignore
    }
    queryClient.clear();
    // The copy saved for offline goes too (queued changes stay: they are sent if this account returns).
    await clearPersistedQueries();
    forgetOfflineOwner();
    void router.replace('/login/');
  };
}
