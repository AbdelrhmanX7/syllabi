import type { SharePerson, ShareRole, ShareTarget } from '../types';

import { useState } from 'react';
import { Chip, Select, SelectItem, addToast, cn } from '@repo/ui';
import { Copy, Link2, Trash2, UserMinus } from 'lucide-react';

import { useMyShare, useShareMutations } from '../api';
import { RESOURCE_NOUN, ROLE_LABEL } from '../types';

import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { Toggle } from '@/components/ui/Toggle';
import { ActionButton, INPUT_CLASS } from '@/components/ui/primitives';
import { Sheet } from '@/features/inbox/components/Sheet';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.');

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch {
    // Old WebView / no permission: a hidden textarea + execCommand still works there.
    try {
      const area = document.createElement('textarea');

      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');

      area.remove();

      return ok;
    } catch {
      return false;
    }
  }
}

/** Can view / Can edit: the designed Select, small, one per person and one for new people. */
function RolePicker({
  value,
  label,
  disabled,
  onChange,
}: {
  value: ShareRole;
  label: string;
  disabled?: boolean;
  onChange: (role: ShareRole) => void;
}) {
  return (
    <Select
      disallowEmptySelection
      aria-label={label}
      className='w-40 shrink-0'
      isDisabled={disabled}
      selectedKeys={[value]}
      size='sm'
      onSelectionChange={(keys: Set<string>) => {
        const next = [...keys][0] as ShareRole | undefined;

        if (next && next !== value) onChange(next);
      }}
    >
      <SelectItem key='viewer'>{ROLE_LABEL.viewer}</SelectItem>
      <SelectItem key='editor'>{ROLE_LABEL.editor}</SelectItem>
    </Select>
  );
}

/**
 * Share one notebook / deck / question set / concept map: add people by email (chips, a Can view /
 * Can edit picker, then Share), a view-only link (signed-in accounts only), the current people with
 * their access and Remove, and Stop sharing. Removing someone, lowering their access and stopping all
 * confirm first. Flat rows only (this is a scroll box).
 */
