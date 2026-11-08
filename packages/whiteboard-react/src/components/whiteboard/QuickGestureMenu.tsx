import React, { useMemo, useRef, useState } from 'react';

import { Minus, Plus } from 'lucide-react';
import { CLAY_EDGE, CLAY_LIP, CLAY_PRESS, CLAY_SURFACE } from './clayChrome';
import { motion, useReducedMotion } from 'motion/react';
import { ColorSwatch } from '@repo/ui';

import type { WhiteboardTool } from './types';
import type { Point } from './utils/quickGestureMenuLayout';
import { buildQuickColorRing, readRecentColors, sameColor } from './utils/recentColors';

import { useDragHandle, useViewportBox } from './hooks/useQuickPenAnchor';
import { DEFAULT_COLORS, MAX_STROKE_WIDTH, MIN_STROKE_WIDTH } from './types';
import {
  clampMenuCenter,
  dragAnchor,
  getQuickMenuSlots,
  getQuickMenuStorageKey,
  QUICK_MENU_EXTENT,
  QUICK_MENU_HUB_SIZE,
  QUICK_MENU_ITEM_SIZE,
  readStoredAnchor,
  resolveMenuCenterForAnchor,
  writeStoredAnchor,
} from './utils/quickGestureMenuLayout';
import { useWbStrings } from '../../i18n/context';

interface QuickGestureMenuProps {
  activeTool: WhiteboardTool;
  strokeColor: string;
  strokeWidth: number;
  onClose: () => void;
  onStrokeColorChange: (color: string) => void;
  onStrokeWidthChange: (width: number) => void;
  /**
   * Shared position (viewport fraction) with the trigger button; the menu centres on it. Pass with
   * `onAnchorChange` to control it — dragging the hub then moves the trigger too.
   */
  anchor?: Point | null;
  onAnchorChange?: (anchor: Point, commit: boolean) => void;
  /** Recently picked colours, most recent first — shown before the default palette on the ring. */
  recentColors?: readonly string[];
  /** Uncontrolled only: localStorage key for the dragged position — include the board id. */
  positionStorageKey?: string;
}

export const QUICK_GESTURE_COLORS = DEFAULT_COLORS.filter((color) => color !== '#FFFFFF' && color !== '#6B7280').slice(
  0,
  6,
);

const SLOTS = getQuickMenuSlots();
const DISC_SIZE = QUICK_MENU_EXTENT * 2;

function clampStrokeWidth(width: number) {
  return Math.max(MIN_STROKE_WIDTH, Math.min(MAX_STROKE_WIDTH, Math.round(width * 2) / 2));
}

function getAdjacentStrokeWidth(width: number, direction: -1 | 1) {
  // Half-pixel steps at the fine end (1 → 1.5 → 2), whole pixels above.
  const step = width < 4 || (width === 4 && direction < 0) ? 0.5 : 1;

  return clampStrokeWidth(width + direction * step);
}

// Keep pointer input on the menu: nothing underneath (canvas, window-level ink listeners) may see it.
function swallowPointer(event: React.PointerEvent) {
  event.stopPropagation();
}

