import type { ShareResourceType, ShareTarget } from '../types';

import { useState } from 'react';
import { Tooltip, cn } from '@repo/ui';
import { CopyCheck, Share2 } from 'lucide-react';

import { useForkedFrom } from '../api';

import { ShareSheet } from './ShareSheet';

import { ActionButton, BOARD_CHIP, BOARD_CHIP_OVERRIDE } from '@/components/ui/primitives';

/**
 * The one Share control. `board` = the notebook's 36px top-bar chip (icon + tooltip on narrow
 * screens); otherwise a normal secondary button. Opens the share sheet.
 */
export function ShareButton({
  target,
  board = false,
  iconOnly = false,
  variant = 'secondary',
  className,
}: {
  target: ShareTarget;
  board?: boolean;
  iconOnly?: boolean;
  /** 'ghost' inside flat list rows (next to other ghost actions). */
  variant?: 'secondary' | 'ghost';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = (
    <ActionButton
      aria-label={iconOnly ? `Share ${target.title}` : undefined}
      className={cn(board && BOARD_CHIP_OVERRIDE, iconOnly && !board && 'w-11 px-0', className)}
      variant={variant}
      onClick={() => setOpen(true)}
    >
      <Share2 className='h-4 w-4 shrink-0' />
      {iconOnly ? null : <span className={cn(board && 'hidden sm:inline')}>Share</span>}
    </ActionButton>
  );

  return (
    <>
      {iconOnly ? (
        <Tooltip content='Share'>
          <span className='inline-flex'>{button}</span>
        </Tooltip>
      ) : (
        button
      )}
      {open && <ShareSheet target={target} onClose={() => setOpen(false)} />}
    </>
  );
}

/** "Copied from Maya Chen’s Membranes" on a copy made from something shared (nothing otherwise). */
export function ForkedFromNote({
  resourceType,
  resourceId,
  topic,
  board = false,
  className,
}: {
  resourceType: ShareResourceType;
  resourceId: string | null | undefined;
  topic?: string | null;
  /** The notebook's top-bar chip look (text from lg up, icon + tooltip below). */
  board?: boolean;
  className?: string;
}) {
  const fork = useForkedFrom(resourceType, resourceId, topic);

  if (!fork) return null;
  const text = `Copied from ${fork.forkedFrom.ownerName}’s ${fork.forkedFrom.title}`;

  if (board) {
    return (
      <Tooltip content={text}>
        <span aria-label={text} className={cn(BOARD_CHIP, 'max-w-[16rem] cursor-default', className)} role='note'>
          <CopyCheck className='h-4 w-4 shrink-0' />
          <span className='hidden lg:inline'>Copy</span>
        </span>
      </Tooltip>
    );
  }

  return (
    <p className={cn('text-st-muted flex min-w-0 items-center gap-1.5 text-xs', className)} title={text}>
      <CopyCheck className='h-3.5 w-3.5 shrink-0' />
      <span className='truncate'>{text}</span>
    </p>
  );
}

export type { ShareTarget };
