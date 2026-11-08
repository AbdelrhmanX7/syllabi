import React from 'react';

import { cn } from '../../cn';
import { CheckboxGroupContext } from '../CheckboxGroup/CheckboxGroup';
import type { ClayColor } from '../clay';
import { CLAY_FILL, CLAY_LABEL, clayKindFor, clayVars } from '../clay';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';

/**
 * Checkbox — clay.
 *
 * The state change is PHYSICAL, not chromatic:
 *   unchecked -> a recessed hole  (`clayVars(fill, { inset: true })` + `.clay-field`)
 *   checked   -> a slab that has popped up (`clayVars(fill)` + `.clay-btn`)
 * So the control still reads at a glance in greyscale, and a colour-blind user
 * gets the same signal a sighted-in-colour one does. The tick is the third
 * signal on top of those two.
 *
 * Sibling contract: RadioGroup's `<Radio>` is this component in a circle. Box
 * dimensions, lip depth, press ladder, border width and mark colour are
 * deliberately IDENTICAL there — a checkbox and a radio on the same form are
 * the same object in two shapes, and any divergence here has to be mirrored.
 */

// Written out, not interpolated: Tailwind's JIT scans source text and cannot
// see through an interpolated arbitrary `h-` value. Boxes are one step chunkier than the scrapbook's
// 16/20/24 because a 3px clay edge eats 6px of a 16px box and leaves no room
// for a tick.
const SIZE: Record<HeroUISize, { box: string; label: string }> = {
  sm: { box: 'h-5 w-5', label: 'text-[13px]' },
  md: { box: 'h-6 w-6', label: 'text-[14px]' },
  lg: { box: 'h-7 w-7', label: 'text-[15px]' },
};

// Clay's radius ladder scaled to a control this small — CLAY_RADIUS.sm (14) on
// a 24px box is a circle, which is the radio's job, not this one's.
const RADIUS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-[7px]',
  md: 'rounded-[9px]',
  lg: 'rounded-[11px]',
  full: 'rounded-full',
};

/**
 * Lip depth. One value for every size, so the press ladder below is one ladder:
 * the box travels exactly as far as the lip closes (rest 4 -> hover 2 -> active
 * 1, travel 0 -> 2 -> 3), which keeps the slab's bottom edge pinned while only
 * the lip shuts. Different depths per size would need three ladders and three
 * chances to get that cancellation wrong.
 */
const LIP = 4;

/**
 * How deep the HOLE goes. Larger than the lip on purpose: an inset shadow only
 * ever paints INSIDE a 24px box, so it has a fraction of the room the outer lip
 * has, and at depth 4 the recess is barely legible on a white card.
 */
const HOLE = 6;


/**
 * `mb-[4px]` is not spacing — it reserves the lip. Without it the label text
 * centres against the border-box and the box reads 2px high, and the row would
 * shift by 4px between the recessed and raised states.
 */
const LIP_RESERVE = 'mb-[4px]';

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'onChange' | 'color' | 'value'> {
  isSelected?: boolean;
  defaultSelected?: boolean;
  isIndeterminate?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onValueChange?: (selected: boolean) => void;
  color?: HeroUIColor;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  isRequired?: boolean;
  isInvalid?: boolean;
  lineThrough?: boolean;
  /**
   * Scrapbook-era seeded tilt. Accepted and ignored: clay has no rotation, and
   * the transform slot now carries the press. Kept so the six apps' call sites
   * do not have to change.
   */
  rotate?: number;
  classNames?: { base?: string; wrapper?: string; icon?: string; label?: string };
  children?: React.ReactNode;
  /** When inside a CheckboxGroup, identifies this option's value. */
  value?: string;
}

const CheckIcon = (props: React.SVGAttributes<SVGSVGElement>) => (
  <svg
    fill='none'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={3}
    viewBox='0 0 24 24'
    {...props}
  >
    <path d='M4 12 10 18 20 6' />
  </svg>
);

