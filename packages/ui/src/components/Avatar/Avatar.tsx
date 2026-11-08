import React from 'react';

import { cn } from '../../cn';
import { CLAY_FILL, CLAY_RIM } from '../clay';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';
import { HEROUI_COLOR_SHADOW, SHADOW_C } from '../tokens';

/**
 * Avatar — drop-in for HeroUI Avatar. Falls back to the first letter when `src`
 * is missing or errors.
 *
 * TIER 4: no clay FORM. An avatar is an image in a frame — it is not pressable
 * and it does not stand off the page, so it gets **no lip**. A lip says "push
 * me" and there is nothing here to push. What went is the scrapbook geometry:
 * the 2.5px ink border, the `3px 3px 0` hard diagonal shadow, the seeded
 * rotation, and the `rounded-sk-*` radius ladder.
 *
 * The rim STAYS, and it is the one thing here that has to be argued for rather
 * than assumed — see `RIM` below.
 */

const SIZE: Record<HeroUISize, string> = {
  sm: 'h-8 w-8 text-[12px]',
  md: 'h-10 w-10 text-[14px]',
  lg: 'h-14 w-14 text-[18px]',
};

// Clay's ladder at avatar scale. `CLAY_RADIUS.sm` (14) on a 32px avatar is
// almost a circle, which is what `full` is for. Written out, not interpolated —
// Tailwind's JIT cannot see through a template literal.
const RADIUS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
};

/**
 * The rim survives when the shadow and the border both go, because it does two
 * jobs nothing else here can:
 *   1. it separates the avatar's edge from the card behind it — an avatar's fill
 *      is a user's photograph, so nothing about the fill can be relied on to
 *      differ from the surface it sits on;
 *   2. `AvatarGroup` overlaps avatars by -12px, and the rim is what stops a
 *      stack fusing into one blob. It is a separator, not decoration.
 * `CLAY_RIM` is the shared token for exactly this case. See `clay.ts`.
 */

export interface AvatarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'color'> {
  src?: string;
  alt?: string;
  name?: string;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  color?: HeroUIColor;
  isBordered?: boolean;
  isDisabled?: boolean;
  isFocusable?: boolean;
  showFallback?: boolean;
  fallback?: React.ReactNode;
  /**
   * Scrapbook-era seeded tilt. Accepted and ignored — clay has no rotation.
   * Kept so the six apps' call sites do not have to change.
   */
  rotate?: number;
  /** Optional gradient duotone {g1, g2} for fallback bg. */
  gradient?: { from: string; to: string };
  classNames?: { base?: string; img?: string; fallback?: string; name?: string; icon?: string };
  /** HeroUI compat — show tiny status dot. */
  isInvisible?: boolean;
  /** HeroUI compat — render an icon instead of name fallback. */
  icon?: React.ReactNode;
  /** HeroUI compat — image element props. */
  ImgComponent?: React.ElementType;
  imgProps?: React.ImgHTMLAttributes<HTMLImageElement>;
}

const firstLetter = (name?: string) => {
  if (!name) return '?';
  // Take first non-space char.
  const trimmed = name.trim();

  return trimmed[0] ?? '?';
};

export const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(function Avatar(
  {
    src,
    alt,
    name,
    size = 'md',
    radius = 'full',
    color = 'default',
    isBordered = true,
    isDisabled,
    showFallback,
    fallback,
    rotate: _rotate,
    gradient,
    classNames,
    className,
    style,
    icon,
    ImgComponent: _ImgComponent,
    imgProps,
    isInvisible: _isInvisible,
    isFocusable: _isFocusable,
    ...rest
  },
  ref,
) {
  const [imageOk, setImageOk] = React.useState(true);
  const showImage = src && imageOk && !showFallback;

  const tint = HEROUI_COLOR_SHADOW[color];
  // The ramp's light end carries a white initial, and several brand fills are
  // too light to hold one: measured against the lightest pixel the glyph
  // actually covers, the raw fill gave warning 3.66:1 and success 4.22:1 in the
  // default palette, 3.95/4.40 in dark, and primary 3.17:1 in a warm palette
  // palette. Nudging the light end toward the (always dark) shadow keeps the
  // hue and fixes every theme at once — HEROUI_COLOR_TEXT is NOT the token for
  // this, because in dark mode it lightens on purpose and would take white down
  // to 1.69:1. At 68% the worst case across light/dark is 5.24:1.
  const rampFrom = `color-mix(in oklab, ${tint} 68%, ${SHADOW_C})`;
  const bgGradient = gradient
    ? `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`
    : color === 'default'
      ? undefined
      : `linear-gradient(135deg, ${rampFrom}, ${SHADOW_C})`;

  return (
    <div
      ref={ref}
      aria-disabled={isDisabled || undefined}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden',
        // Rim only — no lip. See RIM above for why the rim survives.
        isBordered && 'border-[3px] border-[color:var(--avatar-rim)]',
        SIZE[size],
        RADIUS[radius],
        isDisabled && 'opacity-50',
        className,
        classNames?.base,
      )}
      style={{ '--avatar-rim': CLAY_RIM, ...(style as React.CSSProperties) } as React.CSSProperties}
      {...rest}
    >
      {showImage ? (
        <img
          alt={alt ?? name ?? ''}
          className={cn('h-full w-full object-cover', classNames?.img)}
          loading='lazy'
          onError={() => setImageOk(false)}
          src={src}
          {...imgProps}
        />
      ) : (
        <span
          aria-hidden={!name && !icon}
          className={cn(
            'flex h-full w-full items-center justify-center font-black',
            // `text-white` is correct here and is NOT the hardcoded-foreground
            // defect: the fill is not `CLAY_FILL[color]` but the deliberately
            // DARKENED gradient computed above, whose paired answer is white —
            // measured at 5.24:1 worst case across both themes. Reading
            // `CLAY_LABEL[color]` instead would put dark ink on a dark gradient.
            bgGradient ? 'text-white' : 'text-ink',
            classNames?.fallback,
          )}
          style={{ background: bgGradient ?? CLAY_FILL.default }}
        >
          {icon ? (
            <span className={cn('inline-flex items-center justify-center', classNames?.icon)}>{icon}</span>
          ) : (
            (fallback ?? firstLetter(name))
          )}
        </span>
      )}
    </div>
  );
});

Avatar.displayName = 'Avatar';
