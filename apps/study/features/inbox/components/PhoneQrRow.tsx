import { useState } from 'react';
import { ChevronDown, ChevronRight, QrCode as QrIcon } from 'lucide-react';
import Link from 'next/link';

import { usePhoneDropLink } from '../usePhoneDropLink';

import { QrCode } from './QrCode';

import { ActionButton, ErrorNote } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';

const OPEN_KEY = 'study_board_phone_qr_open';

function readOpen(fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);

    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

/**
 * «Send from phone» in the board's From-phone sheet: the same drop-link QR as Settings → Phone
 * inbox, for a student who has not set up the Shortcut. Flat (it lives in the sheet's scroll box).
 * Collapsible when the sheet already lists items; open on its own when there is nothing yet.
 */
export function PhoneQrRow({ collapsible }: { collapsible: boolean }) {
  const { enabled, url, make, create } = usePhoneDropLink();
  const [open, setOpen] = useState(() => (collapsible ? readOpen(false) : true));
  const shown = !collapsible || open;

  const toggle = () => {
    const next = !open;

    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      // remembered for this sheet only
    }
  };

  const body = !enabled ? (
    <p className='text-st-muted text-sm'>
      Sending from your phone needs an account.{' '}
      <Link className='text-st-accent underline underline-offset-2' href='/settings/'>
        Sign in
      </Link>{' '}
      to get a code.
    </p>
  ) : (
    <div className='flex flex-wrap items-center gap-4'>
      {url ? (
        <QrCode label='Phone upload code' size={148} value={url} />
      ) : (
        <div className='rounded-st border-st-line flex h-[148px] w-[148px] shrink-0 flex-col items-center justify-center gap-3 border border-dashed p-3 pb-4'>
          <QrIcon className='text-st-muted h-8 w-8' strokeWidth={1.5} />
          <ActionButton loading={create.isPending} variant='primary' onClick={() => make('Board code')}>
            Show code
          </ActionButton>
        </div>
      )}
      <div className='flex min-w-0 flex-1 basis-44 flex-col gap-2'>
        <p className='text-st-fg text-sm'>Scan with your phone camera to send a photo here.</p>
        {create.error && <ErrorNote message={describeError(create.error)} />}
      </div>
    </div>
  );

  return (
    <section className='border-st-line mb-4 border-b pb-4'>
      {collapsible ? (
        <button
          aria-expanded={open}
          className='text-st-fg flex min-h-10 w-full items-center gap-2 text-sm font-medium'
          type='button'
          onClick={toggle}
        >
          {open ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
          <QrIcon className='text-st-muted h-4 w-4' /> Send from phone
          {!open && <span className='text-st-muted ml-auto truncate text-xs font-normal'>Scan a code, no setup</span>}
        </button>
      ) : (
        <p className='text-st-fg mb-3 flex items-center gap-2 text-sm font-medium'>
          <QrIcon className='text-st-muted h-4 w-4' /> Send from phone
        </p>
      )}
      {shown && <div className={collapsible ? 'pt-2' : undefined}>{body}</div>}
    </section>
  );
}
