import React from 'react';

import { cn } from '../../cn';
import { Avatar, type AvatarProps } from '../Avatar/Avatar';

/**
 * da-v2 User — drop-in for HeroUI User. A horizontal layout pairing an Avatar
 * with a name + optional description; the avatar sits on the left.
 *
 * Visual: `<Avatar />` + column { name (font-bold ink), description (font-hand
 * ink at 60% opacity) }, separated by an inline gap. The whole thing is a
 * `<div>` — no chrome — so it composes inside cards, lists, etc.
 */

export interface UserProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  name: React.ReactNode;
  description?: React.ReactNode;
  avatarProps?: Partial<AvatarProps>;
  isFocusable?: boolean;
  classNames?: { base?: string; wrapper?: string; name?: string; description?: string };
}

export const User = React.forwardRef<HTMLDivElement, UserProps>(function User(
  { name, description, avatarProps, isFocusable, className, classNames, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn('inline-flex items-center gap-3', className, classNames?.base)}
      tabIndex={isFocusable ? 0 : undefined}
      {...rest}
    >
      <Avatar name={typeof name === 'string' ? name : undefined} {...avatarProps} />
      <div className={cn('flex flex-col text-start leading-tight', classNames?.wrapper)}>
        <span className={cn('text-ink text-[14px] font-bold', classNames?.name)}>{name}</span>
        {/* 70%, not 60%: a warm palette's lighter ink is a lighter ink, so the same
            alpha lands at 3.90:1 there against 4.98:1 in the default one. 70% clears
            4.5:1 in both and still reads as subordinate to the name above. */}
        {description ? (
          <span className={cn('text-ink/70 text-[13px]', classNames?.description)}>{description}</span>
        ) : null}
      </div>
    </div>
  );
});

User.displayName = 'User';
