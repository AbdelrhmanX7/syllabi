import React from 'react';

import { cn } from '../../cn';
import { CLAY_FILL, CLAY_LABEL, clayKindFor, clayVars } from '../clay';
import type { HeroUIColor, HeroUIRadius } from '../tokens';

/**
 * da-v2 Alert — drop-in replacement for HeroUI's Alert.
 *
 *   <Alert color='warning' title='Heads up' description='...' isClosable />
 *
 * Visual language: CLAY, tier 2 — a raised surface. Edge and lip, no press: an
 * alert is something you read, not something you push, so it has the shape of a
 * physical card and none of a key's behaviour.
 *
 * WHERE SEVERITY LIVES, AND WHY IT MOVED. An alert's only job is to say which
 * state you are in, so it is worth being explicit about the channels:
 *
 *   glyph        per-severity already (check / warn / cross / info). The one
 *                channel that survives colourblindness. Unchanged.
 *   body hue     the wash, rim and lip, all derived from one fill by `clayVars`.
 *   ICON CHIP    NEW. It used to be `var(--citrine)` on every severity — the
 *                same yellow behind a success tick, a danger cross and an info
 *                'i' — which carried no information at all, and on the warning
 *                alert put a yellow chip on a yellow body.
 *
 * The chip is now the severity fill at full strength. That matters because the
 * thing it replaces is the washi tape: a 40px strip at the top edge that encoded
 * severity weakly, sat outside the reader's fovea, and dies with the scrapbook.
 * A saturated chip beside the title is the same information in the place the eye
 * is already looking, and it doubles the glyph channel with a hue channel at the
 * same coordinates rather than in a different corner of the component.
 */

export type AlertVariant = 'solid' | 'flat' | 'bordered' | 'faded';

export interface AlertClassNames {
  base?: string;
  mainWrapper?: string;
  iconWrapper?: string;
  alertIcon?: string;
  title?: string;
  description?: string;
  closeButton?: string;
}

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'color'> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  hideIcon?: boolean;
  hideIconWrapper?: boolean;
  isVisible?: boolean;
  isClosable?: boolean;
  closeIcon?: React.ReactNode;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  color?: HeroUIColor;
  variant?: AlertVariant;
  radius?: HeroUIRadius;
  classNames?: AlertClassNames;
  className?: string;
  /**
   * Scrapbook seeded tilt. Accepted and IGNORED under clay — a clay object is
   * square to the page; rotation was the paper-on-a-desk metaphor. Kept in the
   * API because call sites across six apps pass it, and destructured in the
   * implementation so it never reaches the DOM as an unknown attribute.
   */
  rotate?: number;
  onClose?: () => void;
  onVisibleChange?: (visible: boolean) => void;
  children?: React.ReactNode;
}

// Clay's radius ladder (CLAY_RADIUS = 14/18/20/24), written out rather than
// interpolated — Tailwind's JIT scans source TEXT and cannot see through a
// template literal, so an interpolated arbitrary `rounded-` value generates no class.
const RADIUS_CLASS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-md',
  md: 'rounded-lg',
  lg: 'rounded-lg',
  full: 'rounded-lg',
};

/**
 * An alert is a large panel, so its lip runs at 8 rather than a control's 6 —
 * DESIGN.md's shadow vocabulary puts larger surfaces one step deeper.
 */
const ALERT_DEPTH = 8;

const FG = 'hsl(var(--heroui-foreground))';
const SURFACE = CLAY_FILL.default;

/**
 * The chip's rim runs on the `control` mix (50% toward the foreground) rather
 * than the `brand` mix (82%), whatever colour fills it.
 *
 * `clayKindFor` selects that profile by asking "is this colour `default`?", but
 * the property the profile actually encodes is "this is a SMALL object whose rim
 * is its boundary" — and a 32px chip is that regardless of hue. At the brand mix
 * the rim of a green chip on a pale-green wash measured 2.90:1 and an amber chip
 * on a pale-amber wash 2.77:1, both under the 3:1 floor for a graphic that
 * carries meaning. Reported as a `clay.ts` gap: the profile cannot currently be
 * asked for by name.
 */
const CHIP_KIND = clayKindFor('default', true);

/**
 * The body wash per variant. A tint OF THIS SURFACE rather than a value from a
 * soft-fill map, so it is guaranteed to sit in the surface's family in both
 * themes and cannot invert: 16% purple into white is a pale lavender, 16%
 * purple into the dark surface is a tinted navy.
 *
 * `default` has no hue to mix — mixing the surface into itself is a no-op that
 * would leave the alert invisible on the page — so it steps down the surface
 * ladder instead.
 */
