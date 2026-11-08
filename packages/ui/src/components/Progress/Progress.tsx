import React from 'react';

import { cn } from '../../cn';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';
import { CLAY_FILL, CLAY_RIM, clayVars } from '../clay';
import { HEROUI_COLOR_TEXT } from '../tokens';

/**
 * da-v2 Progress + CircularProgress — drop-in for HeroUI.
 *
 * HeroUI API mirrored:
 *   <Progress aria-label value minValue maxValue color size radius isIndeterminate
 *             isStriped showValueLabel valueLabel formatOptions classNames disableAnimation />
 *   <CircularProgress aria-label value minValue maxValue color size formatOptions
 *                     showValueLabel valueLabel strokeWidth classNames />
 *
 * Visual contract: ink hairline track + 2.5px ink border around the fill,
 * citrine + per-color tints. Indeterminate = traveling fill, 1.4s loop.
 */

const LINEAR_HEIGHT: Record<HeroUISize, string> = {
  sm: 'h-2',
  md: 'h-3',
  lg: 'h-4',
};

const RADIUS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  md: 'rounded-sm',
  lg: 'rounded-md',
  full: 'rounded-full',
};

interface ProgressFmtOpts {
  style?: 'percent' | 'decimal' | 'currency' | 'unit';
  unit?: string;
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
  // Allow other Intl.NumberFormatOptions to pass through.
  [k: string]: unknown;
}

export interface ProgressProps {
  'aria-label'?: string;
  label?: React.ReactNode;
  value?: number;
  minValue?: number;
  maxValue?: number;
  color?: HeroUIColor;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  isIndeterminate?: boolean;
  isStriped?: boolean;
  isDisabled?: boolean;
  showValueLabel?: boolean;
  valueLabel?: React.ReactNode;
  formatOptions?: ProgressFmtOpts;
  className?: string;
  classNames?: {
    base?: string;
    track?: string;
    indicator?: string;
    label?: string;
    value?: string;
    labelWrapper?: string;
  };
  disableAnimation?: boolean;
  /** Allow style passthrough on the wrapper. */
  style?: React.CSSProperties;
  dir?: 'rtl' | 'ltr';
}

function clampPct(value: number | undefined, min: number, max: number): number {
  if (value === undefined || Number.isNaN(value)) return 0;
  if (max <= min) return 0;
  const pct = ((value - min) / (max - min)) * 100;

  return Math.max(0, Math.min(100, pct));
}

function formatValue(value: number, max: number, opts: ProgressFmtOpts | undefined) {
  try {
    const fmt = new Intl.NumberFormat('en-US', (opts as Intl.NumberFormatOptions) ?? { style: 'percent' });
    if ((opts?.style ?? 'percent') === 'percent') return fmt.format(value / max);

    return fmt.format(value);
  } catch {
    return `${Math.round((value / max) * 100)}%`;
  }
}

