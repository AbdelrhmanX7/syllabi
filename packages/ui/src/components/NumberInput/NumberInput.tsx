import React from 'react';

import { cn } from '../../cn';
import { CLAY_FILL, clayVars } from '../clay';
import { HEROUI_COLOR_TEXT } from '../tokens';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';

/**
 * da-v2 NumberInput — drop-in for HeroUI's <NumberInput>.
 *
 * Mirrored API:
 *   <NumberInput value defaultValue onValueChange onChange
 *                minValue maxValue step formatOptions
 *                hideStepper isWheelDisabled isReadOnly isInvalid isRequired
 *                errorMessage description label labelPlacement
 *                size radius variant placeholder startContent endContent classNames>
 *
 * Internal value is always a `number | null` (null = empty input). Display
 * formatting goes through `Intl.NumberFormat(formatOptions)` when provided —
 * but only when the field is NOT focused, so users can freely type.
 *
 * Stepper: stacked +/− buttons rendered as `endContent`. Long-press repeats
 * (200ms initial delay → 50ms interval). Wheel scroll steps when focused.
 * Keyboard: ↑/↓ steps; Home/End jump to min/max.
 *
 * The stepper renders as `endContent`, at the end of the field.
 *
 * VISUAL: this is `Input` with a stepper bolted on, and it has to be
 * INDISTINGUISHABLE from one sitting beside it in a form — so the field chrome
 * here is copied from `Input.tsx` rather than re-derived, down to the token
 * names. If you change one, change both.
 *
 *   field    flat, 2px border doing all the structural work, a neutral that
 *            darkens on hover, focus recolouring the border to the brand MARK
 *            and thickening it with a 1px outline (no layout shift, and
 *            `box-shadow` stays out of it).
 *   stepper  NOT the field's treatment. The two buttons are genuinely
 *            pressable, so they are tier 1: `.clay-btn`, a real lip, and a
 *            press that closes it. A control that does something should not
 *            inherit the chrome of the container it sits in.
 */

export type NumberInputVariant = 'flat' | 'bordered' | 'underlined' | 'faded';

// Copied from Input.tsx — the two must match. `sm` is 44px for the touch target.
const SIZE: Record<HeroUISize, string> = {
  sm: 'h-11 text-[15px]',
  md: 'h-[52px] text-[16px]',
  lg: 'h-[60px] text-[17px]',
};

// Clay's radius ladder, written out — the JIT cannot see through a template literal.
const RADIUS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-md',
  md: 'rounded-lg',
  lg: 'rounded-lg',
  full: 'rounded-full',
};

/**
 * Stepper key size per field size. Written out rather than `h-1/2`, because a
 * clay key needs room for its lip BELOW it: two keys plus a 3px gap plus two
 * 3px lips has to fit inside the field's height, and a percentage cannot know
 * that. Totals are 35 / 43 / 51 inside 44 / 52 / 60.
 */
const STEPPER_SIZE: Record<HeroUISize, string> = {
  sm: 'h-[16px] w-6',
  md: 'h-[20px] w-7',
  lg: 'h-[24px] w-7',
};

const FG = 'hsl(var(--heroui-foreground))';
const SURFACE = CLAY_FILL.default;
const MUTED = `color-mix(in srgb, ${FG} 62%, ${SURFACE})`;

const FACE: Record<NumberInputVariant, string> = {
  bordered: SURFACE,
  flat: 'hsl(var(--heroui-content2))',
  faded: 'hsl(var(--heroui-content3))',
  underlined: 'transparent',
};

/** See Input.tsx: a darker border comes from a lower rung, not a darker profile. */
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

export interface NumberInputProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'size' | 'color' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max' | 'step' | 'type'
  > {
  value?: number | null;
  defaultValue?: number | null;
  onValueChange?: (value: number) => void;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  minValue?: number;
  maxValue?: number;
  step?: number;
  formatOptions?: Intl.NumberFormatOptions;
  hideStepper?: boolean;
  isWheelDisabled?: boolean;
  isReadOnly?: boolean;
  isInvalid?: boolean;
  isDisabled?: boolean;
  isRequired?: boolean;
  isClearable?: boolean;
  onClear?: () => void;
  label?: React.ReactNode;
  description?: React.ReactNode;
  errorMessage?: React.ReactNode;
  labelPlacement?: 'inside' | 'outside' | 'outside-left';
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  color?: HeroUIColor;
  variant?: NumberInputVariant;
  /** Scrapbook seeded tilt. Accepted and IGNORED under clay; see Input.tsx. */
  rotate?: number;
  fullWidth?: boolean;
  validate?: (value: number | null) => string | null | undefined | true;
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
    stepperButton?: string;
  };
  /** Locale for formatOptions; defaults to 'en-US'. */
  locale?: string;
}