const DashIcon = (props: React.SVGAttributes<SVGSVGElement>) => (
  <svg fill='none' stroke='currentColor' strokeLinecap='round' strokeWidth={3} viewBox='0 0 24 24' {...props}>
    <path d='M5 12h14' />
  </svg>
);

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    isSelected,
    defaultSelected,
    isIndeterminate,
    onChange,
    onValueChange,
    color = 'primary',
    size = 'md',
    radius = 'sm',
    isDisabled,
    isReadOnly,
    isRequired,
    isInvalid,
    lineThrough,
    rotate: _rotate,
    children,
    classNames,
    className,
    value,
    ...rest
  },
  ref,
) {
  const group = React.useContext(CheckboxGroupContext);
  const inGroup = group !== null && value !== undefined;

  const isControlled = isSelected !== undefined;
  const [internal, setInternal] = React.useState(Boolean(defaultSelected));
  const checked = inGroup ? group!.value.has(String(value)) : isControlled ? Boolean(isSelected) : internal;

  // Group-derived state takes precedence (color/size/disabled).
  const effectiveColor = group?.color ?? color;
  const effectiveSize = group?.size ?? size;
  const effectiveDisabled = group?.isDisabled || isDisabled;
  const effectiveReadOnly = group?.isReadOnly || isReadOnly;
  const effectiveInvalid = group?.isInvalid || isInvalid;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (effectiveReadOnly || effectiveDisabled) return;
    if (inGroup) {
      group!.toggle(String(value));
      onChange?.(e);
      onValueChange?.(e.target.checked);

      return;
    }
    if (!isControlled) setInternal(e.target.checked);
    onChange?.(e);
    onValueChange?.(e.target.checked);
  };

  // Indeterminate is an ON state, not a third thing floating between the two:
  // "some of my children are selected" is a filled box in every checkbox
  // convention, and it carries its own glyph. Drawing it as a hole with a dash
  // in it reads as an empty box someone scribbled on.
  const isOn = checked || Boolean(isIndeterminate);

  /*
   * Invalid OVERRIDES the colour once the box is filled. Re-edging alone works
   * while the box is a hole — the danger rim reads 6.48:1 against the white
   * interior — but the moment it is checked the fill becomes the box, and a
   * danger rim on a primary fill measured 1.10:1. That is not a weak signal, it
   * is no signal: a checked invalid box was pixel-identical to an ordinary
   * checked one. A state that disappears in one of its two states is not a
   * state.
   */
  const clayColor = (effectiveInvalid ? 'danger' : effectiveColor) as ClayColor;
  const fill = isOn ? CLAY_FILL[clayColor] : CLAY_FILL.default;
  // `small` picks clay's `control` profile for the near-white fills, whose rim
  // has to be the boundary here — there is no label inside the box doing the
  // identifying the way a button's does. Without it the unchecked rim mixes at
  // 90% fill and measures 1.23:1 against a white card.
  const kind = clayKindFor(isOn ? clayColor : 'default', true);

  // The UNCHECKED invalid box keeps its hole and only takes a danger rim — there
  // is no fill to carry the state, so the rim has to. The mid-tone comes back
  // out of the same helper rather than being mixed by hand here — one lip
  // recipe, not two.
  const dangerEdge = clayVars(CLAY_FILL.danger, { kind: 'brand' }) as Record<string, string>;

  // The mark sits ON the fill, so it is read out of the fill's own paired
  // foreground. Hardcoding `text-white` here is what put a 2.03:1 tick on a
  // light brand fill; CLAY_LABEL is the map that already answers this per theme.
  const markColor = CLAY_LABEL[clayColor];

  const style = {
    background: fill,
    color: markColor,
    // The focus ring is the control's OWN colour, not the edge mid-tone: an
    // unchecked default box edges in grey, and a grey ring on a grey rim is not
    // a focus indicator.
    '--clay-ring': CLAY_FILL[clayColor],
    ...clayVars(fill, { kind, depth: isOn ? LIP : HOLE, inset: !isOn }),
    ...(effectiveInvalid ? { '--clay-edge': dangerEdge['--clay-edge'] } : null),
  } as React.CSSProperties;

  const interactive = !effectiveDisabled && !effectiveReadOnly;

  return (
    <label
      className={cn(
        'group inline-flex items-center gap-2.5',
        // 44px minimum touch target on mobile (PRODUCT.md). The label is the
        // hit area, and a 24px box plus a line of 14px text is ~28px tall — so
        // the row is grown on small screens only, where a finger is the pointer.
        // A bare control (no label text) also needs the width.
        'max-sm:min-h-[44px]',
        !children && 'max-sm:min-w-[44px]',
        effectiveDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
        classNames?.base,
      )}
    >
      <input
        ref={ref}
        checked={checked}
        className='sr-only'
        disabled={effectiveDisabled}
        name={group?.name}
        onChange={handleChange}
        readOnly={effectiveReadOnly}
        required={isRequired}
        type='checkbox'
        value={value}
        {...rest}
      />
      <span
        aria-hidden
        className={cn(
          'relative inline-flex shrink-0 items-center justify-center',
          'border-[3px] border-[color:var(--clay-edge)]',
          LIP_RESERVE,
          // Only transform and box-shadow animate. The fill flips instantly:
          // fading it would turn a press into a colour cross-dissolve.
          'transition-[transform,box-shadow] duration-200 motion-reduce:transition-none',
          // A raised slab depresses; a hole does not rise, so the recessed state
          // gets no travel — `.clay-field` deepens its inset instead.
          isOn ? 'clay-btn' : 'clay-field',
          // `.clay-btn:hover` keys off the BOX, but what the user hovers and
          // presses is the whole label — clicking the text would have travelled
          // the box 3px down while its lip stayed 4px open, which reads as the
          // slab sliding rather than depressing. The group variants restate the
          // same two vars from the label's state so travel and lip stay in sync.
          // (These are arbitrary PROPERTIES, `[box-shadow:…]`, not the
          // arbitrary `shadow-` utility — that one computes to `none` with a var.)
          interactive && 'group-hover:[box-shadow:var(--clay-hover)] group-active:[box-shadow:var(--clay-active)]',
          interactive && isOn && 'group-hover:translate-y-[2px] group-active:translate-y-[3px] group-active:scale-[0.97]',
          interactive && isOn && 'motion-reduce:group-hover:translate-y-0',
          // The control the user actually focuses is the sr-only input, so the
          // ring has to be forwarded here. Previously there was none at all —
          // a keyboard user could not see where they were.
          'group-has-[:focus-visible]:outline group-has-[:focus-visible]:outline-2',
          'group-has-[:focus-visible]:outline-offset-2 group-has-[:focus-visible]:outline-[color:var(--clay-ring)]',
          RADIUS[radius],
          SIZE[effectiveSize].box,
          classNames?.wrapper,
        )}
        style={style}
      >
        {isIndeterminate ? (
          <DashIcon className={cn('h-3/4 w-3/4', classNames?.icon)} />
        ) : checked ? (
          <CheckIcon className={cn('h-3/4 w-3/4', classNames?.icon)} />
        ) : null}
      </span>
      {children ? (
        <span
          className={cn(
            'text-ink font-bold transition-colors',
            SIZE[effectiveSize].label,
            lineThrough && checked && 'line-through opacity-50',
            classNames?.label,
          )}
        >
          {children}
        </span>
      ) : null}
    </label>
  );
});

Checkbox.displayName = 'Checkbox';
