import { verifyEmail } from '@/features/auth/api';
import { TokenFlow } from '@/features/auth/components/TokenFlow';
import { readTokenFromSearch } from '@/features/auth/lib/auth-url';

/** `/auth/verify/?token=` — the link in the verification email. */
export default function VerifyEmailPage() {
  return (
    <TokenFlow
      busyLabel='Confirming your email…'
      exchange={verifyEmail}
      readToken={() => ({ token: readTokenFromSearch(window.location.search) })}
      title='Confirm your email'
    />
  );
}
