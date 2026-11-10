import type { DropTokenCreated } from '../types';

import { useState } from 'react';
import { ChevronDown, ChevronRight, QrCode as QrIcon, Share, Smartphone, Trash2 } from 'lucide-react';

import { HEIC_HINT, shortcutSteps } from '../lib/links';
import { forgetDropLink } from '../lib/dropLink';
import { usePhoneDropLink } from '../usePhoneDropLink';

import { CopyButton } from './CopyButton';
import { QrCode } from './QrCode';

import { SampleDataBanner } from '@/components/ui/SampleDataBanner';
import {
  ActionButton,
  ErrorNote,
  Field,
  INPUT_CLASS,
  LoadingRows,
  SectionTitle,
  Surface,
} from '@/components/ui/primitives';
import { useBackendSettings } from '@/hooks/useBackendSettings';
import { describeError } from '@/lib/api/errors';
import { formatRelative } from '@/lib/format';

const MASK = '••••••••••••';

function Code({ children }: { children: string }) {
  return (
    <code className='bg-st-raised text-st-fg min-w-0 flex-1 select-all break-all rounded-sm px-3 py-2 font-mono text-xs'>
      {children}
    </code>
  );
}

/**
 * Settings → Phone inbox: drop tokens, the Share-Sheet Shortcut recipe (everyday use) and a QR for
 * the one-off browser upload page.
 */
