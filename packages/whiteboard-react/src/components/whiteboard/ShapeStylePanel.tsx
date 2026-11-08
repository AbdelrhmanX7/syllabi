import React, { useEffect, useRef, useState } from 'react';

import { ColorSwatch, Slider } from '@repo/ui';

import { HsvPicker } from './HsvPicker';
import { INK_COLORS, NO_FILL, QUICK_FILL_TINTS } from './palette';
import { SHAPE_WIDTHS } from './utils/shapeStyle';
import { useWbStrings } from '../../i18n/context';

import type { ShapeStylePatch } from './utils/shapeStylePaint';
import type { ShapeDash, ShapeEdges, ShapeFillStyle, ShapeRough } from './utils/shapeStyle';
import type { ReactNode } from 'react';

/**
 * The shape panel: small rows of square toggles, one row per choice — outline colour, background,
 * fill pattern, outline width, outline style, sloppiness, edges — and an opacity slider. The same panel
 * sets the next shape (shape tools) and restyles a selection (only the rows that fit it are shown).
 *
 * Flat rows only (it lives inside scroll boxes); when taller than its room it scrolls, with a soft shade
 * at the edge that has more to show.
 */

export interface ShapeStyleRows {
  stroke?: boolean;
  fill?: boolean;
  /** Width, outline style, sloppiness and edges. */
  shape?: boolean;
}

interface ShapeStylePanelProps {
  value: ShapeStylePatch;
  rows: ShapeStyleRows;
  onChange: (patch: ShapeStylePatch) => void;
  /** Tailwind max-height for the scroll box. */
  maxHeightClassName?: string;
  /** A max height in px instead (wins over the class). */
  maxHeight?: number;
  className?: string;
}

const STROKE_SWATCHES = INK_COLORS.slice(0, 5);

const TOGGLE_CLASS =
  'text-ink inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-ink/5 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1';
const TOGGLE_ON_CLASS = 'bg-sky-100 text-sky-900 hover:bg-sky-100 dark:bg-sky-400/25 dark:text-sky-50 dark:hover:bg-sky-400/25';

/** A checkerboard: the usual sign for «nothing here». Plain repeating squares, no blending. */
const CHECKER_STYLE: React.CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage:
    'linear-gradient(45deg, #cbd5e1 25%, transparent 25%), linear-gradient(-45deg, #cbd5e1 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #cbd5e1 75%), linear-gradient(-45deg, transparent 75%, #cbd5e1 75%)',
  backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0',
  backgroundSize: '8px 8px',
};

/** The scroll shade: the panel's own colour over a soft ink edge, pinned to the content (old WebViews too). */
const SCROLL_SHADE_STYLE: React.CSSProperties = {
  background: [
    'linear-gradient(var(--paper, #fbfaf6) 30%, rgba(255,255,255,0)) center top / 100% 28px no-repeat local',
    'linear-gradient(rgba(255,255,255,0), var(--paper, #fbfaf6) 70%) center bottom / 100% 28px no-repeat local',
    'linear-gradient(rgba(15,23,42,0.14), rgba(15,23,42,0)) center top / 100% 10px no-repeat scroll',
    'linear-gradient(rgba(15,23,42,0), rgba(15,23,42,0.14)) center bottom / 100% 10px no-repeat scroll',
    'var(--paper, #fbfaf6)',
  ].join(', '),
};

const Icon = ({ children }: { children: ReactNode }) => (
  <svg aria-hidden className='h-5 w-5' fill='none' stroke='currentColor' strokeLinecap='round' strokeLinejoin='round' strokeWidth={1.75} viewBox='0 0 20 20'>
    {children}
  </svg>
);

const FILL_ICONS: Record<ShapeFillStyle, ReactNode> = {
  hatch: (
    <Icon>
      <rect height='14' rx='2' width='14' x='3' y='3' />
      <path d='M3.5 11.5 11.5 3.5M6.5 16.5 16.5 6.5M11 16.5 16.5 11' strokeWidth={1.25} />
    </Icon>
  ),
  cross: (
    <Icon>
      <rect height='14' rx='2' width='14' x='3' y='3' />
      <path d='M3.5 11.5 11.5 3.5M6.5 16.5 16.5 6.5M8.5 3.5 16.5 11.5M3.5 8.5 11.5 16.5' strokeWidth={1.25} />
    </Icon>
  ),
  solid: (
    <Icon>
      <rect fill='currentColor' height='14' rx='2' width='14' x='3' y='3' />
    </Icon>
  ),
};

const DASH_ICONS: Record<ShapeDash, ReactNode> = {
  solid: (
    <Icon>
      <path d='M3 10h14' strokeWidth={2} />
    </Icon>
  ),
  dashed: (
    <Icon>
      <path d='M3 10h14' strokeDasharray='4 3' strokeLinecap='butt' strokeWidth={2} />
    </Icon>
  ),
  dotted: (
    <Icon>
      <path d='M3 10h14' strokeDasharray='0.01 3.5' strokeWidth={2.25} />
    </Icon>
  ),
};

