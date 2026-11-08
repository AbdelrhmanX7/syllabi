import type { ReactNode } from 'react';

import { useState } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import Head from 'next/head';

import { Surface } from '@/components/ui/primitives';

/**
 * The shell every sign-in screen shares (/login, /auth/*). The page itself scrolls (a phone keyboard or
 * the create-account form can be taller than the screen) and pads more than the card's 4px clay lip, so
 * neither the card edge nor its lip is ever cut.
 */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <>
      <Head>
        <title>{`${title} · Syllabi`}</title>
      </Head>
      <main className='bg-st-bg h-full w-full overflow-y-auto'>
        {/* Centred both ways at every width: a full-width grid cell + an auto-margined card (old WebViews too). */}
        <div className='grid min-h-full w-full place-items-center px-4 py-6 sm:px-6'>
          <Surface className='mx-auto w-full max-w-md p-5 sm:p-7'>
            <div className='mb-5 flex items-center gap-3'>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt='' className='h-9 w-9 shrink-0' height={36} src='/logo-mark.svg' width={36} />
              <div className='min-w-0'>
                <h1 className='text-st-fg font-display text-xl font-bold tracking-tight'>{title}</h1>
                {subtitle && <p className='text-st-muted text-sm'>{subtitle}</p>}
              </div>
            </div>
            {children}
          </Surface>
        </div>
      </main>
    </>
  );
}

/** INPUT_CLASS's look on a wrapper (written out so Tailwind sees it); focus styles follow the inner input. */
const PASSWORD_FIELD_CLASS =
  'min-h-11 w-full rounded-st border-2 border-st-clay-edge bg-st-surface px-3 text-sm text-st-fg focus-within:border-st-accent focus-within:ring-2 focus-within:ring-st-accent/25';

/** Password input with the key icon and a show/hide toggle. */
export function PasswordInput({
  value,
  onChange,
  autoComplete,
  name = 'password',
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  name?: string;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);

  // The field chrome lives on the wrapper so the eye button sits BESIDE the input, not on top of it.
  return (
    <div className={`${PASSWORD_FIELD_CLASS} flex items-center gap-2 pr-1.5`}>
      <KeyRound className='text-st-muted pointer-events-none h-4 w-4 shrink-0' />
      <input
        autoComplete={autoComplete}
        className='text-st-fg placeholder:text-st-muted min-h-10 min-w-0 flex-1 bg-transparent text-sm outline-none'
        name={name}
        placeholder={placeholder}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        aria-label={show ? 'Hide password' : 'Show password'}
        className='text-st-muted hover:bg-st-raised flex h-8 w-8 shrink-0 items-center justify-center rounded-sm'
        type='button'
        onClick={() => setShow((current) => !current)}
      >
        {show ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
      </button>
    </div>
  );
}

/** Google's "G" mark (official colours, logo only). */
export function GoogleIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg aria-hidden className={className} viewBox='0 0 48 48'>
      <path
        d='M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z'
        fill='#FFC107'
      />
      <path
        d='M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z'
        fill='#FF3D00'
      />
      <path
        d='M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z'
        fill='#4CAF50'
      />
      <path
        d='M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z'
        fill='#1976D2'
      />
    </svg>
  );
}

/** Spaced hairline with a centred word ("or"). */
export function OrDivider() {
  return (
    <div className='text-st-muted flex items-center gap-3 text-xs font-medium'>
      <span className='bg-st-line h-px flex-1' />
      or
      <span className='bg-st-line h-px flex-1' />
    </div>
  );
}
