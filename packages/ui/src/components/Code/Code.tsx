import React from 'react';

import { cn } from '../../cn';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';
import { CLAY_RIM } from '../clay';
import { HEROUI_COLOR_SOFT_FILL, INK, PAPER_DARK } from '../tokens';

/**
 * da-v2 Code — drop-in for HeroUI Code. Inline `<code>` element with the
 * scrapbook surface (paper-2 fill, thin ink border, hard mini shadow). Uses a
 * monospace font and renders inline within text.
 *
 * Visual: 2px ink border, 2px hard offset shadow, paper-2 fill (or per-color
 * soft tint), 0.4em horizontal padding, mono font, small radius.
 */

export type CodeColor = HeroUIColor;
export type CodeSize = HeroUISize;
export type CodeRadius = HeroUIRadius;

const SIZE: Record<CodeSize, string> = {
  sm: 'text-[11px]',
  md: 'text-[12px]',
  lg: 'text-[14px]',
};

const RADIUS: Record<CodeRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-md',
  full: 'rounded-full',
};

export interface CodeProps extends Omit<React.HTMLAttributes<HTMLElement>, 'color'> {
  color?: CodeColor;
  size?: CodeSize;
  radius?: CodeRadius;
  classNames?: { base?: string };
}

export const Code = React.forwardRef<HTMLElement, CodeProps>(function Code(
  { color = 'default', size = 'md', radius = 'sm', children, className, classNames, style, ...rest },
  ref,
) {
  const bg = color === 'default' ? PAPER_DARK : HEROUI_COLOR_SOFT_FILL[color];
  // Every fill above is theme-aware (paper-2 / soft fills), so the foreground is
  // always the flipping INK — never a brand-constant foreground.
  const fg = INK;

  return (
    <code
      ref={ref}
      className={cn(
        'inline-flex items-center whitespace-pre-wrap break-words font-mono',
        // Rim only. The hard offset shadow is scrapbook, and inline code is
        // inert — it gets no lip.
        'border-[2px]',
        SIZE[size],
        RADIUS[radius],
        className,
        classNames?.base,
      )}
      dir='ltr'
      style={{
        background: bg,
        color: fg,
        borderColor: CLAY_RIM,
        paddingInline: '0.4em',
        paddingBlock: '0.05em',
        ...(style as React.CSSProperties),
      }}
      {...rest}
    >
      {children}
    </code>
  );
});

Code.displayName = 'Code';
