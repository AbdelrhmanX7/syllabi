import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';

import { ActionButton, ErrorNote, Field, LinkButton } from '@/components/ui/primitives';
import { hasAuthServer, resetPassword, useStoreSession } from '@/features/auth/api';
import { AuthCard, PasswordInput } from '@/features/auth/components/AuthCard';
import { describeAuthError, readTokenFromSearch } from '@/features/auth/lib/auth-url';

/** `/auth/reset/?token=` — choose a new password from the emailed link (1 hour, single use). */
export default function ResetPasswordPage() {
  const storeSession = useStoreSession();
  // Static export: read ?token= in an effect (router.query is empty on the first render).
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setToken(readTokenFromSearch(window.location.search)), []);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!token) return;
    if (password.length < 8) return setError('Use at least 8 characters.');
    if (password !== confirm) return setError('The two passwords don’t match.');
    if (!hasAuthServer()) return setError('Sign-in needs a Syllabi server — add one in Settings.');
    setSubmitting(true);
    try {
      await storeSession(await resetPassword(token, password));
    } catch (caught) {
      setError(describeAuthError(caught, 'This link has expired or was already used.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard subtitle='Pick a new password for your account.' title='Reset password'>
      {token === null ? (
        <div className='flex flex-col gap-3'>
          <ErrorNote message='This link is incomplete — open it again from the email.' />
          <LinkButton className='w-full' href='/login/' variant='primary'>
            Back to sign in
          </LinkButton>
        </div>
      ) : (
        <form noValidate className='flex flex-col gap-3' onSubmit={submit}>
          <Field hint='At least 8 characters.' label='New password'>
            <PasswordInput autoComplete='new-password' value={password} onChange={setPassword} />
          </Field>
          <Field label='Repeat it'>
            <PasswordInput autoComplete='new-password' name='confirm' value={confirm} onChange={setConfirm} />
          </Field>
          {error && <ErrorNote message={error} />}
          <ActionButton className='mt-1 w-full' disabled={!token} loading={submitting} type='submit' variant='primary'>
            <KeyRound className='h-4 w-4' /> Save and sign in
          </ActionButton>
        </form>
      )}
    </AuthCard>
  );
}
