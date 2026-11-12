import React, { useCallback } from 'react';

import { Button, Divider, Slider, Switch } from '@repo/ui';
import { motion } from 'motion/react';

import type { LineShape, StrokeSettings as StrokeSettingsType } from './types';

import { MAX_STROKE_WIDTH, MIN_STROKE_WIDTH } from './types';
import { PenSizePicker } from './PenSizePicker';
import { PEN_SIZES_MM, penMmToPx, penPxToMm } from './utils/penSizes';
import { useWbStrings } from '../../i18n/context';

/** The fine slider spans 0.26–5 mm, where pen sizes live (a wider older width stretches it). */
const FINE_SLIDER_MAX_PX = penMmToPx(5);

const LINE_SHAPE_OPTIONS: { mode: LineShape; label: 'stroke.lineFree' | 'stroke.lineHold' | 'stroke.lineAlways' }[] = [
  { mode: 'free', label: 'stroke.lineFree' },
  { mode: 'hold', label: 'stroke.lineHold' },
  { mode: 'always', label: 'stroke.lineAlways' },
];

interface StrokeSettingsProps {
  settings: StrokeSettingsType;
  onChange: (settings: StrokeSettingsType) => void;
  smoothingEnabled?: boolean;
  onSmoothingChange?: (enabled: boolean) => void;
}

const StrokeSettingsComponent: React.FC<StrokeSettingsProps> = ({
  settings,
  onChange,
  smoothingEnabled,
  onSmoothingChange,
}) => {
  const { t } = useWbStrings();
  // No rounding: a size chip sets an exact width (0.3 mm = 1.13 px), which a 0.5 px grid would move.
  const clampWidth = useCallback((width: number) => {
    return Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, width));
  }, []);

  const handleWidthChange = useCallback(
    (width: number) => {
      onChange({ ...settings, width: clampWidth(width) });
    },
    [clampWidth, settings, onChange],
  );

  const handleWidthSliderChange = useCallback(
    (value: number | number[]) => {
      handleWidthChange(Array.isArray(value) ? value[0] : value);
    },
    [handleWidthChange],
  );

  const handleOpacityChange = useCallback(
    (value: number | number[]) => {
      const opacity = Array.isArray(value) ? value[0] : value;

      onChange({ ...settings, opacity });
    },
    [settings, onChange],
  );

  return (
    <motion.div
      animate={{ opacity: 1, scale: 1 }}
      className='flex w-[min(calc(100vw-2rem),18rem)] flex-col gap-4 p-3'
      initial={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
    >
      {/* Preview Line */}
      {/* The preview is a strip of PAPER: ink colours are chosen for the white page, so a black nib on
          a dark-theme panel would vanish here while drawing perfectly well on the board. */}
      <div className='bg-default-100 flex items-center justify-center rounded-md p-3 dark:bg-white'>
        <svg className='h-16 w-full' viewBox='0 0 180 72'>
          <line
            stroke={settings.color}
            strokeLinecap='round'
            strokeDasharray={settings.dashed ? `${settings.width * 1.5} ${settings.width * 2.5}` : undefined}
            strokeOpacity={settings.opacity}
            strokeWidth={settings.width}
            x1='10'
            x2='170'
            y1='36'
            y2='36'
          />
        </svg>
      </div>

      {/* Pen size in real mm (0.3 mm, 0.5 mm… like the number on a pen), with a fine slider above it
          for any width in between. */}
      <div className='flex flex-col gap-2'>
        <Slider
          aria-label={t('stroke.sizeCustom')}
          color='primary'
          getValue={(value) => t('stroke.sizeMm', { n: penPxToMm(Array.isArray(value) ? value[0]! : value).toFixed(1) })}
          label={t('stroke.size')}
          maxValue={Math.min(MAX_STROKE_WIDTH, Math.max(FINE_SLIDER_MAX_PX, settings.width))}
          minValue={MIN_STROKE_WIDTH}
          size='sm'
          step={0.1}
          value={settings.width}
          onChange={handleWidthSliderChange}
        />
        <PenSizePicker label={t('stroke.size')} sizes={PEN_SIZES_MM} valuePx={settings.width} onChange={handleWidthChange} />
      </div>

      {/* Opacity, 10–100 % (the highlighter keeps its own see-through look) */}
      <Slider
        aria-label={t('stroke.opacity')}
        color='primary'
        getValue={(value) => `${Math.round((Array.isArray(value) ? value[0]! : value) * 100)}%`}
        label={t('stroke.opacity')}
        maxValue={1}
        minValue={0.1}
        size='sm'
        step={0.05}
        value={settings.opacity}
        onChange={handleOpacityChange}
      />

      {/* Line mode: freehand / straight on hold / always straight, plus dashed */}
      <Divider />
      <div className='flex flex-col gap-3'>
        <p className='text-foreground text-xs font-medium'>{t('stroke.lineMode')}</p>
        <div className='grid grid-cols-3 gap-2'>
          {LINE_SHAPE_OPTIONS.map((option) => {
            const isSelected = (settings.lineShape ?? 'free') === option.mode;

            return (
              <Button
                key={option.mode}
                className={`h-auto min-h-8 min-w-0 whitespace-normal px-1 py-1 text-xs leading-tight ${
                  isSelected
                    ? 'border border-sky-200 bg-sky-50 text-sky-800'
                    : 'border border-slate-200 bg-slate-50 text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-ink/75'
                }`}
                size='sm'
                variant='flat'
                onPress={() => onChange({ ...settings, lineShape: option.mode })}
              >
                {t(option.label)}
              </Button>
            );
          })}
        </div>
        <div className='flex items-center justify-between'>
          <p className='text-foreground text-xs font-medium'>{t('stroke.dashed')}</p>
          <Switch
            aria-label={t('stroke.dashed')}
            isSelected={settings.dashed === true}
            size='sm'
            onValueChange={(dashed) => onChange({ ...settings, dashed })}
          />
        </div>
        {/* The pen and the script pen get thicker when pressed harder; off = an even line. */}
        <div className='flex items-center justify-between gap-3' data-pen-pressure={settings.pressure !== false ? 'on' : 'off'}>
          <p className='text-foreground text-xs font-medium'>{t('stroke.pressure')}</p>
          <Switch
            aria-label={t('stroke.pressure')}
            isSelected={settings.pressure !== false}
            size='sm'
            onValueChange={(pressure) => onChange({ ...settings, pressure })}
          />
        </div>
      </div>

      {/* Stroke Smoothing Toggle */}
      {onSmoothingChange !== undefined && (
        <>
          <Divider />
          <div className='flex items-center justify-between'>
            <p className='text-foreground text-xs font-medium'>{t('stroke.smoothing')}</p>
            <Switch aria-label={t('stroke.smoothing')} isSelected={smoothingEnabled} size='sm' onValueChange={onSmoothingChange} />
          </div>
        </>
      )}
    </motion.div>
  );
};

const MemoizedStrokeSettings = React.memo(StrokeSettingsComponent);

export { MemoizedStrokeSettings as StrokeSettings };
export default MemoizedStrokeSettings;
