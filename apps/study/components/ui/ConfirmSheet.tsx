import type { ReactNode } from 'react';

import { ActionButton } from '@/components/ui/primitives';
import { Sheet } from '@/features/inbox/components/Sheet';

/**
 * The app's confirm modal (never `window.confirm`, which shows the browser's own dialog with the
 * page origin in the title). Cancel is the quiet button; the action is red when it destroys data.
 */
export function ConfirmSheet({
  title,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      footer={
        <div className='flex justify-end gap-3'>
          <ActionButton variant='secondary' onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {confirmLabel}
          </ActionButton>
        </div>
      }
      title={title}
      onClose={onClose}
    >
      {children ? <div className='text-st-muted text-sm'>{children}</div> : null}
    </Sheet>
  );
}
