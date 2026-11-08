import React from 'react';

import { cn } from '../../cn';
import { CLAY_RIM } from '../clay';

/**
 * da-v2 Divider — drop-in replacement for HeroUI's Divider.
 *
 *   <Divider />                                  // horizontal dashed ink hairline
 *   <Divider orientation='vertical' />           // vertical dashed ink hairline
 *
 * Visual: 2px dashed ink line at 45% opacity. Logical-property aware so the
 * vertical variant always renders on the start side of its parent box.
 */

export type DividerOrientation = 'horizontal' | 'vertical';

export interface DividerProps extends Omit<React.HTMLAttributes<HTMLElement>, 'role'> {
  orientation?: DividerOrientation;
  className?: string;
  /** HeroUI compat — sets the WAI-ARIA role explicitly. Defaults to 'separator'. */
  role?: 'separator' | 'presentation';
}

export const Divider = React.forwardRef<HTMLElement, DividerProps>(function Divider(
  { orientation = 'horizontal', className, role = 'separator', style, ...rest },
  ref,
) {
  if (orientation === 'vertical') {
    // Vertical divider — dashed ink line on the start side via CSS logical prop.
    // Defaults to 100% height; consumers can override with className h-N.
    return (
      <div
        ref={ref as React.Ref<HTMLDivElement>}
        aria-orientation='vertical'
        className={cn('inline-block h-full w-0 self-stretch', className)}
        role={role}
        style={{
          // Solid, not dashed: a dashed ink hairline is scrapbook. And CLAY_RIM
          // rather than a tint of `--line`, which FLIPS — the old rule measured
          // ~2.8:1 in light and ~1.3:1 in dark, i.e. it tracked the theme rather
          // than its job. A divider is a separator the author placed on purpose,
          // so it takes the shared separator rim (3.88:1 light / 5.27:1 dark) at
          // 1px: thin and visible beats thick and faint.
          borderInlineStartStyle: 'solid',
          borderInlineStartWidth: '1px',
          borderInlineStartColor: CLAY_RIM,
          minHeight: '1em',
          ...(style as React.CSSProperties),
        }}
        {...(rest as React.HTMLAttributes<HTMLDivElement>)}
      />
    );
  }

  return (
    <hr
      ref={ref as React.Ref<HTMLHRElement>}
      aria-orientation='horizontal'
      className={cn('my-2 block w-full border-0', className)}
      role={role}
      style={{
        // Same reasoning as the vertical branch above.
        borderTopStyle: 'solid',
        borderTopWidth: '1px',
        borderTopColor: CLAY_RIM,
        ...(style as React.CSSProperties),
      }}
      {...(rest as React.HTMLAttributes<HTMLHRElement>)}
    />
  );
});

Divider.displayName = 'Divider';
