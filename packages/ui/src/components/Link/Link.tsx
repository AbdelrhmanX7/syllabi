import React from 'react';

import { cn } from '../../cn';
import type { HeroUISize } from '../tokens';
import { HEROUI_COLOR_TEXT, INK } from '../tokens';

/**
 * da-v2 Link — drop-in for HeroUI Link. Renders an anchor with token-tinted
 * color states and a citrine scribble underline (SVG) that animates in based on
 * the `underline` prop.
 *
 * Visual: color-tinted text. Hover/focus reveals the citrine wavy underline.
 * Optional external icon at inline-end. Disabled = 0.5 opacity, no events.
 *
 * The external icon is a corner-arrow ("opens elsewhere") at the end of the link.
 *
 * ---------------------------------------------------------------------------
 * CLAY MIGRATION: this component takes NO clay slab, in any state. Deliberate.
 *
 * Clay's slab is a 3px edge over a solid `0 6px 0` lip — a thing you press. A
 * Link is running text. Every state here measures `border-width: 0` and
 * `box-shadow: none`, so there is no scrapbook border or lip to convert in the
 * first place; giving one a lip would be inventing a new design, not porting an
 * old one. Rendered side by side, a paragraph whose links are all clay slabs
 * blows out its own leading and stops reading as prose.
 *
 * If you are here to "finish the port" by adding a lip, the four reasons not
 * to, with the receipts, are in `.clay/link.md`. The short version: `isBlock`
 * is a layout modifier and not a slab (see below); no call site in the six apps
 * passes it; the codebase's existing answer to "a link that is a button" is to
 * put a real <Button> inside the Link, which half the call sites do; and
 * `LinkColor` includes `'foreground'`, which has no CLAY_FILL and so no fill
 * semantic to paint a slab with.
 *
 * What IS clay here: the focus ring's radius. See the `rounded-md` note.
 * ---------------------------------------------------------------------------
 */

export type LinkColor = 'foreground' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
export type LinkUnderline = 'none' | 'hover' | 'always' | 'active' | 'focus';
export type LinkSize = HeroUISize;

const SIZE: Record<LinkSize, string> = {
  sm: 'text-[13px]',
  md: 'text-[14px]',
  lg: 'text-[16px]',
};

/**
 * A colored link tints its LABEL, so it takes HEROUI_COLOR_TEXT — the map that
 * exists for exactly this ("when the brand tints a label rather than filling a
 * surface"). This used to read HEROUI_COLOR_SHADOW, the hard-offset-shadow tint
 * map, which is the raw brand fill: dark enough to carry white on a sticker and
 * far too light to BE text on paper. Measured on a warm palette's paper,
 * where the brand is amber: primary was 1.91:1, warning 2.03:1, success 2.39:1,
 * secondary 3.03:1 — every colored link below AA, and primary a regression from
 * 7.02:1 under the default purple. Through HEROUI_COLOR_TEXT the same five are
 * 5.70 / 5.70 / 5.17 / 5.92 / 4.43:1.
 */
function colorFor(color: LinkColor): string {
  if (color === 'foreground') return INK;

  return HEROUI_COLOR_TEXT[color];
}

const UNDERLINE_VISIBILITY: Record<LinkUnderline, string> = {
  none: 'opacity-0',
  hover: 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
  always: 'opacity-100',
  active: 'opacity-0 group-active:opacity-100',
  focus: 'opacity-0 group-focus-visible:opacity-100',
};

const ScribbleUnderline: React.FC<{ stroke: string; className?: string }> = ({ stroke, className }) => (
  <svg
    aria-hidden
    className={cn(
      'pointer-events-none absolute inset-x-0 bottom-[-3px] h-[5px] w-full transition-opacity duration-150',
      className,
    )}
    fill='none'
    preserveAspectRatio='none'
    viewBox='0 0 100 5'
  >
    <path
      d='M1 3 Q 12 0.5, 24 2.5 T 48 2.5 T 72 2.5 T 99 2.5'
      stroke={stroke}
      strokeLinecap='round'
      strokeWidth={1.6}
    />
  </svg>
);

const ExternalIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    aria-hidden
    className={className}
    fill='none'
    height='1em'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={2}
    viewBox='0 0 24 24'
    width='1em'
  >
    <path d='M7 7h10v10' />
    <path d='M7 17 17 7' />
  </svg>
);

