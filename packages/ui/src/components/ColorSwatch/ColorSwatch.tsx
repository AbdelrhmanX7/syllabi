import React from 'react';

import { cn } from '../../cn';

/**
 * ColorSwatch / SwatchPicker — the one way to pick a colour (ink, pen, class colour).
 *
 * Construction (ui-rules: radius ladder, nothing clipped, works light + dark, Chrome ≥ 90 safe):
 *   - a round DOT (a true circle, so `rounded-full` is allowed) with an inset 1.5px rim in the
 *     theme's ink at low alpha, so a white swatch still reads on a white card and a navy one on
 *     a navy card;
 *   - SELECTED = a 2px ring in the brand text colour (`--p-text`, ≥ 4.5:1 in both themes) held
 *     2px off the dot by a TRANSPARENT gap — it reads against any fill and any surface — plus a
 *     check glyph whose colour is picked from the swatch's luminance (white on dark, ink on light);
 *   - the button is the touch target (32px sm / 40px md, never smaller), `rounded-md` so the
 *     focus-visible outline follows the radius ladder;
 *   - no color-mix(), no :has() — the tablets' WebView can be older than Chrome 103.
 */

export type ColorSwatchSize = 'sm' | 'md';

const SIZE: Record<ColorSwatchSize, { hit: string; ring: string; dot: string; check: string; text: string }> = {
  sm: { hit: 'h-8 w-8', ring: 'h-[30px] w-[30px]', dot: 'h-[22px] w-[22px]', check: 'h-3.5 w-3.5', text: 'text-[9px]' },
  md: { hit: 'h-10 w-10', ring: 'h-9 w-9', dot: 'h-7 w-7', check: 'h-4 w-4', text: 'text-[10px]' },
};

/** Relative luminance of a #rgb / #rrggbb colour; null when it can't be parsed (CSS var, name…). */
export function swatchLuminance(color: string): number | null {
  const hex = color.trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.slice(0, 6);

  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;

    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Check glyph colour that reads on the swatch: white on a dark fill, the fixed dark ink on a light one. */
function checkColorFor(color: string | null | undefined): string {
  if (!color) return 'var(--ink)';
  const lum = swatchLuminance(color);

  if (lum === null) return '#ffffff';

  // Contrast against white vs against the constant ink (#18204a, L ≈ 0.017): pick the larger.
  return (1.05 / (lum + 0.05)) >= (lum + 0.05) / 0.067 ? '#ffffff' : 'var(--ink-const, #18204a)';
}

const CheckGlyph = (props: React.SVGAttributes<SVGSVGElement>) => (
  <svg
    aria-hidden='true'
    fill='none'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={3.5}
    viewBox='0 0 24 24'
    {...props}
  >
    <path d='M4 12 10 18 20 6' />
  </svg>
);

export interface ColorSwatchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  /** The fill. `null` = "no colour" (e.g. keep the pen's own ink): the dot shows `children` instead. */
  color: string | null;
  /** Accessible name (required — a colour alone is not a name). */
  label: string;
  isSelected?: boolean;
  isDisabled?: boolean;
  size?: ColorSwatchSize;
  /** Content for a `null` swatch (e.g. "Aa"). Ignored when `color` is set. */
  children?: React.ReactNode;
}

export const ColorSwatch = React.forwardRef<HTMLButtonElement, ColorSwatchProps>(function ColorSwatch(
  { color, label, isSelected = false, isDisabled, disabled, size = 'md', children, className, style, type, ...rest },
  ref,
) {
  const s = SIZE[size];
  const off = isDisabled ?? disabled ?? false;

  return (
    <button
      ref={ref}
      aria-label={label}
      aria-pressed={isSelected}
      className={cn(
        'relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center rounded-md',
        'transition-transform duration-100 active:scale-95',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--p-text)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        s.hit,
        className,
      )}
      data-selected={isSelected || undefined}
      disabled={off}
      style={style}
      title={label}
      type={type ?? 'button'}
      {...rest}
    >
      <span
        aria-hidden='true'
        className={cn(
          'flex items-center justify-center rounded-full border-2 transition-colors duration-100',
          s.ring,
          isSelected ? 'border-[color:var(--p-text)]' : 'border-transparent',
        )}
      >
        <span
          className={cn(
            'flex items-center justify-center rounded-full font-semibold leading-none',
            s.dot,
            s.text,
            color ? '' : 'bg-[color:var(--surface-1)] text-[color:var(--ink)]',
          )}
          style={{
            backgroundColor: color ?? undefined,
            boxShadow: 'inset 0 0 0 1.5px rgb(var(--ink-rgb, 24 32 74) / 0.28)',
            color: color ? checkColorFor(color) : undefined,
          }}
        >
          {color ? isSelected ? <CheckGlyph className={s.check} /> : null : children}
        </span>
      </span>
    </button>
  );
});

export interface SwatchOption {
  value: string | null;
  label: string;
  /** Content for a `null` (no-colour) option. */
  content?: React.ReactNode;
}

export interface SwatchPickerProps {
  /** Hex strings (labelled by `getLabel`, default the hex) or full options. */
  colors: ReadonlyArray<string | SwatchOption>;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  /** Group name for assistive tech. */
  label: string;
  size?: ColorSwatchSize;
  getLabel?: (color: string) => string;
  isDisabled?: boolean;
  className?: string;
  /** Lay the swatches out as a fixed-column grid instead of a wrapping row. */
  columns?: number;
}

/** A wrapping row (or grid) of ColorSwatches with single selection. Compare is case-insensitive. */
export function SwatchPicker({
  colors,
  value,
  onChange,
  label,
  size = 'md',
  getLabel,
  isDisabled,
  className,
  columns,
}: SwatchPickerProps) {
  const current = typeof value === 'string' ? value.toLowerCase() : value;

  return (
    <div
      aria-label={label}
      className={cn(columns ? 'grid gap-1' : 'flex flex-wrap gap-1', className)}
      role='group'
      style={columns ? { gridTemplateColumns: `repeat(${columns}, max-content)` } : undefined}
    >
      {colors.map((entry) => {
        const option: SwatchOption =
          typeof entry === 'string' ? { value: entry, label: getLabel ? getLabel(entry) : entry } : entry;
        const key = option.value ?? '__none__';
        const selected = (typeof option.value === 'string' ? option.value.toLowerCase() : option.value) === current;

        return (
          <ColorSwatch
            key={key}
            color={option.value}
            isDisabled={isDisabled}
            isSelected={selected}
            label={option.label}
            size={size}
            onClick={() => onChange(option.value)}
          >
            {option.content}
          </ColorSwatch>
        );
      })}
    </div>
  );
}
