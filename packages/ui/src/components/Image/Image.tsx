import React from 'react';

import { cn } from '../../cn';
import { CLAY_FILL, CLAY_RIM, clayVars } from '../clay';
import type { HeroUIRadius } from '../tokens';

/**
 * Image — drop-in for HeroUI Image. Wraps an `<img>` and handles loading and
 * error states.
 *
 * TIER 4: no clay FORM. An image is not pressable, so it gets **no press
 * ladder** — no `.clay-btn`, and not `.clay-surface` either, whose hover state
 * would have an inert picture responding to the cursor. What it does get is the
 * lip its own `shadow` prop asks for, drawn straight DOWN and held static.
 *
 * Gone, all scrapbook: the 2.5px ink border, the hard diagonal `shadow-sk-*`
 * ramp, the `rounded-sk-*` ladder, `bg-paper-2`, and the tilt.
 *
 * `isBlurred` puts a soft blurred clone behind; `isZoomed` scales 1.06x on
 * hover; loading shows a dashed skeleton; error shows an empty-frame glyph.
 */

export type ImageRadius = HeroUIRadius;
export type ImageShadow = 'none' | 'sm' | 'md' | 'lg';

// Clay's ladder. Written out, not interpolated — Tailwind's JIT cannot see
// through a template literal.
const RADIUS: Record<ImageRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-[10px]',
  md: 'rounded-[14px]',
  lg: 'rounded-[20px]',
  full: 'rounded-full',
};

/** Lip depth per `shadow` step. `none` draws nothing at all. */
const DEPTH: Record<ImageShadow, number> = { none: 0, sm: 4, md: 6, lg: 8 };

/**
 * An image's content is arbitrary, so nothing about it can be relied on to
 * differ from the card behind it — the rim is the only thing that guarantees an
 * edge. `CLAY_RIM` is the shared token for a component that frames content it
 * does not control. See `clay.ts`.
 */

export interface ImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'placeholder' | 'children'> {
  radius?: ImageRadius;
  shadow?: ImageShadow;
  isBlurred?: boolean;
  isZoomed?: boolean;
  isLoading?: boolean;
  disableSkeleton?: boolean;
  removeWrapper?: boolean;
  fallbackSrc?: React.ReactNode;
  classNames?: { base?: string; img?: string; wrapper?: string; zoomedWrapper?: string; blurredImg?: string };
  /**
   * Scrapbook-era tilt. Accepted and ignored — clay has no rotation. Kept so
   * the six apps' call sites do not have to change.
   */
  rotate?: number;
}

const EmptyImageGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    aria-hidden
    className={cn('text-ink/40 h-10 w-10', className)}
    fill='none'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2}
    viewBox='0 0 24 24'
  >
    <rect height='17' rx='2' width='17' x='3.5' y='3.5' />
    <circle cx='9' cy='9' r='1.5' />
    <path d='m4 18 5-5 4 4 3-3 4 4' />
  </svg>
);

export const Image = React.forwardRef<HTMLImageElement, ImageProps>(function Image(
  {
    src,
    alt = '',
    width,
    height,
    radius = 'md',
    shadow = 'md',
    isBlurred,
    isZoomed,
    isLoading: controlledLoading,
    disableSkeleton,
    removeWrapper,
    fallbackSrc,
    loading = 'lazy',
    className,
    classNames,
    style,
    rotate: _rotate,
    onLoad,
    onError,
    ...rest
  },
  ref,
) {
  const [internalLoading, setInternalLoading] = React.useState(true);
  const [errored, setErrored] = React.useState(false);
  const isLoading = controlledLoading ?? internalLoading;

  const handleLoad: React.ReactEventHandler<HTMLImageElement> = (e) => {
    setInternalLoading(false);
    onLoad?.(e);
  };
  const handleError: React.ReactEventHandler<HTMLImageElement> = (e) => {
    setInternalLoading(false);
    setErrored(true);
    onError?.(e);
  };

  const imgEl = (
    <img
      ref={ref}
      alt={alt}
      className={cn(
        'block h-auto max-w-full object-cover',
        'transition-opacity duration-200',
        isLoading || errored ? 'opacity-0' : 'opacity-100',
        isZoomed && 'transition-transform duration-300 ease-out hover:scale-[1.06]',
        classNames?.img,
      )}
      height={height}
      loading={loading}
      onError={handleError}
      onLoad={handleLoad}
      src={src}
      width={width}
      {...rest}
    />
  );

  if (removeWrapper) {
    return imgEl;
  }

  const depth = DEPTH[shadow];
  // `.clay-panel` — raised, with NO hover rule. Not `.clay-surface`, which
  // changes its shadow on hover and would have an inert picture answering the
  // cursor. (This was a hand-rolled `[box-shadow:var(--clay-rest)]` until the
  // shared class landed.)
  const wrapperShape = cn(
    'relative inline-block overflow-hidden',
    'border-[3px] border-[color:var(--clay-edge)]',
    depth > 0 && 'clay-panel',
    RADIUS[radius],
    isZoomed && 'overflow-hidden',
    className,
    classNames?.base,
    classNames?.wrapper,
    isZoomed && classNames?.zoomedWrapper,
  );

  return (
    <span
      className={wrapperShape}
      style={
        {
          background: CLAY_FILL.default,
          ...clayVars(CLAY_FILL.default, { kind: 'surface', depth: depth || 6 }),
          '--clay-edge': CLAY_RIM,
          ...(style as React.CSSProperties),
        } as React.CSSProperties
      }
    >
      {isBlurred && src ? (
        <img
          aria-hidden
          alt=''
          className={cn(
            'absolute inset-0 h-full w-full scale-110 object-cover',
            'pointer-events-none opacity-60',
            classNames?.blurredImg,
          )}
          src={src}
          style={{ filter: 'blur(20px)' }}
        />
      ) : null}
      {isLoading && !disableSkeleton && !errored ? (
        <span
          aria-hidden
          className={cn(
            'absolute inset-0 z-[1] block border-[2px] border-dashed',
            '[animation:sk-pulse-soft_1.6s_ease-in-out_infinite]',
            RADIUS[radius],
          )}
          style={{ background: CLAY_FILL.default, borderColor: 'var(--clay-edge)' }}
        />
      ) : null}
      {errored ? (
        <span
          className={cn('relative z-[2] flex items-center justify-center', RADIUS[radius])}
          style={{ width, height, background: CLAY_FILL.default }}
        >
          {fallbackSrc ?? <EmptyImageGlyph />}
        </span>
      ) : (
        <span className='relative z-[2] block'>{imgEl}</span>
      )}
    </span>
  );
});

Image.displayName = 'Image';
