import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogIn, LogOut, MailCheck, Trash2, UserPlus } from 'lucide-react';
import { useRouter } from 'next/router';

import { changePassword, deleteAccount, resendVerification, useAccount } from '../api';
import { describeAuthError } from '../lib/auth-url';
import { PasswordInput } from './AuthCard';

import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { ActionButton, Badge, ErrorNote, Field, LinkButton, LoadingRows, SectionTitle, Surface } from '@/components/ui/primitives';
import { useBackendSettings } from '@/hooks/useBackendSettings';
import { useSession } from '@/hooks/useSession';
import { STUDY_USER_KEY, useAuthCookie } from '@/lib/auth';
import { BUILD_STAMP } from '@/lib/platform/runtime';

function useSignOut() {
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

function ChangePasswordForm({ needsCurrent, onDone }: { needsCurrent: boolean; onDone: (message: string) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (needsCurrent && !current) return setError('Enter your current password.');
    if (next.length < 8) return setError('Use at least 8 characters for the new password.');
    setSaving(true);
    try {
      const response = await changePassword({ currentPassword: needsCurrent ? current : undefined, newPassword: next });

      onDone(response?.message || 'Password saved.');
    } catch (caught) {
      setError(describeAuthError(caught, 'Could not change the password.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form noValidate className='border-st-line mt-3 flex flex-col gap-3 border-t pt-3' onSubmit={submit}>
      <div className='grid gap-3 sm:grid-cols-2'>
        {needsCurrent && (
          <Field label='Current password'>
            <PasswordInput autoComplete='current-password' name='current' value={current} onChange={setCurrent} />
          </Field>
        )}
        <Field hint='At least 8 characters.' label={needsCurrent ? 'New password' : 'Set a password'}>
          <PasswordInput autoComplete='new-password' name='new' value={next} onChange={setNext} />
        </Field>
      </div>
      {error && <ErrorNote message={error} />}
      <div className='flex justify-end'>
        <ActionButton loading={saving} type='submit' variant='primary'>
          Save password
        </ActionButton>
      </div>
    </form>
  );
}

/** Settings → Account: who is signed in, email verification, password, sign out, delete account. */
export function AccountSection() {
  const session = useSession();
  const { backendUrl } = useBackendSettings();
  const signedIn = session.state === 'signed-in';
  const account = useAccount(signedIn);
  const signOut = useSignOut();
  const [editingPassword, setEditingPassword] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [resending, setResending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const user = account.data ?? null;
  const hasPassword = Boolean(user?.providers?.includes('password'));
  const build = <span className='text-st-muted text-xs'>{BUILD_STAMP ? `Build ${BUILD_STAMP}` : 'Development build'}</span>;

  // Demo mode: nothing is saved anywhere but this device.
  if (!backendUrl) {
    return (
      <Surface className='flex flex-wrap items-center justify-between gap-3 p-5'>
        <div className='min-w-0'>
          <p className='text-st-fg text-sm font-semibold'>Account</p>
          <p className='text-st-muted text-xs'>Demo mode — create an account to keep your data. {build}</p>
        </div>
        <LinkButton href='/login/?tab=create' variant='primary'>
          <UserPlus className='h-4 w-4' /> Create account
        </LinkButton>
      </Surface>
    );
  }

  if (!signedIn) {
    return (
      <Surface className='flex flex-wrap items-center justify-between gap-3 p-5'>
        <div className='min-w-0'>
          <p className='text-st-fg text-sm font-semibold'>Account</p>
          <p className='text-st-muted text-xs'>Signed out. {build}</p>
        </div>
        <LinkButton href='/login/' variant='primary'>
          <LogIn className='h-4 w-4' /> Sign in
        </LinkButton>
      </Surface>
    );
  }

  const resend = async () => {
    setError(null);
    setResending(true);
    try {
      const response = await resendVerification();

      setNotice(response?.message || 'Verification email sent — check your inbox.');
    } catch (caught) {
      setError(describeAuthError(caught, 'Could not send the email.'));
    } finally {
      setResending(false);
    }
  };

  const remove = async () => {
    setError(null);
    setDeleting(true);
    try {
      await deleteAccount(hasPassword ? deletePassword : undefined);
      await signOut();
    } catch (caught) {
      setError(describeAuthError(caught, 'Could not delete the account.'));
    } finally {
      setDeleting(false);
      setDeletePassword('');
    }
  };

  return (
    <Surface className='p-5'>
      <SectionTitle
        action={
          user ? (
            user.isVerified ? (
              <Badge tone='ok'>Verified</Badge>
            ) : (
              <Badge tone='warn'>Email not verified</Badge>
            )
          ) : undefined
        }
      >
        Account
      </SectionTitle>

      {account.isPending ? (
        <LoadingRows rows={1} />
      ) : account.isError ? (
        <ErrorNote message={describeAuthError(account.error)} onRetry={() => void account.refetch()} />
      ) : (
        <div className='flex flex-col gap-1'>
          <p className='text-st-fg break-words text-sm font-medium'>
            {user?.email || session.name || 'Signed in'}
            {user?.name && user.email ? <span className='text-st-muted font-normal'> · {user.name}</span> : null}
          </p>
          {build}
        </div>
      )}

      {notice && (
        <p className='border-st-ok/30 bg-st-ok/10 text-st-fg rounded-st mt-3 border-2 px-4 py-2 text-sm' role='status'>
          {notice}
        </p>
      )}
      {error && (
        <div className='mt-3'>
          <ErrorNote message={error} />
        </div>
      )}

      <div className='mt-4 flex flex-wrap gap-3'>
        {user && !user.isVerified && (
          <ActionButton loading={resending} variant='soft' onClick={resend}>
            <MailCheck className='h-4 w-4' /> Resend verification
          </ActionButton>
        )}
        {user && (
          <ActionButton onClick={() => setEditingPassword((open) => !open)}>
            <KeyRound className='h-4 w-4' /> {hasPassword ? 'Change password' : 'Set a password'}
          </ActionButton>
        )}
        <ActionButton onClick={() => void signOut()}>
          <LogOut className='h-4 w-4' /> Sign out
        </ActionButton>
        {user && (
          <ActionButton className='sm:ml-auto' loading={deleting} variant='danger' onClick={() => setConfirmDelete(true)}>
            <Trash2 className='h-4 w-4' /> Delete account
          </ActionButton>
        )}
      </div>

      {user && editingPassword && (
        <ChangePasswordForm
          needsCurrent={hasPassword}
          onDone={(message) => {
            setEditingPassword(false);
            setNotice(message);
            void account.refetch();
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmSheet
          danger
          confirmLabel='Delete my account'
          title='Delete your account?'
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        >
          <div className='flex flex-col gap-3'>
            <p>
              This deletes <span className='text-st-fg font-semibold'>{user?.email || 'this account'}</span> and
              everything in it — classes, notebooks, questions, files — on every device. It can’t be undone.
            </p>
            {hasPassword && (
              <Field label='Your password'>
                <PasswordInput autoComplete='current-password' value={deletePassword} onChange={setDeletePassword} />
              </Field>
            )}
          </div>
        </ConfirmSheet>
      )}
    </Surface>
  );
}
