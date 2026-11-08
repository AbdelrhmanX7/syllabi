import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';

import { STUDY_USER_KEY, useAuthCookie } from '@/lib/auth';

/**
 * Sign out: drop the token + cached user and the query cache, then go to /login. Notebooks and other
 * on-device data are untouched (they sync again on the next sign-in).
 */
export function useSignOut() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { removeAuthToken } = useAuthCookie();

  return async () => {
    await removeAuthToken();
    try {
      localStorage.removeItem(STUDY_USER_KEY);
    } catch {
      // ignore
    }
    queryClient.clear();
    void router.replace('/login/');
  };
}
