import React, { useCallback } from 'react';

import { Button, Divider, Slider, Switch } from '@repo/ui';
import { Eraser, ScanSearch } from 'lucide-react';
import { motion } from 'motion/react';

import type { EraserMode, WholeHandEraserSettings } from './types';
import { useWbStrings } from '../../i18n/context';
import type { WbStringKey } from '../../i18n/strings';

const WHOLE_HAND_COUNT_MIN = 2;
const WHOLE_HAND_COUNT_MAX = 10;
const WHOLE_HAND_SIZE_MIN = 16;
const WHOLE_HAND_SIZE_MAX = 200;
const WHOLE_HAND_PADDING_MIN = 0;
const WHOLE_HAND_PADDING_MAX = 60;

interface EraserSettingsProps {
  forceObjectMode?: boolean;
  mode: EraserMode;
  size: number;
  /** Whole-hand (palm) eraser settings. When both this and onWholeHandEraserChange are provided, the
   *  whole-hand controls render in this menu. */
  wholeHandEraser?: WholeHandEraserSettings;
  onModeChange: (mode: EraserMode) => void;
  onSizeChange: (size: number) => void;
  onWholeHandEraserChange?: (next: WholeHandEraserSettings) => void;
}

const ERASER_MODES: Array<{
  description: WbStringKey;
  icon: React.ReactNode;
  label: WbStringKey;
  value: EraserMode;
}> = [
  {
    value: 'partial',
    label: 'eraser.partial',
    description: 'eraser.partialHint',
    icon: <Eraser className='h-4 w-4' />,
  },
  {
    value: 'object',
    label: 'eraser.object',
    description: 'eraser.objectHint',
    icon: <ScanSearch className='h-4 w-4' />,
  },
];

