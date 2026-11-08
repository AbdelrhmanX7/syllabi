import React, { useCallback } from 'react';

import { Button, Divider, Slider, Switch } from '@repo/ui';
import { Minus, Plus } from 'lucide-react';
import { motion } from 'motion/react';

import type { LineShape, StrokeSettings as StrokeSettingsType } from './types';

import { MAX_STROKE_WIDTH, MIN_STROKE_WIDTH, STROKE_WIDTHS } from './types';
import { useWbStrings } from '../../i18n/context';

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
  const clampWidth = useCallback((width: number) => {
    return Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, Math.round(width * 2) / 2));
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
      <div className='bg-default-100 flex items-center justify-center rounded-lg p-3 dark:bg-white'>
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

      {/* Width Selector */}
      <div className='flex flex-col gap-2'>
        {/* Label and an inline − value + stepper on ONE row: no separate input row under the slider. */}
        <div className='flex items-center justify-between gap-2'>
          <p className='text-foreground text-xs font-medium'>{t('stroke.width')}</p>
          <div className='border-ink bg-paper text-ink flex h-8 items-stretch overflow-hidden rounded-full border-[1.5px]'>
            <button
              aria-label={t('stroke.widthPx') + ' −'}
              className='hover:bg-paper-2 flex w-8 items-center justify-center disabled:opacity-40'
              disabled={settings.width <= MIN_STROKE_WIDTH}
              type='button'
              onClick={() => handleWidthChange(Math.max(MIN_STROKE_WIDTH, settings.width - 0.5))}
            >
              <Minus className='h-3.5 w-3.5' />
            </button>
            <label className='border-ink/15 flex items-center gap-0.5 border-x px-1.5'>
              <input
                aria-label={t('stroke.widthPx')}
                className='w-8 bg-transparent text-center text-sm font-bold tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
                inputMode='decimal'
                max={MAX_STROKE_WIDTH}
                min={MIN_STROKE_WIDTH}
                step={0.5}
                type='number'
                value={settings.width}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= MIN_STROKE_WIDTH && n <= MAX_STROKE_WIDTH) handleWidthChange(n);
                }}
              />
              <span className='text-ink/55 text-[11px] font-semibold'>px</span>
            </label>
            <button
              aria-label={t('stroke.widthPx') + ' +'}
              className='hover:bg-paper-2 flex w-8 items-center justify-center disabled:opacity-40'
              disabled={settings.width >= MAX_STROKE_WIDTH}
              type='button'
              onClick={() => handleWidthChange(Math.min(MAX_STROKE_WIDTH, settings.width + 0.5))}
            >
              <Plus className='h-3.5 w-3.5' />
            </button>
          </div>
        </div>
        <Slider
          aria-label={t('stroke.widthPx')}
          color='primary'
          maxValue={MAX_STROKE_WIDTH}
          minValue={MIN_STROKE_WIDTH}
          size='sm'
          step={0.5}
          value={settings.width}
          onChange={handleWidthSliderChange}
        />
        <div className='flex items-center justify-between gap-1'>
          {STROKE_WIDTHS.map((w) => (
            <button
              key={w}
              aria-label={t('stroke.widthN', { n: w })}
              className={`hover:bg-default-200 flex cursor-pointer items-center justify-center rounded-full transition-all ${
                settings.width === w ? 'bg-primary/10 ring-primary ring-2' : 'bg-default-100'
              }`}
              style={{ width: 32, height: 32 }}
              type='button'
              onClick={() => handleWidthChange(w)}
            >
              <div
                className='rounded-full'
                style={{
                  width: Math.min(w + 2, 20),
                  height: Math.min(w + 2, 20),
                  backgroundColor:
                    settings.width === w ? 'hsl(var(--heroui-primary))' : 'hsl(var(--heroui-default-500))',
                }}
              />
            </button>
          ))}
        </div>
      </div>

      {/* Opacity Slider */}
      <div className='flex flex-col gap-2'>
        <p className='text-foreground text-xs font-medium'>{t('stroke.opacity')}</p>
        <Slider
          aria-label={t('stroke.opacity')}
          color='primary'
          maxValue={1}
          minValue={0.1}
          size='sm'
          step={0.1}
          value={settings.opacity}
          onChange={handleOpacityChange}
        />
        <p className='text-default-400 text-center text-xs'>{Math.round(settings.opacity * 100)}%</p>
      </div>

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