export function PhoneInboxSection() {
  const { backendUrl } = useBackendSettings();
  const { tokens, create, revoke, isSample, link, url, make } = usePhoneDropLink();
  const [label, setLabel] = useState('iPhone');
  // The «ready» note for a token made just now. The secret itself is remembered on this device
  // (usePhoneDropLink), so the board's «From phone» sheet shows the same code.
  const [fresh, setFresh] = useState<DropTokenCreated | null>(null);
  const [stepsOpen, setStepsOpen] = useState(true);
  const steps = shortcutSteps(backendUrl, link?.token ?? null);

  return (
    <Surface className='p-5'>
      <SectionTitle>
        <Smartphone className='text-st-muted mr-1 inline h-4 w-4' /> Phone inbox
      </SectionTitle>
      {isSample && <SampleDataBanner className='mb-4' what='Phone inbox tokens' />}
      <p className='text-st-muted mb-4 text-sm'>
        Send photos and PDFs from your iPhone straight to this tablet. They land in the Inbox, ready to drop onto a
        board, into notes or into the question bank.
      </p>

      <form
        className='mb-4 flex flex-wrap items-end gap-3'
        onSubmit={(event) => {
          event.preventDefault();
          make(label, (token) => setFresh(token));
        }}
      >
        <Field label='Device label'>
          <input className={`${INPUT_CLASS} w-56`} value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <ActionButton loading={create.isPending} type='submit' variant='primary'>
          Create token
        </ActionButton>
        {create.error && <ErrorNote message={describeError(create.error)} />}
      </form>

      {fresh && (
        <div className='rounded-st border-st-ok/30 bg-st-ok/5 mb-4 flex flex-col gap-2 border p-4'>
          <p className='text-st-fg text-sm font-semibold'>
            Token “{fresh.label}” is ready. It is filled in below and stays on this tablet; other devices won’t see
            the secret.
          </p>
          <div className='flex items-center gap-2'>
            <Code>{fresh.token}</Code>
            <CopyButton label='Copy token' text={fresh.token} />
          </div>
        </div>
      )}

      {/* Every day: the iOS Shortcut in the Share Sheet (the backend's recipe). */}
      <div className='border-st-line rounded-st mb-4 border'>
        <button
          aria-expanded={stepsOpen}
          className='text-st-fg flex min-h-11 w-full items-center gap-2 px-4 text-sm font-medium'
          type='button'
          onClick={() => setStepsOpen((open) => !open)}
        >
          {stepsOpen ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
          <Share className='h-4 w-4' /> Share Sheet Shortcut
          <span className='bg-st-accent/10 text-st-accent rounded-sm px-2 py-0.5 text-[11px] font-semibold'>
            Recommended
          </span>
          {!link && (
            <span className='text-st-muted ml-auto text-xs font-normal'>Create a token to fill in the secret</span>
          )}
        </button>
        {stepsOpen && (
          <div className='border-st-line border-t px-4 py-3'>
            <p className='text-st-muted mb-3 text-sm'>
              Set it up once on the iPhone; after that, any photo or PDF goes to Study from Share → “Send to Study”.
            </p>
            <ol className='flex flex-col gap-3'>
              {steps.map((step, index) => (
                <li key={step.title} className='flex gap-3'>
                  <span className='bg-st-raised text-st-fg flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold'>
                    {index + 1}
                  </span>
                  <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
                    <p className='text-st-fg text-sm'>{step.title}</p>
                    {step.values?.map((value) => {
                      const hidden = value.secret && !link;

                      return (
                        <div key={value.label} className='flex items-center gap-2'>
                          <span className='text-st-muted w-24 shrink-0 text-xs'>{value.label}</span>
                          <Code>{hidden ? `Bearer ${MASK}` : value.value}</Code>
                          <CopyButton disabled={hidden} text={value.value} />
                        </div>
                      );
                    })}
                    {step.detail && <p className='text-st-muted text-xs'>{step.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
            <p className='text-st-muted mt-3 text-xs'>
              HEIC photos need no conversion. If an upload ever fails with “could not convert this HEIC photo”:{' '}
              {HEIC_HINT}
            </p>
          </div>
        )}
      </div>

      {/* One-off: the browser upload page */}
      <div className='border-st-line rounded-st mb-4 flex flex-col gap-4 border p-4 md:flex-row md:items-center'>
        {url ? (
          <QrCode label={`Upload page for ${link?.label || 'this token'}`} size={184} value={url} />
        ) : (
          <div className='rounded-st border-st-line flex h-[184px] w-[184px] shrink-0 flex-col items-center justify-center gap-3 border border-dashed p-3'>
            <QrIcon className='text-st-muted h-10 w-10' strokeWidth={1.5} />
            <ActionButton
              loading={create.isPending}
              variant='primary'
              type='button'
              onClick={() => make(label, (token) => setFresh(token))}
            >
              Make a code
            </ActionButton>
          </div>
        )}
        <div className='flex min-w-0 flex-1 flex-col gap-2'>
          <p className='text-st-fg text-sm font-semibold'>Quick send: scan with your phone camera</p>
          <p className='text-st-muted text-sm'>
            Point your phone camera at the code to open a page where you can send a photo. The same code also shows
            under «From phone» on a board. For everyday use, set up the Shortcut above.
          </p>
          {url ? (
            <div className='flex items-center gap-2'>
              <Code>{url}</Code>
              <CopyButton label='Copy link' text={url} />
            </div>
          ) : (
            <p className='text-st-muted text-xs'>The code stays on this tablet until you revoke its token below.</p>
          )}
        </div>
      </div>

      {tokens.isLoading && !tokens.data && <LoadingRows rows={2} />}
      {tokens.error && <ErrorNote message={describeError(tokens.error)} onRetry={() => void tokens.refetch()} />}
      {tokens.data && tokens.data.length === 0 && <p className='text-st-muted text-sm'>No tokens yet.</p>}
      {tokens.data && tokens.data.length > 0 && (
        <ul className='divide-st-line flex flex-col divide-y'>
          {tokens.data.map((token) => (
            <li key={token.id} className='flex min-h-12 items-center gap-3 py-2 text-sm'>
              <Smartphone className='text-st-muted h-4 w-4 shrink-0' />
              <span className='min-w-0 flex-1'>
                <span className='text-st-fg block font-medium'>{token.label}</span>
                <span className='text-st-muted block text-xs'>
                  {token.prefix ? `${token.prefix}… · ` : ''}created {formatRelative(token.createdAt)}
                  {token.lastUsedAt ? ` · used ${formatRelative(token.lastUsedAt)}` : ''}
                </span>
              </span>
              <ActionButton
                className='min-h-9 px-3 text-xs'
                loading={revoke.isPending && revoke.variables === token.id}
                variant='danger'
                onClick={() =>
                  revoke.mutate(token.id, {
                    onSuccess: () => {
                      if (fresh?.id === token.id) setFresh(null);
                      forgetDropLink(token.id);
                    },
                  })
                }
              >
                <Trash2 className='h-3.5 w-3.5' /> Revoke
              </ActionButton>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}
