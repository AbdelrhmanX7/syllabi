import React from 'react';

import { cn } from '../../cn';
import { useValidation } from '../useValidation';
import { CLAY_FILL, clayVars } from '../clay';
import { HEROUI_COLOR_TEXT } from '../tokens';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';

/**
 * da-v2 Input — drop-in for HeroUI Input.
 *
 * Visual: a FLAT BORDERED field, Duolingo-style (owner decision, 2026-08-27).
 * The border is the entire structure — 2px at rest, a neutral that darkens when
 * you point at it, and on focus it takes the brand colour and thickens. The
 * background is flat: no inset, no groove, no lip, and nothing moves.
 *
 * This replaced a recessed tier-3 treatment. If you are wondering why a field
 * is not a hole when the rest of clay says it should be: it was, it was built
 * and measured, and the owner chose this instead. `.clay/input-textarea.md`
 * keeps those measurements rather than deleting them.
 *
 * THE BORDER AND THE FOCUS RING ARE ON SEPARATE PROPERTIES, deliberately. The
 * scrapbook put its ring on `box-shadow` and then had to restate the drop
 * shadow beside it, because `box-shadow` replaces rather than composes — the
 * comment in `styles/scrapbook.css` records the cost. Here `border-color`
 * carries the state and `outline` carries the extra thickness, so neither can
 * silently delete the other, and `box-shadow` is left unused. That also means
 * focus thickens the edge WITHOUT a layout shift: a 1px outline at offset 0
 * sits flush outside the 2px border and reads as a single 3px edge.
 */

export type InputVariant = 'flat' | 'bordered' | 'underlined' | 'faded';

// `sm` was 40px, under the 44px touch target PRODUCT.md asks for on mobile. A
// text field is its own hit area, so the fix is the height itself rather than
// the transparent `::before` band the small buttons use. Type runs a step
// larger than a dense admin input would: this field is meant to be roomy.
const SIZE: Record<HeroUISize, string> = {
  sm: 'h-11 text-[15px]',
  md: 'h-[52px] text-[16px]',
  lg: 'h-[60px] text-[17px]',
};

// Clay's radius ladder, written out — the JIT cannot see through a template literal.
const RADIUS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-[14px]',
  md: 'rounded-[18px]',
  lg: 'rounded-[20px]',
  full: 'rounded-full',
};

const FG = 'hsl(var(--heroui-foreground))';
const SURFACE = CLAY_FILL.default;
/** A helper line: mixed toward the surface it sits on rather than faded with opacity. */
const MUTED = `color-mix(in srgb, ${FG} 62%, ${SURFACE})`;

/**
 * With the field flat, the four variants are exactly a border/fill combination —
 * which is what makes `variant` worth honouring here rather than collapsing.
 * `bordered` is the plain outlined field; `flat` and `faded` fill it, one step
 * and two steps down the surface ladder; `underlined` has no box at all.
 */
const FACE: Record<InputVariant, string> = {
  bordered: SURFACE,
  flat: 'hsl(var(--heroui-content2))',
  faded: 'hsl(var(--heroui-content3))',
  underlined: 'transparent',
};

/**
 * The resting border, and the darker one it moves to on hover.
 *
 * Both come out of `clayVars`, but from DIFFERENT FILLS rather than different
 * profiles — `control` (50% toward the foreground) is already the darkest mix
 * the helper offers, so "darker than the resting border" cannot be asked for as
 * a profile. Running the same profile over a lower rung of the surface ladder
 * gets there without hand-mixing a colour.
 */
const edgeOf = (fill: string) => (clayVars(fill, { kind: 'control' }) as Record<string, string>)['--clay-edge'];
const HOVER_EDGE = edgeOf('hsl(var(--heroui-content4, var(--heroui-content3)))');