export const QuickGestureMenu: React.FC<QuickGestureMenuProps> = ({
  activeTool,
  strokeColor,
  strokeWidth,
  onClose,
  onStrokeColorChange,
  onStrokeWidthChange,
  anchor: controlledAnchor,
  onAnchorChange,
  positionStorageKey,
  recentColors,
}) => {
  const { t } = useWbStrings();
  const storageKey = positionStorageKey ?? getQuickMenuStorageKey();
  const isControlled = onAnchorChange !== undefined;
  const reduceMotion = useReducedMotion();
  const viewportRef = useRef<HTMLDivElement>(null);
  const box = useViewportBox(viewportRef);
  const [ownAnchor, setOwnAnchor] = useState<Point | null>(() => (isControlled ? null : readStoredAnchor(storageKey)));
  const anchor = isControlled ? (controlledAnchor ?? null) : ownAnchor;
  const center = box ? resolveMenuCenterForAnchor(anchor, box.viewport, box.bounds, box.isRtl) : null;
  const dragOriginRef = useRef<Point | null>(null);
  const lastAnchorRef = useRef<Point | null>(null);

  const setAnchor = (next: Point, commit: boolean) => {
    if (isControlled) {
      onAnchorChange(next, commit);

      return;
    }
    setOwnAnchor(next);
    if (commit) writeStoredAnchor(storageKey, next);
  };

  const hubHandlers = useDragHandle({
    onDragStart: () => {
      dragOriginRef.current = center;
      lastAnchorRef.current = null;
    },
    onDragMove: (delta) => {
      if (!box || !dragOriginRef.current) return;
      const next = dragAnchor(dragOriginRef.current, delta, box.viewport, clampMenuCenter, box.bounds);
      lastAnchorRef.current = next;
      setAnchor(next, false);
    },
    onDragEnd: () => {
      if (lastAnchorRef.current) setAnchor(lastAnchorRef.current, true);
      dragOriginRef.current = null;
    },
    onTap: onClose,
  });

  const currentStrokeWidth = clampStrokeWidth(strokeWidth);
  const canDecreaseWidth = currentStrokeWidth > MIN_STROKE_WIDTH;
  const canIncreaseWidth = currentStrokeWidth < MAX_STROKE_WIDTH;
  const activeLabel = activeTool === 'eraser' ? t('quick.backToPen') : t('quick.penShortcuts');
  const previewDotSize = Math.max(4, Math.min(26, currentStrokeWidth));
  // Recent colours first, then the palette; always 6, and the active colour is always on it.
  const ringColors = useMemo(
    () => buildQuickColorRing(recentColors ?? readRecentColors(), QUICK_GESTURE_COLORS, strokeColor),
    [recentColors, strokeColor],
  );

  const itemTransition = reduceMotion
    ? { duration: 0.12 }
    : ({ type: 'spring', stiffness: 520, damping: 34, mass: 0.7 } as const);

  const renderSlot = (key: string, offset: Point, index: number, content: React.ReactNode) => (
    <motion.div
      key={key}
      animate={{ opacity: 1, x: offset.x, y: offset.y, scale: 1 }}
      className='absolute'
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 0, y: 0, scale: 0.4 }}
      initial={reduceMotion ? { opacity: 0, x: offset.x, y: offset.y } : { opacity: 0, x: 0, y: 0, scale: 0.4 }}
      style={{
        left: QUICK_MENU_EXTENT - QUICK_MENU_ITEM_SIZE / 2,
        top: QUICK_MENU_EXTENT - QUICK_MENU_ITEM_SIZE / 2,
        width: QUICK_MENU_ITEM_SIZE,
        height: QUICK_MENU_ITEM_SIZE,
      }}
      transition={reduceMotion ? itemTransition : { ...itemTransition, delay: index * 0.015 }}
    >
      {content}
    </motion.div>
  );

  const widthButtonClass = (enabled: boolean) =>
    `${CLAY_EDGE} ${CLAY_LIP} ${CLAY_SURFACE} ${CLAY_PRESS} flex h-11 w-11 items-center justify-center rounded-full ${
      enabled ? '' : 'cursor-not-allowed opacity-40'
    }`;

  return (
    <div ref={viewportRef} className='absolute inset-0 z-30' onPointerDown={onClose}>
      {center ? (
        <motion.div
          animate={{ opacity: 1, scale: 1 }}
          aria-label={activeLabel}
          className='absolute'
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
          role='dialog'
          style={{
            left: center.x - QUICK_MENU_EXTENT,
            top: center.y - QUICK_MENU_EXTENT,
            width: DISC_SIZE,
            height: DISC_SIZE,
            touchAction: 'none',
          }}
          transition={reduceMotion ? { duration: 0.12 } : { type: 'spring', stiffness: 420, damping: 32 }}
          onPointerDown={swallowPointer}
          onPointerMove={swallowPointer}
          onPointerUp={swallowPointer}
        >
          <div className={`${CLAY_EDGE} ${CLAY_SURFACE} absolute inset-0 rounded-full shadow-[0_6px_0_rgb(var(--st-clay-edge,205_209_224))]`} />

          {ringColors.map((color, index) => {
            const isActive = sameColor(strokeColor, color);

            return renderSlot(
              color,
              SLOTS.colors[index],
              index,
              <ColorSwatch
                className={`${CLAY_EDGE} ${CLAY_LIP} ${CLAY_SURFACE} ${CLAY_PRESS} rounded-full`}
                color={color}
                isSelected={isActive}
                label={t('quick.colorN', { color })}
                size='lg'
                onClick={() => {
                  onStrokeColorChange(color);
                  onClose();
                }}
              />,
            );
          })}

          {renderSlot(
            'width-decrease',
            SLOTS.decrease,
            ringColors.length,
            <button
              aria-label={t('quick.thinner')}
              className={widthButtonClass(canDecreaseWidth)}
              disabled={!canDecreaseWidth}
              type='button'
              onClick={() => onStrokeWidthChange(getAdjacentStrokeWidth(currentStrokeWidth, -1))}
            >
              <Minus className='h-4 w-4' />
            </button>,
          )}
          {renderSlot(
            'width-increase',
            SLOTS.increase,
            ringColors.length + 1,
            <button
              aria-label={t('quick.thicker')}
              className={widthButtonClass(canIncreaseWidth)}
              disabled={!canIncreaseWidth}
              type='button'
              onClick={() => onStrokeWidthChange(getAdjacentStrokeWidth(currentStrokeWidth, 1))}
            >
              <Plus className='h-4 w-4' />
            </button>,
          )}

          <button
            aria-label={t('quick.close')}
            className={`${CLAY_EDGE} ${CLAY_LIP} ${CLAY_SURFACE} ${CLAY_PRESS} absolute flex cursor-grab touch-none select-none flex-col items-center justify-center gap-1 rounded-full active:cursor-grabbing`}
            style={{
              left: QUICK_MENU_EXTENT - QUICK_MENU_HUB_SIZE / 2,
              top: QUICK_MENU_EXTENT - QUICK_MENU_HUB_SIZE / 2,
              width: QUICK_MENU_HUB_SIZE,
              height: QUICK_MENU_HUB_SIZE,
            }}
            type='button'
            {...hubHandlers}
          >
            <span className='flex h-7 w-7 items-center justify-center'>
              <span
                className='border-ink/30 rounded-full border'
                style={{ backgroundColor: strokeColor, width: previewDotSize, height: previewDotSize }}
              />
            </span>
            <span className='text-[10px] font-semibold leading-none tabular-nums'>{currentStrokeWidth}px</span>
          </button>
        </motion.div>
      ) : null}
    </div>
  );
};

export default QuickGestureMenu;
