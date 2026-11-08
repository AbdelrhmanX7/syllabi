import { consumeMagicLink } from '@/features/auth/api';
import { TokenFlow } from '@/features/auth/components/TokenFlow';
import { readTokenFromSearch } from '@/features/auth/lib/auth-url';

/** `/auth/magic/?token=` — the emailed sign-in link (15 minutes, single use). */
export default function MagicLinkPage() {
  return (
    <TokenFlow
      busyLabel='Signing you in…'
      exchange={consumeMagicLink}
      readToken={() => ({ token: readTokenFromSearch(window.location.search) })}
      title='Signing in'
    />
  );
}
