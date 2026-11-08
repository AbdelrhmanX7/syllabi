import React from 'react';

import { cn } from '../../cn';
import type { ClayColor } from '../clay';
import { CLAY_FILL, CLAY_LABEL, clayKindFor, clayVars } from '../clay';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';
import { HEROUI_COLOR_SOFT_FILL, HEROUI_COLOR_TEXT, INK_MUTED } from '../tokens';

/**
 * da-v2 Pagination — drop-in for HeroUI Pagination, in clay.
 *
 * HeroUI API mirrored:
 *   <Pagination total page initialPage onChange siblings boundaries showControls
 *               showShadow color size radius isDisabled disableAnimation isCompact
 *               loop classNames variant />
 *
 * Clay reading of the pattern: the row is a BANK OF KEYS. Every page number and
 * both controls are a pressable slab with a lip; the current page is the key
 * that has been pushed IN — it keeps its place in the row and takes a recessed
 * inset instead of a lip, so "where am I" is answered by depth as well as by
 * colour. The ellipsis is not a key at all: it is inert text, and gets no
 * border, no lip and no press, because giving an inert element a pressable
 * affordance is a lie.
 *
 * The cursor was first built as a key parked at the bottom of its own travel
 * (translated down, lip closed). That reads beautifully in light and breaks in
 * dark: a dark `content1` key cannot have a visible lip at all — even a pure
 * black lip is only 1.18:1 against it — so the neighbours go flat, there is no
 * surface left to be pushed into, and the translated cursor reads as a row
 * that is 4px out of alignment. An inset is drawn ON the cursor's own fill
 * rather than under its neighbours', so it survives a palette whose surfaces
 * sit within 1.2:1 of black.
 *
 * See `../clay.ts` for why the edge/lip colours are mixed rather than taken from
 * a numbered ramp, and `../../styles/scrapbook.css` (`.clay-btn`) for why the
 * three shadow states are real CSS.
 */

export type PaginationVariant = 'flat' | 'bordered' | 'light' | 'faded';

/**
 * Per-size geometry. `depth` is the lip at rest.
 *
 * A pagination key is a third of a `ClayButton`'s height, so the reference's flat
 * 6px lip is proportionally three times heavier here and turns a row of ten keys
 * into a row of ten shadows. Depth tracks the key instead, at roughly 1/7th of
 * its height — the ratio the large button already reads at.
 */
const SIZE: Record<HeroUISize, { box: string; depth: number }> = {
  sm: { box: 'h-8 min-w-8 px-2 text-[12px]', depth: 4 },
  md: { box: 'h-9 min-w-9 px-2.5 text-[13px]', depth: 5 },
  lg: { box: 'h-10 min-w-10 px-3 text-[14px]', depth: 6 },
};

/**
 * PRODUCT.md: touch targets are at least 44px on mobile. Every size above is
 * below that — 32/36/40px — because `size` is a DENSITY knob for a mouse, and a
 * mouse can hit a 32px key. A finger cannot.
 *
 * So the key floors at 44x44 when the PRIMARY pointer is coarse. Deliberately not
 * a viewport breakpoint: a narrow window on a laptop is still a mouse and a
 * 1024px tablet is still a finger — width does not tell you what is pointing.
 * `pointer: coarse` does. (`any-pointer: coarse` would be wrong: it is also true
 * of a desktop with a touchscreen attached, where the mouse is still primary.)
 *
 * This collapses all three sizes to one key on a phone. That is the honest
 * answer: below the touch floor the density knob has nothing left to trade.
 */
const TOUCH_FLOOR =
  '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:px-3';

/**
 * Travel, keyed by lip depth. Hover travels 2px (the lip goes depth -> depth-2)
 * and a press travels depth-1 (the lip goes depth -> 1), so the key's BOTTOM EDGE
 * never moves and only the lip closes — that is the difference between a press
 * and a slide.
 *
 * Written out per depth rather than interpolated because Tailwind's JIT scans
 * source text and cannot see through a template literal:
 * an interpolated arbitrary `translate-y-` value generates no class at all. 4-8 covers every size with
 * and without `showShadow`, which deepens the row by 2.
 */
