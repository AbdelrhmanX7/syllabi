import type { SessionResponse } from '../api';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';

import { hasAuthServer, useStoreSession } from '../api';
import { describeAuthError } from '../lib/auth-url';
import { AuthCard } from './AuthCard';

import { ErrorNote, LinkButton, LoadingRows } from '@/components/ui/primitives';

/**
 * Finishes an email-link or OAuth flow: read the single-use token client-side (static export — the router
 * query is empty on the first render, so it is read in an effect off `window.location`), exchange it once
 * (a ref guards StrictMode / re-render double runs, which would burn the token and show «expired»), store
 * the session and go to Today.
 */
export function TokenFlow({
  title,
  busyLabel,
  readToken,
  exchange,
  missingMessage = 'This link is incomplete — open it again from the email.',
}: {
  title: string;
  busyLabel: string;
  readToken: () => { token: string | null; error?: string | null };
  /** Turn the token into a session; return the session to store it as is. */
  exchange: (token: string) => Promise<SessionResponse>;
  missingMessage?: string;
}) {
  const storeSession = useStoreSession();
  const ran = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const { token, error: flowError } = readToken();

    if (flowError) return setError(flowError);
    if (!token) return setError(missingMessage);
    if (!hasAuthServer()) return setError('Sign-in needs a Syllabi server — add one in Settings, then open the link again.');

    exchange(token)
      .then(async (session) => {
        setDone(true);
        await storeSession(session);
      })
      .catch((caught) => setError(describeAuthError(caught, 'This link has expired or was already used.')));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs exactly once per page load
  }, []);

  return (
    <AuthCard title={title}>
      {error ? (
        <div className='flex flex-col gap-3'>
          <ErrorNote message={error} />
          <LinkButton className='w-full' href='/login/' variant='primary'>
            Back to sign in
          </LinkButton>
        </div>
      ) : done ? (
        <p className='text-st-fg flex items-center gap-2 text-sm' role='status'>
          <CheckCircle2 className='text-st-ok h-4 w-4 shrink-0' /> Signed in — opening Today…
        </p>
      ) : (
        <div className='flex flex-col gap-3'>
          <p className='text-st-muted text-sm' role='status'>
            {busyLabel}
          </p>
          <LoadingRows rows={1} />
        </div>
      )}
    </AuthCard>
  );
}