export function ShareSheet({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const { data: share, isLoading, error: loadError } = useMyShare(target);
  const { update, stop } = useShareMutations(target);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string[]>([]);
  const [inputError, setInputError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SharePerson | null>(null);
  const [lowering, setLowering] = useState<SharePerson | null>(null);
  const [newRole, setNewRole] = useState<ShareRole>('viewer');
  const [stopping, setStopping] = useState(false);
  const noun = RESOURCE_NOUN[target.resourceType];
  const busy = update.isPending || stop.isPending;
  const people = share?.people ?? [];
  const shared = Boolean(share && (people.length || share.link));

  /** Turn what is typed into chips (comma / space / Enter separate addresses). */
  const takeDraft = (text = draft): string[] => {
    const parts = text.split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
    const badOne = parts.find((p) => !EMAIL_RE.test(p));

    if (badOne) {
      setInputError(`"${badOne}" isn't an email address`);

      return pending;
    }
    setInputError(null);
    const next = [...pending];

    for (const p of parts) if (!next.includes(p) && !people.some((x) => x.email === p)) next.push(p);
    setPending(next);
    setDraft('');

    return next;
  };

  const send = () => {
    const emails = takeDraft();

    if (!emails.length) return;
    update.mutate(
      { current: share, addEmails: emails, role: newRole },
      {
        onSuccess: () => {
          setPending([]);
          addToast({ title: emails.length === 1 ? `Shared with ${emails[0]}` : `Shared with ${emails.length} people`, color: 'success' });
        },
        onError: (e) => setInputError(errorText(e)),
      },
    );
  };

  const setRole = (person: SharePerson, role: ShareRole) => {
    // Taking away editing confirms first; giving it is one tap.
    if (role === 'viewer') return setLowering(person);
    update.mutate(
      { current: share, roles: [{ email: person.email, role }] },
      { onError: (e) => addToast({ title: errorText(e), color: 'danger' }) },
    );
  };

  const toggleLink = (on: boolean) =>
    update.mutate({ current: share, link: on }, { onError: (e) => addToast({ title: errorText(e), color: 'danger' }) });

  const copyLink = async () => {
    if (!share?.link) return;
    const ok = await copyText(share.link.url);

    addToast({ title: ok ? 'Link copied' : 'Couldn’t copy. Select the link and copy it.', color: ok ? 'success' : 'warning' });
  };

  return (
    <>
      <Sheet
        footer={
          shared ? (
            <div className='flex justify-end'>
              <ActionButton className='text-st-danger' disabled={busy} variant='secondary' onClick={() => setStopping(true)}>
                <Trash2 className='h-4 w-4' /> Stop sharing
              </ActionButton>
            </div>
          ) : undefined
        }
        subtitle='Choose who can view or edit. The link is view only.'
        title={`Share “${target.title}”`}
        onClose={onClose}
      >
        <div className='flex flex-col gap-4'>
          {/* Add people */}
          <div className='flex flex-col gap-2'>
            <label className='text-st-fg text-sm font-semibold' htmlFor='share-email'>
              Add people
            </label>
            <div className='flex flex-wrap gap-3'>
              <input
                aria-invalid={Boolean(inputError)}
                autoCapitalize='none'
                autoComplete='email'
                className={cn(INPUT_CLASS, 'min-w-0 flex-1 basis-48 text-base sm:text-sm')}
                id='share-email'
                inputMode='email'
                placeholder='name@school.edu'
                type='email'
                value={draft}
                onChange={(event) => {
                  const value = event.target.value;

                  if (/[,;\s]$/.test(value)) takeDraft(value);
                  else setDraft(value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    send();
                  } else if (event.key === 'Backspace' && !draft && pending.length) {
                    setPending(pending.slice(0, -1));
                  }
                }}
              />
              <RolePicker disabled={busy} label='Access for new people' value={newRole} onChange={setNewRole} />
              <ActionButton disabled={busy || (!draft.trim() && !pending.length)} loading={update.isPending && pending.length > 0} variant='primary' onClick={send}>
                Share
              </ActionButton>
            </div>
            {pending.length > 0 && (
              <div className='flex flex-wrap gap-2'>
                {pending.map((email) => (
                  <Chip key={email} isClosable size='sm' variant='flat' onClose={() => setPending(pending.filter((p) => p !== email))}>
                    {email}
                  </Chip>
                ))}
              </div>
            )}
            {inputError && <p className='text-st-danger text-xs'>{inputError}</p>}
          </div>

          {/* People with access */}
          <div className='flex flex-col gap-1'>
            <p className='text-st-fg text-sm font-semibold'>People with access</p>
            {isLoading ? (
              <p className='text-st-muted text-sm'>Loading…</p>
            ) : loadError ? (
              <p className='text-st-danger text-sm'>{errorText(loadError)}</p>
            ) : people.length === 0 ? (
              <p className='text-st-muted text-sm'>Only you. Add someone by email above.</p>
            ) : (
              <ul className='divide-st-line flex flex-col divide-y'>
                {people.map((person) => (
                  <li key={person.email} className='flex min-h-11 items-center gap-3 py-1'>
                    <div className='min-w-0 flex-1'>
                      <p className='text-st-fg truncate text-sm' title={person.email}>
                        {person.name ? `${person.name} · ${person.email}` : person.email}
                        {!person.joined && <span className='text-st-muted text-xs'> · Invited</span>}
                      </p>
                    </div>
                    <RolePicker
                      disabled={busy}
                      label={`Access for ${person.email}`}
                      value={person.role}
                      onChange={(role) => setRole(person, role)}
                    />
                    <ActionButton
                      aria-label={`Remove ${person.email}`}
                      className='w-11 shrink-0 px-0'
                      disabled={busy}
                      variant='ghost'
                      onClick={() => setRemoving(person)}
                    >
                      <UserMinus className='text-st-danger h-4 w-4' />
                    </ActionButton>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Link */}
          <div className='border-st-line flex flex-col gap-2 border-t pt-3'>
            <div className='flex items-center gap-3'>
              <Link2 className='text-st-muted h-4 w-4 shrink-0' />
              <div className='min-w-0 flex-1'>
                <p className='text-st-fg text-sm font-semibold'>Share with a link</p>
                <p className='text-st-muted truncate text-xs'>Anyone signed in who has it can view</p>
              </div>
              <Toggle checked={Boolean(share?.link)} disabled={busy || isLoading} label='Share with a link' onChange={toggleLink} />
            </div>
            {share?.link && (
              <div className='flex items-center gap-3'>
                <input
                  readOnly
                  aria-label='Share link'
                  className={cn(INPUT_CLASS, 'text-st-muted min-w-0 flex-1 text-base sm:text-sm')}
                  value={share.link.url}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <ActionButton className='shrink-0' onClick={() => void copyLink()}>
                  <Copy className='h-4 w-4' /> Copy
                </ActionButton>
              </div>
            )}
          </div>
        </div>
      </Sheet>

      {removing && share && (
        <ConfirmSheet
          danger
          confirmLabel='Remove'
          title={`Remove ${removing.email}?`}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            update.mutate(
              { current: share, removeEmails: [removing.email] },
              { onError: (e) => addToast({ title: errorText(e), color: 'danger' }) },
            )
          }
        >
          They can no longer open this {noun}. A copy they already made stays theirs.
        </ConfirmSheet>
      )}
      {lowering && share && (
        <ConfirmSheet
          danger
          confirmLabel='Change to Can view'
          title={`Stop ${lowering.email} from editing?`}
          onClose={() => setLowering(null)}
          onConfirm={() =>
            update.mutate(
              { current: share, roles: [{ email: lowering.email, role: 'viewer' }] },
              { onError: (e) => addToast({ title: errorText(e), color: 'danger' }) },
            )
          }
        >
          They can still open this {noun}, but can no longer change it. Their earlier changes stay.
        </ConfirmSheet>
      )}
      {stopping && share && (
        <ConfirmSheet
          danger
          confirmLabel='Stop sharing'
          title={`Stop sharing this ${noun}?`}
          onClose={() => setStopping(false)}
          onConfirm={() =>
            stop.mutate(share.id, {
              onSuccess: () => addToast({ title: 'Sharing stopped', color: 'success' }),
              onError: (e) => addToast({ title: errorText(e), color: 'danger' }),
            })
          }
        >
          Everyone you added and anyone with the link lose access. Copies people already made stay theirs.
        </ConfirmSheet>
      )}
    </>
  );
}