const TRAVEL: Record<number, { press: string; clear: string }> = {
  4: { press: 'active:translate-y-[3px]', clear: 'pb-[6px]' },
  5: { press: 'active:translate-y-[4px]', clear: 'pb-[7px]' },
  6: { press: 'active:translate-y-[5px]', clear: 'pb-[8px]' },
  7: { press: 'active:translate-y-[6px]', clear: 'pb-[9px]' },
  8: { press: 'active:translate-y-[7px]', clear: 'pb-[10px]' },
};

/**
 * The half of the lift that does not vary with depth.
 *
 * `motion-reduce` removes the hover and focus lift, as the reference does. The
 * press travel is deliberately kept: it is direct manipulation, it is
 * instantaneous once `transition-none` applies, and suppressing it while
 * `.clay-btn:active` still closes the lip would make the key appear to SHRINK
 * from the bottom rather than go down — a worse artefact than the 4px it saves.
 */
const LIFT_COMMON =
  'hover:translate-y-[2px] ' +
  'motion-reduce:hover:translate-y-0';

/**
 * Clay's radius ladder (`CLAY_RADIUS` 14/18/20/24) is tuned for slabs; on a 36px
 * key an 18px radius is a pill. These are the same ladder scaled to key size,
 * again written out literally for the JIT.
 */
const RADIUS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-md',
  full: 'rounded-full',
};

export interface PaginationProps {
  total: number;
  page?: number;
  initialPage?: number;
  onChange?: (page: number) => void;
  siblings?: number;
  boundaries?: number;
  showControls?: boolean;
  showShadow?: boolean;
  color?: HeroUIColor;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  variant?: PaginationVariant;
  isDisabled?: boolean;
  disableAnimation?: boolean;
  isCompact?: boolean;
  loop?: boolean;
  className?: string;
  classNames?: {
    base?: string | null | false;
    wrapper?: string | null | false;
    item?: string | null | false;
    cursor?: string | null | false;
    prev?: string | null | false;
    next?: string | null | false;
    ellipsis?: string | null | false;
    chevronNext?: string | null | false;
  };
  /** HeroUI compat — render the page link as a custom element. */
  renderItem?: (props: {
    key: string;
    value: number | 'prev' | 'next' | 'dots';
    isActive: boolean;
    onNext: () => void;
    onPrevious: () => void;
    onPress: () => void;
    className?: string;
  }) => React.ReactNode;
  /** HeroUI compat — kept for parity. */
  dotsJump?: number;
  /** Passed through to the nav element. */
  dir?: 'rtl' | 'ltr';
  'aria-label'?: string;
}

const DOTS = 'dots' as const;

function buildPages(total: number, current: number, siblings: number, boundaries: number): Array<number | typeof DOTS> {
  const totalPageNumbers = siblings * 2 + 3 + boundaries * 2;

  if (total <= totalPageNumbers) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const leftSibling = Math.max(current - siblings, boundaries + 2);
  const rightSibling = Math.min(current + siblings, total - boundaries - 1);

  const showLeftDots = leftSibling > boundaries + 2;
  const showRightDots = rightSibling < total - boundaries - 1;

  const result: Array<number | typeof DOTS> = [];

  // Left boundary
  for (let i = 1; i <= boundaries; i++) result.push(i);

  if (!showLeftDots) {
    for (let i = boundaries + 1; i < leftSibling; i++) result.push(i);
  } else {
    result.push(DOTS);
  }

  for (let i = leftSibling; i <= rightSibling; i++) result.push(i);

  if (!showRightDots) {
    for (let i = rightSibling + 1; i <= total - boundaries; i++) result.push(i);
  } else {
    result.push(DOTS);
  }

  // Right boundary
  for (let i = total - boundaries + 1; i <= total; i++) result.push(i);

  // Dedup safety
  return result.filter((v, i, arr) => i === 0 || v !== arr[i - 1]);
}

