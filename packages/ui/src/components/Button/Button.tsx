import React from 'react';

import { cn } from '../../cn';
import type { ClayColor, ClayKind } from '../clay';
import { CLAY_FILL, clayKindFor, clayVars } from '../clay';
import { Spinner } from '../Spinner';
import type { HeroUIColor, HeroUIRadius, HeroUISize, HeroUIVariant } from '../tokens';
import { HEROUI_COLOR_FILL, HEROUI_COLOR_FOREGROUND, HEROUI_COLOR_SOFT_FILL, HEROUI_COLOR_TEXT, INK } from '../tokens';

/**
 * da-v2 Button — drop-in replacement for @heroui/react's Button.
 *
 * Mirrors the HeroUI prop API (color/variant/size/radius/isIconOnly/isLoading/
 * isDisabled/startContent/endContent/onPress/as/href/fullWidth) so the barrel
 * re-export in @repo/ui can shadow HeroUI's Button without call-site edits.
 *
 * Visual direction: CLAY. A 3px edge in a mid-tone of the fill, a solid lip
 * `0 Npx 0` straight DOWN, and a press that travels exactly as far as the lip
 * closes, so the bottom edge stays pinned and the button depresses rather than
 * slides.
 *
 * Ported IN PLACE — 953 call sites depend on this file and none of them change.
 * The architecture is unchanged: `surfaceFor()` still returns custom properties
 * and the base class still consumes them. Only the vocabulary they express is
 * different, plus the shadow states now come from the shared `.clay-btn` rule.
 *
 * WHAT EACH VARIANT GETS, AND WHY (`ClayButton` only ever answered `solid`):
 *
 *   solid     the reference slab. Full lip, depth 6.
 *   shadow    the same slab lifted higher — depth 9. In clay "more shadow" is
 *             more ELEVATION, not a second offset stacked behind the first.
 *   flat      a pastel face, so it is a real surface and keeps a lip. It takes
 *             `control`, not `brand`: see CLAY_KIND_FOR_SOFT below.
 *   bordered  its identity is a brand OUTLINE around a plain surface. It has a
 *             fill, so it presses like the others; the rim is the brand rather
 *             than a mix of the fill, because that is the whole variant.
 *   ghost     no surface at rest, so NO lip at rest — a shadow under nothing is
 *             a lie. It gains a fill and a lip on HOVER and presses back down on
 *             active: flush -> lifted -> pressed. Clay's vocabulary used to say
 *             exactly what "ghost" means.
 *   light     no border, no fill, no lip, no travel. There is no surface here to
 *             give physics to; it is a tinted label with a hover wash.
 */

/**
 * `flat` paints a WASH, and a rim derived from a wash is a paler wash. My first
 * pass rescued the CONTRAST with `kind: 'control'` (4.99:1 light / 5.68:1 dark)
 * but not the HUE — primary's rim came out `#756a80`, a desaturated mauve, so
 * `flat` read as "a pastel with a grey rim" rather than "the brand, quietly".
 *
 * `shapeFrom` is the right answer and it is the shared one: the face stays the
 * wash while the edge and lip are drawn from the full brand. `kind` then applies
 * to the SHAPE colour, not the face, so the saturated brands take `brand` and
 * only `default` — whose shape source is near-white — needs `control`. That is
 * exactly `clayKindFor(color, true)`.
 */

const SIZE: Record<HeroUISize, string> = {
  sm: 'h-9 px-3.5 text-[13px] [&_svg]:h-4 [&_svg]:w-4',
  md: 'h-11 px-5 text-[14px] [&_svg]:h-[18px] [&_svg]:w-[18px]',
  lg: 'h-[52px] px-6 text-[15px] [&_svg]:h-5 [&_svg]:w-5',
};

const ICON_ONLY_SIZE: Record<HeroUISize, string> = {
  sm: 'w-9 min-w-9 px-0 [&_svg]:h-[18px] [&_svg]:w-[18px]',
  md: 'w-11 min-w-11 px-0 [&_svg]:h-5 [&_svg]:w-5',
  lg: 'w-[52px] min-w-[52px] px-0 [&_svg]:h-6 [&_svg]:w-6',
};

// Clay's ladder, written out — the JIT cannot read a template literal.
const RADIUS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-md',
  md: 'rounded-lg',
  lg: 'rounded-lg',
  full: 'rounded-full',
};

const SPINNER_SIZE: Record<HeroUISize, 'sm' | 'md' | 'lg'> = { sm: 'sm', md: 'sm', lg: 'md' };

