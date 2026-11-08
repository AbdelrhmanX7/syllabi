import { useEffect, useState } from 'react';

import { isValidAdminToken, readSessionToken, useGetUserData } from '@/lib/auth';

export type SessionState = 'checking' | 'signed-in' | 'signed-out';

/**
 * Live sign-in state. Read off the cookie on every evaluation (the 401 interceptor deletes it
 * without a re-render) and re-checked each minute so an overnight expiry flips the banner on its own.
 */
export function useSession(): { state: SessionState; name: string; email: string } {
  const { token, userData } = useGetUserData();
  const [state, setState] = useState<SessionState>('checking');
  const tokenValue = typeof token === 'string' ? token : '';

  useEffect(() => {
    const evaluate = () => {
      const live = readSessionToken() || tokenValue;

      setState(isValidAdminToken(live) ? 'signed-in' : 'signed-out');
    };

    evaluate();
    const timer = window.setInterval(evaluate, 60_000);

    return () => window.clearInterval(timer);
  }, [tokenValue]);

  return {
    state,
    name: (userData?.name || userData?.username || '').trim(),
    email: (userData?.email || '').trim(),
  };
}
