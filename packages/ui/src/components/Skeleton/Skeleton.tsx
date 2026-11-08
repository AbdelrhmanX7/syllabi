import React from 'react';

import { cn } from '../../cn';
import { CLAY_RIM } from '../clay';

/**
 * da-v2 Skeleton — drop-in for HeroUI Skeleton. Dashed-ink-bordered placeholder
 * with a soft cream fill and gentle pulse. Polymorphic via `as`.
 */

export interface SkeletonProps extends React.HTMLAttributes<HTMLElement> {
  isLoaded?: boolean;
  disableAnimation?: boolean;
  classNames?: { base?: string; content?: string };
  /** Element type for the rendered tag. Defaults to 'div'. */
  as?: React.ElementType;
}

export const Skeleton = React.forwardRef<HTMLElement, SkeletonProps>(function Skeleton(
  { isLoaded, disableAnimation, className, classNames, children, as, ...rest },
  ref,
) {
  const Component = (as ?? 'div') as React.ElementType;

  if (isLoaded) {
    return (
      <Component ref={ref} className={cn(className, classNames?.content)} {...rest}>
        {children}
      </Component>
    );
  }

  return (
    <Component
      ref={ref}
      aria-busy='true'
      className={cn(
        // `--paper-2` stays: it is the only surface token with a real step in
        // BOTH themes (light `--surface-1`/`--surface-2` are both #ffffff), and a
        // placeholder has to read as absent content. The dashed ink border is
        // scrapbook; a 1px solid separator rim keeps the block's extent legible
        // in dark, where the fill is only 1.11:1 against the card.
        'rounded-[10px] bg-paper-2 relative block overflow-hidden border-[1px]',
        !disableAnimation && '[animation:sk-pulse-soft_1.6s_ease-in-out_infinite]',
        className,
        classNames?.base,
      )}
      style={{ borderColor: CLAY_RIM, ...(rest.style as React.CSSProperties) }}
      {...rest}
    >
      <span className='invisible'>{children}</span>
    </Component>
  );
});

Skeleton.displayName = 'Skeleton';