const ROUGH_ICONS: Record<ShapeRough, ReactNode> = {
  0: (
    <Icon>
      <path d='M3 14c3-7 9-9 14-8' />
    </Icon>
  ),
  1: (
    <Icon>
      <path d='M3 14c2-5 5-7 8-7.5S15 7 17 6' />
      <path d='M3.5 15c3-6 7-8.5 13-7.5' strokeWidth={1.25} />
    </Icon>
  ),
  2: (
    <Icon>
      <path d='M3 15c1-3 2.5-2 3.5-5s3-2 4-4 3.5-.5 6.5-1' />
      <path d='M3 12.5c2 0 2.5-3 5-3.5s3 1 5-1.5 2.5-1.5 4-1' strokeWidth={1.25} />
    </Icon>
  ),
};

const EDGE_ICONS: Record<ShapeEdges, ReactNode> = {
  sharp: (
    <Icon>
      <path d='M4 16V4h12' strokeLinecap='butt' strokeLinejoin='miter' />
    </Icon>
  ),
  round: (
    <Icon>
      <path d='M4 16V10a6 6 0 0 1 6-6h6' />
    </Icon>
  ),
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-1'>
      <span className='text-ink/70 px-0.5 text-xs font-semibold'>{label}</span>
      <div aria-label={label} className='flex flex-wrap items-center gap-1' role='group'>
        {children}
      </div>
    </div>
  );
}

function Toggle({ on, label, onPress, children, data }: { on: boolean; label: string; onPress: () => void; children: ReactNode; data?: string }) {
  return (
    <button
      aria-label={label}
      aria-pressed={on}
      className={`${TOGGLE_CLASS} ${on ? TOGGLE_ON_CLASS : ''}`}
      data-value={data}
      title={label}
      type='button'
      onClick={onPress}
    >
      {children}
    </button>
  );
}

