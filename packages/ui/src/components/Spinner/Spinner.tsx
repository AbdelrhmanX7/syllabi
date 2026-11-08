import React from 'react';

import { cn } from '../../cn';
import type { HeroUIColor, HeroUISize } from '../tokens';
import { HEROUI_COLOR_TEXT } from '../tokens';

/**
 * da-v2 Spinner — drop-in replacement for @heroui/react Spinner.
 * Hand-drawn arc that rotates. Stroke-only, no fill.
 */
export interface SpinnerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'color'> {
  color?: HeroUIColor | 'current' | 'white';
  size?: HeroUISize;
  /** Optional caption rendered beside / below the arc (HeroUI compat). */
  label?: React.ReactNode;
  /** HeroUI compat — render label inline rather than below. */
  labelColor?: HeroUIColor;
  /** Hide visual but keep accessible label. */
  classNames?: { wrapper?: string; circle1?: string; circle2?: string; label?: string };
}

const SIZE_PX: Record<HeroUISize, number> = { sm: 18, md: 24, lg: 32 };
const STROKE_PX: Record<HeroUISize, number> = { sm: 2.4, md: 2.8, lg: 3.2 };

export const Spinner = React.forwardRef<HTMLDivElement, SpinnerProps>(
  ({ color = 'primary', size = 'md', label, className, classNames, ...rest }, ref) => {
    const px = SIZE_PX[size];
    const stroke = STROKE_PX[size];
    // The arc is a foreground GLYPH drawn straight onto the page — nothing sits
    // behind it — so it reads from HEROUI_COLOR_TEXT (brand-as-a-mark), not
    // HEROUI_COLOR_SHADOW (brand-as-a-fill). The fill map is tuned to be legible
    // with a label on top of it, which is the opposite problem: a warm palette's --p
    // (#f5a623) is 1.91:1 on its own paper, so a 2.8px arc in it was invisible,
    // where --p-text (#945211) is 5.70:1. `default` maps to the flipping INK.
    const strokeColor =
      color === 'current'
        ? 'currentColor'
        : color === 'white'
          ? '#ffffff'
          : HEROUI_COLOR_TEXT[color];

    return (
      <div
        ref={ref}
        aria-busy='true'
        aria-live='polite'
        className={cn('inline-flex items-center gap-2', className, classNames?.wrapper)}
        role='status'
        {...rest}
      >
        <svg
          aria-hidden='true'
          className={cn('shrink-0 [animation:sk-spin_900ms_linear_infinite]', classNames?.circle1)}
          fill='none'
          height={px}
          stroke={strokeColor}
          strokeLinecap='round'
          strokeWidth={stroke}
          // The 1px hard DIAGONAL drop-shadow was the scrapbook's offset, at
          // spinner scale. Clay has no diagonal, and a spinner is not a slab
          // standing off the page, so nothing replaces it. The arc already
          // reads: it is `HEROUI_COLOR_TEXT` on the track, which is the mark
          // map and was already correct here.
          viewBox='0 0 24 24'
          width={px}
        >
          {/* Hand-drawn-ish arc with a soft wobble in the path. */}
          <path d='M21 12a9 9 0 0 1-3.5 7.1' />
          <path d='M3.4 14.4a9 9 0 0 1 6.9-11' opacity={0.55} />
        </svg>
        {label ? <span className={cn('text-ink text-[14px] font-bold', classNames?.label)}>{label}</span> : null}
      </div>
    );
  },
);

Spinner.displayName = 'Spinner';
