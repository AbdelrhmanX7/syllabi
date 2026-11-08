import type { AuthConfig } from '@/features/auth/lib/auth-url';

import { useEffect, useState } from 'react';
import { ArrowLeft, LogIn, Mail, UserPlus, Wand2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { ActionButton, DividerTabs, ErrorNote, Field, INPUT_CLASS, LoadingRows } from '@/components/ui/primitives';
import {
  authServer,
  forgotPassword,
  loginWithPassword,
  register,
  requestMagicLink,
  safeNextPath,
  useAuthConfig,
  useStoreSession,
} from '@/features/auth/api';
import { AuthCard, GoogleIcon, OrDivider, PasswordInput } from '@/features/auth/components/AuthCard';
import {
  buildCallbackUrl,
  buildGoogleStartUrl,
  describeAuthError,
  parseLoginTab,
  validateCredentials,
} from '@/features/auth/lib/auth-url';
import { useBackendSettings } from '@/hooks/useBackendSettings';
import { useSession } from '@/hooks/useSession';
import { adminLogin } from '@/lib/auth';
import { isTauri } from '@/lib/platform/runtime';

type Tab = 'signin' | 'create';
type View = 'form' | 'magic' | 'forgot';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function EmailInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className='relative'>
      <Mail className='text-st-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2' />
      <input
        autoCapitalize='none'
        autoComplete='username'
        autoCorrect='off'
        className={`${INPUT_CLASS} pl-9`}
        inputMode='email'
        name='email'
        placeholder='you@example.com'
        spellCheck={false}
        type='email'
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** Old server (no `/auth`): the password form against `/admin/login`, as before. */
function LegacyForm({ host }: { host: string }) {
  const storeSession = useStoreSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');

      return;
    }
    setSubmitting(true);
    try {
      const identifier = email.trim();
      // The server matches `phoneNumber` against the account's phone OR email; `email` is sent too.
      const response = await adminLogin({ phoneNumber: identifier, email: identifier, password });

      await storeSession(response);
    } catch (caught) {
      setError(`${describeAuthError(caught, 'Wrong email or password.')} — ${host}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form noValidate className='flex flex-col gap-3' onSubmit={submit}>
      <Field label='Email'>
        <EmailInput value={email} onChange={setEmail} />
      </Field>
      <Field label='Password'>
        <PasswordInput autoComplete='current-password' value={password} onChange={setPassword} />
      </Field>
      {error && <ErrorNote message={error} />}
      <ActionButton className='mt-1 w-full' loading={submitting} type='submit' variant='primary'>
        <LogIn className='h-4 w-4' /> Sign in
      </ActionButton>
    </form>
  );
}

/** Email-only forms: magic link and forgot password. Always answer the same line (no account enumeration). */
function EmailOnlyForm({ view, initialEmail, onBack }: { view: 'magic' | 'forgot'; initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter the email you signed up with.');

      return;
    }
    setSubmitting(true);
    try {
      const response = view === 'magic' ? await requestMagicLink(email.trim()) : await forgotPassword(email.trim());

      setSent(
        response?.message ||
          (view === 'magic'
            ? 'If that email can sign in, a link is on its way. It works for 15 minutes.'
            : 'If that email has an account, a reset link is on its way. It works for 1 hour.'),
      );
    } catch (caught) {
      setError(describeAuthError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className='flex flex-col gap-3'>
      <p className='text-st-fg text-sm font-semibold'>
        {view === 'magic' ? 'Email me a sign-in link' : 'Reset your password'}
      </p>
      {sent ? (
        <p className='border-st-ok/30 bg-st-ok/10 text-st-fg rounded-st border-2 px-4 py-3 text-sm' role='status'>
          {sent}
        </p>
      ) : (
        <form noValidate className='flex flex-col gap-3' onSubmit={submit}>
          <Field label='Email'>
            <EmailInput value={email} onChange={setEmail} />
          </Field>
          {error && <ErrorNote message={error} />}
          <ActionButton className='w-full' loading={submitting} type='submit' variant='primary'>
            <Mail className='h-4 w-4' /> {view === 'magic' ? 'Send sign-in link' : 'Send reset link'}
          </ActionButton>
        </form>
      )}
      <ActionButton className='w-full' variant='ghost' onClick={onBack}>
        <ArrowLeft className='h-4 w-4' /> Back to sign in
      </ActionButton>
    </div>
  );
}

function AccountForm({ config, tab, onTab }: { config: AuthConfig; tab: Tab; onTab: (tab: Tab) => void }) {
  const storeSession = useStoreSession();
  const [view, setView] = useState<View>('form');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canRegister = config.registration === 'open';
  const creating = tab === 'create' && canRegister;
  // TODO(apk): Google blocks OAuth inside embedded WebViews. The APK path is: open
  // buildGoogleStartUrl(server, APK_AUTH_DEEP_LINK) in the system browser and catch the
  // `studio.syllabi.app://auth#token=` deep link (tauri-plugin-deep-link + tauri-plugin-opener, not installed).
  // Until then the Google button is web-only.
  const showGoogle = config.google && !isTauri();

  useEffect(() => setError(null), [tab, view]);

  if (view !== 'form') {
    return <EmailOnlyForm initialEmail={email} view={view} onBack={() => setView('form')} />;
  }

  const startGoogle = () => {
    window.location.href = buildGoogleStartUrl(authServer(), buildCallbackUrl(window.location.origin));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const invalid = validateCredentials(email, password, creating ? 8 : 1);

    if (invalid) {
      setError(invalid);

      return;
    }
    setSubmitting(true);
    try {
      const session = creating
        ? await register({ name: name.trim() || undefined, email: email.trim(), password })
        : await loginWithPassword({ email: email.trim(), password });

      await storeSession(session);
    } catch (caught) {
      setError(describeAuthError(caught, creating ? 'Could not create the account.' : 'Wrong email or password.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className='flex flex-col gap-4'>
      {canRegister ? (
        <DividerTabs<Tab>
          aria-label='Sign in or create an account'
          tabs={[
            { key: 'signin', label: 'Sign in' },
            { key: 'create', label: 'Create account' },
          ]}
          value={tab}
          onChange={onTab}
        />
      ) : tab === 'create' ? (
        <p className='text-st-muted text-sm'>New sign-ups are closed right now. Sign in instead.</p>
      ) : null}

      {showGoogle && (
        <>
          <ActionButton className='w-full' variant='secondary' onClick={startGoogle}>
            <GoogleIcon /> Continue with Google
          </ActionButton>
          <OrDivider />
        </>
      )}

      <form noValidate className='flex flex-col gap-3' onSubmit={submit}>
        {creating && (
          <Field label='Name'>
            <input
              autoComplete='name'
              className={INPUT_CLASS}
              name='name'
              placeholder='Optional'
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        )}
        <Field label='Email'>
          <EmailInput value={email} onChange={setEmail} />
        </Field>
        <Field hint={creating ? 'At least 8 characters.' : undefined} label='Password'>
          <PasswordInput
            autoComplete={creating ? 'new-password' : 'current-password'}
            value={password}
            onChange={setPassword}
          />
        </Field>
        {!creating && (
          <button
            className='text-st-accent self-end text-sm font-medium underline-offset-2 hover:underline'
            type='button'
            onClick={() => setView('forgot')}
          >
            Forgot password?
          </button>
        )}
        {error && <ErrorNote message={error} />}
        <ActionButton className='mt-1 w-full' loading={submitting} type='submit' variant='primary'>
          {creating ? (
            <>
              <UserPlus className='h-4 w-4' /> Create account
            </>
          ) : (
            <>
              <LogIn className='h-4 w-4' /> Sign in
            </>
          )}
        </ActionButton>
      </form>

      {config.magicLink && (
        <ActionButton className='w-full' variant='ghost' onClick={() => setView('magic')}>
          <Wand2 className='h-4 w-4' /> Email me a sign-in link
        </ActionButton>
      )}
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const session = useSession();
  const { backendUrl } = useBackendSettings();
  const config = useAuthConfig();
  const [tab, setTab] = useState<Tab>('signin');

  // Static export: router.query is empty on the first render; read ?tab= once the router is ready.
  useEffect(() => {
    if (router.isReady) setTab(parseLoginTab(router.query.tab));
  }, [router.isReady, router.query.tab]);

  useEffect(() => {
    if (session.state === 'signed-in') void router.replace(safeNextPath(router.query.next));
  }, [router, session.state]);

  const creating = tab === 'create' && config.data?.registration === 'open';
  let body: React.ReactNode;

  // No server configured (demo mode): the form signs in to / creates an account on the official server.
  if (config.isPending) body = <LoadingRows rows={3} />;
  else if (config.isError)
    body = (
      <ErrorNote
        message={describeAuthError(config.error, 'Can’t reach the server — try again.')}
        onRetry={() => void config.refetch()}
      />
    );
  else if (config.data.legacy) body = <LegacyForm host={hostOf(authServer())} />;
  else body = <AccountForm config={config.data} tab={tab} onTab={setTab} />;

  return (
    <AuthCard
      subtitle={creating ? 'Your notes follow you to every device.' : 'Welcome back.'}
      title={creating ? 'Create your account' : 'Sign in to Syllabi'}
    >
      {body}
      {!backendUrl && (
        <p className='text-st-muted border-st-line mt-5 border-t pt-3 text-sm'>
          <Link className='underline underline-offset-2' href='/'>
            Keep exploring the demo
          </Link>
        </p>
      )}
    </AuthCard>
  );
}