const washFor = (color: HeroUIColor, pct: number, defaultStep: string) =>
  color === 'default' ? defaultStep : `color-mix(in srgb, ${CLAY_FILL[color]} ${pct}%, ${SURFACE})`;

const DEFAULT_ICON = (color: HeroUIColor) => {
  if (color === 'success') {
    return (
      <svg
        fill='none'
        height='16'
        stroke='currentColor'
        strokeLinecap='round'
        strokeLinejoin='round'
        strokeWidth={2.4}
        viewBox='0 0 24 24'
        width='16'
      >
        <path d='M22 11.08V12a10 10 0 1 1-5.93-9.14' />
        <path d='m9 11 3 3L22 4' />
      </svg>
    );
  }
  if (color === 'warning') {
    return (
      <svg
        fill='none'
        height='16'
        stroke='currentColor'
        strokeLinecap='round'
        strokeLinejoin='round'
        strokeWidth={2.4}
        viewBox='0 0 24 24'
        width='16'
      >
        <path d='m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z' />
        <path d='M12 9v4' />
        <path d='M12 17h.01' />
      </svg>
    );
  }
  if (color === 'danger') {
    return (
      <svg
        fill='none'
        height='16'
        stroke='currentColor'
        strokeLinecap='round'
        strokeLinejoin='round'
        strokeWidth={2.4}
        viewBox='0 0 24 24'
        width='16'
      >
        <circle cx='12' cy='12' r='10' />
        <line x1='15' x2='9' y1='9' y2='15' />
        <line x1='9' x2='15' y1='9' y2='15' />
      </svg>
    );
  }
  // default / primary / secondary — info icon
  return (
    <svg
      fill='none'
      height='16'
      stroke='currentColor'
      strokeLinecap='round'
      strokeLinejoin='round'
      strokeWidth={2.4}
      viewBox='0 0 24 24'
      width='16'
    >
      <circle cx='12' cy='12' r='10' />
      <path d='M12 16v-4' />
      <path d='M12 8h.01' />
    </svg>
  );
};

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(function Alert(
  {
    title,
    description,
    icon,
    hideIcon,
    hideIconWrapper,
    isVisible: isVisibleProp,
    isClosable,
    closeIcon,
    startContent,
    endContent,
    color = 'default',
    variant = 'flat',
    radius = 'md',
    classNames,
    className,
    rotate: _rotate,
    onClose,
    onVisibleChange,
    children,
    style,
    ...rest
  },
  ref,
) {
  const [internalVisible, setInternalVisible] = React.useState(true);
  const isControlled = isVisibleProp !== undefined;
  const visible = isControlled ? Boolean(isVisibleProp) : internalVisible;

  if (!visible) return null;

  /*
   * The body, per variant. Only `solid` paints the brand at full strength; the
   * other three are surfaces, and the colour reaches them through the wash and
   * the rim.
   *
   * `solid`'s label is `CLAY_LABEL[color]` — the theme's own answer for a label
   * on that fill. This replaces a hardcoded `'#ffffff'` that the old code had to
   * special-case for `default`, because `default`'s fill used to be SHADOW_C (a
   * near-black chip). Clay's `default` is the theme surface, so the special case
   * and the literal both go: rule 4 of the migration is that a hardcoded
   * foreground is the most common defect in this codebase's history.
   */
  const isSolid = variant === 'solid';
  const isBordered = variant === 'bordered';

  const body = isSolid
    ? CLAY_FILL[color]
    : isBordered
      ? SURFACE
      : washFor(color, variant === 'faded' ? 8 : 16, 'hsl(var(--heroui-content2))');

  const label = isSolid ? CLAY_LABEL[color] : FG;

  /*
   * The severity chip. Full-strength brand behind the glyph — see the header for
   * why this is where severity moved.
   *
   * On `solid` the body is ALREADY the brand at full strength, so a brand chip
   * would vanish into it. It inverts instead: the chip takes the label colour
   * and the glyph takes the fill. That pairing is the same two colours as the
   * body, so its contrast is identical by construction — it cannot be worse than
   * the alert's own title.
   */
  const chipBg = isSolid ? CLAY_LABEL[color] : CLAY_FILL[color];
  const chipFg = isSolid ? CLAY_FILL[color] : CLAY_LABEL[color];

  const handleClose = () => {
    if (!isControlled) setInternalVisible(false);
    onClose?.();
    onVisibleChange?.(false);
  };

  return (
    <div
      ref={ref}
      role='alert'
      className={cn(
        'relative flex items-start gap-3 px-5 py-4',
        // Clay's 3px edge, in a mid-tone OF THE FILL.
        'border-[3px] border-[color:var(--clay-edge)]',
        // Tier 2: raised, no press. The lip is real CSS in styles/scrapbook.css
        // — a Tailwind `shadow-[var(--clay-rest)]` computes to `none` here.
        'clay-surface',
        RADIUS_CLASS[radius],
        className,
        classNames?.base,
      )}
      style={
        {
          background: body,
          color: label,
          /*
         * The face is whatever the variant paints; the SHAPE is always the brand
         * at full strength. That is one rule for all four variants rather than a
         * special case for `bordered`, and it is what `shapeFrom` is for: a rim
         * derived from an 8-16% wash is a paler wash, which measured 1.69-2.42:1
         * against the page — no boundary at all. `clayVars` never touches
         * `background`, so the face is unaffected.
         */
        ...clayVars(body, { shapeFrom: CLAY_FILL[color], kind: clayKindFor(color, true), depth: ALERT_DEPTH }),
          // `.clay-surface` swaps to `--clay-hover` on hover. An alert is not
          // pressable and nothing happens when you point at it, so a shadow that
          // answers the pointer is an affordance that lies. Both states are the
          // resting lip. (Reported: tier 2 arguably should not define a hover at
          // all — a card that reacts to hover is claiming to be a control.)
          '--clay-hover': 'var(--clay-rest)',
          ...(style as React.CSSProperties),
        } as React.CSSProperties
      }
      {...rest}
    >
      {startContent}

      {!hideIcon ? (
        <span
          aria-hidden
          className={cn(
            'inline-flex shrink-0 items-center justify-center',
            // A rim, but NO lip: the chip is inert, and a lip says "push me".
            !hideIconWrapper && 'mt-0.5 h-8 w-8 rounded-md border-[2px] border-[color:var(--clay-edge)]',
            classNames?.iconWrapper,
          )}
          style={
            !hideIconWrapper
              ? {
                  background: chipBg,
                  color: chipFg,
                  // Scoped `--clay-edge` for the chip's own rim. Setting the
                  // whole var set here shadows the alert's for this subtree,
                  // which is what we want — the rim should be a mid-tone of the
                  // CHIP, not of the body behind it. The lip vars come along
                  // unused, because no `.clay-*` class is applied.
                  ...clayVars(chipBg, { kind: CHIP_KIND }),
                }
              : // No wrapper: the glyph sits directly on the body, so it takes
                // the body's own label colour.
                { color: label }
          }
        >
          <span className={classNames?.alertIcon}>{icon ?? DEFAULT_ICON(color)}</span>
        </span>
      ) : null}

      <div className={cn('min-w-0 flex-1', classNames?.mainWrapper)}>
        {title ? <p className={cn('text-[14px] font-extrabold leading-tight', classNames?.title)}>{title}</p> : null}
        {description ? (
          <p className={cn('text-[13px] font-medium leading-snug', title && 'mt-1', classNames?.description)}>
            {description}
          </p>
        ) : null}
        {children}
      </div>

      {endContent}

      {isClosable ? (
        <button
          aria-label='Close'
          className={cn(
            // The one genuinely pressable thing in an alert, so it is the one
            // thing that gets tier 1: a small clay key with a real press. Depth
            // 4 with a 3px travel, so its bottom edge stays put and only the lip
            // closes — the same invariant as every other clay control.
            'clay-btn relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
            'border-[2px] border-[color:var(--clay-edge)]',
            'transition-[transform,box-shadow] duration-200',
            'cursor-pointer hover:translate-y-[2px] active:translate-y-[3px]',
            'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[2px]',
            'focus-visible:outline-[color:var(--clay-focus)]',
            'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
            // 44px touch target without inflating the drawn key (PRODUCT.md).
            "before:absolute before:inset-x-0 before:top-1/2 before:h-[44px] before:-translate-y-1/2 before:content-['']",
            classNames?.closeButton,
          )}
          onClick={handleClose}
          style={
            {
              background: SURFACE,
              color: FG,
              '--clay-focus': FG,
              ...clayVars(SURFACE, { kind: clayKindFor('default', true), depth: 4 }),
            } as React.CSSProperties
          }
          type='button'
        >
          {closeIcon ?? (
            <svg
              fill='none'
              height='12'
              stroke='currentColor'
              strokeLinecap='round'
              strokeWidth={2.4}
              viewBox='0 0 24 24'
              width='12'
            >
              <path d='M18 6 6 18M6 6l12 12' />
            </svg>
          )}
        </button>
      ) : null}
    </div>
  );
});

Alert.displayName = 'Alert';
