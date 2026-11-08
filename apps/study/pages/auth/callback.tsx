import type { SessionResponse } from '@/features/auth/api';

import { fetchMe } from '@/features/auth/api';
import { TokenFlow } from '@/features/auth/components/TokenFlow';
import { readAuthError, readTokenFromHash } from '@/features/auth/lib/auth-url';

/**
 * `/auth/callback/#token=<jwt>` — where the server sends the browser after Google. The JWT rides in the
 * fragment (never sent to any server); it is read once, then wiped from the address bar and history.
 */
export default function AuthCallbackPage() {
  const readToken = () => {
    const { search, hash, pathname } = window.location;
    const token = readTokenFromHash(hash);
    const error = readAuthError(search, hash);

    window.history.replaceState(window.history.state, '', pathname);

    return { token, error: error ? `Google sign-in didn’t finish (${error}). Try again.` : null };
  };
  // The fragment carries only the JWT; fetch the user with it so Settings and the rail have a name.
  const exchange = async (token: string): Promise<SessionResponse> => {
    const { user } = await fetchMe(token);

    return { token, user };
  };

  return (
    <TokenFlow
      busyLabel='Finishing Google sign-in…'
      exchange={exchange}
      missingMessage='Google sign-in didn’t return a session. Try again.'
      readToken={readToken}
      title='Signing in'
    />
  );
}
