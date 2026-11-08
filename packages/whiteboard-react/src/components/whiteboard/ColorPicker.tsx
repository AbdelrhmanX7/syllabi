import React, { useCallback, useState } from 'react';

import { ArrowLeftRight } from 'lucide-react';
import { motion } from 'motion/react';
import { SwatchPicker } from '@repo/ui';

import { HsvPicker } from './HsvPicker';
import { DEFAULT_COLORS } from './types';
import { useWbStrings } from '../../i18n/context';

interface ColorPickerProps {
  color: string;
  onChange: (color: string) => void;
  colors?: string[];
  label?: string;
  /**
   * When provided alongside `onSecondaryChange`, the picker renders a dual-slot
   * UI: a PRIMARY (active drawing color) slot and a SECONDARY slot. The pen
   * COLOR barrel button (and the manual swap affordance) flip between the two.
   * When omitted, the picker keeps its original single-color behavior.
   */
  secondaryColor?: string;
  onSecondaryChange?: (color: string) => void;
  /**
   * Manual swap of primary <-> secondary. If omitted in dual mode the picker
   * falls back to swapping via onChange/onSecondaryChange.
   */
  onSwap?: () => void;
}

const ColorPicker: React.FC<ColorPickerProps> = ({
  color,
  onChange,
  colors,
  label,
  secondaryColor,
  onSecondaryChange,
  onSwap,
}) => {
  const { t } = useWbStrings();
  const [showCustom, setShowCustom] = useState(false);
  const dualMode = secondaryColor !== undefined && onSecondaryChange !== undefined;
  const [editingSlot, setEditingSlot] = useState<'primary' | 'secondary'>('primary');

  const palette = colors ?? [...DEFAULT_COLORS];

  // In dual mode edits target the selected slot; otherwise always the primary.
  const targetIsSecondary = dualMode && editingSlot === 'secondary';
  const editingColor = targetIsSecondary ? (secondaryColor as string) : color;
  const applyColor = useCallback(
    (next: string) => {
      if (targetIsSecondary) {
        onSecondaryChange?.(next);

        return;
      }

      onChange(next);
    },
    [targetIsSecondary, onChange, onSecondaryChange],
  );

  const handleCustomColorClick = useCallback(() => {
    setShowCustom((open) => !open);
  }, []);

  const handleSwap = useCallback(() => {
    if (onSwap) {
      onSwap();

      return;
    }

    if (!dualMode) return;

    const previousPrimary = color;

    onChange(secondaryColor as string);
    onSecondaryChange?.(previousPrimary);
  }, [onSwap, dualMode, color, secondaryColor, onChange, onSecondaryChange]);

  return (
    <motion.div
      animate={{ opacity: 1, scale: 1 }}
      className='flex flex-col gap-3 p-3'
      initial={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
    >
      {label && <p className='text-foreground text-xs font-medium'>{label}</p>}

      {dualMode ? (
        <div className='flex items-center gap-2'>
          <button
            aria-label={t('color.primary')}
            aria-pressed={editingSlot === 'primary'}
            className={`relative flex flex-1 items-center gap-2 rounded-xl border-2 px-2 py-1.5 transition-colors ${
              editingSlot === 'primary' ? 'border-primary bg-default-100' : 'border-default-200 hover:bg-default-50'
            }`}
            type='button'
            onClick={() => setEditingSlot('primary')}
          >
            <span
              className='border-default-300 h-6 w-6 shrink-0 rounded-full border'
              style={{ backgroundColor: color }}
            />
            <span className='flex flex-col items-start leading-tight'>
              <span className='text-foreground text-[11px] font-semibold'>{t('color.primaryShort')}</span>
              <span className='text-primary text-[9px] font-medium'>{t('color.active')}</span>
            </span>
          </button>

          <button
            aria-label={t('color.swap')}
            className='border-default-200 text-foreground hover:bg-default-100 shrink-0 rounded-md border p-1.5 transition-colors'
            title={t('color.swap')}
            type='button'
            onClick={handleSwap}
          >
            <ArrowLeftRight className='h-4 w-4' />
          </button>

          <button
            aria-label={t('color.secondary')}
            aria-pressed={editingSlot === 'secondary'}
            className={`flex flex-1 items-center gap-2 rounded-xl border-2 px-2 py-1.5 transition-colors ${
              editingSlot === 'secondary' ? 'border-primary bg-default-100' : 'border-default-200 hover:bg-default-50'
            }`}
            type='button'
            onClick={() => setEditingSlot('secondary')}
          >
            <span
              className='border-default-300 h-6 w-6 shrink-0 rounded-full border'
              style={{ backgroundColor: secondaryColor }}
            />
            <span className='flex flex-col items-start leading-tight'>
              <span className='text-foreground text-[11px] font-semibold'>{t('color.secondaryShort')}</span>
              <span className='text-default-400 text-[9px] font-medium'>{t('color.toSwitch')}</span>
            </span>
          </button>
        </div>
      ) : null}

      <SwatchPicker
        colors={palette}
        columns={5}
        label={label ?? t('color.palette')}
        size='md'
        value={editingColor}
        onChange={(next) => {
          if (next) applyColor(next);
        }}
      />

      {/* Current colour + its hex on the left, the system colour picker behind one bordered chip. */}
      <div className='border-divider flex items-center gap-2 border-t pt-3'>
        <span
          aria-hidden='true'
          className='border-ink h-7 w-7 shrink-0 rounded-full border-[1.5px]'
          style={{ backgroundColor: editingColor }}
        />
        <span className='text-foreground min-w-0 flex-1 truncate font-mono text-xs font-semibold uppercase'>
          {editingColor}
        </span>
        <button
          aria-label={dualMode ? t('color.customOf', { which: targetIsSecondary ? t('color.secondaryDef') : t('color.primaryDef') }) : t('color.custom')}
          className='border-ink bg-paper text-ink shadow-sk-sm inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] pe-3 ps-1.5 text-xs font-semibold transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none'
          type='button'
          aria-expanded={showCustom}
          onClick={handleCustomColorClick}
        >
          <span
            aria-hidden='true'
            className='h-5 w-5 rounded-full'
            style={{ background: 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)' }}
          />
          {t('color.custom')}
        </button>
      </div>
      {showCustom && <HsvPicker value={editingColor} onChange={applyColor} />}
    </motion.div>
  );
};

const MemoizedColorPicker = React.memo(ColorPicker);

export { MemoizedColorPicker as ColorPicker };
export default MemoizedColorPicker;
