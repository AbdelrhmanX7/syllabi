import React from 'react';

import { cn } from '../../cn';
import { useValidation } from '../useValidation';
import { CLAY_FILL, clayVars } from '../clay';
import { HEROUI_COLOR_TEXT } from '../tokens';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';

/**
 * da-v2 Textarea — multi-line counterpart to Input, built from the same parts
 * on purpose. Everything documented in `Input.tsx` applies here: a flat face
 * with a 2px border doing all the structural work, a neutral that darkens on
 * hover, focus recolouring the border to the brand MARK and thickening it with
 * a 1px outline (no layout shift, and `box-shadow` left out of it entirely),
 * the invalid state carrying a glyph as well as a colour, and `underlined`
 * drawing a real bar instead of a border set to transparent.
 *
 * Auto-grows up to ~6 rows unless `maxRows` overrides.
 */

export type TextareaVariant = 'flat' | 'bordered' | 'underlined' | 'faded';

// Clay's radius ladder, written out — the JIT cannot see through a template literal.
const RADIUS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-md',
  md: 'rounded-lg',
  lg: 'rounded-lg',
  full: 'rounded-lg', // textareas don't go round
};

const FG = 'hsl(var(--heroui-foreground))';
const SURFACE = CLAY_FILL.default;
const MUTED = `color-mix(in srgb, ${FG} 62%, ${SURFACE})`;

const FACE: Record<TextareaVariant, string> = {
  bordered: SURFACE,
  flat: 'hsl(var(--heroui-content2))',
  faded: 'hsl(var(--heroui-content3))',
  underlined: 'transparent',
};

/** See Input.tsx: the darker hover border comes from a lower rung, not a darker profile. */
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

