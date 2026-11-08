import React from 'react';

import { cn } from '../../cn';
import type { ClayKind } from '../clay';
import { CLAY_FILL, CLAY_LABEL, clayKindFor, clayVars } from '../clay';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';
import { HEROUI_COLOR_SHADOW, HEROUI_COLOR_SOFT_FILL, HEROUI_COLOR_TEXT, INK, SURFACE_1 } from '../tokens';

/**
 * Chip — the clay label. A small slab with a 3px edge in a mid-tone of its own
 * fill and a solid lip straight down; see `../clay.ts` for the recipe and
 * `../ClayButton/ClayButton.tsx` for the reference implementation.
 *
 * WHAT IS DIFFERENT HERE FROM THE BUTTON: a button is always a control, so it
 * always presses. A chip usually is NOT — in this codebase ~97% of the 1,372
 * call sites are status labels in tables and cards. So the press affordance is
 * conditional (see `pressable` below), and a static chip does not even lift on
 * hover: `--clay-hover` is pinned to `--clay-rest`. Giving a label that reacts
 * to the cursor is the same lie as giving it a press-down.
 */

export type ChipVariant = 'solid' | 'flat' | 'bordered' | 'dot' | 'shadow' | 'light';

const SIZE: Record<HeroUISize, string> = {
  sm: 'h-6 px-2.5 text-[11px] gap-1',
  md: 'h-7 px-3 text-[12px] gap-1.5',
  lg: 'h-8 px-3.5 text-[13px] gap-2',
};

// Clay's radius ladder, one rung down from CLAY_RADIUS because a chip is a third
// the height of a button. Written out rather than interpolated from the
// constant: Tailwind's JIT scans source text and cannot see through a template
// literal, so an interpolated arbitrary `rounded-` value generates no class at all.
const RADIUS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-[8px]',
  md: 'rounded-[10px]',
  lg: 'rounded-[14px]',
  full: 'rounded-full',
};

/**
 * Lip depth. ONE value for all three sizes, deliberately: a row mixing `sm` and
 * `md` chips with different lips reads as two different materials.
 *
 * 4px, not the button's 6px — measured, not guessed (see `.clay/chip.md`). Two
 * things pin it there. At 6px the lip is a quarter of an `sm` chip's 24px box
 * and the chip reads as a squashed button. At 3px the press degenerates:
 * `clayVars` sets the hover lip to `depth - 2` and the active lip to 1, so at
 * depth 3 hover and active are both 1px and the two states become
 * indistinguishable. 4 is the smallest depth that still has three distinct
 * states, and it is what the screenshots picked.
 */
const DEPTH = 4;
/** `shadow` was scrapbook's "extra shadow" variant. In clay that is a deeper lip. */
const DEPTH_SHADOW = 6;

/**
 * Press travel, keyed by depth. The invariant is `translate = depth - lip`, so
 * the chip's BOTTOM edge never moves and only the lip closes — animating one
 * without the other makes the chip slide instead of depress. Both strings are
 * written out literally so the JIT can see them.
 */
const PRESS: Record<number, string> = {
  // NO `focus-visible:` travel. `.clay-btn` used to apply `--clay-hover` on
  // focus as well as hover, so this compensated for a lip that closed while the
  // chip stood still. That rule now applies to `:hover` only, and the
  // compensation would OVER-correct — the lip stays at rest while the chip
  // moves 2px down, which is the same 2px slide pointing the other way.
  4: 'hover:translate-y-[2px] active:translate-y-[3px]',
  6: 'hover:translate-y-[2px] active:translate-y-[5px]',
};

/** Where a selected chip parks — the full lip, so it sits flush in its hole. */
const SELECTED_SIT: Record<number, string> = {
  4: 'translate-y-[4px]',
  6: 'translate-y-[6px]',
};

