import React from 'react';

import { cn } from '../../cn';
import { CLAY_FILL, CLAY_RIM } from '../clay';
import { Avatar, type AvatarProps } from '../Avatar/Avatar';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';

/**
 * da-v2 AvatarGroup — drop-in for HeroUI AvatarGroup. Renders a stack of
 * `<Avatar>` children that overlap each other along the inline axis.
 *
 * Visual: avatars overlap with `-12px` margin-inline-start (logical) so the
 * stack reads left-to-right.
 * Each child gets per-index alternating rotation (±0.6°) and the canonical
 * scrapbook border + shadow.
 *
 * Overflow: if children exceed `max` (default 3), the remainder is replaced
 * by a "+N" sticker chip — or by `renderCount(remaining)` if provided.
 *
 * The `+N` chip lands at the end of the inline flow.
 */

export interface AvatarGroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'color'> {
  children?: React.ReactNode;
  max?: number;
  total?: number;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  color?: HeroUIColor;
  isBordered?: boolean;
  isDisabled?: boolean;
  isGrid?: boolean;
  renderCount?: (count: number) => React.ReactNode;
  classNames?: { base?: string; count?: string };
}

const COUNT_SIZE: Record<HeroUISize, string> = {
  sm: 'h-8 min-w-8 text-[11px]',
  md: 'h-10 min-w-10 text-[12px]',
  lg: 'h-14 min-w-14 text-[14px]',
};

// Must match Avatar's ladder step for step — the chip sits in the same stack.
const COUNT_RADIUS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
};

export const AvatarGroup = React.forwardRef<HTMLDivElement, AvatarGroupProps>(function AvatarGroup(
  {
    children,
    max = 3,
    total,
    size = 'md',
    radius = 'full',
    color = 'default',
    isBordered = true,
    isDisabled,
    isGrid: _isGrid,
    renderCount,
    classNames,
    className,
    ...rest
  },
  ref,
) {
  const items = React.Children.toArray(children).filter(React.isValidElement);
  const visible = items.slice(0, max);
  const remaining = typeof total === 'number' ? Math.max(0, total - visible.length) : Math.max(0, items.length - max);

  const overlap: React.CSSProperties = { marginInlineStart: '-12px' };

  return (
    <div
      ref={ref}
      aria-disabled={isDisabled || undefined}
      className={cn('inline-flex items-center', isDisabled && 'opacity-50', className, classNames?.base)}
      {...rest}
    >
      {visible.map((child, i) => {
        // Apply group-level defaults (size/radius/color/isBordered) without
        // clobbering any per-avatar overrides the consumer set.
        const merged: Partial<AvatarProps> = {
          size: (child.props as AvatarProps).size ?? size,
          radius: (child.props as AvatarProps).radius ?? radius,
          color: (child.props as AvatarProps).color ?? color,
          isBordered: (child.props as AvatarProps).isBordered ?? isBordered,
        };

        return React.cloneElement(
          child as React.ReactElement<AvatarProps>,
          {
            ...merged,
            style: {
              ...overlap,
              ...((child.props as AvatarProps).style as React.CSSProperties | undefined),
            },
          } as Partial<AvatarProps>,
        );
      })}
      {remaining > 0 ? (
        renderCount ? (
          <span style={overlap}>{renderCount(remaining)}</span>
        ) : (
          <CountChip
            className={classNames?.count}
            isBordered={isBordered}
            radius={radius}
            remaining={remaining}
            size={size}
            style={overlap}
          />
        )
      ) : null}
    </div>
  );
});

AvatarGroup.displayName = 'AvatarGroup';

interface CountChipProps {
  remaining: number;
  size: HeroUISize;
  radius: HeroUIRadius;
  isBordered?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const CountChip: React.FC<CountChipProps> = ({ remaining, size, radius, isBordered, className, style }) => (
  <span
    className={cn(
      'text-ink relative inline-flex shrink-0 items-center justify-center font-extrabold',
      // Identical to Avatar: the rim survives because it separates the chip from
      // the avatar it overlaps; the lip does not exist because there is nothing
      // to press. `CLAY_RIM` is the shared token, so the chip cannot
      // drift from the avatars standing next to it.
      isBordered && 'border-[3px] border-[color:var(--avatar-rim)]',
      COUNT_SIZE[size],
      COUNT_RADIUS[radius],
      className,
    )}
    style={{ '--avatar-rim': CLAY_RIM, background: CLAY_FILL.default, ...style } as React.CSSProperties}
  >
    +{remaining}
  </span>
);
