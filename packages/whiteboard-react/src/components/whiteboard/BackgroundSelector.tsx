import React, { useCallback } from 'react';

import { Button, Slider } from '@repo/ui';
import { motion } from 'motion/react';

import { PAPER_SPACING_MM_MAX, PAPER_SPACING_MM_MIN } from './types';
import { boardPxToMm, LEGACY_PATTERN_SPACING_PX, spacingPresetsFor } from './utils/paperSpacing';

import type { BackgroundType } from './types';
import { useWbStrings } from '../../i18n/context';
import type { WbStringKey } from '../../i18n/strings';

interface BackgroundSelectorProps {
  backgroundType: BackgroundType;
  hasBackgroundImage: boolean;
  backgroundImageOpacity: number;
  onChange: (type: BackgroundType) => void;
  onBackgroundImageOpacityChange: (opacity: number) => void;
  onClearBackgroundImage: () => void;
  onUploadBackgroundImage: () => void;
  /** The board's paper spacing (mm); absent = the original spacing. Shown with the control below. */
  paperSpacingMm?: number;
  /** Present = the spacing control is offered (host opt-in, `WhiteboardEditor.allowPaperSpacing`). */
  onPaperSpacingChange?: (mm: number) => void;
}

const backgrounds: { type: BackgroundType; label: WbStringKey }[] = [
  { type: 'blank', label: 'bg.blank' },
  { type: 'grid', label: 'bg.grid' },
  { type: 'lined', label: 'bg.lined' },
  { type: 'dotted', label: 'bg.dotted' },
];

const BackgroundPreview: React.FC<{ type: BackgroundType }> = ({ type }) => {
  return (
    <svg className='border-default-300 h-8 w-10 rounded border bg-white' viewBox='0 0 40 32'>
      {type === 'grid' && (
        <g stroke='#d1d5db' strokeWidth='0.5'>
          <line x1='10' x2='10' y1='0' y2='32' />
          <line x1='20' x2='20' y1='0' y2='32' />
          <line x1='30' x2='30' y1='0' y2='32' />
          <line x1='0' x2='40' y1='8' y2='8' />
          <line x1='0' x2='40' y1='16' y2='16' />
          <line x1='0' x2='40' y1='24' y2='24' />
        </g>
      )}
      {type === 'lined' && (
        <g stroke='#d1d5db' strokeWidth='0.5'>
          <line x1='0' x2='40' y1='8' y2='8' />
          <line x1='0' x2='40' y1='16' y2='16' />
          <line x1='0' x2='40' y1='24' y2='24' />
        </g>
      )}
      {type === 'dotted' && (
        <g fill='#d1d5db'>
          <circle cx='10' cy='8' r='1' />
          <circle cx='20' cy='8' r='1' />
          <circle cx='30' cy='8' r='1' />
          <circle cx='10' cy='16' r='1' />
          <circle cx='20' cy='16' r='1' />
          <circle cx='30' cy='16' r='1' />
          <circle cx='10' cy='24' r='1' />
          <circle cx='20' cy='24' r='1' />
          <circle cx='30' cy='24' r='1' />
        </g>
      )}
    </svg>
  );
};

const formatMm = (mm: number | string) => `${mm} mm`;

/** Presets for the paper in use plus a fine slider; 44px targets for a finger or a pen. */
const PaperSpacingControl: React.FC<{ type: BackgroundType; value?: number; onChange: (mm: number) => void }> = ({
  type,
  value,
  onChange,
}) => {
  const { t } = useWbStrings();
  const presets = spacingPresetsFor(type);
  const shown = value ?? Math.round(boardPxToMm(LEGACY_PATTERN_SPACING_PX) * 10) / 10;

  return (
    <div className='border-divider flex flex-col gap-2 border-t pt-2' data-wb-paper-spacing>
      <div className='flex items-center justify-between'>
        <p className='text-foreground text-xs font-medium'>{t('bg.spacing.title')}</p>
        <span className='text-default-500 text-xs tabular-nums'>
          {value === undefined ? t('bg.spacing.default') : formatMm(shown.toFixed(1))}
        </span>
      </div>
      <div className='grid grid-cols-3 gap-1.5'>
        {presets.map((preset) => (
          <button
            key={preset.id}
            className={`flex h-11 flex-col items-center justify-center rounded-lg text-[11px] font-medium transition-all ${
              value !== undefined && Math.abs(value - preset.mm) < 0.05 ? 'bg-primary/10 ring-primary ring-2' : 'bg-default-50 hover:bg-default-100'
            }`}
            data-wb-spacing-preset={preset.mm}
            type='button'
            onClick={() => onChange(preset.mm)}
          >
            <span>{t(`bg.spacing.${preset.id}` as WbStringKey)}</span>
            <span className='text-default-400 tabular-nums'>{formatMm(preset.mm)}</span>
          </button>
        ))}
      </div>
      <Slider
        aria-label={t('bg.spacing.aria')}
        color='primary'
        maxValue={PAPER_SPACING_MM_MAX}
        minValue={PAPER_SPACING_MM_MIN}
        size='md'
        step={0.1}
        value={shown}
        onChange={(next) => onChange(Array.isArray(next) ? next[0]! : next)}
      />
    </div>
  );
};