/**
 * Touch target. PRODUCT.md asks for 44px on mobile; the chip boxes are 24/28/32,
 * so a PRESSABLE chip grows an invisible `::before` to 44px tall. Vertical only:
 * widening it too would let a chip steal taps from its neighbour in a row, and a
 * chip is always wider than it is tall anyway. Static chips get nothing — an
 * inert label has no target to hit.
 */
const TOUCH: Record<HeroUISize, string> = {
  sm: "before:absolute before:inset-x-0 before:-top-[10px] before:-bottom-[10px] before:content-['']",
  md: "before:absolute before:inset-x-0 before:-top-2 before:-bottom-2 before:content-['']",
  lg: "before:absolute before:inset-x-0 before:-top-[6px] before:-bottom-[6px] before:content-['']",
};

type ChipFace = {
  /** The painted face. Everything else (edge, lip, glow) is derived from it. */
  fill: string;
  label: string;
  kind: ClayKind;
  /** No clay geometry at all — `light` is text, not an object. */
  bare?: boolean;
};

/**
 * WHICH MIX PROFILE, AND WHY IT IS NOT JUST `clayKindFor(color)`.
 *
 * `clayKindFor` keys off the COLOUR, which is the right question for a button:
 * a button's fill is either a saturated brand or `default`. A chip's is not.
 * Four of its six variants paint a near-white face NO MATTER which colour is
 * asked for — `bordered` and `dot` fill with the card surface and let the colour
 * tint only the LABEL, and `flat` fills with a pastel. So the question here is
 * "is this face saturated enough to separate itself from the card?", and only
 * `solid`/`shadow` on a brand colour can answer yes.
 *
 * Everything else is `control`: at chip scale the rim IS the boundary, so WCAG
 * 1.4.11 puts a 3:1 floor on it. Measured before this, against the card:
 * `bordered` was 1.23:1 in EVERY colour, and `flat` 1.23-2.29:1 — an invisible
 * chip where the scrapbook drew near-black ink at ~15:1.
 */
function chipFace(variant: ChipVariant, color: HeroUIColor): ChipFace {
  if (variant === 'light') {
    // `bare` skips clay entirely, so `kind` is never read on this branch.
    return { fill: 'transparent', label: color === 'default' ? INK : HEROUI_COLOR_TEXT[color], kind: 'control', bare: true };
  }
  if (variant === 'solid' || variant === 'shadow') {
    // The one branch where the colour decides: a brand fill separates itself, a
    // `default` fill is content1 and needs the rim. `small` is what makes that
    // second case `control` rather than the panel-sized `surface`.
    return { fill: CLAY_FILL[color], label: CLAY_LABEL[color], kind: clayKindFor(color, true) };
  }
  if (variant === 'flat') {
    // The soft fills are theme-aware (pastel in light, deep in dark) and their
    // contrast against the flipping INK is already measured in tokens.ts. Clay
    // changes the shape, not which palette a variant paints. NOT
    // `clayKindFor(color, true)`: that returns `brand` for a flat primary, and
    // the face here is a PASTEL, not the brand — mixing it as a brand fill
    // leaves the rim at 1.66:1.
    return { fill: HEROUI_COLOR_SOFT_FILL[color], label: INK, kind: 'control' };
  }
  // bordered | dot — the card surface carries the chip, the brand carries the
  // label. The fill is the SAME near-white for all six colours, so the rim is
  // the entire chip: `control` unconditionally, never keyed off `color`.
  return { fill: SURFACE_1, label: color === 'default' ? INK : HEROUI_COLOR_TEXT[color], kind: 'control' };
}

/**
 * A latched chip. Promoted to the solid brand fill AND pushed into its hole, so
 * it reads as selected on its own rather than only next to an idle sibling.
 *
 * `default` cannot use CLAY_FILL.default here: that is content1, the same
 * surface a `bordered` chip already paints, so a selected default chip would
 * differ from an idle one by the inset alone. `--heroui-default` is a distinct
 * mid-tone in both themes and its own foreground is the theme's answer for it.
 */