const Caret = ({ direction }: { direction: 'up' | 'down' }) => (
  <svg
    aria-hidden
    fill='none'
    height='10'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={3}
    viewBox='0 0 24 24'
    width='10'
  >
    {direction === 'up' ? <path d='m6 15 6-6 6 6' /> : <path d='m6 9 6 6 6-6' />}
  </svg>
);

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  {
    value: valueProp,
    defaultValue,
    onValueChange,
    onChange,
    minValue,
    maxValue,
    step = 1,
    formatOptions,
    hideStepper,
    isWheelDisabled,
    isReadOnly,
    isInvalid,
    isDisabled,
    isRequired,
    isClearable,
    onClear,
    label,
    description,
    errorMessage,
    labelPlacement: _labelPlacement,
    startContent,
    endContent,
    size = 'md',
    radius = 'md',
    color = 'default',
    variant = 'bordered',
    rotate: _rotate,
    fullWidth = true,
    classNames,
    className,
    style,
    id,
    placeholder,
    locale = 'en-US',
    validate: _validate,
    ...rest
  },
  ref,
) {
  const reactId = React.useId();
  const inputId = id ?? reactId;
  const descId = description ? `${inputId}-desc` : undefined;
  const errId = errorMessage ? `${inputId}-err` : undefined;

  const isControlled = valueProp !== undefined;
  const [internal, setInternal] = React.useState<number | null>(defaultValue !== undefined ? defaultValue : null);
  const value = isControlled ? (valueProp ?? null) : internal;

  // Track the raw text the user is typing so we don't fight them while editing.
  const [draft, setDraft] = React.useState<string>('');
  const [focused, setFocused] = React.useState(false);

  const formatter = React.useMemo(() => {
    if (!formatOptions) return null;
    try {
      return new Intl.NumberFormat(locale, formatOptions);
    } catch {
      return null;
    }
  }, [formatOptions, locale]);

  const displayValue = React.useMemo(() => {
    if (focused) return draft;
    if (value === null || value === undefined || Number.isNaN(value)) return '';
    if (formatter) return formatter.format(value);

    return String(value);
  }, [focused, draft, value, formatter]);

  const clamp = React.useCallback(
    (n: number): number => {
      let next = n;
      if (typeof minValue === 'number') next = Math.max(minValue, next);
      if (typeof maxValue === 'number') next = Math.min(maxValue, next);

      return next;
    },
    [minValue, maxValue],
  );

  const commit = React.useCallback(
    (next: number) => {
      const clamped = clamp(next);
      if (!isControlled) setInternal(clamped);
      onValueChange?.(clamped);
    },
    [clamp, isControlled, onValueChange],
  );

  const stepBy = React.useCallback(
    (delta: number) => {
      if (isReadOnly || isDisabled) return;
      const base = typeof value === 'number' ? value : (minValue ?? 0);
      commit(base + delta);
    },
    [commit, isReadOnly, isDisabled, value, minValue],
  );

  /* ---- long-press repeat ---- */
  const repeatRef = React.useRef<{ start: number | null; interval: number | null }>({
    start: null,
    interval: null,
  });
  const stopRepeat = React.useCallback(() => {
    if (repeatRef.current.start !== null) {
      window.clearTimeout(repeatRef.current.start);
      repeatRef.current.start = null;
    }
    if (repeatRef.current.interval !== null) {
      window.clearInterval(repeatRef.current.interval);
      repeatRef.current.interval = null;
    }
  }, []);
  const beginRepeat = React.useCallback(
    (delta: number) => {
      stepBy(delta);
      stopRepeat();
      repeatRef.current.start = window.setTimeout(() => {
        repeatRef.current.interval = window.setInterval(() => stepBy(delta), 50);
      }, 200);
    },
    [stepBy, stopRepeat],
  );
  React.useEffect(() => () => stopRepeat(), [stopRepeat]);

  /* ---- handlers ---- */
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setDraft(raw);
    onChange?.(e);
    // Try to parse — accept empty / partial input gracefully.
    if (raw === '' || raw === '-') {
      if (!isControlled) setInternal(null);
      onValueChange?.(NaN);

      return;
    }
    // Strip non-numeric chars except '-' and '.' so locale-formatted typing works.
    const cleaned = raw.replace(/[^\d.\-]/g, '');
    const parsed = Number(cleaned);
    if (!Number.isNaN(parsed)) {
      commit(parsed);
    }
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setFocused(true);
    setDraft(value === null || value === undefined ? '' : String(value));
    rest.onFocus?.(e);
  };
  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    setFocused(false);
    rest.onBlur?.(e);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isReadOnly || isDisabled) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepBy(step);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepBy(-step);
    } else if (e.key === 'Home' && typeof minValue === 'number') {
      e.preventDefault();
      commit(minValue);
    } else if (e.key === 'End' && typeof maxValue === 'number') {
      e.preventDefault();
      commit(maxValue);
    }
    rest.onKeyDown?.(e);
  };

  const handleWheel = (e: React.WheelEvent<HTMLInputElement>) => {
    if (isWheelDisabled || isReadOnly || isDisabled) return;
    if (!focused) return;
    e.preventDefault();
    stepBy(e.deltaY < 0 ? step : -step);
  };

  /* ---- styling: the field half is Input.tsx's, verbatim ---- */
  const isUnderlined = variant === 'underlined';
  const face = FACE[variant];
  const focusEdge = isInvalid ? HEROUI_COLOR_TEXT.danger : HEROUI_COLOR_TEXT.primary;

  const fieldStyle = {
    background: face,
    ...clayVars(isUnderlined ? SURFACE : face, {
      shapeFrom: isInvalid ? CLAY_FILL.danger : color === 'default' ? undefined : CLAY_FILL[color],
      // The profile follows the SHAPE's luminance — see Input.tsx / clay.ts header.
      kind: isInvalid || color !== 'default' ? 'brand' : 'control',
      // Shallower than a button's 6: a field should read as made of the same
      // material without competing with the controls it sits beside in a form.
      depth: 4,
    }),
    '--clay-edge-hover': HOVER_EDGE,
    '--clay-focus': focusEdge,
  } as React.CSSProperties;

  /*
   * The steppers are tier 1, not field chrome. They are the only things here you
   * can push, so they get a real lip and a real press: depth 3, travel 2, which
   * keeps the bottom edge fixed while the lip closes — the same invariant every
   * other clay control holds.
   *
   * They are small, and the field already gives them a 44px-tall column to live
   * in, so no `::before` band is needed: the touch target is the field's height.
   */
  const stepperBtn = cn(
    'clay-btn inline-flex select-none items-center justify-center rounded-sm',
    STEPPER_SIZE[size],
    'border-[2px] border-[color:var(--clay-edge)]',
    'transition-[transform,box-shadow] duration-200 motion-reduce:transition-none',
    // Travel must equal depth minus the lip that state leaves, or the bottom
    // edge moves and the key SLIDES instead of depressing:
    //   rest 0 + 4 = 4   hover 2 + 2 = 4   active 3 + 1 = 4
    !isDisabled && 'cursor-pointer hover:translate-y-[2px] active:translate-y-[3px]',
    !isDisabled && 'motion-reduce:hover:translate-y-0',
    isDisabled && 'cursor-not-allowed opacity-40',
    classNames?.stepperButton,
  );

  /*
   * Depth 4, not 3.
   *
   * `clayVars`'s ladder COLLAPSES below 4: hover is `depth - 2` and active is a
   * fixed 1px, so at depth 3 both land on 1px and pressing the key shows nothing
   * that hovering it did not already show. 4 is the shallowest depth where the
   * three states are still three states (4 / 2 / 1).
   *
   * That makes the stepper the same NUMBER as the field beside it, but not the
   * same thing: the field is `.clay-panel` and never moves, the stepper is
   * `.clay-btn` and travels. Press-versus-static is the stronger distinction
   * anyway, and unlike a depth difference it cannot be lost to arithmetic.
   */
  const stepperStyle = {
    background: SURFACE,
    color: FG,
    ...clayVars(SURFACE, { kind: 'control', depth: 4 }),
  } as React.CSSProperties;

  const isAtMax = typeof maxValue === 'number' && typeof value === 'number' && value >= maxValue;
  const isAtMin = typeof minValue === 'number' && typeof value === 'number' && value <= minValue;

  return (
    <div className={cn('flex flex-col gap-1.5', fullWidth && 'w-full', className, classNames?.base)} style={style}>
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
            // Nothing translates and nothing lifts: a field is not pressed, so it
            // takes the lip WITHOUT the press ladder — `.clay-panel`.
            'transition-[border-color,outline-color] duration-150 motion-reduce:transition-none',
            // The lip. Without it the field was a 2px outline and no depth at
            // all, which read as an empty box beside the clay buttons it shares
            // a form with — the whole point of the migration is that everything
            // is made of the same material.
            !isUnderlined && 'clay-panel border-[2px] border-[color:var(--clay-edge)]',
            !isDisabled && !isUnderlined && 'hover:border-[color:var(--clay-edge-hover)]',
            isDisabled && 'cursor-not-allowed opacity-50',
            // Focus recolours the border and thickens it with a 1px outline at
            // offset 0 — one 3px edge, no layout shift, `box-shadow` uninvolved.
            'focus-within:outline-none',
            !isUnderlined && 'has-[:focus-visible]:border-[color:var(--clay-focus)]',
            'has-[:focus-visible]:outline has-[:focus-visible]:outline-[1px] has-[:focus-visible]:outline-offset-0',
            'has-[:focus-visible]:outline-[color:var(--clay-focus)]',
            SIZE[size],
            isUnderlined ? 'rounded-none' : RADIUS[radius],
            classNames?.inputWrapper,
            classNames?.innerWrapper,
          )}
          style={fieldStyle}
        >
          {startContent}
          <input
            ref={ref}
            aria-describedby={cn(descId, errId)}
            aria-invalid={isInvalid || undefined}
            className={cn(
              // min-w-0: without it the input can't shrink below its intrinsic width and
              // overflows the bordered wrapper, pushing the stepper controls outside the box.
              // Placeholder uses the body face (no `font-hand`).
              'w-full min-w-0 flex-1 bg-transparent font-bold outline-none placeholder:font-semibold placeholder:text-[color:var(--clay-muted)]',
              size === 'lg'
                ? 'placeholder:text-[20px]'
                : size === 'sm'
                  ? 'placeholder:text-[16px]'
                  : 'placeholder:text-[18px]',
              classNames?.input,
            )}
            dir='ltr'
            disabled={isDisabled}
            style={{ color: FG, '--clay-muted': MUTED } as React.CSSProperties}
            id={inputId}
            inputMode='decimal'
            onBlur={handleBlur}
            onChange={handleChange}
            onFocus={handleFocus}
            onKeyDown={handleKeyDown}
            onWheel={handleWheel}
            placeholder={typeof placeholder === 'string' ? placeholder : undefined}
            readOnly={isReadOnly}
            required={isRequired}
            type='text'
            value={displayValue}
            {...rest}
          />
          {isClearable && value !== null && value !== undefined ? (
            <button
              aria-label='Clear'
              className='text-ink/60 hover:text-ink inline-flex h-5 w-5 items-center justify-center rounded-full'
              onClick={() => {
                if (!isControlled) setInternal(null);
                setDraft('');
                onValueChange?.(NaN);
                onClear?.();
              }}
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
          {/* Error's second channel — a glyph, not only a colour. See Input.tsx. */}
          {isInvalid ? (
            <span
              aria-hidden='true'
              className='inline-flex shrink-0 items-center justify-center'
              style={{ color: HEROUI_COLOR_TEXT.danger }}
            >
              {ALERT_GLYPH}
            </span>
          ) : null}
          {endContent}
          {!hideStepper ? (
            <span aria-hidden className='-me-2 flex shrink-0 flex-col items-stretch justify-center gap-[3px]'>
              <button
                aria-label='Increase'
                className={stepperBtn}
                style={stepperStyle}
                disabled={isDisabled || isAtMax}
                onMouseDown={(e) => {
                  e.preventDefault();
                  beginRepeat(step);
                }}
                onMouseLeave={stopRepeat}
                onMouseUp={stopRepeat}
                onTouchEnd={stopRepeat}
                onTouchStart={(e) => {
                  e.preventDefault();
                  beginRepeat(step);
                }}
                tabIndex={-1}
                type='button'
              >
                <Caret direction='up' />
              </button>
              <button
                aria-label='Decrease'
                className={stepperBtn}
                disabled={isDisabled || isAtMin}
                style={stepperStyle}
                onMouseDown={(e) => {
                  e.preventDefault();
                  beginRepeat(-step);
                }}
                onMouseLeave={stopRepeat}
                onMouseUp={stopRepeat}
                onTouchEnd={stopRepeat}
                onTouchStart={(e) => {
                  e.preventDefault();
                  beginRepeat(-step);
                }}
                tabIndex={-1}
                type='button'
              >
                <Caret direction='down' />
              </button>
            </span>
          ) : null}
        </div>
        {/* `underlined`'s whole box — a bar that owns its colour. See Input.tsx. */}
        {isUnderlined ? (
          <span
            aria-hidden='true'
            className='pointer-events-none absolute inset-x-0 bottom-0 h-[3px] rounded-full transition-colors duration-200'
            style={{ background: isInvalid ? HEROUI_COLOR_TEXT.danger : 'var(--clay-edge)' }}
          />
        ) : null}
      </div>
      {description || errorMessage ? (
        <div className={cn('flex flex-col gap-0.5', classNames?.helperWrapper)}>
          {errorMessage ? (
            <span
              className={cn('text-[13px] font-bold', classNames?.errorMessage)}
              id={errId}
              style={{ color: HEROUI_COLOR_TEXT.danger }}
            >
              {errorMessage}
            </span>
          ) : description ? (
            <span
              className={cn('text-[13px] font-medium', classNames?.description)}
              id={descId}
              style={{ color: MUTED }}
            >
              {description}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

NumberInput.displayName = 'NumberInput';