const BackgroundSelector: React.FC<BackgroundSelectorProps> = ({
  backgroundType,
  hasBackgroundImage,
  backgroundImageOpacity,
  onChange,
  onBackgroundImageOpacityChange,
  onClearBackgroundImage,
  onUploadBackgroundImage,
  paperSpacingMm,
  onPaperSpacingChange,
}) => {
  const { t } = useWbStrings();
  const handleSelect = useCallback(
    (type: BackgroundType) => {
      onChange(type);
    },
    [onChange],
  );

  return (
    <motion.div
      animate={{ opacity: 1, scale: 1 }}
      className='flex w-[min(calc(100vw-2rem),18rem)] flex-col gap-3 p-3'
      initial={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
    >
      <div className='space-y-1'>
        <p className='text-foreground text-xs font-medium'>{t('bg.title')}</p>
        <p className='text-default-400 text-[11px]'>
          {t('bg.hint')}
        </p>
      </div>
      <div className='grid grid-cols-2 gap-2'>
        {backgrounds.map(({ type, label }) => (
          <button
            key={type}
            className={`hover:bg-default-100 flex cursor-pointer flex-col items-center gap-1.5 rounded-lg p-2 transition-all ${
              backgroundType === type ? 'bg-primary/10 ring-primary ring-2' : 'bg-default-50'
            }`}
            type='button'
            onClick={() => handleSelect(type)}
          >
            <BackgroundPreview type={type} />
            <span className='text-foreground text-[10px] font-medium'>{t(label)}</span>
          </button>
        ))}
      </div>

      {onPaperSpacingChange && spacingPresetsFor(backgroundType).length > 0 ? (
        <PaperSpacingControl type={backgroundType} value={paperSpacingMm} onChange={onPaperSpacingChange} />
      ) : null}

      <div className='border-divider flex flex-col gap-2 border-t pt-2'>
        <Button
          className='w-full justify-center'
          color='primary'
          size='sm'
          variant='flat'
          onPress={onUploadBackgroundImage}
        >
          {hasBackgroundImage ? t('bg.changeImage') : t('bg.uploadImage')}
        </Button>

        {hasBackgroundImage && (
          <>
            <div className='bg-default-50 flex flex-col gap-2 rounded-xl px-3 py-2'>
              <div className='flex items-center justify-between'>
                <p className='text-foreground text-xs font-medium'>{t('bg.imageOpacity')}</p>
                <span className='text-default-400 text-xs'>{Math.round(backgroundImageOpacity * 100)}%</span>
              </div>
              <Slider
                aria-label={t('bg.imageOpacityAria')}
                color='primary'
                maxValue={1}
                minValue={0.05}
                size='sm'
                step={0.05}
                value={backgroundImageOpacity}
                onChange={(value) => onBackgroundImageOpacityChange(Array.isArray(value) ? value[0] : value)}
              />
            </div>

            <Button
              className='w-full justify-center'
              color='danger'
              size='sm'
              variant='light'
              onPress={onClearBackgroundImage}
            >
              {t('bg.removeImage')}
            </Button>
          </>
        )}
      </div>
    </motion.div>
  );
};

const MemoizedBackgroundSelector = React.memo(BackgroundSelector);

export { MemoizedBackgroundSelector as BackgroundSelector };
export default MemoizedBackgroundSelector;
