import React from 'react';

import { cn } from '../../cn';
import { clayVars } from '../clay';
import type { HeroUIColor, HeroUISize } from '../tokens';
import { HEROUI_COLOR_FILL, HEROUI_COLOR_FOREGROUND, HEROUI_COLOR_OUTLINE, INK, LINE, tint } from '../tokens';

/**
 * da-v2 Badge — drop-in replacement for HeroUI's Badge.
 *
 *   <Badge content={3} color='primary'>
 *     <BellIcon />
 *   </Badge>
 *
 * Visual: ink-bordered bubble absolutely positioned over a wrapped child.
 *  - Numeric content uses tabular figures.
 *  - `placement` strings are PHYSICAL ('top-right' = visually top-right).
 *    HeroUI's Badge treats placement physically too.
 *  - `isDot` renders a 12px solid circle with no content.
 *  - `shape='circle'` rounds the bubble fully; 'rectangle' uses 4px radius.
 */

export type BadgePlacement = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
export type BadgeShape = 'circle' | 'rectangle';
export type BadgeVariant = 'solid' | 'flat' | 'faded' | 'shadow';

export interface BadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'content' | 'color'> {
  children: React.ReactNode;
  content?: React.ReactNode;
  color?: HeroUIColor;
  variant?: BadgeVariant;
  size?: HeroUISize;
  shape?: BadgeShape;
  placement?: BadgePlacement;
  isInvisible?: boolean;
  isOneChar?: boolean;
  isDot?: boolean;
  showOutline?: boolean;
  disableOutline?: boolean;
  classNames?: { base?: string; badge?: string };
  className?: string;
}

const SIZE: Record<HeroUISize, string> = {
  sm: 'text-[9px] h-4 min-w-4 px-1',
  md: 'text-[10px] h-5 min-w-5 px-1.5',
  lg: 'text-[11px] h-6 min-w-6 px-2',
};

const DOT_SIZE: Record<HeroUISize, string> = {
  sm: 'h-2.5 w-2.5',
  md: 'h-3 w-3',
  lg: 'h-3.5 w-3.5',
};

function placementStyles(placement: BadgePlacement): React.CSSProperties {
  // Physical placement.
  switch (placement) {
    case 'top-right':
      return { top: 0, right: 0, transform: 'translate(35%, -35%)' };
    case 'top-left':
      return { top: 0, left: 0, transform: 'translate(-35%, -35%)' };
    case 'bottom-right':
      return { bottom: 0, right: 0, transform: 'translate(35%, 35%)' };
    case 'bottom-left':
      return { bottom: 0, left: 0, transform: 'translate(-35%, 35%)' };
  }
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  {
    children,
    content,
    color = 'primary',
    variant = 'solid',
    size = 'md',
    shape = 'rectangle',
    placement = 'top-right',
    isInvisible,
    isOneChar,
    isDot,
    showOutline = true,
    disableOutline,
    classNames,
    className,
    style,
    ...rest
  },
  ref,
) {
  const fill = HEROUI_COLOR_FILL[color];
  const fg = HEROUI_COLOR_FOREGROUND[color];

  const isNumeric = typeof content === 'number' || (typeof content === 'string' && /^[\d\s+\-,.]+$/.test(content));

  const renderedContent =
    isNumeric && content != null ? (
      <span dir='ltr' style={{ fontFeatureSettings: '"tnum"' }}>
        {content}
      </span>
    ) : (
      content
    );

  const radiusClass = shape === 'circle' || isDot || isOneChar ? 'rounded-full' : 'rounded-[6px]';

  // flat/faded wash the fill down to a translucent tint, so they sit on the
  // THEMED page and take the themed `LINE` + flipping ink.
  const isWashed = variant === 'flat' || variant === 'faded';
  /*
   * The badge's own edge is a darker shade of ITS OWN fill — clay's whole
   * recipe — not a constant near-black. A near-black 1px line plus a flat-grey
   * 1.5px ring put 2.5px of two-coloured chrome around a 12px dot: 42% of the
   * diameter was border, in two colours that belonged to neither the dot nor
   * the page, which is why it read as a muddy donut rather than a status dot.
   */
  const outline = isWashed ? LINE : (clayVars(fill, { kind: 'brand' }) as Record<string, string>)['--clay-edge'];

  const badgeStyle: React.CSSProperties = {
    ...placementStyles(placement),
    background: isWashed ? tint(fill, 33) : fill,
    color: isWashed ? INK : fg,
    borderColor: outline,
    /*
     * The RING stays; the two hard diagonals under it are gone.
     *
     * A badge is the one thing in this group that sits ON another component —
     * an avatar's photograph, a button, an icon — so nothing about what is
     * behind it can be relied on. That is Avatar's argument exactly, and it is
     * why the ring is structure rather than decoration: it is what stops a
     * count fusing into whatever it is pinned to.
     *
     * `variant='shadow'` no longer has a shadow to draw — clay has no diagonal,
     * and a badge is inert, so it gets no lip either. It now renders the same
     * separating ring, which is the useful half of what it used to mean.
     *
     * The separating ring is a CUT-OUT in the page colour, not a coloured line.
     * A badge lands on things nothing can be assumed about — an avatar's
     * photograph, an icon, a button — so the ring's job is to put a gap between
     * the badge and its HOST, not to outline the badge. A ring that matches the
     * ground does that at any size and on any host, and adds no third colour;
     * a `CLAY_RIM` grey was a third colour, and measured 1.5px of it against a
     * 12px dot. `--badge-ring` overrides it where the host is not the page.
     * (The earlier constant near-black measured 1.03:1 on a dark host — the
     * problem that motivated the grey. A cut-out has no contrast requirement at
     * all, because it is not trying to be seen.)
     */
    boxShadow: isInvisible
      ? 'none'
      : variant === 'shadow' || (showOutline && !disableOutline)
        ? '0 0 0 2px var(--badge-ring, var(--surface-0))'
        : 'none',
  };

  return (
    <span ref={ref} className={cn('relative inline-flex', className, classNames?.base)} {...rest}>
      {children}
      {!isInvisible ? (
        <span
          aria-hidden={!content && !isDot}
          className={cn(
            'absolute z-10 inline-flex items-center justify-center whitespace-nowrap font-extrabold',
            // borderColor comes from `outline` in badgeStyle — see above.
            // An edge identifies a SHAPE. A 10-14px dot has no shape to identify, so it
            // gets the cut-out ring only — the border was pure chrome at that size.
            'pointer-events-none',
            !isDot && 'border-[1.5px]',
            isDot ? DOT_SIZE[size] : SIZE[size],
            radiusClass,
            classNames?.badge,
          )}
          style={{ ...badgeStyle, ...(style as React.CSSProperties) }}
        >
          {!isDot ? renderedContent : null}
        </span>
      ) : null}
    </span>
  );
});

Badge.displayName = 'Badge';