const EraserSettings: React.FC<EraserSettingsProps> = ({
  forceObjectMode = false,
  mode,
  size,
  wholeHandEraser,
  onModeChange,
  onSizeChange,
  onWholeHandEraserChange,
}) => {
  const { t } = useWbStrings();
  const effectiveMode = forceObjectMode ? 'object' : mode;

  const handleSizeChange = useCallback(
    (value: number | number[]) => {
      const nextSize = Array.isArray(value) ? value[0] : value;

      onSizeChange(nextSize);
    },
    [onSizeChange],
  );

  const handleWholeHandEnabledChange = useCallback(
    (enabled: boolean) => {
      if (wholeHandEraser) onWholeHandEraserChange?.({ ...wholeHandEraser, enabled });
    },
    [onWholeHandEraserChange, wholeHandEraser],
  );

  const handleWholeHandCountChange = useCallback(
    (value: number | number[]) => {
      const contactCountThreshold = Array.isArray(value) ? value[0] : value;

      if (wholeHandEraser) onWholeHandEraserChange?.({ ...wholeHandEraser, contactCountThreshold });
    },
    [onWholeHandEraserChange, wholeHandEraser],
  );

  const handleWholeHandSizeChange = useCallback(
    (value: number | number[]) => {
      const eraserSize = Array.isArray(value) ? value[0] : value;

      if (wholeHandEraser) onWholeHandEraserChange?.({ ...wholeHandEraser, eraserSize });
    },
    [onWholeHandEraserChange, wholeHandEraser],
  );

  const handleWholeHandPaddingChange = useCallback(
    (value: number | number[]) => {
      const fingerPadding = Array.isArray(value) ? value[0] : value;

      if (wholeHandEraser) onWholeHandEraserChange?.({ ...wholeHandEraser, fingerPadding });
    },
    [onWholeHandEraserChange, wholeHandEraser],
  );

  const handleWholeHandTestEmulationChange = useCallback(
    (testEmulation: boolean) => {
      if (wholeHandEraser) onWholeHandEraserChange?.({ ...wholeHandEraser, testEmulation });
    },
    [onWholeHandEraserChange, wholeHandEraser],
  );

  return (
    <motion.div
      animate={{ opacity: 1, scale: 1 }}
      className='flex w-[min(calc(100vw-2rem),18rem)] flex-col gap-4 p-3'
      initial={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
    >
      <div className='space-y-1'>
        <p className='text-foreground text-xs font-medium'>{t('eraser.type')}</p>
        <p className='text-default-400 text-[11px]'>
          {forceObjectMode
            ? t('eraser.pdfNote')
            : t('eraser.typeHint')}
        </p>
      </div>

      <div className='flex flex-col gap-2'>
        {ERASER_MODES.map((option) => (
          <Button
            key={option.value}
            className='h-auto min-h-0 justify-between gap-2 rounded-2xl px-3 py-2.5'
            color={(forceObjectMode ? 'object' : mode) === option.value ? 'primary' : 'default'}
            isDisabled={forceObjectMode && option.value === 'partial'}
            variant={(forceObjectMode ? 'object' : mode) === option.value ? 'solid' : 'flat'}
            onPress={() => onModeChange(option.value)}
          >
            <span className='flex items-center gap-2 text-sm font-semibold'>
              {option.icon}
              {t(option.label)}
            </span>
            <span className='text-[11px] opacity-70'>{t(option.description)}</span>
          </Button>
        ))}
      </div>

      <div className='bg-default-100 flex items-center justify-center rounded-2xl p-5'>
        <div className='border-default-300 relative flex h-16 w-full items-center justify-center overflow-hidden rounded-xl border border-dashed bg-white'>
          <div
            className={`rounded-full border-2 ${
              effectiveMode === 'object'
                ? 'border-dashed border-rose-500 bg-rose-100/60'
                : 'border-slate-700 bg-slate-200/70'
            }`}
            style={{
              width: Math.min(Math.max(size, 12), 48),
              height: Math.min(Math.max(size, 12), 48),
            }}
          />
        </div>
      </div>

      <div className='flex flex-col gap-2'>
        <div className='flex items-center justify-between'>
          <p className='text-foreground text-xs font-medium'>{t('eraser.size')}</p>
          <span className='text-default-400 text-xs'>{size}px</span>
        </div>
        <Slider
          aria-label={t('eraser.size')}
          color='primary'
          maxValue={150}
          minValue={8}
          size='sm'
          step={2}
          value={size}
          onChange={handleSizeChange}
        />
      </div>

      {wholeHandEraser && onWholeHandEraserChange ? (
        <>
          <Divider />

          <div className='flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 dark:border-white/10 dark:bg-white/5 p-3'>
            <div className='flex items-start justify-between gap-3'>
              <div className='space-y-1'>
                <p className='text-foreground text-xs font-medium'>{t('eraser.palm')}</p>
                <p className='text-default-400 text-[11px] leading-5'>
                  {t('eraser.palmHint')}
                </p>
              </div>
              <Switch
                aria-label={t('eraser.palm')}
                isSelected={wholeHandEraser.enabled}
                size='sm'
                onValueChange={handleWholeHandEnabledChange}
              />
            </div>

            {wholeHandEraser.enabled ? (
              <>
                <div className='flex flex-col gap-2'>
                  <div className='flex items-center justify-between'>
                    <p className='text-foreground text-xs font-medium'>{t('eraser.palmPoints')}</p>
                    <span className='text-default-400 text-xs'>{wholeHandEraser.contactCountThreshold}</span>
                  </div>
                  <Slider
                    aria-label={t('eraser.palmPoints')}
                    color='primary'
                    maxValue={WHOLE_HAND_COUNT_MAX}
                    minValue={WHOLE_HAND_COUNT_MIN}
                    size='sm'
                    step={1}
                    value={wholeHandEraser.contactCountThreshold}
                    onChange={handleWholeHandCountChange}
                  />
                </div>

                <div className='flex flex-col gap-2'>
                  <div className='flex items-center justify-between'>
                    <p className='text-foreground text-xs font-medium'>{t('eraser.palmSize')}</p>
                    <span className='text-default-400 text-xs'>{wholeHandEraser.eraserSize}px</span>
                  </div>
                  <Slider
                    aria-label={t('eraser.palmSize')}
                    color='primary'
                    maxValue={WHOLE_HAND_SIZE_MAX}
                    minValue={WHOLE_HAND_SIZE_MIN}
                    size='sm'
                    step={2}
                    value={wholeHandEraser.eraserSize}
                    onChange={handleWholeHandSizeChange}
                  />
                </div>

                <div className='flex flex-col gap-2'>
                  <div className='flex items-center justify-between'>
                    <p className='text-foreground text-xs font-medium'>{t('eraser.palmPadding')}</p>
                    <span className='text-default-400 text-xs'>{wholeHandEraser.fingerPadding ?? 8}px</span>
                  </div>
                  <Slider
                    aria-label={t('eraser.palmPadding')}
                    color='primary'
                    maxValue={WHOLE_HAND_PADDING_MAX}
                    minValue={WHOLE_HAND_PADDING_MIN}
                    size='sm'
                    step={1}
                    value={wholeHandEraser.fingerPadding ?? 8}
                    onChange={handleWholeHandPaddingChange}
                  />
                  <p className='text-default-400 text-[11px] leading-5'>
                    {t('eraser.palmPaddingHint')}
                  </p>
                </div>

                <div className='flex items-start justify-between gap-3'>
                  <div className='space-y-1'>
                    <p className='text-foreground text-xs font-medium'>{t('eraser.simulate')}</p>
                    <p className='text-default-400 text-[11px] leading-5'>
                      {t('eraser.simulateHint')}
                    </p>
                  </div>
                  <Switch
                    aria-label={t('eraser.simulate')}
                    isSelected={wholeHandEraser.testEmulation}
                    size='sm'
                    onValueChange={handleWholeHandTestEmulationChange}
                  />
                </div>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </motion.div>
  );
};

const MemoizedEraserSettings = React.memo(EraserSettings);

export { MemoizedEraserSettings as EraserSettings };
export default MemoizedEraserSettings;