export interface TextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'size' | 'color' | 'rows'> {
  label?: React.ReactNode;
  description?: React.ReactNode;
  errorMessage?: React.ReactNode;
  isInvalid?: boolean;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  isRequired?: boolean;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  color?: HeroUIColor;
  variant?: TextareaVariant;
  /** Scrapbook seeded tilt. Accepted and IGNORED under clay; see Input.tsx. */
  rotate?: number;
  minRows?: number;
  maxRows?: number;
  fullWidth?: boolean;
  classNames?: {
    base?: string;
    inputWrapper?: string;
    input?: string;
    label?: string;
    innerWrapper?: string;
    description?: string;
    errorMessage?: string;
  };
  onValueChange?: (value: string) => void;
  labelPlacement?: 'inside' | 'outside' | 'outside-left';
  validate?: (value: string) => string | null | undefined | true;
  /** HeroUI compat — element rendered after the textarea (e.g. send button). */
  endContent?: React.ReactNode;
  /** HeroUI compat — element rendered before the textarea. */
  startContent?: React.ReactNode;
  /** HeroUI compat — disable auto-grow. */
  disableAutosize?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    label,
    description,
    errorMessage,
    isInvalid,
    isDisabled,
    isReadOnly,
    isRequired,
    size = 'md',
    radius = 'md',
    color = 'default',
    variant = 'bordered',
    rotate: _rotate,
    className,
    classNames,
    style,
    onChange,
    onBlur,
    onValueChange,
    fullWidth = true,
    minRows = 3,
    maxRows = 6,
    id,
    labelPlacement: _labelPlacement,
    validate,
    endContent,
    startContent,
    disableAutosize,
    ...rest
  },
  ref,
) {
  const seedRef = React.useRef<number | null>(null);
  const reactId = React.useId();
  const inputId = id ?? reactId;

  const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement);

  /*
   * `validate` was destructured here and never called — see `useValidation`.
   * Props still win: a parent that has already decided the field is bad
   * outranks a local rule that only knows about this one value.
   */
  const validation = useValidation<string>(validate, String(rest.value ?? ''), innerRef);
  const effectiveInvalid = isInvalid || validation.isInvalid;
  const effectiveError = errorMessage ?? validation.shown;

  const isUnderlined = variant === 'underlined';
  const face = FACE[variant];

  /*
   * The brand as a MARK, not as a FILL — `CLAY_FILL.primary` is a fixed dark
   * purple and measured 1.93-2.94:1 against a dark field. See Input.tsx.
   */
  const focusEdge = effectiveInvalid ? HEROUI_COLOR_TEXT.danger : HEROUI_COLOR_TEXT.primary;

  const fieldStyle = {
    background: face,
    ...clayVars(isUnderlined ? SURFACE : face, {
      shapeFrom: effectiveInvalid ? CLAY_FILL.danger : color === 'default' ? undefined : CLAY_FILL[color],
      // See Input.tsx: the profile follows the SHAPE's luminance, not the face's
      // and not the `color` prop, and `clayKindFor` cannot be asked that.
      kind: effectiveInvalid || color !== 'default' ? 'brand' : 'control',
      // Shallower than a button's 6 — same value as Input.
      depth: 4,
    }),
    '--clay-edge-hover': HOVER_EDGE,
    '--clay-focus': focusEdge,
  } as React.CSSProperties;

  // Auto-grow on input.

  const fitHeight = React.useCallback(() => {
    if (disableAutosize) return;
    const el = innerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '20');
    const maxH = Math.round(lineHeight * maxRows + 24);
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  }, [maxRows, disableAutosize]);

  React.useEffect(() => {
    fitHeight();
  }, [fitHeight, rest.value, rest.defaultValue]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    validation.run(e.target.value);
    onChange?.(e);
    onValueChange?.(e.target.value);
    fitHeight();
  };

  // Blur is what makes a failing rule visible; see Input.
  const handleBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    validation.markTouched();
    validation.run(e.target.value);
    onBlur?.(e);
  };

  const fontSize = size === 'lg' ? 'text-[16px]' : size === 'sm' ? 'text-[13px]' : 'text-[15px]';

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
      <div
        className={cn(
          'relative flex w-full items-start gap-2 px-5 py-4',
          'transition-[border-color,outline-color] duration-150 motion-reduce:transition-none',
          // `.clay-panel` = the lip WITHOUT the press ladder. A field is not
          // pressed, but it is made of the same material as the buttons beside
          // it — a flat field in a system where everything else has a lip reads
          // as unfinished. Matches Input; keep the two identical.
          !isUnderlined && 'clay-panel border-[2px] border-[color:var(--clay-edge)]',
          !isDisabled && !isUnderlined && 'hover:border-[color:var(--clay-edge-hover)]',
          isDisabled && 'cursor-not-allowed opacity-50',
          // Focus recolours the border and thickens it with a 1px outline at
          // offset 0 — one 3px edge, no layout shift, `box-shadow` uninvolved.
          'focus-within:outline-none',
          !isUnderlined && 'has-[:focus-visible]:border-[color:var(--clay-focus)]',
          'has-[:focus-visible]:outline has-[:focus-visible]:outline-[1px] has-[:focus-visible]:outline-offset-0',
          'has-[:focus-visible]:outline-[color:var(--clay-focus)]',
          isUnderlined ? 'rounded-none' : RADIUS[radius],
          classNames?.inputWrapper,
        )}
        style={fieldStyle}
      >
        {startContent}
        <textarea
          ref={innerRef}
          aria-invalid={effectiveInvalid || undefined}
          className={cn(
            // Placeholder uses the body face (no `font-hand`).
            'block w-full resize-none bg-transparent font-bold leading-relaxed outline-none placeholder:font-semibold placeholder:text-[color:var(--clay-muted)]',
            fontSize,
            classNames?.input,
          )}
          disabled={isDisabled}
          id={inputId}
          style={{ color: FG, '--clay-muted': MUTED } as React.CSSProperties}
          onBlur={handleBlur}
          onChange={handleChange}
          readOnly={isReadOnly}
          required={isRequired}
          rows={minRows}
          {...rest}
        />
        {/* The error's second channel — a glyph, not only a colour. See Input.tsx. */}
        {effectiveInvalid ? (
          <span
            aria-hidden='true'
            className='mt-0.5 inline-flex shrink-0 items-center justify-center'
            style={{ color: HEROUI_COLOR_TEXT.danger }}
          >
            {ALERT_GLYPH}
          </span>
        ) : null}
        {endContent}
        {/* `underlined`'s whole box — a bar that owns its colour, not a border set to transparent. */}
        {isUnderlined ? (
          <span
            aria-hidden='true'
            className='pointer-events-none absolute inset-x-0 bottom-0 h-[3px] rounded-full transition-colors duration-200'
            style={{ background: effectiveInvalid ? HEROUI_COLOR_TEXT.danger : 'var(--clay-edge)' }}
          />
        ) : null}
      </div>
      {description || effectiveError ? (
        <div className='flex flex-col gap-0.5'>
          {effectiveError ? (
            <span className='text-[13px] font-bold' style={{ color: HEROUI_COLOR_TEXT.danger }}>
              {effectiveError}
            </span>
          ) : description ? (
            <span className='text-[13px] font-medium' style={{ color: MUTED }}>
              {description}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

Textarea.displayName = 'Textarea';