function selectedFace(color: HeroUIColor): ChipFace {
  if (color === 'default') {
    return {
      fill: 'hsl(var(--heroui-default))',
      label: 'hsl(var(--heroui-default-foreground))',
      // The half-application trap: a SELECTED default chip is still a
      // near-white slab whose rim does the identifying, so it takes `control`
      // too — not just the resting state. In dark this fill is #2d376e against
      // a #141a3b card, which is 1.4:1 on its own and separates by nothing.
      kind: 'control',
    };
  }

  return { fill: CLAY_FILL[color], label: CLAY_LABEL[color], kind: 'brand' };
}

export interface ChipProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'color'> {
  color?: HeroUIColor;
  variant?: ChipVariant;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  /** Leading mini-avatar (HeroUI parity). Rendered before `startContent`,
   *  wrapped in a small box ringed in the chip's own clay edge. */
  avatar?: React.ReactNode;
  isClosable?: boolean;
  onClose?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  isDisabled?: boolean;
  /**
   * @deprecated No-op. Seeded rotation was a scrapbook device and died with it —
   * a clay chip is an extruded slab, and a tilted one reads as broken rather
   * than as paper. Kept accepted so the six apps' call sites still compile.
   */
  rotate?: number;
  /** Selected state — the chip latches down into its own hole. */
  selected?: boolean;
  classNames?: {
    base?: string;
    content?: string;
    closeButton?: string;
    dot?: string;
    avatar?: string;
  };
}