const ALERT_GLYPH = (
  <svg
    aria-hidden='true'
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

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'color'> {
  label?: React.ReactNode;
  description?: React.ReactNode;
  errorMessage?: React.ReactNode;
  isInvalid?: boolean;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  isRequired?: boolean;
  isClearable?: boolean;
  onClear?: () => void;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  color?: HeroUIColor;
  variant?: InputVariant;
  /**
   * Scrapbook seeded tilt. Accepted and IGNORED under clay — a clay object is
   * square to the page. Kept because call sites across six apps pass it, and
   * destructured so it never reaches the DOM as an unknown attribute.
   */
  rotate?: number;
  /** HeroUI compat — full-width by default; opt out to wrap. */
  fullWidth?: boolean;
  classNames?: {
    base?: string;
    mainWrapper?: string;
    inputWrapper?: string;
    input?: string;
    label?: string;
    helperWrapper?: string;
    description?: string;
    errorMessage?: string;
    innerWrapper?: string;
  };
  /** HeroUI compat: receives the new value. */
  onValueChange?: (value: string) => void;
  /** HeroUI compat — label position. We always render above for scrapbook. */
  labelPlacement?: 'inside' | 'outside' | 'outside-left';
  /** HeroUI compat — validation function. Returns string for error or null/undefined for valid. */
  validate?: (value: string) => string | null | undefined | true;
  /** HeroUI Form integration — name applied to the inner <input>. Already on HTMLInputAttributes. */
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    description,
    errorMessage,
    isInvalid,
    isDisabled,
    isReadOnly,
    isRequired,
    isClearable,
    onClear,
    startContent,
    endContent,
    size = 'md',
    radius = 'md',
    color = 'default',
    variant = 'bordered',
    rotate: _rotate,
    className,
    classNames,
    style,
    onChange,
    onValueChange,
    onBlur,
    fullWidth = true,
    id,
    type = 'text',
    labelPlacement: _labelPlacement,
    validate,
    ...rest
  },
  ref,
) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const setRefs = React.useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
    },
    [ref],
  );

  // Controlled inputs derive the clear button from `value`; uncontrolled ones have
  // no prop to read, so track emptiness locally (seeded from defaultValue).
  const isControlled = rest.value !== undefined;
  const [hasUncontrolledValue, setHasUncontrolledValue] = React.useState(
    () => String(rest.defaultValue ?? '').length > 0,
  );
  const hasValue = isControlled ? String(rest.value ?? '').length > 0 : hasUncontrolledValue;
  const showClear = Boolean(isClearable) && hasValue && !isDisabled && !isReadOnly;

  /*
   * `validate` used to be destructured here and never called — see
   * `useValidation`. `isInvalid`/`errorMessage` from props still WIN: a parent
   * that has decided a field is bad (a server rejection, a cross-field rule)
   * outranks a local rule that only knows about this one value.
   */
  const currentValue = isControlled ? String(rest.value ?? '') : undefined;
  const validation = useValidation<string>(validate, currentValue ?? '', inputRef);
  const effectiveInvalid = isInvalid || validation.isInvalid;
  const effectiveError = errorMessage ?? validation.shown;

  const reactId = React.useId();
  const inputId = id ?? reactId;
  const descId = description ? `${inputId}-desc` : undefined;
  const errId = effectiveError ? `${inputId}-err` : undefined;

  const isUnderlined = variant === 'underlined';
  const face = FACE[variant];

  /*
   * The state colour for the border. An invalid field goes danger; a focused one
   * goes brand. Neither is the whole signal on its own — see the glyph below —
   * because a differently-coloured border is exactly what "invalid" must not be
   * mistaken for.
   */
  /*
   * The focus/invalid border takes the brand as a MARK, not as a FILL.
   *
   * `CLAY_FILL.primary` is a fixed dark purple in both themes, so on a dark field
   * it measured 1.93-2.94:1 against the fill — a focus indicator you cannot see,
   * and below the 3:1 floor WCAG puts on one. The `*-text` tokens are the same
   * brand corrected to read AGAINST the theme (#2f5bea light, #c3d0fb dark), and
   * they are the only place in the system that answers this question. Same for
   * danger: #e11d48 light, #ff8494 dark.
   *
   * This is the fill-vs-mark distinction the Tabs port landed on, arriving again
   * — a hue that works as a surface does not automatically work as a stroke.
   */
  const focusEdge = effectiveInvalid ? HEROUI_COLOR_TEXT.danger : HEROUI_COLOR_TEXT.primary;

  const fieldStyle = {
    background: face,
    // `shapeFrom` lets an invalid or brand-coloured field colour its border
    // without staining the face; `clayVars` never touches `background`.
    ...clayVars(isUnderlined ? SURFACE : face, {
      shapeFrom: effectiveInvalid ? CLAY_FILL.danger : color === 'default' ? undefined : CLAY_FILL[color],
      /*
       * The profile follows the SHAPE's luminance, not the face's and not the
       * `color` prop. Off a near-white face the shape IS that face, so its border
       * is the boundary and needs `control` (50%) — the `brand` mix off a
       * near-white fill is the ~1.2:1 border this migration keeps rediscovering.
       * When `shapeFrom` is saturated, `control` over-darkens it: the invalid
       * border came out a near-black maroon instead of a red.
       *
       * `clayKindFor` cannot be asked this, because it selects a profile by
       * COLOUR NAME. Third independent instance of that conflation; see the
       * report. Selecting directly, with this note, is the honest workaround.
       */
      kind: effectiveInvalid || color !== 'default' ? 'brand' : 'control',
      // Shallower than a button's 6: a field should read as made of the same
      // material without competing with the controls it sits beside in a form.
      depth: 4,
    }),
    '--clay-edge-hover': HOVER_EDGE,
    '--clay-focus': focusEdge,
  } as React.CSSProperties;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isControlled) setHasUncontrolledValue(e.target.value.length > 0);
    validation.run(e.target.value);
    onChange?.(e);
    onValueChange?.(e.target.value);
  };

  // Blur is what makes a failing rule VISIBLE. It also re-runs, so a field the
  // user cleared and left empty reports on the way out.
  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    validation.markTouched();
    validation.run(e.target.value);
    onBlur?.(e);
  };

  /**
   * HeroUI parity: the clear button OWNS the clearing. It writes '' through the
   * native value setter and dispatches a real input event, so React's onChange
   * fires normally — controlled parents get onValueChange(''), uncontrolled ones
   * get the DOM reset. `onClear` stays an optional extra notification, never the
   * mechanism (wiring it as the mechanism left every consumer that omitted it
   * with a dead button).
   */
  const handleClear = () => {
    const node = inputRef.current;

    if (node) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

      setter?.call(node, '');
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.focus();
    }

    onClear?.();
  };

  return (
    <div className={cn('flex flex-col gap-1.5', fullWidth && 'w-full', className, classNames?.base)}>
      {label ? (
        <label
          className={cn(
            'text-[13px] font-bold',
            isRequired && "after:ms-1 after:text-[color:var(--clay-danger)] after:content-['*']",
            classNames?.label,
          )}
          htmlFor={inputId}
          style={{ color: FG, '--clay-danger': HEROUI_COLOR_TEXT.danger } as React.CSSProperties}
        >
          {label}
        </label>
      ) : null}
      <div className={cn('relative', classNames?.mainWrapper)}>
        <div
          className={cn(
            'relative flex items-center gap-2 px-5',
            // Only the border colour animates. Nothing translates and nothing
            // lifts: a field is not pressed, so it takes the lip WITHOUT the
            // press ladder — `.clay-panel`, the static raised surface.
            'transition-[border-color,outline-color] duration-150 motion-reduce:transition-none',
            // The lip. Without it the field was a 2px outline and no depth at
            // all, which read as an empty box beside the clay buttons it shares
            // a form with — the whole point of the migration is that everything
            // is made of the same material.
            !isUnderlined && 'clay-panel border-[2px] border-[color:var(--clay-edge)]',
            // The neutral darkens when you point at it.
            !isDisabled && !isUnderlined && 'hover:border-[color:var(--clay-edge-hover)]',
            isDisabled && 'cursor-not-allowed opacity-50',
            /*
             * Focus: the border takes the brand colour AND thickens.
             *
             * The thickening is a 1px `outline` at offset 0, which sits flush
             * outside the 2px border and reads as one 3px edge — so the edge
             * grows without a layout shift, and without `box-shadow` being
             * involved at all. Two separate properties, so neither can silently
             * replace the other the way the scrapbook's ring deleted its drop
             * shadow.
             */
            'focus-within:outline-none',
            !isUnderlined && 'has-[:focus-visible]:border-[color:var(--clay-focus)]',
            'has-[:focus-visible]:outline has-[:focus-visible]:outline-[1px] has-[:focus-visible]:outline-offset-0',
            'has-[:focus-visible]:outline-[color:var(--clay-focus)]',
            SIZE[size],
            isUnderlined ? 'rounded-none' : RADIUS[radius],
            classNames?.inputWrapper,
          )}
          style={fieldStyle}
        >
          {startContent}
          <input
            ref={setRefs}
            aria-describedby={cn(descId, errId)}
            aria-invalid={effectiveInvalid || undefined}
            className={cn(
              // min-w-0: without it the input can't shrink below its intrinsic width and
              // overflows the bordered wrapper, pushing start/end content outside the box.
              // Placeholders use the body face, not `font-hand` (Caveat is not
              // loaded by default — see tailwind.preset.js).
              'w-full min-w-0 flex-1 bg-transparent font-bold outline-none placeholder:font-semibold placeholder:text-[color:var(--clay-muted)]',
              size === 'lg'
                ? 'placeholder:text-[20px]'
                : size === 'sm'
                  ? 'placeholder:text-[16px]'
                  : 'placeholder:text-[18px]',
              classNames?.input,
            )}
            disabled={isDisabled}
            id={inputId}
            style={{ color: FG, '--clay-muted': MUTED } as React.CSSProperties}
            onBlur={handleBlur}
            onChange={handleChange}
            readOnly={isReadOnly}
            required={isRequired}
            type={type}
            {...rest}
          />
          {showClear ? (
            <button
              aria-label='Clear'
              className='text-ink/60 hover:text-ink inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full'
              onClick={handleClear}
              tabIndex={-1}
              type='button'
            >
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
            </button>
          ) : null}
          {/*
           * The error's second channel. `isInvalid` also tints the rim and the
           * groove, but a colour alone means an error state is indistinguishable
           * from a differently-coloured field — and it is the channel that fails
           * for a colourblind reader. The glyph says WHICH state this is; the
           * colour only says how loudly. It replaces the hand-drawn squiggle,
           * which was decoration and carried no information at all.
           */}
          {effectiveInvalid ? (
            <span
              aria-hidden='true'
              className='inline-flex shrink-0 items-center justify-center'
              style={{ color: HEROUI_COLOR_TEXT.danger }}
            >
              {ALERT_GLYPH}
            </span>
          ) : null}
          {endContent}
          {/*
           * `underlined`'s entire box. A positioned bar rather than a
           * `border-bottom`, for the reason the old code failed: it set the
           * border COLOUR to `transparent` and supplied only a width, so the one
           * variant defined by having a line rendered no line at all. A bar owns
           * its own colour, and can carry a radius.
           */}
          {isUnderlined ? (
            <span
              aria-hidden='true'
              className='pointer-events-none absolute inset-x-0 bottom-0 h-[3px] rounded-full transition-colors duration-200'
              style={{ background: effectiveInvalid ? HEROUI_COLOR_TEXT.danger : 'var(--clay-edge)' }}
            />
          ) : null}
        </div>
      </div>
      {description || effectiveError ? (
        <div className={cn('flex flex-col gap-0.5', classNames?.helperWrapper)}>
          {effectiveError ? (
            <span
              className={cn('text-[13px] font-bold', classNames?.errorMessage)}
              style={{ color: HEROUI_COLOR_TEXT.danger }}
              id={errId}
            >
              {effectiveError}
            </span>
          ) : description ? (
            <span
              className={cn('text-[13px] font-medium', classNames?.description)}
              style={{ color: MUTED }}
              id={descId}
            >
              {description}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

Input.displayName = 'Input';