export function Progress(props: ProgressProps) {
  const {
    'aria-label': ariaLabel,
    label,
    value,
    minValue = 0,
    maxValue = 100,
    color = 'primary',
    size = 'md',
    radius = 'full',
    isIndeterminate,
    isStriped,
    showValueLabel,
    valueLabel,
    formatOptions,
    className,
    classNames,
    disableAnimation,
    style,
    dir,
  } = props;

  // The surface the groove is cut INTO — the same token the track paints.
  const TRACK = 'var(--paper-2)';

  const pct = clampPct(value, minValue, maxValue);
  /*
   * `CLAY_FILL`, not `HEROUI_COLOR_TEXT`. A LINEAR bar's filled portion is a
   * large painted AREA, not a mark: its contrast requirement is 3:1 against the
   * track it sits in, not 4.5:1 as text on the page. `HEROUI_COLOR_TEXT` is the
   * brand darkened for legibility AS TEXT, and every entry was tuned
   * independently for that job — which is why a primary bar and a success bar
   * out of that map do not read as the same family. The success entry came out
   * a dark teal next to the purple, and the two bars looked like they belonged
   * to different products.
   *
   * The CIRCULAR variant below keeps `HEROUI_COLOR_TEXT`, and that is correct
   * there and not an inconsistency: it is a 2-3px STROKE, which is a mark.
   */
  const fillColor = color === 'default' ? CLAY_FILL.primary : CLAY_FILL[color as keyof typeof CLAY_FILL];

  return (
    <div
      aria-label={ariaLabel}
      aria-valuemax={maxValue}
      aria-valuemin={minValue}
      aria-valuenow={isIndeterminate ? undefined : value}
      className={cn('flex w-full flex-col gap-1.5', className, classNames?.base)}
      dir={dir}
      role='progressbar'
      style={style}
    >
      {label || showValueLabel ? (
        <div
          className={cn('text-ink flex items-center justify-between text-[13px] font-bold', classNames?.labelWrapper)}
        >
          {label ? <span className={classNames?.label}>{label}</span> : <span />}
          {showValueLabel ? (
            <span className={cn('text-ink/70 text-[14px] font-bold', classNames?.value)}>
              {valueLabel ?? (value !== undefined ? formatValue(value, maxValue, formatOptions) : null)}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        className={cn(
          // A track is a CHANNEL, the same object as the Slider's — `.clay-field`
          // plus an inset, so the groove is cut into the surface rather than drawn
          // as a hairline rectangle sitting on it. Without `.clay-field` the
          // `--clay-*` vars below are inert and the bar paints flat.
          'clay-field bg-paper-2 relative w-full overflow-hidden border-[2px]',
          LINEAR_HEIGHT[size],
          RADIUS[radius],
          classNames?.track,
        )}
        style={{
          borderColor: 'var(--clay-edge)',
          ...clayVars(TRACK, { kind: 'control', depth: 4, inset: true }),
        }}
      >
        {/*
         * The "hand-drawn dashed underline accent" that used to sit here was a
         * scrapbook flourish by its own description, and it is gone. The track
         * now reads as a groove because it is filled `--paper-2` rather than the
         * page token, not because a dashed line is drawn along its bottom.
         */}
        <div
          className={cn(
            /* The bar grows from the start edge. */
            'absolute inset-y-0 start-0 border-e-[2px]',
            !disableAnimation && 'transition-[width] duration-300 ease-out',
            isIndeterminate && 'sk-progress-indeterminate',
            isStriped && 'sk-progress-striped',
            classNames?.indicator,
          )}
          style={{
            width: isIndeterminate ? '40%' : `${pct}%`,
            background: fillColor,
            /*
             * The leading edge is a darker shade of the FILL — clay's recipe —
             * not a neutral grey rim, which read as a pencil line drawn across
             * the bar and belonged to neither the fill nor the track.
             *
             * `control`, not `brand`, and this is the WCAG 1.4.11 boundary, not
             * a style choice. The filled portion is a graphic object that
             * conveys a value, so where it ENDS must clear 3:1. On a near-white
             * track the family fills do not: success measured 2.02 and warning
             * 1.90 against it. `brand` (82% fill) only lifted success to 2.94 —
             * still short. `control` (50% fill) puts both near 5.7, and stays
             * on-family because it is still the bar's own hue, just darker. The
             * fill keeps the palette; the edge carries the contrast.
             */
            borderColor: (clayVars(fillColor, { kind: 'control' }) as Record<string, string>)['--clay-edge'],
          }}
        />
      </div>
      <style>{`
        @keyframes sk-progress-travel {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }
        .sk-progress-indeterminate {
          animation: sk-progress-travel 1.4s ease-in-out infinite;
        }
        .sk-progress-striped {
          background-image: repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 8px, transparent 8px 16px);
        }
      `}</style>
    </div>
  );
}

Progress.displayName = 'Progress';

/* ============================================================
   <CircularProgress>
   ============================================================ */

const CIRC_SIZE: Record<HeroUISize, { d: number; sw: number; label: string }> = {
  sm: { d: 32, sw: 4, label: 'text-[10px]' },
  md: { d: 44, sw: 5, label: 'text-[12px]' },
  lg: { d: 64, sw: 6, label: 'text-[14px]' },
};

export interface CircularProgressProps {
  'aria-label'?: string;
  label?: React.ReactNode;
  value?: number;
  minValue?: number;
  maxValue?: number;
  color?: HeroUIColor;
  size?: HeroUISize;
  isIndeterminate?: boolean;
  isDisabled?: boolean;
  showValueLabel?: boolean;
  valueLabel?: React.ReactNode;
  formatOptions?: ProgressFmtOpts;
  strokeWidth?: number;
  className?: string;
  classNames?: {
    base?: string;
    svg?: string;
    track?: string;
    indicator?: string;
    label?: string;
    value?: string;
    svgWrapper?: string;
  };
  disableAnimation?: boolean;
}

export function CircularProgress(props: CircularProgressProps) {
  const {
    'aria-label': ariaLabel,
    label,
    value,
    minValue = 0,
    maxValue = 100,
    color = 'primary',
    size = 'md',
    isIndeterminate,
    showValueLabel,
    valueLabel,
    formatOptions,
    strokeWidth,
    className,
    classNames,
    disableAnimation,
  } = props;

  const cfg = CIRC_SIZE[size];
  const sw = strokeWidth ?? cfg.sw;
  const r = (cfg.d - sw) / 2;
  const c = 2 * Math.PI * r;
  const pct = clampPct(value, minValue, maxValue);
  const dashOffset = isIndeterminate ? c * 0.25 : c - (pct / 100) * c;

  // Unlike the linear bar — whose indicator carries a 2px LINE edge marking where
  // the fill stops — this ring has no boundary stroke: the only cue is indicator
  // colour vs the 25%-opacity LINE track ring behind it. That makes it a MARK, so
  // it reads from HEROUI_COLOR_TEXT. With the fill map, a warm palette's --p sat at 1.17:1
  // against its own track ring (light was 3.98:1); --p-text restores it.
  const stroke = color === 'default' ? 'var(--citrine)' : HEROUI_COLOR_TEXT[color];

  return (
    <div
      aria-label={ariaLabel}
      aria-valuemax={maxValue}
      aria-valuemin={minValue}
      aria-valuenow={isIndeterminate ? undefined : value}
      className={cn('flex flex-col items-center gap-1', className, classNames?.base)}
      role='progressbar'
    >
      <div className={cn('relative inline-flex items-center justify-center', classNames?.svgWrapper)}>
        <svg
          className={cn(isIndeterminate && 'sk-circular-spin', classNames?.svg)}
          height={cfg.d}
          viewBox={`0 0 ${cfg.d} ${cfg.d}`}
          width={cfg.d}
        >
          <circle
            cx={cfg.d / 2}
            cy={cfg.d / 2}
            fill='none'
            r={r}
            stroke={CLAY_RIM}
            strokeOpacity={0.25}
            strokeWidth={sw}
            className={classNames?.track}
          />
          <circle
            className={classNames?.indicator}
            cx={cfg.d / 2}
            cy={cfg.d / 2}
            fill='none'
            r={r}
            stroke={stroke}
            strokeDasharray={c}
            strokeDashoffset={dashOffset}
            strokeLinecap='round'
            strokeWidth={sw}
            style={{
              transition: disableAnimation ? undefined : 'stroke-dashoffset 280ms ease-out',
              transform: 'rotate(-90deg)',
              transformOrigin: '50% 50%',
            }}
          />
        </svg>
        {showValueLabel ? (
          <span
            className={cn(
              'text-ink absolute inset-0 flex items-center justify-center font-extrabold',
              cfg.label,
              classNames?.value,
            )}
          >
            {valueLabel ?? (value !== undefined ? formatValue(value, maxValue, formatOptions) : null)}
          </span>
        ) : null}
      </div>
      {label ? <span className={cn('text-ink text-[13px] font-bold', classNames?.label)}>{label}</span> : null}
      <style>{`
        @keyframes sk-circular-spin { to { transform: rotate(360deg); } }
        .sk-circular-spin { animation: sk-circular-spin 1.2s linear infinite; transform-origin: center; }
      `}</style>
    </div>
  );
}

CircularProgress.displayName = 'CircularProgress';
