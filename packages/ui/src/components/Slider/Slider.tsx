import React from 'react';

import { cn } from '../../cn';
import type { HeroUIColor, HeroUIRadius, HeroUISize } from '../tokens';
import { CLAY_FILL, CLAY_LABEL, clayVars } from '../clay';
import { HEROUI_COLOR_TEXT } from '../tokens';

/**
 * da-v2 Slider — drop-in replacement for HeroUI's Slider.
 *
 *   <Slider value={50} maxValue={100} onChange={setValue} />
 *   <Slider value={[20, 80]} isRange onChange={setRange} />
 *
 * Visual: CLAY, the two-part problem `Switch` solved — a RECESSED track with a
 * RAISED thumb sliding along it.
 *
 *   track   tier 3. `clayVars({ inset: true })` + `.clay-field`: a channel cut
 *           into the page, with the two-sided groove (shadow along the top
 *           inner edge, highlight along the bottom).
 *   filled  a MARK, not a fill. `HEROUI_COLOR_TEXT[color]`, not
 *           `CLAY_FILL[color]` — the filled portion is a stroke read against
 *           the page, and a hue that works as a surface does not automatically
 *           work as a stroke. `CLAY_FILL.primary` is a fixed dark purple that
 *           disappears on a dark track; the `*-text` tokens are the same brand
 *           corrected to read AGAINST the theme.
 *   thumb   tier 1. `.clay-btn` + a lip, so grabbing it sinks it INTO the
 *           channel — it is the one part you actually push.
 *
 * Old (removed): scrapbook track (paper bg, 1.5px solid LINE border — applied so it
 * renders in every app regardless of the --line token), citrine fill,
 * 22px line-bordered thumb with hard 3px shadow, slight rotation on the thumb.
 */

export interface SliderClassNames {
  base?: string;
  label?: string;
  labelWrapper?: string;
  value?: string;
  output?: string;
  trackWrapper?: string;
  track?: string;
  filler?: string;
  thumb?: string;
  step?: string;
  mark?: string;
  startContent?: string;
  endContent?: string;
}

export type SliderValue = number | number[];

export interface SliderProps {
  label?: React.ReactNode;
  value?: SliderValue;
  defaultValue?: SliderValue;
  onChange?: (value: SliderValue) => void;
  onChangeEnd?: (value: SliderValue) => void;
  minValue?: number;
  maxValue?: number;
  step?: number;
  marks?: Array<{ value: number; label: React.ReactNode }>;
  color?: HeroUIColor;
  size?: HeroUISize;
  radius?: HeroUIRadius;
  fillOffset?: number;
  startContent?: React.ReactNode;
  endContent?: React.ReactNode;
  showSteps?: boolean;
  showTooltip?: boolean;
  showOutline?: boolean;
  hideValue?: boolean;
  hideThumb?: boolean;
  isDisabled?: boolean;
  orientation?: 'horizontal';
  isRange?: boolean;
  className?: string;
  classNames?: SliderClassNames;
  formatOptions?: Intl.NumberFormatOptions;
  getValue?: (value: SliderValue) => React.ReactNode;
  renderLabel?: (props: { children: React.ReactNode }) => React.ReactNode;
  renderValue?: (props: { children: React.ReactNode }) => React.ReactNode;
  renderThumb?: (props: { index: number; value: number; ariaProps: Record<string, unknown> }) => React.ReactNode;
  tooltipProps?: Record<string, unknown>;
  /** Scrapbook seeded tilt. Accepted and IGNORED under clay — a clay object is
   * square to the page. Kept because call sites pass it; destructured so it
   * never reaches the DOM. */
  rotate?: number;
  'aria-label'?: string;
  /** Accepted for compatibility; the slider is always LTR. */
  dir?: 'rtl' | 'ltr';
  name?: string;
  /** HeroUI compat — kept for parity. */
  isVertical?: boolean;
}

