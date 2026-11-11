import React from 'react';

import { Button } from '@repo/ui';

import { useWbStrings } from '../../i18n/context';
import { TOOLBAR_SURFACE } from './toolbarSurfaces';
import { formatSizeMm, penMmToPx, selectedSizeMm } from './utils/penSizes';

/** Largest preview dot (px). Every dot in a set uses one factor, so the dots keep their true ratios. */
const MAX_DOT_PX = 12;
const MIN_DOT_PX = 1.5;

interface PenSizePickerProps {
  /** Sizes in real mm, smallest first. */
  sizes: readonly number[];
  /** The current width in board px. */
  valuePx: number;
  /** Called with the picked size's width in board px. */
  onChange: (widthPx: number) => void;
  /** Accessible name for the group. */
  label: string;
}

/**
 * One chip per real pen size (0.3 mm, 0.5 mm…): a dot whose diameter keeps the sizes' true ratios,
 * the number under it. A width that is not one of the sizes (an older custom width) picks no chip.
 */
function PenSizePickerComponent({ sizes, valuePx, onChange, label }: PenSizePickerProps) {
  const { t } = useWbStrings();
  const picked = selectedSizeMm(valuePx, sizes);
  const dotPerMm = MAX_DOT_PX / Math.max(...sizes);

  return (
    <div aria-label={label} className='flex gap-1' role='group'>
      {sizes.map((mm) => {
        const isSelected = picked === mm;
        const dot = Math.max(MIN_DOT_PX, mm * dotPerMm);
        const text = formatSizeMm(mm);

        return (
          <Button
            key={mm}
            aria-label={t('stroke.sizeMmPen', { n: text })}
            aria-pressed={isSelected}
            className='h-auto min-h-11 min-w-0 flex-1 px-1 py-1'
            size='sm'
            style={isSelected ? TOOLBAR_SURFACE.brand : undefined}
            variant='flat'
            onPress={() => onChange(penMmToPx(mm))}
          >
            <span className='flex flex-col items-center gap-1'>
              <span className='flex items-center justify-center' style={{ width: MAX_DOT_PX, height: MAX_DOT_PX }}>
                <span className='rounded-full bg-current' style={{ width: dot, height: dot }} />
              </span>
              <span className='text-[11px] font-semibold leading-none tabular-nums'>{text}</span>
            </span>
          </Button>
        );
      })}
    </div>
  );
}

export const PenSizePicker = React.memo(PenSizePickerComponent);
export default PenSizePicker;
