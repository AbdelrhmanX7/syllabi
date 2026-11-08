import React from 'react';

import { cn } from '../../cn';
import type { ClayColor } from '../clay';
import { CLAY_FILL, CLAY_LABEL, clayKindFor, clayVars } from '../clay';

/**
 * Clay button — the pressable slab. Reference implementation for the migration;
 * every other tier-1 component should follow this shape.
 *
 * The colour maths lives in `../clay.ts` so all 46 components share one lip
 * rather than 46 hand-tuned ones. This file only decides WHICH token it paints
 * and how it behaves on press.
 */

// Radii are written out, not interpolated from CLAY_RADIUS: Tailwind's JIT
// scans source text and cannot see through a template literal, so
// an interpolated arbitrary `rounded-` value generates no class at all. The constant stays
// the source of truth for non-Tailwind consumers; these must match it.
const SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'px-5 py-2.5 text-sm rounded-md',
  md: 'px-7 py-3.5 text-base rounded-lg',
  lg: 'px-8 py-4 text-lg rounded-lg',
};

export type ClayButtonProps = {
  children: React.ReactNode;
  color?: ClayColor;
  size?: keyof typeof SIZE;
  fullWidth?: boolean;
  isDisabled?: boolean;
  className?: string;
  onPress?: () => void;
  type?: 'button' | 'submit';
};

export function ClayButton({
  children,
  color = 'primary',
  size = 'lg',
  fullWidth,
  isDisabled,
  className,
  onPress,
  type = 'button',
}: ClayButtonProps) {
  const fill = CLAY_FILL[color];

  return (
    <button
      className={cn(
        'relative touch-manipulation text-center font-bold',
        // Only transform and box-shadow animate — never the fill, or the press
        // reads as a colour change instead of a movement.
        'transition-[transform,box-shadow] duration-200',
        // The press: the lip shrinks 6 -> 4 -> 1px while the button travels the
        // same distance down, so its bottom edge stays put and only the lip
        // closes. Animating one without the other makes it slide, not depress.
        'hover:translate-y-[2px] active:translate-y-[5px] active:scale-[0.99]',
        // A keyboard user gets the same affordance a pointer user does.
        'focus-visible:outline-none',
        'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        // The three shadow states live in styles/scrapbook.css under `.clay-btn`
        // — see the note there for why this is not a Tailwind arbitrary value.
        'clay-btn',
        'border-[3px] border-[color:var(--clay-edge)]',
        SIZE[size],
        fullWidth && 'block w-full',
        isDisabled && 'pointer-events-none opacity-50',
        className,
      )}
      disabled={isDisabled}
      style={{
        background: fill,
        color: CLAY_LABEL[color],
        ...clayVars(fill, { kind: clayKindFor(color) }),
      }}
      type={type}
      onClick={onPress}
    >
      {children}
    </button>
  );
}