export const Chip = React.forwardRef<HTMLSpanElement, ChipProps>(function Chip(
  {
    children,
    className,
    color = 'default',
    variant = 'solid',
    size = 'md',
    radius = 'full',
    startContent,
    endContent,
    avatar,
    isClosable,
    onClose,
    isDisabled,
    rotate: _rotate,
    selected,
    classNames,
    style,
    ...rest
  },
  ref,
) {
  const face = selected ? selectedFace(color) : chipFace(variant, color);
  const depth = variant === 'shadow' ? DEPTH_SHADOW : DEPTH;

  // A chip is a control only when something happens when you hit it. `onClick`
  // arrives through `...rest` — Chip has never had an `onPress`.
  const pressable = !isDisabled && !selected && !face.bare && typeof rest.onClick === 'function';

  const vars = clayVars(face.fill, { kind: face.kind, depth, inset: selected }) as Record<string, string>;
  // Static chips are raised but frozen: no hover lift. See the note at the top.
  const clay = pressable || selected ? vars : { ...vars, '--clay-hover': vars['--clay-rest'] };

  /**
   * A pressable chip is a `span`, so without this it is not reachable at all —
   * the `focus-visible:` classes above could never fire and a keyboard user
   * could not use the control. Applied only when the chip really is pressable,
   * and BEFORE `{...rest}`, so a call site passing its own `role` / `tabIndex` /
   * `onKeyDown` still wins.
   *
   * `.click()` rather than calling `rest.onClick` directly: that would mean
   * fabricating a MouseEvent, and this routes through React's own handler.
   */
  const pressProps = pressable
    ? {
        role: 'button',
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent<HTMLSpanElement>) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.currentTarget.click();
        },
      }
    : null;

  return (
    <span
      ref={ref}
      aria-disabled={isDisabled || undefined}
      className={cn(
        'relative inline-flex items-center whitespace-nowrap font-extrabold',
        // Only transform and box-shadow animate — never the fill, or a press
        // reads as a colour change rather than a movement. 150ms, not the
        // button's 200: a third of the mass over half the travel.
        'transition-[transform,box-shadow] duration-150',
        SIZE[size],
        RADIUS[radius],
        face.bare
          ? 'border-[3px] border-transparent'
          : ['border-[3px] border-[color:var(--clay-edge)]', selected || !pressable ? 'clay-surface' : 'clay-btn'],
        pressable && [
          // NOTE: deliberately no `focus-visible:outline-none` here, unlike the
          // reference button. Clay has no focus token yet: the ring the design
          // system does own (`--focus-ring-shadow`) is a `box-shadow`, and
          // box-shadow REPLACES rather than composes, so setting it would
          // delete the lip at exactly the moment the control is in use — the
          // defect `.sk-input` documents at length in scrapbook.css. A single
          // citrine outline is not a substitute either: measured 1.29:1 on
          // paper. Until `.clay-btn:focus-visible` restates the lip alongside
          // the ring (shared file — reported, not applied), the UA's own
          // outline stays as the visible indicator. The travel below reinforces
          // it; it is not an indicator on its own.
          'cursor-pointer touch-manipulation select-none',
          TOUCH[size],
          PRESS[depth],
          // Scoped to the pressable branch on purpose: unscoped, this would
          // also unpark a SELECTED chip on hover under reduced motion, since a
          // selected chip holds a permanent translate rather than an animated one.
          'motion-reduce:hover:translate-y-0',
        ],
        selected && SELECTED_SIT[depth],
        'motion-reduce:transition-none',
        isDisabled && 'opacity-50',
        className,
        classNames?.base,
      )}
      style={{
        background: face.fill,
        color: face.label,
        ...(face.bare ? null : clay),
        ...(style as React.CSSProperties),
      }}
      {...pressProps}
      {...rest}
    >
      {avatar ? (
        <span
          aria-hidden
          className={cn(
            'inline-flex h-[1.4em] w-[1.4em] shrink-0 items-center justify-center overflow-hidden',
            'bg-paper -ms-1 me-1 rounded-full border-[1.5px] border-[color:var(--clay-edge)]',
            '[&>img]:h-full [&>img]:w-full [&>img]:object-cover',
            classNames?.avatar,
          )}
        >
          {avatar}
        </span>
      ) : null}
      {variant === 'dot' ? (
        <span
          aria-hidden
          className={cn('inline-block h-2 w-2 shrink-0 rounded-full', classNames?.dot)}
          // The dot is a mark, not clay geometry — it keeps the reviewed
          // scrapbook brand tints rather than being derived from the fill.
          // `default` takes the flipping INK, not HEROUI_COLOR_SHADOW.default
          // (which stays dark in both themes and would vanish on a dark chip).
          style={{ background: color === 'default' ? INK : HEROUI_COLOR_SHADOW[color] }}
        />
      ) : null}
      {startContent}
      <span className={cn('inline-flex items-center', classNames?.content)}>{children}</span>
      {endContent}
      {isClosable ? (
        <button
          aria-label='Remove'
          className={cn(
            'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
            'transition-[transform,box-shadow,opacity] duration-150',
            face.bare
              ? // A `light` chip has no edge, so neither does its ✕ — just the
                // glyph. It previously carried `border border-current/30`,
                // which does not compile: the `border` shorthand class landed
                // but the opacity-modified colour did not, so the ring fell
                // back to Tailwind preflight's grey-200 in BOTH themes.
                'hover:opacity-70'
              : // Its own clay key, set INTO the chip. The `--clay-*` vars are
                // re-declared here on purpose: custom properties inherit, so
                // without this the ✕ would wear the chip's 4px lip at 16px wide.
                'clay-btn border-[1.5px] border-[color:var(--clay-edge)] active:translate-y-[1px]',
            classNames?.closeButton,
          )}
          style={face.bare ? undefined : (clayVars(face.fill, { kind: face.kind, depth: 2 }) as React.CSSProperties)}
          type='button'
          onClick={onClose}
        >
          <svg
            fill='none'
            height='10'
            stroke='currentColor'
            strokeLinecap='round'
            strokeWidth={2.4}
            viewBox='0 0 24 24'
            width='10'
          >
            <path d='M18 6 6 18M6 6l12 12' />
          </svg>
        </button>
      ) : null}
    </span>
  );
});

Chip.displayName = 'Chip';
