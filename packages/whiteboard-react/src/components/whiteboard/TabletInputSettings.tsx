import React, { useCallback } from 'react';

import { Button, Divider, Slider, Switch } from '@repo/ui';
import { motion } from 'motion/react';

import { useWbStrings } from '../../i18n/context';
import type { WbStringKey } from '../../i18n/strings';
import type { DualTipClassifier, TabletInputSettings as TabletInputSettingsType, TouchInputMode } from './types';

interface TabletInputSettingsProps {
  settings: TabletInputSettingsType;
  /**
   * Capture is not this device's to switch off — hide the row entirely.
   *
   * Set when the board runs under a TEACHER account (owner ask 2026-09-20). Hidden, not disabled: a
   * greyed-out switch with an explanation is still an announcement that their handwriting is being
   * collected and that they may not stop it, which is a worse screen than no screen.
   */
  penCaptureLocked?: boolean;
  onChange: (settings: TabletInputSettingsType) => void;
}

const DUAL_TIP_CLASSIFIER_OPTIONS: { mode: DualTipClassifier; label: WbStringKey; hint: WbStringKey }[] = [
  {
    mode: 'height-aware',
    label: 'tablet.dualTip.heightAware',
    hint: 'tablet.dualTip.heightAwareHint',
  },
  {
    mode: 'legacy',
    label: 'tablet.dualTip.legacy',
    hint: 'tablet.dualTip.legacyHint',
  },
];

const TOUCH_INPUT_MODE_OPTIONS: { mode: TouchInputMode; label: WbStringKey; hint: WbStringKey }[] = [
  {
    mode: 'auto',
    label: 'tablet.touchMode.auto',
    hint: 'tablet.touchMode.autoHint',
  },
  {
    mode: 'finger-draws',
    label: 'tablet.touchMode.fingerDraws',
    hint: 'tablet.touchMode.fingerDrawsHint',
  },
  {
    mode: 'capacitive-pen',
    label: 'tablet.touchMode.capacitive',
    hint: 'tablet.touchMode.capacitiveHint',
  },
];

const MULTI_TOUCH_PAN_ACTIVATION_BASE_PX = 8;
const MULTI_TOUCH_ZOOM_ACTIVATION_BASE_SCALE = 0.018;
const MULTI_TOUCH_PAN_FRAME_DEADZONE_BASE_PX = 0.5;
const PEN_TILT_OFFSET_MIN_PX = -8;
const PEN_TILT_OFFSET_MAX_PX = 8;
const PEN_TILT_OFFSET_STEP_PX = 0.5;
const PEN_JITTER_FILTER_MIN_PX = 0;
const PEN_JITTER_FILTER_MAX_PX = 15;
const PEN_JITTER_FILTER_STEP_PX = 0.5;