const sameColor = (a: string | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();
const isNone = (color: string | undefined) => !color || color === NO_FILL;

export function ShapeStylePanel({ value, rows, onChange, maxHeightClassName = 'max-h-[min(60vh,420px)]', maxHeight, className = '' }: ShapeStylePanelProps) {
  const { t } = useWbStrings();
  const [custom, setCustom] = useState<'stroke' | 'fill' | null>(null);
  // The slider shows its own value while dragged and applies once on release (one undo step, one save).
  const [dragOpacity, setDragOpacity] = useState<number | null>(null);
  const opacity = dragOpacity ?? Math.round((value.opacity ?? 1) * 100);
  // Arrow keys move the slider without a release: those apply after a short pause instead.
  const opacityTimerRef = useRef<number | null>(null);
  const commitOpacity = (percent: number) => {
    if (opacityTimerRef.current !== null) window.clearTimeout(opacityTimerRef.current);
    opacityTimerRef.current = null;
    setDragOpacity(null);
    onChange({ opacity: percent / 100 });
  };

  useEffect(
    () => () => {
      if (opacityTimerRef.current !== null) window.clearTimeout(opacityTimerRef.current);
    },
    [],
  );
  const strokeIsCustom = value.stroke !== undefined && !STROKE_SWATCHES.some((color) => sameColor(value.stroke, color));
  const fillIsCustom = !isNone(value.fill) && !QUICK_FILL_TINTS.some((color) => sameColor(value.fill, color));

  const customDot = <span aria-hidden className='h-full w-full rounded-full' style={{ background: 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)' }} />;

  return (
    <div
      aria-label={t('shape.panel')}
      className={`flex w-[14.5rem] flex-col gap-2.5 overflow-y-auto overscroll-contain p-2 ${maxHeight ? '' : maxHeightClassName} ${className}`}
      data-testid='wb-shape-style'
      style={maxHeight ? { ...SCROLL_SHADE_STYLE, maxHeight } : SCROLL_SHADE_STYLE}
    >
      {rows.stroke ? (
        <Row label={t('shape.stroke')}>
          {STROKE_SWATCHES.map((color) => (
            <ColorSwatch
              key={color}
              color={color}
              data-color={color}
              isSelected={sameColor(value.stroke, color)}
              label={color}
              size='sm'
              onClick={() => onChange({ stroke: color })}
            />
          ))}
          <ColorSwatch
            color={strokeIsCustom ? value.stroke! : null}
            isSelected={strokeIsCustom || custom === 'stroke'}
            label={t('shape.custom')}
            size='sm'
            onClick={() => setCustom((current) => (current === 'stroke' ? null : 'stroke'))}
          >
            {customDot}
          </ColorSwatch>
          {custom === 'stroke' ? (
            <div className='w-full pt-1'>
              <HsvPicker value={value.stroke ?? INK_COLORS[0]} onChange={(stroke) => onChange({ stroke })} />
            </div>
          ) : null}
        </Row>
      ) : null}

      {rows.fill ? (
        <Row label={t('shape.background')}>
          {QUICK_FILL_TINTS.map((color) =>
            color === NO_FILL ? (
              <ColorSwatch
                key={color}
                color={null}
                data-color={color}
                isSelected={isNone(value.fill)}
                label={t('shape.noBackground')}
                size='sm'
                onClick={() => onChange({ fill: NO_FILL })}
              >
                <span aria-hidden className='h-full w-full rounded-full' style={CHECKER_STYLE} />
              </ColorSwatch>
            ) : (
              <ColorSwatch
                key={color}
                color={color}
                data-color={color}
                isSelected={sameColor(value.fill, color)}
                label={color}
                size='sm'
                onClick={() => onChange({ fill: color })}
              />
            ),
          )}
          <ColorSwatch
            color={fillIsCustom ? value.fill! : null}
            isSelected={fillIsCustom || custom === 'fill'}
            label={t('shape.custom')}
            size='sm'
            onClick={() => setCustom((current) => (current === 'fill' ? null : 'fill'))}
          >
            {customDot}
          </ColorSwatch>
          {custom === 'fill' ? (
            <div className='w-full pt-1'>
              <HsvPicker value={isNone(value.fill) ? QUICK_FILL_TINTS[3] : value.fill!} onChange={(fill) => onChange({ fill })} />
            </div>
          ) : null}
        </Row>
      ) : null}

      {rows.fill ? (
        <Row label={t('shape.fill')}>
          {(['hatch', 'cross', 'solid'] as const).map((style) => (
            <Toggle
              key={style}
              data={style}
              label={t(style === 'hatch' ? 'shape.fillHatch' : style === 'cross' ? 'shape.fillCross' : 'shape.fillSolid')}
              on={(value.fillStyle ?? 'solid') === style}
              onPress={() => onChange({ fillStyle: style })}
            >
              {FILL_ICONS[style]}
            </Toggle>
          ))}
        </Row>
      ) : null}

      {rows.shape ? (
        <>
          <Row label={t('shape.width')}>
            {SHAPE_WIDTHS.map((width, index) => (
              <Toggle
                key={width}
                data={String(width)}
                label={t(index === 0 ? 'shape.widthThin' : index === 1 ? 'shape.widthMedium' : 'shape.widthThick')}
                on={value.width === width}
                onPress={() => onChange({ width })}
              >
                <Icon>
                  <path d='M3 10h14' strokeWidth={index === 0 ? 1.25 : index === 1 ? 2.5 : 4.5} />
                </Icon>
              </Toggle>
            ))}
          </Row>
          <Row label={t('shape.dash')}>
            {(['solid', 'dashed', 'dotted'] as const).map((dash) => (
              <Toggle
                key={dash}
                data={dash}
                label={t(dash === 'solid' ? 'shape.dashSolid' : dash === 'dashed' ? 'shape.dashDashed' : 'shape.dashDotted')}
                on={(value.dash ?? 'solid') === dash}
                onPress={() => onChange({ dash })}
              >
                {DASH_ICONS[dash]}
              </Toggle>
            ))}
          </Row>
          <Row label={t('shape.rough')}>
            {([0, 1, 2] as const).map((rough) => (
              <Toggle
                key={rough}
                data={String(rough)}
                label={t(rough === 0 ? 'shape.rough0' : rough === 1 ? 'shape.rough1' : 'shape.rough2')}
                on={(value.rough ?? 0) === rough}
                onPress={() => onChange({ rough })}
              >
                {ROUGH_ICONS[rough]}
              </Toggle>
            ))}
          </Row>
          <Row label={t('shape.edges')}>
            {(['sharp', 'round'] as const).map((edges) => (
              <Toggle
                key={edges}
                data={edges}
                label={t(edges === 'sharp' ? 'shape.edgesSharp' : 'shape.edgesRound')}
                on={(value.edges ?? 'sharp') === edges}
                onPress={() => onChange({ edges })}
              >
                {EDGE_ICONS[edges]}
              </Toggle>
            ))}
          </Row>
        </>
      ) : null}

      <div className='px-1.5 pb-0.5'>
        <Slider
          aria-label={t('shape.opacity')}
          color='primary'
          getValue={(next) => `${Array.isArray(next) ? next[0] : next}%`}
          label={t('shape.opacity')}
          maxValue={100}
          minValue={5}
          size='sm'
          step={5}
          value={opacity}
          onChange={(next) => {
            const percent = Array.isArray(next) ? next[0]! : next;

            setDragOpacity(percent);
            if (opacityTimerRef.current !== null) window.clearTimeout(opacityTimerRef.current);
            opacityTimerRef.current = window.setTimeout(() => commitOpacity(percent), 600);
          }}
          onChangeEnd={(next) => commitOpacity(Array.isArray(next) ? next[0]! : next)}
        />
      </div>
    </div>
  );
}