export function Pagination(props: PaginationProps) {
  const {
    total,
    page: pageProp,
    initialPage,
    onChange,
    siblings = 1,
    boundaries = 1,
    showControls,
    showShadow,
    color = 'primary',
    size = 'md',
    radius = 'md',
    variant = 'flat',
    isDisabled,
    disableAnimation,
    isCompact,
    loop,
    className,
    classNames,
    dir,
    'aria-label': ariaLabel = 'Pagination',
    renderItem,
  } = props;

  const isControlled = pageProp !== undefined;
  const [internal, setInternal] = React.useState(initialPage ?? 1);
  const page = Math.min(Math.max(1, isControlled ? Number(pageProp) : internal), Math.max(1, total));

  const navRef = React.useRef<HTMLElement>(null);

  const goTo = React.useCallback(
    (next: number) => {
      let target = next;
      if (loop) {
        if (target < 1) target = total;
        if (target > total) target = 1;
      } else {
        target = Math.min(Math.max(1, target), total);
      }
      if (!isControlled) setInternal(target);
      onChange?.(target);
    },
    [isControlled, loop, onChange, total],
  );

  const geo = SIZE[size];
  /*
   * `showShadow` used to stack a second hard diagonal, which clay has no word
   * for. It maps to DEPTH: the whole row sits 2px higher off the page, lip and
   * ambient glow scaling together. That keeps every value coming out of
   * `clayVars` — the alternative was appending a hand-written box-shadow layer,
   * which is exactly the per-component drift the helper exists to prevent.
   */
  const depth = geo.depth + (showShadow ? 2 : 0);
  const travel = TRAVEL[depth];
  const pages = buildPages(total, page, siblings, boundaries);

  // `HeroUIColor` and `ClayColor` are the same six keys; the cast documents that
  // rather than widening either type.
  const clayColor = color as ClayColor;
  // Every key that is NOT the current page is a plain surface slab. Colour marks
  // the selection; it does not decorate the row.
  const restFill = CLAY_FILL.default;
  /*
   * `color='default'` has no brand fill to spend — `CLAY_FILL.default` IS the
   * resting key — so the cursor would differ from its neighbours by depth alone.
   * Depth is a real signal, but it should not be the only one. Step the cursor to
   * `content3`: still neutral, visibly darker, and `CLAY_LABEL.default` (the theme
   * foreground) stays high-contrast on it in both themes.
   */
  const cursorFill = color === 'default' ? 'hsl(var(--heroui-content3))' : CLAY_FILL[clayColor];
  /*
   * Two different answers to "what colour is the current page's label", and they
   * are not interchangeable:
   *   on a fill  -> `CLAY_LABEL[color]`, the theme's contrast-checked partner for
   *                 that fill. Never a hardcoded `#ffffff`: that painted white on
   *                 the `warning` amber (2.15:1) and on a warm palette's amber
   *                 primary (2.03:1) — and `primary` is this component's DEFAULT.
   *   on nothing -> `HEROUI_COLOR_TEXT[color]` (variant `light`), the brand
   *                 lightened for dark mode so it survives as text on the page.
   */
  const cursorLabel = color === 'default' ? CLAY_LABEL.default : variant === 'light' ? HEROUI_COLOR_TEXT[color] : CLAY_LABEL[clayColor];

  const baseKey =
    'relative inline-flex select-none items-center justify-center whitespace-nowrap font-bold ' +
    // Only transform and box-shadow animate. Animating the fill would make a
    // press read as a colour change instead of a movement.
    'transition-[transform,box-shadow] duration-150 ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
    'motion-reduce:transition-none';

  const renderKey = (value: number | typeof DOTS | 'prev' | 'next', idx: number): React.ReactNode => {
    const isPrev = value === 'prev';
    const isNext = value === 'next';
    const isDots = value === DOTS;
    const isActive = typeof value === 'number' && value === page;

    if (renderItem && (typeof value === 'number' || value === 'prev' || value === 'next' || value === DOTS)) {
      const node = renderItem({
        key: String(value) + '-' + idx,
        value,
        isActive,
        onPress: () => typeof value === 'number' && goTo(value),
        onNext: () => goTo(page + 1),
        onPrevious: () => goTo(page - 1),
        className: classNames?.item || undefined,
      });
      if (node !== undefined && node !== null) return node;
    }

    // The ellipsis is inert: it is a gap in the sequence, not a destination.
    // No edge, no lip, no hover, no press — nothing that offers to be pushed.
    // It keeps the key footprint only so the row does not reflow around it.
    if (isDots) {
      return (
        <span
          key={`dots-${idx}`}
          aria-hidden
          className={cn(
            'inline-flex items-center justify-center pb-1 text-[16px] leading-none tracking-[0.15em]',
            geo.box,
            TOUCH_FLOOR,
            classNames?.ellipsis,
          )}
          style={{ color: INK_MUTED }}
        >
          …
        </span>
      );
    }

    const isLocallyDisabled = isDisabled || (isPrev && !loop && page <= 1) || (isNext && !loop && page >= total);

    /*
     * Variants, in clay terms:
     *   flat (default) — full slab: edge, lip, painted key.
     *   bordered       — same slab, resting keys unpainted; only the cursor fills.
     *   faded          — cursor softened to a tint of the brand over the surface.
     *   light          — NO slab at all. Nothing to press into, so the cursor is
     *                    carried by the brand as a LABEL colour instead of a fill,
     *                    and nothing sinks (a bare numeral dropping 4px reads as a
     *                    typo, not a press).
     */
    const isSlab = variant !== 'light';
    const unpainted = variant === 'bordered' || variant === 'light';
    const restBg = unpainted ? 'transparent' : restFill;
    const activeBg = !isSlab ? 'transparent' : variant === 'faded' ? HEROUI_COLOR_SOFT_FILL[color] : cursorFill;

    const fill = isActive ? activeBg : restBg;
    // `clayVars` needs an opaque colour to mix an edge and lip out of; a resting
    // `bordered` key is unpainted but still sits on the surface, so it mixes from
    // that rather than from `transparent`.
    const mixFrom = isActive && isSlab ? activeBg : restFill;
    // `faded` keeps the plain foreground: its fill is mostly the surface, so the
    // cursor colour would be the wrong partner for it.
    const fg = isActive && variant !== 'faded' ? cursorLabel : CLAY_LABEL.default;

    /*
     * `small = true` on EVERY branch that resolves to a near-white fill, not just
     * the inactive one. A page key has no label doing the identifying the way a
     * button does — its RIM is the control — so WCAG 1.4.11 puts a 3:1 floor on
     * that rim, and the `surface` profile's edge measures 1.23:1 on a white card.
     *
     * The branch that hides is the `default`-coloured ACTIVE key: nobody
     * screenshots it, because the interesting shot is always the brand-coloured
     * cursor. It is equally a near-white slab and equally needs the rim.
     * A faded cursor is a soft tint over the surface, so it counts as near-white
     * too — darkening it as hard as a saturated fill would only turn it grey.
     *
     * This matters MORE at the shallow depth this component chose: the lip is
     * 4-6px rather than the reference's flat 6, so the rim carries
     * proportionally more of the boundary, not less.
     */
    const kind = clayKindFor(isActive && variant !== 'faded' ? clayColor : 'default', true);
    // `inset` is what makes the cursor a socket rather than a slab. It is the
    // helper's own tier-3 vocabulary, used here on a tier-1 control on purpose:
    // the key IS pressed, and the recess has to be drawn on its own fill to
    // survive dark mode.
    const vars = clayVars(mixFrom, { kind, depth, inset: isActive && isSlab }) as Record<string, string>;

    /*
     * The current page is PUSHED IN, and stays in the row while it is. All three
     * shadow states collapse onto the full inset so `.clay-btn`'s hover rule
     * cannot pop it back out, and pressing the page you are already on does
     * nothing — which is the truth.
     *
     * Depth, not just hue, says "you are here", and that second channel survives
     * for anyone who cannot separate the brand fill from the surface.
     */
    // Typed as the custom-property bag it actually is. `React.CSSProperties`
    // has no index signature, so assigning `--clay-*` through it was an
    // implicit `any` — invisible while the type-check was silently aborting.
    const style: React.CSSProperties & Record<string, string | number | undefined> = {
      background: fill,
      color: fg,
      outlineColor: CLAY_LABEL.default,
      ...vars,
    };

    if (isActive) {
      style['--clay-rest'] = vars['--clay-active'];
      style['--clay-hover'] = vars['--clay-active'];
    }

    const onClick = () => {
      if (isDisabled) return;
      if (isPrev) goTo(page - 1);
      else if (isNext) goTo(page + 1);
      else if (typeof value === 'number') goTo(value);
    };

    const arrowDir = isPrev ? 'left' : 'right';

    return (
      <button
        key={(isPrev ? 'prev' : isNext ? 'next' : `p-${value}`) + `-${idx}`}
        aria-current={isActive ? 'page' : undefined}
        aria-label={isPrev ? 'Previous page' : isNext ? 'Next page' : `Page ${value}`}
        className={cn(
          baseKey,
          geo.box,
          TOUCH_FLOOR,
          RADIUS[radius],
          isSlab && 'clay-btn border-[3px] border-[color:var(--clay-edge)]',
          // The cursor never translates: it is recessed in place, so it has no
          // travel to remove and nothing for `disableAnimation` or
          // `motion-reduce` to straighten out.
          isSlab && !isActive && !isLocallyDisabled && !disableAnimation && cn(LIFT_COMMON, travel.press),
          disableAnimation && 'transition-none',
          isLocallyDisabled && 'pointer-events-none opacity-40',
          !isLocallyDisabled && 'cursor-pointer',
          classNames?.item,
          isPrev && classNames?.prev,
          isNext && classNames?.next,
          isActive && classNames?.cursor,
        )}
        disabled={isLocallyDisabled}
        style={style}
        type='button'
        onClick={onClick}
      >
        {isPrev || isNext ? (
          <svg
            fill='none'
            height='14'
            stroke='currentColor'
            strokeLinecap='round'
            strokeLinejoin='round'
            strokeWidth={2.6}
            viewBox='0 0 24 24'
            width='14'
          >
            {arrowDir === 'left' ? <path d='m15 18-6-6 6-6' /> : <path d='m9 18 6-6-6-6' />}
          </svg>
        ) : (
          <span>{value}</span>
        )}
      </button>
    );
  };

  return (
    <nav
      ref={navRef}
      aria-label={ariaLabel}
      /*
       * The 44px touch floor makes a full row wider than a phone (8 keys x 44 +
       * gaps = ~394px against a 390px viewport), so the row scrolls instead of
       * putting page 12 somewhere a finger cannot reach. `overflow-x` also
       * makes the Y axis a scrollport, which would CLIP the lip — the `pb` on
       * the list is what keeps it inside. No effect on desktop, where nothing
       * overflows.
       */
      className={cn('flex max-w-full items-center overflow-x-auto', className, classNames?.base)}
      dir={dir}
    >
      {/* The lip is a box-shadow and takes no layout space, so the row reserves
          its own clearance — `depth + 2`, which tracks `showShadow`. Without it
          whatever sits below is overlapped, and now that the nav is a scrollport
          the lip would be clipped outright. */}
      <ul className={cn('flex items-center', travel.clear, isCompact ? 'gap-0' : 'gap-1.5', classNames?.wrapper)}>
        {showControls ? <li>{renderKey('prev', -1)}</li> : null}
        {pages.map((p, i) => (
          <li key={typeof p === 'number' ? `p-${p}` : `dots-${i}`}>{renderKey(p, i)}</li>
        ))}
        {showControls ? <li>{renderKey('next', pages.length)}</li> : null}
      </ul>
    </nav>
  );
}

Pagination.displayName = 'Pagination';
