import { useState } from 'react';
import { Tooltip, cn } from '@repo/ui';
import { LogOut } from 'lucide-react';

import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { ActionButton } from '@/components/ui/primitives';
import { useSignOut } from '@/hooks/useSignOut';

/**
 * The one Sign out control (Rail footer, phone More sheet, Settings → Account): a bordered button with
 * a danger-tinted label, and a confirm modal before anything happens (owner rule: destructive = confirm).
 * `iconOnly` is the collapsed-rail form: icon + tooltip, same confirm.
 */
export function SignOutButton({ iconOnly = false, className }: { iconOnly?: boolean; className?: string }) {
  const signOut = useSignOut();
  const [confirming, setConfirming] = useState(false);

  const button = (
    <ActionButton
      aria-label={iconOnly ? 'Sign out' : undefined}
      className={cn('text-st-danger', iconOnly && 'w-11 px-0', className)}
      variant='secondary'
      onClick={() => setConfirming(true)}
    >
      <LogOut className='h-4 w-4 shrink-0' />
      {iconOnly ? null : <span className='truncate'>Sign out</span>}
    </ActionButton>
  );

  return (
    <>
      {iconOnly ? (
        <Tooltip content='Sign out' placement='right'>
          {/* ActionButton takes no ref; the span is the tooltip's anchor (focus bubbles to it). */}
          <span className='inline-flex'>{button}</span>
        </Tooltip>
      ) : (
        button
      )}
      {confirming && (
        <ConfirmSheet
          danger
          confirmLabel='Sign out'
          title='Sign out of Syllabi?'
          onClose={() => setConfirming(false)}
          onConfirm={() => void signOut()}
        >
          Notes saved on this device stay here. Sign in again to sync them and pull Canvas.
        </ConfirmSheet>
      )}
    </>
  );
}