export interface LinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'color'> {
  color?: LinkColor;
  size?: LinkSize;
  underline?: LinkUnderline;
  isExternal?: boolean;
  showAnchorIcon?: boolean;
  anchorIcon?: React.ReactNode;
  isDisabled?: boolean;
  /**
   * Render as a block-level link (full width, allows multi-line).
   *
   * LAYOUT ONLY — this is not a "make it a button" switch and must not become
   * one. It sets `block w-full` and nothing else: no padding, no fill, no clay
   * slab. Callers that want a pressable slab put a real <Button> inside the
   * Link, which is what half of them already do.
   */
  isBlock?: boolean;
  /** HeroUI compat alias for `isBlock`. */
  block?: boolean;
  classNames?: { base?: string; icon?: string };
}

export const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    color = 'primary',
    size = 'md',
    underline = 'hover',
    isExternal,
    showAnchorIcon,
    anchorIcon,
    isDisabled,
    isBlock,
    block,
    classNames,
    className,
    children,
    style,
    href,
    target,
    rel,
    onClick,
    ...rest
  },
  ref,
) {
  const tint = colorFor(color);
  const showIcon = isExternal || showAnchorIcon;
  const blockMode = Boolean(isBlock || block);

  const externalAttrs = isExternal
    ? { target: target ?? '_blank', rel: rel ?? 'noopener noreferrer' }
    : { target, rel };

  return (
    <a
      ref={ref}
      aria-disabled={isDisabled || undefined}
      className={cn(
        'group relative inline-flex items-center gap-1 font-bold transition-colors',
        SIZE[size],
        blockMode && 'block w-full',
        isDisabled && 'pointer-events-none opacity-50',
        // Focus ring — the same two-layer ring Button draws, not a bare citrine
        // outline. Citrine is 1.24:1 against a warm palette's lighter paper and 1.29:1 against the
        // default cream, so on its own it is not a focus indicator at all; the
        // --line-on-brand band inside it is what carries the contrast (13.47:1 on
        // #faf8f5, 18.65:1 on #fbfaf6), and in DARK, where that band goes to
        // 1.03:1 against the page, the citrine takes over at 14.83:1. One of the
        // two is always doing the work.
        //
        // `outline-solid` was also a no-op: this is Tailwind 3.4, which has no
        // such utility (it arrived in v4), so outline-style stayed at the UA's
        // `auto` and Chrome drew its own ring — which swallowed outline-offset-2.
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--citrine)]',
        'focus-visible:ring-offset-[2px] focus-visible:ring-offset-[var(--line-on-brand)]',
        // The focus ring is the only shape a Link draws, so it is the only place
        // clay applies here. This was `rounded-sk-sm` — the SCRAPBOOK 4px step.
        // 14px is clay's `CLAY_RADIUS.sm`, written out literally because
        // Tailwind's JIT scans source text and cannot see through
        // an interpolated arbitrary `rounded-` value; same convention as ClayButton's SIZE
        // map, and it keeps Link off the retiring `sk-*` scale.
        //
        // Not just house style: half the call sites are `<Link><Button/></Link>`,
        // and at 4px the ring's square corners cut visible wedges across the
        // button's 18px curve. At 14px the ring follows it. Inline, 14px on a
        // ~21px line box hugs the word as a lozenge instead of stamping a box
        // over it.
        'rounded-md',
        className,
        classNames?.base,
      )}
      href={isDisabled ? undefined : href}
      onClick={isDisabled ? undefined : onClick}
      style={{ color: tint, ...(style as React.CSSProperties) }}
      tabIndex={isDisabled ? -1 : rest.tabIndex}
      {...externalAttrs}
      {...rest}
    >
      <span className='relative inline-flex'>
        {children}
        {underline !== 'none' ? (
          <ScribbleUnderline className={UNDERLINE_VISIBILITY[underline]} stroke='var(--citrine)' />
        ) : null}
      </span>
      {showIcon ? (
        <span aria-hidden className={cn('ms-0.5 inline-flex shrink-0', classNames?.icon)}>
          {anchorIcon ?? <ExternalIcon />}
        </span>
      ) : null}
    </a>
  );
});

Link.displayName = 'Link';