interface SurfaceStyle extends React.CSSProperties {
  // The three shadow states `.clay-btn` reads. Declared here rather than left to
  // an `as` cast so a typo in one of them is a compile error, not a silent
  // `box-shadow: none` at runtime.
  '--clay-rest'?: string;
  '--clay-hover'?: string;
  '--clay-active'?: string;
  '--clay-bd'?: string;
  '--clay-bg'?: string;
  '--clay-fg'?: string;
  '--clay-focus'?: string;
  '--clay-wash'?: string;
  '--clay-travel-hover'?: string;
  '--clay-travel-active'?: string;
}

/** Lip depth per variant. `light` and a resting `ghost` have no surface at all. */
const DEPTH = { solid: 6, shadow: 9, flat: 5, bordered: 6, ghost: 6 } as const;

/** Pull one var back out of `clayVars` without re-deriving it by hand. */
const varsOf = (fill: string, kind: ClayKind, depth: number) =>
  clayVars(fill, { kind, depth }) as unknown as Record<string, string>;

/**
 * Travel must equal the distance the lip closes, or the button slides instead of
 * depressing. `clayVars` gives rest `depth`, hover `depth - 2`, active `1`.
 */
const travel = (depth: number) => ({
  '--clay-travel-hover': '2px',
  '--clay-travel-active': `${depth - 1}px`,
});

function surfaceFor(variant: HeroUIVariant, color: HeroUIColor): SurfaceStyle {
  const clayColor = color as ClayColor;
  // Fill and label come from `HEROUI_COLOR_*`, NOT `CLAY_FILL`/`CLAY_LABEL`.
  //
  // Those two maps are not the same colours. In light, `CLAY_FILL.danger` is
  // HeroUI's `#f43f5e`, and white on it measures **3.67:1** — fine for a tick as
  // a graphic (3:1), and a FAIL for a button's text label (4.5). `tokens.ts`
  // records this exact trap: the danger fill was deliberately NOT brightened to
  // #f43f5e for this reason. `HEROUI_COLOR_FILL.danger` is #e11d48 at 4.70:1.
  // Warning improves too (8.85 vs 7.52). Every other colour is identical.
  //
  // Clay governs the SHAPE, not the palette — the fill is still fed straight
  // into `clayVars`, so the edge and the lip are derived from it exactly as the
  // recipe says. Nothing about the geometry changes; only the ramp it is
  // derived from is the one that was measured for text.
  const fill = HEROUI_COLOR_FILL[color];
  const label = HEROUI_COLOR_FOREGROUND[color];
  // The brand as a LABEL, not as a fill — the raw brand is too dark to read as
  // text on a dark page. Carries the rim, the text and the focus ring on every
  // variant that does not paint a brand surface.
  const tint = HEROUI_COLOR_TEXT[color];
  const surface = CLAY_FILL.default;

  if (variant === 'solid' || variant === 'shadow') {
    const depth = DEPTH[variant];
    const v = varsOf(fill, clayKindFor(clayColor), depth);

    return {
      '--clay-bd': v['--clay-edge'],
      '--clay-bg': fill,
      '--clay-fg': label,
      '--clay-focus': tint,
      '--clay-rest': v['--clay-rest'],
      '--clay-hover': v['--clay-hover'],
      '--clay-active': v['--clay-active'],
      ...travel(depth),
    } as SurfaceStyle;
  }

  if (variant === 'flat') {
    const soft = HEROUI_COLOR_SOFT_FILL[color];
    const v = clayVars(soft, {
      shapeFrom: fill,
      kind: clayKindFor(clayColor, true),
      depth: DEPTH.flat,
    }) as unknown as Record<string, string>;

    return {
      '--clay-bd': v['--clay-edge'],
      '--clay-bg': soft,
      // The soft fills are theme-aware, so fill and foreground move together and
      // the label is the flipping INK — not `CLAY_LABEL`, which is paired with
      // `CLAY_FILL` and would put a brand foreground on a pastel.
      '--clay-fg': INK,
      '--clay-focus': tint,
      '--clay-rest': v['--clay-rest'],
      '--clay-hover': v['--clay-hover'],
      '--clay-active': v['--clay-active'],
      ...travel(DEPTH.flat),
    } as SurfaceStyle;
  }

  if (variant === 'bordered') {
    // Lip from the surface it actually paints; rim from the brand, because a
    // brand outline around a plain face IS this variant.
    const v = varsOf(surface, 'control', DEPTH.bordered);

    return {
      '--clay-bd': tint,
      '--clay-bg': surface,
      '--clay-fg': tint,
      '--clay-focus': tint,
      '--clay-rest': v['--clay-rest'],
      '--clay-hover': v['--clay-hover'],
      '--clay-active': v['--clay-active'],
      ...travel(DEPTH.bordered),
    } as SurfaceStyle;
  }

  if (variant === 'ghost') {
    const v = varsOf(surface, 'control', DEPTH.ghost);

    return {
      '--clay-bd': tint,
      '--clay-bg': 'transparent',
      '--clay-fg': tint,
      '--clay-focus': tint,
      // Flush at rest — `none`, not a lip under a transparent element.
      '--clay-rest': 'none',
      '--clay-hover': v['--clay-hover'],
      '--clay-active': v['--clay-active'],
      // It rises on hover instead of sinking, so hover does not travel down.
      '--clay-travel-hover': '0px',
      // Measured: the press is relative to the state it is pressed FROM, which
      // for a ghost is hover, not rest. `clayVars` gives hover `depth - 2` and
      // active 1, so the travel is that difference — 3, not `depth - 1`. At
      // `depth - 1` the bottom edge ran 0 -> 4 -> 6 and the button slid on press.
      '--clay-travel-active': `${DEPTH.ghost - 3}px`,
      '--clay-wash': surface,
    } as SurfaceStyle;
  }

  // light — no surface, so no physics. A tinted label with a hover wash.
  return {
    '--clay-bd': 'transparent',
    '--clay-bg': 'transparent',
    '--clay-fg': tint,
    '--clay-focus': tint,
    '--clay-rest': 'none',
    '--clay-hover': 'none',
    '--clay-active': 'none',
    '--clay-travel-hover': '0px',
    '--clay-travel-active': '0px',
    '--clay-wash': HEROUI_COLOR_SOFT_FILL[color],
  } as SurfaceStyle;
}

