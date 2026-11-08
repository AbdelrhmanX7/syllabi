import React from 'react';

import { cn } from '../../cn';
import { clayKindFor, clayVars } from '../clay';
import type { HolePunchProps } from './HolePunch';
import type { TapeColor } from './Tape';

/**
 * da-v2 Card — drop-in replacement for HeroUI's Card, in clay. TIER 2.
 *
 * A card is a RAISED SURFACE, not a key. It gets clay's edge and lip and it does
 * NOT get the press ladder: a lip already says "this object stands off the page",
 * and adding travel on top would say "push me", which is a lie about a div.
 * The one exception is `isPressable`, where the card genuinely IS a button — see
 * below.
 *
 * Two substantive changes beyond the visual language:
 *
 *   1. **The surface rung.** This painted `bg-paper`, and in the light theme
 *      `--paper` and `--surface-0` are the same literal value (`#fbfaf6`), so a
 *      card was 1.000:1 against the page it sat on — not "low contrast", the
 *      same colour. It only read at all because the scrapbook's ink border and
 *      hard diagonal shadow carried it, and clay deletes both. `--card-bg` is
 *      the token authored for this job and the one Popover, Accordion, Input,
 *      Select, Textarea, Autocomplete, Alert and Listbox already paint.
 *      (Dark and studio already had `--paper` === `--card-bg`, so this is a
 *      light-theme fix; do not look at dark to check whether it landed.)
 *
 *   2. **The scrapbook extras are gone**, per the migration. `withTape`,
 *      `withPin`, `withHoles`, `withGrain`, `tilted`, `rotate` and `shadowColor`
 *      are still ACCEPTED — six apps pass them — and are documented no-ops. See
 *      each prop for why. Deleting the seeded rotation also deletes the
 *      ResizeObserver that existed only to straighten tall cards before they
 *      handed the page a horizontal scrollbar.
 */

/** @deprecated Retained for call-site compatibility; see `shadowColor`. */
export type CardShadowColor = 'ink' | 'primary' | 'success' | 'warning' | 'danger' | 'pink' | 'blue';

/**
 * Lip depth per `shadow` size, with the literal travel classes a pressable card
 * needs. Tailwind's JIT scans source text and cannot see through a template
 * literal, so an interpolated arbitrary `translate-y-` value generates nothing —
 * these are written out.
 *
 * A press travels `depth - 1` while the lip closes from `depth` to 1, so the
 * card's bottom edge does not move; a hover LIFT travels 2px while the lip grows
 * by 2, for the same reason in the other direction. Both keep the shadow anchored
 * to the page, which is what separates a rise from a slide.
 */
const SHADOW: Record<'none' | 'sm' | 'md' | 'lg', { depth: number; press: string }> = {
  none: { depth: 0, press: '' },
  sm: { depth: 5, press: 'active:translate-y-[4px]' },
  md: { depth: 8, press: 'active:translate-y-[7px]' },
  lg: { depth: 11, press: 'active:translate-y-[10px]' },
};

export interface CardProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  children?: React.ReactNode;
  className?: string;
  /** Polymorphic root. Default 'div'. */
  as?: React.ElementType;
  /**
   * No-op in clay. Washi tape was a scrapbook extra and does not survive the
   * migration; the prop stays accepted so six apps' call sites keep compiling.
   * `Tape` itself is still exported if anything needs it directly.
   */
  withTape?: boolean | { color?: TapeColor; rotate?: number; top?: number };
  /** No-op in clay — see `withTape`. `Pin` is still exported. */
  withPin?: boolean;
  /** No-op in clay — see `withTape`. `HolePunch` is still exported. */
  withHoles?: boolean | HolePunchProps;
  /** No-op in clay: paper grain was a texture on a paper surface. Clay has none. */
  withGrain?: boolean;
  /**
   * No-op in clay. Seeded rotation was the scrapbook's postcard affordance; a
   * clay slab sits square to the page. Accepted so `tilted` / `tilted={-2}` /
   * `tilted={false}` call sites keep compiling.
   */
  tilted?: boolean | number;
  /**
   * No-op in clay. This tinted the hard offset shadow, which clay does not have:
   * the lip is the card's own side wall, derived from its fill by `clayVars`, so
   * a lip in an unrelated hue would read as a rendering fault rather than a
   * tint. Accepted for call-site compatibility.
   */
  shadowColor?: CardShadowColor;
  /** HeroUI compat — keep card contained, no shadow. Equivalent to `shadow='none'`. */
  isBlurred?: boolean;
  /** HeroUI compat — clickable card. Promotes the card to tier 1: it gets a real press. */
  isPressable?: boolean;
  /** Lip depth: none 0, sm 5, md 8 (default), lg 11. */
  shadow?: 'none' | 'sm' | 'md' | 'lg';
  /** HeroUI compat — hover lift. The card rises 2px and its lip grows to match. */
  isHoverable?: boolean;
  /** No-op in clay — see `tilted`. */
  rotate?: number;
  onPress?: (e: React.MouseEvent<HTMLElement>) => void;
  href?: string;
  /** Forwarded when `as='button'` — pass 'button' to avoid the implicit type="submit". */
  type?: 'button' | 'submit' | 'reset';
  isFooterBlurred?: boolean;
  fullWidth?: boolean;
  disableAnimation?: boolean;
  isFocusable?: boolean;
}

