import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button, Popover, PopoverContent, PopoverTrigger } from '@repo/ui';
import { Eraser, Eye, Highlighter, MousePointer2, Pencil, Redo2, Undo2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import type { EraserMode, StrokeSettings, WhiteboardTool, WholeHandEraserSettings } from './types';
import { isPenFamilyTool } from './types';

import ColorPicker from './ColorPicker';
import EraserSettings from './EraserSettings';
import StrokeSettingsComponent from './StrokeSettings';
import { TOOLBAR_SURFACE } from './toolbarSurfaces';
import { useWbStrings } from '../../i18n/context';
import type { WbStringKey } from '../../i18n/strings';

const TRIGGER_WIDTH = 40;
const TRIGGER_HEIGHT = 40;
const VIEWPORT_PADDING = 16;
const MIN_TOP = 96;
const QUICK_TOOL_LABELS: Record<QuickTool, WbStringKey> = {
  select: 'tool.select',
  pen: 'tool.pen',
  brush: 'tool.brush',
  marker: 'tool.marker',
  script: 'tool.script',
  highlighter: 'tool.highlighter',
  eraser: 'tool.eraser',
};

interface FocusModeDockProps {
  overlayPortalContainer?: Element;
  activeTool: WhiteboardTool;
  strokeSettings: StrokeSettings;
  eraserMode: EraserMode;
  eraserSize: number;
  forceObjectEraserMode?: boolean;
  /** Whole-hand (palm) eraser settings; when provided (with onWholeHandEraserChange) the palm-eraser
   *  controls render inside the eraser panel. */
  wholeHandEraser?: WholeHandEraserSettings;
  canUndo: boolean;
  canRedo: boolean;
  smoothingEnabled: boolean;
  onToolChange: (tool: WhiteboardTool) => void;
  onEraserModeChange: (mode: EraserMode) => void;
  onEraserSizeChange: (size: number) => void;
  onWholeHandEraserChange?: (next: WholeHandEraserSettings) => void;
  onStrokeSettingsChange: (settings: StrokeSettings) => void;
  onSmoothingChange: (enabled: boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  onExitFocusMode: () => void;
}

interface ViewportSize {
  width: number;
  height: number;
}

interface FloatingPosition {
  x: number;
  y: number;
}

// The focus dock is the reduced UI: one tile stands for the whole pen family. It has to ACCEPT the brush
// and marker even though it never offers them separately, or entering focus mode while brushing lit no
// tile at all and the only pen tile switched you off your nib with no way back.
type QuickTool = 'select' | 'pen' | 'brush' | 'marker' | 'script' | 'highlighter' | 'eraser';

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

interface QuickButtonProps {
  icon: React.ReactNode;
  label: string;
  isActive?: boolean;
  isDisabled?: boolean;
  onPress: () => void;
}

// Layout only — the face/label/rim come from `TOOLBAR_SURFACE` through `style`, the clay Button's own
// contract. A `bg-*`/`text-*` utility here competes with the Button's hover rule and strands the icon
// white-on-white on a tablet's sticky hover (see toolbarSurfaces.ts).
// Icon-only tiles (the label is the tooltip / aria-label): focus mode is about the page, not the dock.
const QUICK_TILE_BASE_CLASS = 'h-10 w-full min-w-0 rounded-xl px-0 shadow-none';

const clampPosition = (x: number, y: number, viewport: ViewportSize): FloatingPosition => ({
  x: Math.min(
    Math.max(x, VIEWPORT_PADDING),
    Math.max(VIEWPORT_PADDING, viewport.width - TRIGGER_WIDTH - VIEWPORT_PADDING),
  ),
  y: Math.min(Math.max(y, MIN_TOP), Math.max(MIN_TOP, viewport.height - TRIGGER_HEIGHT - VIEWPORT_PADDING)),
});

const QuickButton: React.FC<QuickButtonProps> = ({ icon, label, isActive = false, isDisabled = false, onPress }) => {
  return (
    <Button
      isIconOnly
      aria-label={label}
      className={QUICK_TILE_BASE_CLASS}
      isDisabled={isDisabled}
      size='sm'
      style={TOOLBAR_SURFACE[isActive ? 'active' : 'idle']}
      title={label}
      variant='flat'
      onPress={onPress}
    >
      {icon}
    </Button>
  );
};

const MemoizedQuickButton = React.memo(QuickButton);

export const FocusModeDock: React.FC<FocusModeDockProps> = ({
  overlayPortalContainer,
  activeTool,
  strokeSettings,
  eraserMode,
  eraserSize,
  forceObjectEraserMode = false,
  wholeHandEraser,
  canUndo,
  canRedo,
  smoothingEnabled,
  onToolChange,
  onEraserModeChange,
  onEraserSizeChange,
  onWholeHandEraserChange,
  onStrokeSettingsChange,
  onSmoothingChange,
  onUndo,
  onRedo,
  onExitFocusMode,
}) => {
  const { t } = useWbStrings();
  const rootRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const positionRef = useRef<FloatingPosition>({
    x: VIEWPORT_PADDING,
    y: MIN_TOP,
  });

  const [isExpanded, setIsExpanded] = useState(false);
  const [viewport, setViewport] = useState<ViewportSize>({ width: 0, height: 0 });
  const [position, setPosition] = useState<FloatingPosition>({
    x: VIEWPORT_PADDING,
    y: MIN_TOP,
  });

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const syncViewport = () => {
      const nextViewport = {
        width: window.innerWidth,
        height: window.innerHeight,
      };

      setViewport(nextViewport);
      setPosition((current) => {
        const hasDockMoved = current.x !== VIEWPORT_PADDING || current.y !== MIN_TOP;
        const fallbackPosition = {
          x: nextViewport.width - TRIGGER_WIDTH - VIEWPORT_PADDING,
          y: nextViewport.height - TRIGGER_HEIGHT - VIEWPORT_PADDING,
        };

        return clampPosition(
          hasDockMoved ? current.x : fallbackPosition.x,
          hasDockMoved ? current.y : fallbackPosition.y,
          nextViewport,
        );
      });
    };

    syncViewport();
    window.addEventListener('resize', syncViewport);

    return () => {
      window.removeEventListener('resize', syncViewport);
    };
  }, []);

  useEffect(() => {
    if (!isExpanded) return;

    const handleOutsidePress = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;

      setIsExpanded(false);
    };

    document.addEventListener('pointerdown', handleOutsidePress);

    return () => {
      document.removeEventListener('pointerdown', handleOutsidePress);
    };
  }, [isExpanded]);

  const handleToolSelect = useCallback(
    (tool: QuickTool) => {
      onToolChange(tool);
      setIsExpanded(false);
    },
    [onToolChange],
  );

  const handleStrokeColorChange = useCallback(
    (color: string) => {
      onStrokeSettingsChange({ ...strokeSettings, color });
    },
    [onStrokeSettingsChange, strokeSettings],
  );

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: positionRef.current.x,
      originY: positionRef.current.y,
      moved: false,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const dragState = dragStateRef.current;

      if (!dragState || dragState.pointerId !== event.pointerId || viewport.width === 0) return;

      const nextX = dragState.originX + event.clientX - dragState.startX;
      const nextY = dragState.originY + event.clientY - dragState.startY;
      const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);

      dragState.moved = dragState.moved || distance > 6;
      setPosition(clampPosition(nextX, nextY, viewport));
    },
    [viewport],
  );

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) return;

    dragStateRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);

    if (!dragState.moved) {
      setIsExpanded((prev) => !prev);
    }
  }, []);

  const handlePointerCancel = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) return;

    dragStateRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const isDockOnLeft = viewport.width > 0 && position.x < viewport.width / 2;
  const shouldOpenBelow = viewport.height > 0 && position.y < viewport.height / 2;

  const orbAccent = useMemo(() => {
    if (activeTool === 'eraser') return '#fb7185';
    if (activeTool === 'highlighter') return '#fbbf24';

    return strokeSettings.color;
  }, [activeTool, strokeSettings.color]);

  const orbIcon = useMemo(() => {
    switch (activeTool) {
      case 'select':
        return <MousePointer2 className='h-4.5 w-4.5' />;
      case 'highlighter':
        return <Highlighter className='h-4.5 w-4.5' />;
      case 'eraser':
        return <Eraser className='h-4.5 w-4.5' />;
      default:
        return <Pencil className='h-4.5 w-4.5' />;
    }
  }, [activeTool]);

  return (
    <div
      ref={rootRef}
      className='pointer-events-none fixed inset-0 z-40'
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      <div className='absolute' style={{ left: position.x, top: position.y }}>
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className={`pointer-events-auto absolute z-10 w-[168px] rounded-2xl border border-slate-200 bg-white/95 p-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.14)] backdrop-blur ${
                isDockOnLeft ? 'left-0' : 'right-0'
              } ${shouldOpenBelow ? 'top-[calc(100%+8px)]' : 'bottom-[calc(100%+8px)]'}`}
              exit={{ opacity: 0, scale: 0.92, y: shouldOpenBelow ? -8 : 8 }}
              initial={{ opacity: 0, scale: 0.92, y: shouldOpenBelow ? -8 : 8 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >

              <div className='grid grid-cols-3 gap-1.5'>
                <MemoizedQuickButton
                  icon={<MousePointer2 className='h-4 w-4' />}
                  isActive={activeTool === 'select'}
                  label={t(QUICK_TOOL_LABELS.select)}
                  onPress={() => handleToolSelect('select')}
                />
                <MemoizedQuickButton
                  icon={<Pencil className='h-4 w-4' />}
                  isActive={isPenFamilyTool(activeTool)}
                  label={t(QUICK_TOOL_LABELS[isPenFamilyTool(activeTool) ? (activeTool as QuickTool) : 'pen'])}
                  // Already on a nib? Stay on it — re-selecting the tile must not silently demote the
                  // brush or marker back to the plain pen.
                  onPress={() => handleToolSelect(isPenFamilyTool(activeTool) ? (activeTool as QuickTool) : 'pen')}
                />
                <MemoizedQuickButton
                  icon={<Highlighter className='h-4 w-4' />}
                  isActive={activeTool === 'highlighter'}
                  label={t(QUICK_TOOL_LABELS.highlighter)}
                  onPress={() => handleToolSelect('highlighter')}
                />
                <MemoizedQuickButton
                  icon={<Eraser className='h-4 w-4' />}
                  isActive={activeTool === 'eraser'}
                  label={t(QUICK_TOOL_LABELS.eraser)}
                  onPress={() => handleToolSelect('eraser')}
                />
                <MemoizedQuickButton
                  icon={<Undo2 className='h-4 w-4' />}
                  isDisabled={!canUndo}
                  label={t('toolbar.undo')}
                  onPress={onUndo}
                />
                <MemoizedQuickButton
                  icon={<Redo2 className='h-4 w-4' />}
                  isDisabled={!canRedo}
                  label={t('toolbar.redo')}
                  onPress={onRedo}
                />

                <Popover
                  placement={shouldOpenBelow ? 'bottom-start' : 'top-start'}
                  portalContainer={overlayPortalContainer}
                >
                  <PopoverTrigger>
                    <Button
                      isIconOnly
                      aria-label={t('focus.color')}
                      className={QUICK_TILE_BASE_CLASS}
                      size='sm'
                      style={TOOLBAR_SURFACE.idle}
                      title={t('focus.color')}
                      variant='flat'
                    >
                      <span
                        className='h-5 w-5 rounded-full border-2 border-slate-200'
                        style={{ backgroundColor: strokeSettings.color }}
                      />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className='p-0'>
                    <ColorPicker color={strokeSettings.color} label={t('toolbar.strokeColor')} onChange={handleStrokeColorChange} />
                  </PopoverContent>
                </Popover>

                <Popover
                  placement={shouldOpenBelow ? 'bottom-end' : 'top-end'}
                  portalContainer={overlayPortalContainer}
                >
                  <PopoverTrigger>
                    <Button
                      isIconOnly
                      aria-label={t('focus.size')}
                      className={QUICK_TILE_BASE_CLASS}
                      size='sm'
                      style={TOOLBAR_SURFACE.idle}
                      title={t('focus.size')}
                      variant='flat'
                    >
                        <svg className='h-5 w-5 text-slate-700' viewBox='0 0 20 20'>
                          <line
                            stroke='currentColor'
                            strokeLinecap='round'
                            strokeWidth={Math.min(strokeSettings.width / 2, 4)}
                            x1='3'
                            x2='17'
                            y1='10'
                            y2='10'
                          />
                        </svg>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className='p-0'>
                    <StrokeSettingsComponent
                      settings={strokeSettings}
                      smoothingEnabled={smoothingEnabled}
                      onChange={onStrokeSettingsChange}
                      onSmoothingChange={onSmoothingChange}
                    />
                  </PopoverContent>
                </Popover>

                <MemoizedQuickButton
                  icon={<Eye className='h-4 w-4' />}
                  label={t('focus.hide')}
                  onPress={() => {
                    setIsExpanded(false);
                    onExitFocusMode();
                  }}
                />
              </div>

              {activeTool === 'eraser' && (
                <div className='mt-1.5 rounded-xl border border-rose-100 bg-white/70 p-1.5'>
                  <EraserSettings
                    forceObjectMode={forceObjectEraserMode}
                    mode={eraserMode}
                    size={eraserSize}
                    wholeHandEraser={wholeHandEraser}
                    onModeChange={onEraserModeChange}
                    onSizeChange={onEraserSizeChange}
                    onWholeHandEraserChange={onWholeHandEraserChange}
                  />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <motion.button
          animate={{ scale: isExpanded ? 1.06 : 1 }}
          aria-expanded={isExpanded}
          aria-label={t('focus.title')}
          // A small quiet knob: drag to move, tap to open. Its rim carries the pen colour; the icon stays
          // dark so a white or yellow pen never makes it vanish.
          className='pointer-events-auto flex h-10 w-10 touch-none items-center justify-center rounded-full border-2 bg-white/90 text-slate-800 shadow-[0_4px_14px_rgba(15,23,42,0.16)] backdrop-blur'
          style={{ borderColor: orbAccent }}
          transition={{ type: 'spring', stiffness: 280, damping: 24 }}
          type='button'
          onPointerCancel={handlePointerCancel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          {orbIcon}
        </motion.button>
      </div>
    </div>
  );
};

export default FocusModeDock;