const baseClass = cn(
  // structural
  //
  // `min-w-fit` rather than `shrink-0`, which is what this used to be. Both stop a
  // button being squashed below its own label in a cramped flex row — that is the
  // invariant worth keeping, and `min-width: fit-content` enforces it exactly, since
  // fit-content already accounts for the padding and the 2.5px border. The difference
  // is what happens ABOVE that floor: `shrink-0` also forbade the harmless kind of
  // shrinking, which turned the single most common call-site idiom into a guaranteed
  // overflow.
  //
  // That idiom is two actions side by side, both `className='w-full'` — 55 modals
  // across web/teacher/admin/accounting are written this way. `w-full` resolves
  // against the shared row, so EACH button asks for the row's full width and the pair
  // demands exactly 2x the space available. Flex would normally settle this by
  // shrinking them to half each; `shrink-0` forbade it, so the row overflowed instead
  // and the trailing button walked off the edge. Measured on the teacher AI-extract
  // modal: a 772px footer with two 772px buttons, the second ending 206px past the
  // 1920px viewport; and on its success card, a 730px row with a 1468px scrollWidth.
  //
  // With the floor expressed as min-width instead, the same pair now divides the row
  // (382px each, measured) and nothing can shrink below its text. Buttons that were
  // already at their natural width are unaffected — their fit-content floor IS their
  // current width, so no existing layout moves.
  'relative inline-flex min-w-fit items-center justify-center gap-2 select-none whitespace-nowrap',
  'font-extrabold tracking-[-0.005em]',
  // Only transform and box-shadow animate on the press. Fill/colour transitions
  // stay for the hover wash on `ghost` and `light`, which have no lip to move.
  'transition-[transform,box-shadow,background-color,color,border-color] duration-200 ease-[cubic-bezier(0.3,0.6,0.2,1.2)]',
  'motion-reduce:transition-none',
  // Border and colours through arbitrary-property syntax so the rules survive
  // Tailwind's box-shadow utility chain, which can swallow var() values.
  '[border:3px_solid_var(--clay-bd)] bg-[color:var(--clay-bg)] text-[color:var(--clay-fg)]',
  // The three shadow states live in styles/scrapbook.css under `.clay-btn` — a
  // hover/active box-shadow cannot be expressed inline, and an arbitrary
  // `shadow-` utility holding a CSS variable
  // computes to `none`. Each variant supplies --clay-rest/-hover/-active.
  'clay-btn',
  // The press: straight DOWN, never diagonal, and the travel is per-variant so
  // it always equals the distance that variant's lip closes. `ghost` sets
  // --clay-travel-hover to 0 because it RISES on hover rather than settling.
  'hover:[transform:translateY(var(--clay-travel-hover,2px))]',
  // NO focus travel. `.clay-btn` closes the lip on `:hover` only, so a button
  // that also moved on `:focus-visible` would slide its DRAWN bottom edge down
  // by the travel with the lip still at rest depth (measured: 133 -> 135).
  // Focus gets the outline and nothing else, which also means a component that
  // writes no focus rule at all is correct by default.
  'active:[transform:translateY(var(--clay-travel-active,5px))_scale(0.99)]',
  'motion-reduce:hover:[transform:none]',
  // `ghost` and `light` paint no surface at rest, so their feedback is the wash.
  'hover:bg-[color:var(--clay-wash,var(--clay-bg))]',
  // Focus ring as OUTLINE, not box-shadow. The scrapbook version layered the
  // ring into the same box-shadow as the cast shadow, because Tailwind's `ring-*`
  // utilities compose into --tw-shadow and REPLACED the hard shadow outright
  // (measured: a focused solid primary lost its `4px 4px 0` for as long as it
  // held focus). `outline` is a different property entirely, so it cannot
  // collide with --clay-rest/-hover/-active no matter what those hold — and the
  // ring is the brand-as-TEXT tint, which is legible on both themes where the
  // raw brand fill is not.
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
  'focus-visible:outline-[color:var(--clay-focus)]',
  // disabled
  'disabled:opacity-50 disabled:cursor-not-allowed disabled:[transform:none] disabled:shadow-none disabled:hover:shadow-none disabled:hover:[transform:none]',
  // svgs
  '[&_svg]:shrink-0',
);

