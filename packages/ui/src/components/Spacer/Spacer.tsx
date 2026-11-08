import React from 'react';

import { cn } from '../../cn';

/**
 * da-v2 Spacer — drop-in for HeroUI Spacer. An empty inline-block whose width
 * (`x`) and/or height (`y`) is set in 4px increments. Used purely for layout
 * spacing between siblings.
 *
 * Visual contract: nothing visible. The scrapbook system only adds to it when
 * a parent uses `border-sk` etc. — this primitive stays invisible by design.
 */

export type SpacerSpace =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26;

export interface SpacerProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Inline-axis size in 4px increments (Tailwind spacing scale). Default 1. */
  x?: SpacerSpace;
  /** Block-axis size in 4px increments (Tailwind spacing scale). Default 1. */
  y?: SpacerSpace;
}

export const Spacer = React.forwardRef<HTMLSpanElement, SpacerProps>(function Spacer(
  { x = 1, y = 1, className, style, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      aria-hidden
      className={cn('inline-block shrink-0', className)}
      style={{
        width: `${x * 4}px`,
        height: `${y * 4}px`,
        ...(style as React.CSSProperties),
      }}
      {...rest}
    />
  );
});

Spacer.displayName = 'Spacer';