// Clay is chunkier, and a recessed channel needs depth to read as one: a 6px
// track cannot show a groove. These are the smallest heights where the two-sided
// inset is still visible.
const TRACK_HEIGHT: Record<HeroUISize, string> = {
  sm: 'h-3',
  md: 'h-3.5',
  lg: 'h-4',
};

/** Groove depth per size — deep enough to read, shallow enough to fit the track. */
const TRACK_DEPTH: Record<HeroUISize, number> = { sm: 5, md: 6, lg: 7 };

const THUMB_SIZE: Record<HeroUISize, number> = {
  sm: 18,
  md: 22,
  lg: 26,
};

const RADIUS_CLASS: Record<HeroUIRadius, string> = {
  none: 'rounded-none',
  sm: 'rounded-[14px]',
  md: 'rounded-full',
  lg: 'rounded-full',
  full: 'rounded-full',
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function snap(value: number, step: number, min: number): number {
  if (step <= 0) return value;
  const stepped = Math.round((value - min) / step) * step + min;

  return parseFloat(stepped.toFixed(10));
}

export function Slider(props: SliderProps) {
  const {
    label,
    value: controlled,
    defaultValue,
    onChange,
    onChangeEnd,
    minValue = 0,
    maxValue = 100,
    step = 1,
    marks,
    color = 'primary',
    size = 'md',
    radius = 'full',
    fillOffset,
    startContent,
    endContent,
    showSteps,
    showTooltip,
    showOutline: _showOutline,
    hideValue,
    hideThumb,
    isDisabled,
    isRange,
    className,
    classNames,
    formatOptions,
    getValue,
    renderLabel,
    renderValue,
    renderThumb,
    rotate: _rotate,
    'aria-label': ariaLabel,
    dir: _dir,
    name,
  } = props;

  // Determine `range` mode from prop or value shape.
  const initial = (controlled ?? defaultValue ?? (isRange ? [minValue, maxValue] : minValue)) as SliderValue;
  const isControlled = controlled !== undefined;
  const isRangeMode = isRange ?? Array.isArray(initial);

  const [internal, setInternal] = React.useState<SliderValue>(initial);
  const current = isControlled ? (controlled as SliderValue) : internal;

  const trackRef = React.useRef<HTMLDivElement | null>(null);

  const setValue = (v: SliderValue, fireOnChange = true) => {
    if (!isControlled) setInternal(v);
    if (fireOnChange) onChange?.(v);
  };

  // Convert a value to a [0,1] percentage along the track.
  const pct = (v: number) => (v - minValue) / (maxValue - minValue) || 0;

  // Convert a pointer x relative to track-rect into a value.
  const valueFromPointer = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return minValue;
    const rect = el.getBoundingClientRect();
    let ratio = (clientX - rect.left) / rect.width;
    ratio = clamp(ratio, 0, 1);
    const raw = minValue + ratio * (maxValue - minValue);

    return clamp(snap(raw, step, minValue), minValue, maxValue);
  };

  /* ----- pointer drag ----- */
  const draggingIndexRef = React.useRef<number | null>(null);

  const beginDrag = (index: number) => (e: React.PointerEvent) => {
    if (isDisabled) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    draggingIndexRef.current = index;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (draggingIndexRef.current === null) return;
    const v = valueFromPointer(e.clientX);
    if (isRangeMode && Array.isArray(current)) {
      const next = [...current] as [number, number];
      next[draggingIndexRef.current] = v;
      // Keep order: a <= b
      if (next[0] > next[1]) {
        next.reverse();
        draggingIndexRef.current = draggingIndexRef.current === 0 ? 1 : 0;
      }
      setValue(next);
    } else {
      setValue(v);
    }
  };

  const endDrag = () => {
    if (draggingIndexRef.current === null) return;
    draggingIndexRef.current = null;
    onChangeEnd?.(current);
  };

  // Click on track → jump.
  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (isDisabled) return;
    const v = valueFromPointer(e.clientX);
    if (isRangeMode && Array.isArray(current)) {
      // Snap to the closest thumb.
      const distA = Math.abs(v - current[0]);
      const distB = Math.abs(v - current[1]);
      const idx = distA <= distB ? 0 : 1;
      const next = [...current] as [number, number];
      next[idx] = v;
      if (next[0] > next[1]) next.reverse();
      setValue(next);
      draggingIndexRef.current = idx;
    } else {
      setValue(v);
      draggingIndexRef.current = 0;
    }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  // Keyboard support for thumbs.
  const onThumbKey = (index: number) => (e: React.KeyboardEvent) => {
    if (isDisabled) return;
    let delta = 0;
    if (e.key === 'ArrowRight') delta = step;
    else if (e.key === 'ArrowLeft') delta = -step;
    else if (e.key === 'ArrowUp') delta = step;
    else if (e.key === 'ArrowDown') delta = -step;
    else if (e.key === 'Home') {
      e.preventDefault();
      const next =
        isRangeMode && Array.isArray(current)
          ? (index === 0 ? [minValue, current[1]] : [current[0], minValue]).sort((a, b) => a - b)
          : minValue;
      setValue(next);

      return;
    } else if (e.key === 'End') {
      e.preventDefault();
      const next =
        isRangeMode && Array.isArray(current)
          ? (index === 0 ? [maxValue, current[1]] : [current[0], maxValue]).sort((a, b) => a - b)
          : maxValue;
      setValue(next);

      return;
    } else {
      return;
    }
    e.preventDefault();
    if (isRangeMode && Array.isArray(current)) {
      const next = [...current] as [number, number];
      next[index] = clamp(snap(next[index] + delta, step, minValue), minValue, maxValue);
      if (next[0] > next[1]) next.reverse();
      setValue(next);
    } else {
      const v = clamp(snap((current as number) + delta, step, minValue), minValue, maxValue);
      setValue(v);
    }
  };

  /* ----- formatting ----- */
  const fmt = React.useMemo(() => {
    try {
      return new Intl.NumberFormat('en-US', formatOptions);
    } catch {
      return null;
    }
  }, [formatOptions]);

  const formatNum = (n: number) => (fmt ? fmt.format(n) : String(n));

  const valueLabel = (() => {
    if (getValue) return getValue(current);
    if (Array.isArray(current)) return `${formatNum(current[0])} – ${formatNum(current[1])}`;

    return formatNum(current as number);
  })();

  /* ----- render ----- */
  /*
   * The filled portion is a MARK. `HEROUI_COLOR_TEXT` is the brand corrected to
   * read against the theme (#2f5bea light / #c3d0fb dark for primary), which is
   * what a stroke on a track needs; `CLAY_FILL` is for painting under a label.
   * `default` marks in the theme foreground — citrine as a stroke measured
   * 1.29:1 on paper when the Tabs port checked it.
   */
  const fillColor = color === 'default' ? 'hsl(var(--heroui-foreground))' : HEROUI_COLOR_TEXT[color];

  /** The empty channel. A step down the surface ladder so it reads as cut in. */
  const trackFill = 'hsl(var(--heroui-content2))';

  /*
   * The thumb is ALWAYS the theme surface — never `CLAY_LABEL[color]`, which is
   * what `Switch` uses for its knob.
   *
   * The precedent does not transfer, and it took measuring to see why: a switch
   * knob sits on ONE ground, the track it is inside. A slider thumb straddles
   * TWO — the filled half and the empty half — and no single face can contrast
   * with both, because the two halves are at opposite ends of the luminance
   * range by construction.
   *
   * So the work is split. The FACE holds against one side and the RIM against
   * the other, and `CLAY_FILL.default` + the `control` mix flips them together
   * in each theme:
   *   light  white face  + dark rim  -> face beats the dark mark, rim beats the pale channel
   *   dark   near-black face + light rim -> face beats the light mark, rim beats the dark channel
   *
   * With `CLAY_LABEL[color]` this failed in dark for primary, success and danger
   * — a white thumb on a LIGHT mark (the mark is lightened in dark, correctly)
   * measured 2.36 / 1.92 / 2.34 on the face and 2.22 / 1.81 / 2.20 on the rim,
   * i.e. no boundary at all on the filled half.
   */
  const thumbFill = CLAY_FILL.default;

  const thumbPx = THUMB_SIZE[size];

  // Compute fill range (in pct) and thumb positions.
  const lo = Array.isArray(current) ? current[0] : Math.min(fillOffset ?? minValue, current as number);
  const hi = Array.isArray(current) ? current[1] : Math.max(fillOffset ?? minValue, current as number);
  const fillStart = pct(lo);
  const fillEnd = pct(hi);
  const fillPctW = Math.max(0, (fillEnd - fillStart) * 100);
  const fillPctL = fillStart * 100;

  const thumbs: Array<{ index: number; value: number }> = Array.isArray(current)
    ? [
        { index: 0, value: current[0] },
        { index: 1, value: current[1] },
      ]
    : [{ index: 0, value: current as number }];

  return (
    <div
      className={cn('flex w-full flex-col gap-2', className, classNames?.base)}
      data-disabled={isDisabled || undefined}
    >
      {label || (!hideValue && valueLabel != null) ? (
        <div className={cn('flex items-baseline justify-between gap-2', classNames?.labelWrapper)}>
          {label ? (
            <span className={cn('text-ink text-[13px] font-extrabold', classNames?.label)}>
              {renderLabel ? renderLabel({ children: label }) : label}
            </span>
          ) : (
            <span />
          )}
          {!hideValue ? (
            <span
              className={cn('text-ink text-[12px] font-extrabold', classNames?.value, classNames?.output)}
              dir='ltr'
              style={{ fontFeatureSettings: '"tnum"' }}
            >
              {renderValue ? renderValue({ children: valueLabel }) : valueLabel}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className={cn('flex items-center gap-2', classNames?.trackWrapper)}>
        {startContent ? <span className={classNames?.startContent}>{startContent}</span> : null}

        <div
          ref={trackRef}
          aria-label={ariaLabel}
          className='relative flex-1 touch-none select-none'
          onPointerDown={onTrackPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {/* Track */}
          <div
            className={cn(
              'clay-field relative w-full overflow-hidden',
              TRACK_HEIGHT[size],
              RADIUS_CLASS[radius],
              classNames?.track,
            )}
            style={{
              background: trackFill,
              // Tier 3: the channel is a hole. `clayVars({ inset: true })` gives
              // the two-sided groove; `.clay-field` carries the states from real
              // CSS, since a Tailwind `shadow-[var(--clay-rest)]` computes to none.
              ...clayVars(trackFill, { kind: 'control', depth: TRACK_DEPTH[size], inset: true }),
              cursor: isDisabled ? 'not-allowed' : 'pointer',
              opacity: isDisabled ? 0.5 : 1,
            }}
          >
            {/* Filler */}
            <div
              aria-hidden
              className={cn('absolute bottom-0 top-0', RADIUS_CLASS[radius], classNames?.filler)}
              style={{
                left: `${fillPctL}%`,
                width: `${fillPctW}%`,
                background: fillColor,
              }}
            />

            {/* Step ticks */}
            {showSteps && step > 0 ? (
              <div aria-hidden className='pointer-events-none absolute inset-0'>
                {(() => {
                  const ticks: number[] = [];
                  for (let v = minValue; v <= maxValue + 0.0001; v += step) ticks.push(v);

                  return ticks.map((tickValue) => {
                    const left = pct(tickValue) * 100;

                    return (
                      <span
                        key={tickValue}
                        className={cn('bg-line/50 absolute top-1/2 h-2 w-[2px] -translate-y-1/2', classNames?.step)}
                        style={{ left: `${left}%` }}
                      />
                    );
                  });
                })()}
              </div>
            ) : null}

            {/* Marks */}
            {marks?.length ? (
              <div aria-hidden className='pointer-events-none absolute -bottom-5 left-0 right-0'>
                {marks.map((m) => (
                  <span
                    key={String(m.value)}
                    className={cn('text-ink/70 absolute -translate-x-1/2 text-[10px] font-bold', classNames?.mark)}
                    style={{
                      left: `${pct(m.value) * 100}%`,
                      transform: 'translateX(-50%)',
                    }}
                  >
                    {m.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {/* Thumbs */}
          {!hideThumb &&
            thumbs.map(({ index, value }) => {
              const left = pct(value) * 100;
              const ariaProps = {
                role: 'slider',
                tabIndex: isDisabled ? -1 : 0,
                'aria-valuemin': minValue,
                'aria-valuemax': maxValue,
                'aria-valuenow': value,
                'aria-orientation': 'horizontal' as const,
                'aria-disabled': isDisabled || undefined,
              };

              const node = (
                <div
                  key={index}
                  {...ariaProps}
                  className={cn(
                    // Tier 1: the one part you grab, so it gets a real lip and a
                    // press that closes it — the knob sinks INTO the channel.
                    'clay-btn absolute top-1/2 inline-flex items-center justify-center rounded-full',
                    'border-[3px] border-[color:var(--clay-edge)]',
                    'transition-[box-shadow] duration-150 motion-reduce:transition-none',
                    'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[2px]',
                    'focus-visible:outline-[color:var(--clay-focus)]',
                    classNames?.thumb,
                  )}
                  onKeyDown={onThumbKey(index)}
                  onPointerDown={beginDrag(index)}
                  onPointerUp={endDrag}
                  style={
                    {
                      left: `${left}%`,
                      width: thumbPx,
                      height: thumbPx,
                      // No rotation — a clay object is square to the page.
                      transform: 'translate(-50%, -50%)',
                      background: thumbFill,
                      '--clay-focus': 'hsl(var(--heroui-foreground))',
                      // `control`: the knob is a small object whose rim is its
                      // boundary, and it has to hold against BOTH the filled and
                      // the empty half of the track.
                      ...clayVars(thumbFill, { kind: 'control', depth: 3 }),
                      cursor: isDisabled ? 'not-allowed' : 'grab',
                      touchAction: 'none',
                    } as React.CSSProperties
                  }
                >
                  {showTooltip ? (
                    <span
                      className='clay-surface absolute -top-9 inline-flex items-center justify-center rounded-[10px] border-[2px] border-[color:var(--clay-edge)] px-2 py-0.5 text-[11px] font-extrabold'
                      dir='ltr'
                      style={
                        {
                          // The chip is a small raised label, not a citrine
                          // sticker. It takes the same MARK the filler does, so
                          // the readout and the fill are visibly one thing.
                          background: fillColor,
                          color: color === 'default' ? 'hsl(var(--heroui-background))' : CLAY_LABEL[color],
                          ...clayVars(fillColor, { kind: 'control', depth: 3 }),
                          fontFeatureSettings: '"tnum"',
                          whiteSpace: 'nowrap',
                        } as React.CSSProperties
                      }
                    >
                      {formatNum(value)}
                    </span>
                  ) : null}
                </div>
              );

              return renderThumb ? (
                <React.Fragment key={index}>{renderThumb({ index, value, ariaProps })}</React.Fragment>
              ) : (
                node
              );
            })}
        </div>

        {endContent ? <span className={classNames?.endContent}>{endContent}</span> : null}
      </div>

      {/* Hidden form-friendly inputs */}
      {name ? (
        Array.isArray(current) ? (
          <>
            <input type='hidden' name={`${name}[0]`} value={current[0]} />
            <input type='hidden' name={`${name}[1]`} value={current[1]} />
          </>
        ) : (
          <input type='hidden' name={name} value={current as number} />
        )
      ) : null}
    </div>
  );
}

Slider.displayName = 'Slider';