export interface ButtonProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement> & React.AnchorHTMLAttributes<HTMLAnchorElement>,
    'color' | 'type' | 'disabled' | 'href'
  > {
  color?: HeroUIColor;
  variant?: HeroUIVariant;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  /** Polymorphic element. Use `as="a"` (or pass a Link component) for link buttons. */
  as?: React.ElementType;
  href?: string;
  type?: 'button' | 'submit' | 'reset';
  isDisabled?: boolean;
  isLoading?: boolean;
  isIconOnly?: boolean;
  fullWidth?: boolean;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  /** HeroUI-compatible press handler. Fires on click & keyboard activation. */
  onPress?: (event: React.MouseEvent<HTMLElement>) => void;
  /** Escape hatch when consumers need native `disabled` semantics. */
  disabled?: boolean;
  /**
   * Scrapbook-era seeded tilt. Accepted and ignored — clay has no rotation, and
   * the transform slot now carries the press. Kept so 953 call sites do not move.
   */
  rotate?: number;
  /** Spinner placement when isLoading (HeroUI compat — only `start` supported). */
  spinnerPlacement?: 'start' | 'end';
}

export const Button = React.forwardRef<HTMLElement, ButtonProps>((props, ref) => {
  const {
    as: Component = 'button',
    className,
    color = 'default',
    variant = 'solid',
    size = 'md',
    radius = 'md',
    isIconOnly,
    isLoading,
    isDisabled,
    disabled,
    fullWidth,
    startContent,
    endContent,
    onPress,
    onClick,
    children,
    type,
    href,
    rotate: _rotate,
    style,
    spinnerPlacement = 'start',
    ...rest
  } = props;

  const resolvedDisabled = Boolean(isDisabled || disabled || isLoading);

  const surface = surfaceFor(variant, color);

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    if (resolvedDisabled) {
      event.preventDefault();

      return;
    }
    onClick?.(event as React.MouseEvent<HTMLButtonElement>);
    onPress?.(event);
  };

  const classes = cn(
    baseClass,
    SIZE[size],
    isIconOnly && ICON_ONLY_SIZE[size],
    RADIUS[radius],
    fullWidth && 'w-full',
    isLoading && 'cursor-progress',
    className,
  );

  const spinner = <Spinner color='current' size={SPINNER_SIZE[size]} />;

  const innerContent = isLoading ? (
    <>
      {spinnerPlacement === 'start' ? spinner : null}
      {!isIconOnly && children}
      {spinnerPlacement === 'end' ? spinner : null}
    </>
  ) : (
    <>
      {startContent}
      {children}
      {endContent}
    </>
  );

  const mergedStyle = { ...(surface as React.CSSProperties), ...(style as React.CSSProperties) };

  if (Component === 'button') {
    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        aria-busy={isLoading || undefined}
        aria-disabled={resolvedDisabled || undefined}
        className={classes}
        disabled={resolvedDisabled}
        onClick={handleClick}
        style={mergedStyle}
        type={type ?? 'button'}
        {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}
      >
        <span className='relative z-[1] inline-flex items-center justify-center gap-2'>{innerContent}</span>
      </button>
    );
  }

  return (
    <Component
      ref={ref}
      aria-busy={isLoading || undefined}
      aria-disabled={resolvedDisabled || undefined}
      className={classes}
      data-disabled={resolvedDisabled || undefined}
      href={href}
      onClick={handleClick}
      style={mergedStyle}
      tabIndex={resolvedDisabled ? -1 : undefined}
      {...rest}
    >
      <span className='relative z-[1] inline-flex items-center justify-center gap-2'>{innerContent}</span>
    </Component>
  );
});

Button.displayName = 'Button';