/**
 * The card surface. `--card-bg` rather than `--paper` — see the note at the top
 * of this file; this is the substantive half of the port, not a cosmetic one.
 */
const CARD_FILL = 'var(--card-bg)';

/**
 * True when there is already a Card above us. A card's rim is mixed from its own
 * FILL, but what it has to separate itself from is the GROUND behind it — and
 * `clayKindFor` cannot see the ground, so a nested card gets the same rim
 * against a lighter backdrop and the boundary degrades.
 *
 * React context rather than a `.clay-card .clay-card` CSS rule: nesting depth is
 * something this component actually knows, so there is no need to infer it from
 * specificity, and it keeps the change inside this directory.
 *
 * KNOWN LIMIT: it only sees CARD ancestors. A Card inside a Modal or Drawer is
 * still painting `--card-bg` on `--card-bg` (1.000:1), because those components
 * do not provide this context. Exported so they can — wrap their panel in
 * `<NestedInCard.Provider value={true}>` and any Card inside them steps up too.
 */
export const NestedInCard = React.createContext(false);

export const Card = React.forwardRef<HTMLElement, CardProps>(function Card(
  {
    children,
    className,
    as: Component = 'div',
    withTape: _withTape,
    withPin: _withPin,
    withHoles: _withHoles,
    withGrain: _withGrain,
    tilted: _tilted,
    shadowColor: _shadowColor,
    shadow = 'md',
    isBlurred,
    isPressable,
    isHoverable,
    rotate: _rotate,
    style,
    onPress,
    onClick,
    href,
    isFooterBlurred: _isFooterBlurred,
    fullWidth,
    disableAnimation,
    isFocusable: _isFocusable,
    ...rest
  },
  ref,
) {
  /*
   * A nested card steps up a rung so it is not painting its parent's exact
   * colour. Dark gains a 1.11:1 fill step where there was 1.000:1; light is a
   * no-op because `--surface-1` and `--surface-2` are the same value there —
   * the ladder documents four rungs and ships three.
   */
  const nested = React.useContext(NestedInCard);
  const fill = nested ? 'var(--surface-2)' : CARD_FILL;

  const flat = isBlurred || shadow === 'none';
  const { depth, press } = flat ? SHADOW.none : SHADOW[shadow];

  /*
   * `clayVars` has no "lift" — its `--clay-hover` is always a SHALLOWER lip,
   * because it was written for a key going down. A card that rises needs a
   * DEEPER one, so the hover state is a second `clayVars` call at depth + 2 and
   * its rest value becomes this card's hover value. Two calls into the same
   * helper, no hand-rolled box-shadow: the values still all come from one place.
   * Reported as a gap rather than worked around locally.
   */
  /*
   * `kind` is passed EXPLICITLY. `clayVars` defaults to `brand`, not `surface` —
   * omit the argument on a near-white fill and you silently get the saturated
   * profile. That is easy to miss because `brand` on a card looks fine, in fact
   * slightly better (rim 1.50:1 vs 1.23:1 light, lip 2.07:1 vs 1.53:1); the
   * numbers only give it away.
   *
   * `surface` it is, all the same: it is the documented profile for a large
   * panel, and in dark it keeps the fill's navy in the rim where `brand` greys
   * it out. `control` (edge 50%) is the only profile that clears 3:1 — 3.90:1
   * light / 5.24:1 dark — and it is wrong here: on a card this size it reads as
   * a focus ring, and in dark it comes out BRIGHTER than the `.clay-stage`
   * containing it, inverting the hierarchy.
   *
   * RESOLVED (owner decision), and the split is on what the rim MEANS rather
   * than on taste:
   *
   * - A PRESSABLE card is a control, so its boundary is what identifies the
   *   control — WCAG 1.4.11's 3:1 applies, and `control` is the only profile
   *   that reaches it (3.90:1 light / 5.24:1 dark). "Reads as a focus ring" is
   *   the right objection for a static panel and the wrong one for a thing you
   *   click: a clickable card SHOULD announce its own extent.
   * - A STATIC card is decorative grouping. Its boundary identifies nothing, no
   *   contrast floor applies, and `surface` keeps the softer rim that does not
   *   compete with the content inside it.
   *
   * The dark-mode half of the old objection — that `control` came out BRIGHTER
   * than the `.clay-stage` behind it — was measured when the page ground was
   * painted with `--paper` (the CARD's rung, `#141a3b`). The ground is now
   * `--surface-0` (`#0f1430`), so the rim no longer inverts the hierarchy.
   */
  const rimKind = isPressable ? 'control' : clayKindFor('default');
  const vars = clayVars(fill, { kind: rimKind, depth }) as Record<string, string>;
  const lifted = clayVars(fill, { kind: rimKind, depth: depth + 2 }) as Record<string, string>;

  const cardStyle: React.CSSProperties = {
    background: fill,
    ...vars,
    /*
     * Only the two classes that HAVE a hover rule need a hover value. The inert
     * default is `.clay-panel`, which has none, so it no longer needs the local
     * pin this file used to carry.
     */
    '--clay-hover': isPressable ? vars['--clay-hover'] : lifted['--clay-rest'],
    ...(style as React.CSSProperties),
  } as React.CSSProperties;

  const handleClick = (e: React.MouseEvent<HTMLElement>) => {
    onClick?.(e);
    if (isPressable) onPress?.(e);
  };

  return (
    <NestedInCard.Provider value={true}>
    <Component
      ref={ref}
      className={cn(
        'relative overflow-hidden rounded-[24px]',
        // Only transform and box-shadow animate. Animating the fill would make a
        // hover read as a colour change rather than a movement.
        'transition-[transform,box-shadow] duration-200 motion-reduce:transition-none',
        /*
         * The rim stays even at `shadow='none'`. `none` means no LIP, not "no
         * boundary": a card fill is 1.02:1 against the page in light and 1.10:1
         * in dark, so dropping the rim as well leaves a container with no edge
         * of any kind — the exact defect this port exists to fix.
         */
        'border-[3px] border-[color:var(--clay-edge)]',
        // A pressable card IS a button, so it takes tier 1 — the press ladder is
        // the truth about it, not a decoration. Everything else is tier 2.
        /*
         * Three classes, three affordances — chosen per instance, not inherited:
         *   `.clay-btn`     pressable card: it IS a button, so it takes tier 1
         *                   outright and gets the real press ladder.
         *   `.clay-surface` `isHoverable`: the caller has said this card
         *                   responds, and this class carries the hover state.
         *   `.clay-panel`   everything else: raised, and inert. A content div
         *                   that answers the cursor is quality bar #3's
         *                   affordance lie in its subtlest form.
         */
        !flat && (isPressable ? 'clay-btn' : isHoverable ? 'clay-surface' : 'clay-panel'),

        isPressable &&
          !disableAnimation &&
          cn('hover:translate-y-[2px]', press),
        // A hoverable-but-not-pressable card rises instead of depressing: it
        // responds, without claiming it can be pushed.
        !isPressable && isHoverable && !disableAnimation && 'hover:-translate-y-[2px]',
        !disableAnimation &&
          'motion-reduce:hover:translate-y-0',
        (isPressable || href) && 'cursor-pointer',
        (isPressable || href) &&
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        fullWidth && 'w-full',
        className,
      )}
      href={href}
      style={{ ...cardStyle, outlineColor: 'hsl(var(--heroui-foreground))' }}
      onClick={handleClick}
      {...rest}
    >
      {children}
    </Component>
    </NestedInCard.Provider>
  );
});

Card.displayName = 'Card';

/* ----------------------- Sub-components ----------------------- */

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardHeader(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={cn('flex flex-col gap-1 px-5 pt-5', className)} {...rest} />;
});

export const CardBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardBody(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={cn('flex flex-col gap-2 p-5', className)} {...rest} />;
});

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardFooter(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={cn('flex items-center gap-2 px-5 pb-5 pt-2', className)} {...rest} />;
});
