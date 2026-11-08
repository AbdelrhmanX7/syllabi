import React, { useRef } from 'react';

import { PenLine } from 'lucide-react';
import { CLAY_EDGE, CLAY_LIP, CLAY_PRESS, CLAY_SURFACE } from './clayChrome';

import type { Point } from './utils/quickGestureMenuLayout';

import { useDragHandle, useViewportBox } from './hooks/useQuickPenAnchor';
import {
  clampTriggerCenter,
  dragAnchor,
  QUICK_PEN_TRIGGER_SIZE,
  resolveTriggerCenter,
} from './utils/quickGestureMenuLayout';
import { useWbStrings } from '../../i18n/context';

interface QuickPenTriggerProps {
  /** Shared position with the quick pen menu (viewport fraction); null = the default edge spot. */
  anchor: Point | null;
  isActive: boolean;
  onAnchorChange: (anchor: Point, commit: boolean) => void;
  onOpen: () => void;
}

/**
 * The «Pen shortcuts» button: tap opens the quick pen menu, drag moves it anywhere on the board.
 * It renders its own `absolute inset-0` pass-through layer to measure the board viewport.
 */
export const QuickPenTrigger: React.FC<QuickPenTriggerProps> = ({ anchor, isActive, onAnchorChange, onOpen }) => {
  const { t } = useWbStrings();
  const layerRef = useRef<HTMLDivElement>(null);
  const box = useViewportBox(layerRef);
  const center = box ? resolveTriggerCenter(anchor, box.viewport, box.bounds, box.isRtl) : null;
  const dragOriginRef = useRef<Point | null>(null);
  const lastAnchorRef = useRef<Point | null>(null);

  const handlers = useDragHandle({
    onDragStart: () => {
      dragOriginRef.current = center;
      lastAnchorRef.current = null;
    },
    onDragMove: (delta) => {
      if (!box || !dragOriginRef.current) return;
      const next = dragAnchor(dragOriginRef.current, delta, box.viewport, clampTriggerCenter, box.bounds);
      lastAnchorRef.current = next;
      onAnchorChange(next, false);
    },
    onDragEnd: () => {
      if (lastAnchorRef.current) onAnchorChange(lastAnchorRef.current, true);
      dragOriginRef.current = null;
    },
    onTap: onOpen,
  });

  return (
    <div ref={layerRef} className='pointer-events-none absolute inset-0 z-20'>
      {center ? (
        <button
          aria-label={t('quick.penShortcuts')}
          aria-pressed={isActive}
          className={`${CLAY_EDGE} ${CLAY_LIP} ${CLAY_PRESS} pointer-events-auto absolute flex cursor-grab touch-none select-none items-center justify-center rounded-full active:cursor-grabbing ${
            isActive ? 'bg-citrine text-ink' : CLAY_SURFACE
          }`}
          style={{
            left: center.x - QUICK_PEN_TRIGGER_SIZE / 2,
            top: center.y - QUICK_PEN_TRIGGER_SIZE / 2,
            width: QUICK_PEN_TRIGGER_SIZE,
            height: QUICK_PEN_TRIGGER_SIZE,
          }}
          title={t('quick.triggerTitle')}
          type='button'
          {...handlers}
        >
          <PenLine className='h-4 w-4' />
        </button>
      ) : null}
    </div>
  );
};

export default QuickPenTrigger;