const TabletInputSettings: React.FC<TabletInputSettingsProps> = ({ settings, penCaptureLocked = false, onChange }) => {
  const { t } = useWbStrings();
  const tMaybe = (key: WbStringKey | undefined) => (key ? t(key) : undefined);
  const panZoomToleranceFactor = settings.touchPanZoomTolerance / 100;

  const handlePenTiltOffsetChange = useCallback(
    (value: number | number[]) => {
      const penTiltOffset = Array.isArray(value) ? value[0] : value;

      onChange({ ...settings, penTiltOffset });
    },
    [onChange, settings],
  );

  const handlePenJitterFilterChange = useCallback(
    (value: number | number[]) => {
      const penJitterFilter = Array.isArray(value) ? value[0] : value;

      onChange({ ...settings, penJitterFilter });
    },
    [onChange, settings],
  );

  const handleTouchPanZoomToleranceChange = useCallback(
    (value: number | number[]) => {
      const touchPanZoomTolerance = Array.isArray(value) ? value[0] : value;

      onChange({ ...settings, touchPanZoomTolerance });
    },
    [onChange, settings],
  );

  const handlePenButtonsEnabledChange = useCallback(
    (penButtonsEnabled: boolean) => {
      onChange({ ...settings, penButtonsEnabled });
    },
    [onChange, settings],
  );

  const handlePenButtonsSwapChange = useCallback(
    (penButtonsSwap: boolean) => {
      onChange({ ...settings, penButtonsSwap });
    },
    [onChange, settings],
  );

  const handleTouchDebugOverlayChange = useCallback(
    (touchDebugOverlay: boolean) => {
      onChange({ ...settings, touchDebugOverlay });
    },
    [onChange, settings],
  );

  const handleShapeSnapOnHoldChange = useCallback(
    (shapeSnapOnHold: boolean) => {
      onChange({ ...settings, shapeSnapOnHold });
    },
    [onChange, settings],
  );

  const handleSmartInkContrastChange = useCallback(
    (smartInkContrast: boolean) => {
      onChange({ ...settings, smartInkContrast });
    },
    [onChange, settings],
  );

  const handleTouchInputModeChange = useCallback(
    (touchInputMode: TouchInputMode) => {
      onChange({ ...settings, touchInputMode });
    },
    [onChange, settings],
  );

  // Which rulebook is live, and the bands it reads. The sliders below always edit the ACTIVE rulebook's
  // own numbers — the other set stays exactly as the teacher calibrated it.
  const isLegacyClassifier = settings.dualTipStylus.classifier === 'legacy';
  const activeSmallHeadMaxWidth = isLegacyClassifier
    ? settings.dualTipStylus.legacyBands.smallHeadMaxWidth
    : settings.dualTipStylus.smallHeadMaxWidth;
  const activeBigHeadMaxWidth = isLegacyClassifier
    ? settings.dualTipStylus.legacyBands.bigHeadMaxWidth
    : settings.dualTipStylus.bigHeadMaxWidth;
  const activeFingerMinWidth = isLegacyClassifier
    ? settings.dualTipStylus.legacyBands.fingerMinWidth
    : settings.singleFingerPan.minWidth;

  const handleDualTipEnabledChange = useCallback(
    (enabled: boolean) => {
      onChange({ ...settings, dualTipStylus: { ...settings.dualTipStylus, enabled } });
    },
    [onChange, settings],
  );

  const handleDualTipClassifierChange = useCallback(
    (classifier: DualTipClassifier) => {
      onChange({ ...settings, dualTipStylus: { ...settings.dualTipStylus, classifier } });
    },
    [onChange, settings],
  );

  const handleDualTipSmallHeadChange = useCallback(
    (value: number | number[]) => {
      const smallHeadMaxWidth = Array.isArray(value) ? value[0] : value;

      if (isLegacyClassifier) {
        onChange({
          ...settings,
          dualTipStylus: {
            ...settings.dualTipStylus,
            legacyBands: {
              ...settings.dualTipStylus.legacyBands,
              smallHeadMaxWidth,
              bigHeadMaxWidth: Math.max(smallHeadMaxWidth + 1, settings.dualTipStylus.legacyBands.bigHeadMaxWidth),
            },
          },
        });

        return;
      }

      // Keep the big-head ceiling strictly above the small-head one.
      const bigHeadMaxWidth = Math.max(smallHeadMaxWidth + 1, settings.dualTipStylus.bigHeadMaxWidth);

      onChange({ ...settings, dualTipStylus: { ...settings.dualTipStylus, smallHeadMaxWidth, bigHeadMaxWidth } });
    },
    [isLegacyClassifier, onChange, settings],
  );

  const handleDualTipBigHeadChange = useCallback(
    (value: number | number[]) => {
      const raw = Array.isArray(value) ? value[0] : value;

      if (isLegacyClassifier) {
        onChange({
          ...settings,
          dualTipStylus: {
            ...settings.dualTipStylus,
            legacyBands: {
              ...settings.dualTipStylus.legacyBands,
              bigHeadMaxWidth: Math.max(settings.dualTipStylus.legacyBands.smallHeadMaxWidth + 1, raw),
            },
          },
        });

        return;
      }

      const bigHeadMaxWidth = Math.max(settings.dualTipStylus.smallHeadMaxWidth + 1, raw);

      onChange({ ...settings, dualTipStylus: { ...settings.dualTipStylus, bigHeadMaxWidth } });
    },
    [isLegacyClassifier, onChange, settings],
  );

  const handlePenCaptureEnabledChange = useCallback(
    (penCaptureEnabled: boolean) => {
      onChange({ ...settings, penCaptureEnabled });
    },
    [onChange, settings],
  );

  const handleSingleFingerPanEnabledChange = useCallback(
    (enabled: boolean) => {
      onChange({ ...settings, singleFingerPan: { ...settings.singleFingerPan, enabled } });
    },
    [onChange, settings],
  );

  const handleSingleFingerPanMinWidthChange = useCallback(
    (value: number | number[]) => {
      const minWidth = Array.isArray(value) ? value[0] : value;

      // The finger threshold belongs to whichever rulebook is reading it: legacy measures it against
      // the major axis, so its number is not the same number.
      if (isLegacyClassifier) {
        onChange({
          ...settings,
          dualTipStylus: {
            ...settings.dualTipStylus,
            legacyBands: { ...settings.dualTipStylus.legacyBands, fingerMinWidth: minWidth },
          },
        });

        return;
      }

      onChange({ ...settings, singleFingerPan: { ...settings.singleFingerPan, minWidth } });
    },
    [isLegacyClassifier, onChange, settings],
  );

  return (
    <motion.div
      animate={{ opacity: 1, scale: 1 }}
      className='flex w-[20rem] max-w-[calc(100vw-2rem)] flex-col gap-4 p-3'
      initial={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
    >
      <div className='space-y-1'>
        <p className='text-foreground text-xs font-semibold'>{t('tablet.title')}</p>
        <p className='text-default-400 text-[11px] leading-5'>
          {t('tablet.intro')}
        </p>
      </div>

      <div className='flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 dark:border-white/10 dark:bg-white/5 p-3'>
        <div className='flex flex-col gap-2'>
          <div className='flex items-center justify-between gap-3'>
            <div className='space-y-1'>
              <p className='text-foreground text-xs font-medium'>{t('tablet.tiltOffset')}</p>
              <p className='text-default-400 text-[11px] leading-5'>
                {t('tablet.tiltOffsetHint')}
              </p>
            </div>
            <span className='text-default-400 shrink-0 text-xs'>{settings.penTiltOffset.toFixed(1)}px</span>
          </div>
          <Slider
            aria-label={t('tablet.tiltOffset')}
            color='primary'
            maxValue={PEN_TILT_OFFSET_MAX_PX}
            minValue={PEN_TILT_OFFSET_MIN_PX}
            size='sm'
            step={PEN_TILT_OFFSET_STEP_PX}
            value={settings.penTiltOffset}
            onChange={handlePenTiltOffsetChange}
          />
        </div>

        <Divider />

        <div className='flex flex-col gap-2'>
          <div className='flex items-center justify-between gap-3'>
            <div className='space-y-1'>
              <p className='text-foreground text-xs font-medium'>{t('tablet.jitter')}</p>
              <p className='text-default-400 text-[11px] leading-5'>
                {t('tablet.jitterHint')}
              </p>
            </div>
            <span className='text-default-400 shrink-0 text-xs'>{settings.penJitterFilter.toFixed(1)}px</span>
          </div>
          <Slider
            aria-label={t('tablet.jitter')}
            color='primary'
            maxValue={PEN_JITTER_FILTER_MAX_PX}
            minValue={PEN_JITTER_FILTER_MIN_PX}
            size='sm'
            step={PEN_JITTER_FILTER_STEP_PX}
            value={settings.penJitterFilter}
            onChange={handlePenJitterFilterChange}
          />
        </div>
      </div>

      <div className='flex flex-col gap-2'>
        <div className='flex items-center justify-between'>
          <p className='text-foreground text-xs font-medium'>{t('tablet.panZoomTolerance')}</p>
          <span className='text-default-400 text-xs'>{settings.touchPanZoomTolerance}%</span>
        </div>
        <Slider
          aria-label={t('tablet.panZoomTolerance')}
          color='primary'
          maxValue={260}
          minValue={40}
          size='sm'
          step={5}
          value={settings.touchPanZoomTolerance}
          onChange={handleTouchPanZoomToleranceChange}
        />
        <p className='text-default-400 text-[11px] leading-5'>
          {t('tablet.panZoomToleranceHint')}
        </p>
        <div className='grid grid-cols-3 gap-2'>
          <div className='rounded-2xl border border-slate-200 bg-slate-50 px-3 dark:border-white/10 dark:bg-white/5 py-2'>
            <p className='text-[10px] font-semibold text-slate-500 dark:text-ink/60'>{t('tablet.panStart')}</p>
            <p className='mt-1 text-xs font-semibold text-slate-900 dark:text-ink'>
              {Math.round(MULTI_TOUCH_PAN_ACTIVATION_BASE_PX * panZoomToleranceFactor)}px
            </p>
          </div>
          <div className='rounded-2xl border border-slate-200 bg-slate-50 px-3 dark:border-white/10 dark:bg-white/5 py-2'>
            <p className='text-[10px] font-semibold text-slate-500 dark:text-ink/60'>{t('tablet.zoomStart')}</p>
            <p className='mt-1 text-xs font-semibold text-slate-900 dark:text-ink'>
              {(MULTI_TOUCH_ZOOM_ACTIVATION_BASE_SCALE * panZoomToleranceFactor * 100).toFixed(1)}%
            </p>
          </div>
          <div className='rounded-2xl border border-slate-200 bg-slate-50 px-3 dark:border-white/10 dark:bg-white/5 py-2'>
            <p className='text-[10px] font-semibold text-slate-500 dark:text-ink/60'>{t('tablet.jitterShort')}</p>
            <p className='mt-1 text-xs font-semibold text-slate-900 dark:text-ink'>
              {(MULTI_TOUCH_PAN_FRAME_DEADZONE_BASE_PX * panZoomToleranceFactor).toFixed(1)}px
            </p>
          </div>
        </div>
      </div>

      <div className='flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 dark:border-white/10 dark:bg-white/5 p-3'>
        <div className='flex items-start justify-between gap-3'>
          <div className='space-y-1'>
            <p className='text-foreground text-xs font-medium'>{t('tablet.shapeSnap')}</p>
            <p className='text-default-400 text-[11px] leading-5'>
              {t('tablet.shapeSnapHint')}
            </p>
          </div>
          <Switch
            aria-label={t('tablet.shapeSnap')}
            isSelected={settings.shapeSnapOnHold !== false}
            size='sm'
            onValueChange={handleShapeSnapOnHoldChange}
          />
        </div>

        <Divider />

        <div className='flex items-start justify-between gap-3'>
          <div className='space-y-1'>
            <p className='text-foreground text-xs font-medium'>{t('tablet.smartContrast')}</p>
            <p className='text-default-400 text-[11px] leading-5'>
              {t('tablet.smartContrastHint')}
            </p>
          </div>
          <Switch
            aria-label={t('tablet.smartContrast')}
            isSelected={settings.smartInkContrast !== false}
            size='sm'
            onValueChange={handleSmartInkContrastChange}
          />
        </div>
      </div>

      <div className='flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 dark:border-white/10 dark:bg-white/5 p-3'>
        <div className='flex items-start justify-between gap-3'>
          <div className='space-y-1'>
            <p className='text-foreground text-xs font-medium'>{t('tablet.penButtons')}</p>
            <p className='text-default-400 text-[11px] leading-5'>
              {t('tablet.penButtonsHint')}
            </p>
          </div>
          <Switch
            aria-label={t('tablet.penButtonsAria')}
            isSelected={settings.penButtonsEnabled}
            size='sm'
            onValueChange={handlePenButtonsEnabledChange}
          />
        </div>

        <div className={`flex items-start justify-between gap-3 ${settings.penButtonsEnabled ? '' : 'opacity-50'}`}>
          <div className='space-y-1'>
            <p className='text-foreground text-xs font-medium'>{t('tablet.swapButtons')}</p>
            <p className='text-default-400 text-[11px] leading-5'>
              {t('tablet.swapButtonsHint')}
            </p>
          </div>
          <Switch
            aria-label={t('tablet.swapButtonsAria')}
            isDisabled={!settings.penButtonsEnabled}
            isSelected={settings.penButtonsSwap}
            size='sm'
            onValueChange={handlePenButtonsSwapChange}
          />
        </div>
      </div>

      <div className='flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 dark:border-white/10 dark:bg-white/5 p-3'>
        <div className='space-y-1'>
          <p className='text-foreground text-xs font-medium'>{t('tablet.touchModel')}</p>
          <p className='text-default-400 text-[11px] leading-5'>
            {t('tablet.touchModelHint')}
          </p>
        </div>
        {/* One full-width row per option: the labels are long, three columns overlapped them. */}
        <div className='flex flex-col gap-1.5' role='radiogroup' aria-label={t('tablet.touchModel')}>
          {TOUCH_INPUT_MODE_OPTIONS.map((option) => {
            const isSelected = settings.touchInputMode === option.mode;

            return (
              <button
                key={option.mode}
                aria-checked={isSelected}
                className={`flex min-h-9 w-full items-center gap-2 rounded-[10px] border-[1.5px] px-3 text-start text-xs font-semibold transition-colors ${
                  isSelected ? 'border-ink bg-primary/10 text-ink' : 'border-ink/20 text-ink/75 hover:bg-ink/5'
                }`}
                role='radio'
                type='button'
                onClick={() => handleTouchInputModeChange(option.mode)}
              >
                <span
                  aria-hidden='true'
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[1.5px] ${isSelected ? 'border-primary' : 'border-ink/40'}`}
                >
                  {isSelected && <span className='bg-primary h-2 w-2 rounded-full' />}
                </span>
                <span className='min-w-0 flex-1'>{t(option.label)}</span>
              </button>
            );
          })}
        </div>
        <p className='text-default-400 text-[11px] leading-5'>
          {tMaybe(TOUCH_INPUT_MODE_OPTIONS.find((option) => option.mode === settings.touchInputMode)?.hint)}
        </p>
      </div>

      <div className='flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 dark:border-white/10 dark:bg-white/5 p-3'>
        <div className='flex items-start justify-between gap-3'>
          <div className='space-y-1'>
            <p className='text-foreground text-xs font-medium'>{t('tablet.touchDebug')}</p>
            <p className='text-default-400 text-[11px] leading-5'>
              {t('tablet.touchDebugHint')}
            </p>
          </div>
          <Switch
            aria-label={t('tablet.touchDebugAria')}
            isSelected={settings.touchDebugOverlay}
            size='sm'
            onValueChange={handleTouchDebugOverlayChange}
          />
        </div>
      </div>

      <div className='flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 dark:border-white/10 dark:bg-white/5 p-3'>
        <div className='flex items-start justify-between gap-3'>
          <div className='space-y-1'>
            <p className='text-foreground text-xs font-medium'>{t('tablet.dualTip')}</p>
            <p className='text-default-400 text-[11px] leading-5'>
              {t('tablet.dualTipHint')}
            </p>
          </div>
          <Switch
            aria-label={t('tablet.dualTipAria')}
            isSelected={settings.dualTipStylus.enabled}
            size='sm'
            onValueChange={handleDualTipEnabledChange}
          />
        </div>

        <div className={`flex flex-col gap-2 ${settings.dualTipStylus.enabled ? '' : 'opacity-50'}`}>
          <p className='text-foreground text-xs font-medium'>{t('tablet.tipMethod')}</p>
          <div className='grid grid-cols-2 gap-2'>
            {DUAL_TIP_CLASSIFIER_OPTIONS.map((option) => {
              const isSelected = settings.dualTipStylus.classifier === option.mode;

              return (
                <Button
                  key={option.mode}
                  className={
                    isSelected
                      ? 'border border-sky-200 bg-sky-50 text-sky-800'
                      : 'border border-slate-200 bg-slate-50 text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-ink/75'
                  }
                  isDisabled={!settings.dualTipStylus.enabled}
                  size='sm'
                  variant='flat'
                  onPress={() => handleDualTipClassifierChange(option.mode)}
                >
                  {t(option.label)}
                </Button>
              );
            })}
          </div>
          <p className='text-default-400 text-[11px] leading-5'>
            {tMaybe(DUAL_TIP_CLASSIFIER_OPTIONS.find((option) => option.mode === settings.dualTipStylus.classifier)?.hint)}
          </p>
          <p className='text-default-400 text-[11px] leading-5'>
            {t('tablet.tipMethodHint')}
          </p>
        </div>

        <div className={`flex flex-col gap-2 ${settings.dualTipStylus.enabled ? '' : 'opacity-50'}`}>
          <div className='flex items-center justify-between'>
            <p className='text-foreground text-xs font-medium'>{t('tablet.smallTipLimit')}</p>
            <span className='text-default-400 text-xs'>≤ {activeSmallHeadMaxWidth}px</span>
          </div>
          <Slider
            aria-label={t('tablet.smallTipLimitAria')}
            color='primary'
            isDisabled={!settings.dualTipStylus.enabled}
            maxValue={20}
            minValue={2}
            size='sm'
            step={1}
            value={activeSmallHeadMaxWidth}
            onChange={handleDualTipSmallHeadChange}
          />
          <div className='flex items-center justify-between'>
            <p className='text-foreground text-xs font-medium'>{t('tablet.largeTipLimit')}</p>
            <span className='text-default-400 text-xs'>≤ {activeBigHeadMaxWidth}px</span>
          </div>
          <Slider
            aria-label={t('tablet.largeTipLimitAria')}
            color='primary'
            isDisabled={!settings.dualTipStylus.enabled}
            maxValue={30}
            minValue={3}
            size='sm'
            step={1}
            value={activeBigHeadMaxWidth}
            onChange={handleDualTipBigHeadChange}
          />
          <p className='text-default-400 text-[11px] leading-5'>
            {t('tablet.tipLimitsHint')}
          </p>
        </div>
      </div>

      {penCaptureLocked ? null : (
        <div className='flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 dark:border-white/10 dark:bg-white/5 p-3'>
          <div className='flex items-start justify-between gap-3'>
            <div className='space-y-1'>
              <p className='text-foreground text-xs font-medium'>{t('tablet.penCapture')}</p>
              <p className='text-default-400 text-[11px] leading-5'>
                {t('tablet.penCaptureHint')}
              </p>
            </div>
            <Switch
              aria-label={t('tablet.penCapture')}
              isSelected={settings.penCaptureEnabled}
              size='sm'
              onValueChange={handlePenCaptureEnabledChange}
            />
          </div>
        </div>
      )}

      <div className='flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 dark:border-white/10 dark:bg-white/5 p-3'>
        <div className='flex items-start justify-between gap-3'>
          <div className='space-y-1'>
            <p className='text-foreground text-xs font-medium'>{t('tablet.oneFingerPan')}</p>
            <p className='text-default-400 text-[11px] leading-5'>
              {t('tablet.oneFingerPanHint')}
            </p>
          </div>
          <Switch
            aria-label={t('tablet.oneFingerPan')}
            isSelected={settings.singleFingerPan.enabled}
            size='sm'
            onValueChange={handleSingleFingerPanEnabledChange}
          />
        </div>

        <div className={`flex flex-col gap-2 ${settings.singleFingerPan.enabled ? '' : 'opacity-50'}`}>
          <div className='flex items-center justify-between'>
            <p className='text-foreground text-xs font-medium'>{t('tablet.fingerSize')}</p>
            <span className='text-default-400 text-xs'>≥ {activeFingerMinWidth}px</span>
          </div>
          <Slider
            aria-label={t('tablet.fingerSize')}
            color='primary'
            isDisabled={!settings.singleFingerPan.enabled}
            maxValue={40}
            minValue={4}
            size='sm'
            step={1}
            value={activeFingerMinWidth}
            onChange={handleSingleFingerPanMinWidthChange}
          />
          <p className='text-default-400 text-[11px] leading-5'>
            {t('tablet.fingerSizeHint')}
          </p>
        </div>
      </div>
    </motion.div>
  );
};

const MemoizedTabletInputSettings = React.memo(TabletInputSettings);

export { MemoizedTabletInputSettings as TabletInputSettings };
export default MemoizedTabletInputSettings;
