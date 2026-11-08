import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Divider, Popover, PopoverContent, PopoverTrigger, Tooltip } from '@repo/ui';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Circle,
  Compass,
  CloudUpload,
  ClipboardPaste,
  Copy,
  CopyPlus,
  DraftingCompass,
  Download,
  Eraser,
  EyeOff,
  FileDown,
  FileJson,
  FileUp,
  Grid3X3,
  Hand,
  Highlighter,
  ImagePlus,
  Minus,
  MousePointer2,
  MoveRight,
  Maximize2,
  Menu,
  MessagesSquare,
  Minimize2,
  PenLine,
  Settings2,
  Pencil,
  Pointer,
  RectangleVertical,
  Redo2,
  RotateCw,
  Rows3,
  Ruler,
  ScanSearch,
  Sparkles,
  Square,
  StickyNote,
  Trash2,
  Triangle,
  Type,
  Undo2,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { motion } from 'motion/react';

import type {
  BackgroundType,
  EraserMode,
  GeometryStencilKind,
  TabletInputSettings,
  StrokeSettings,
  ToolbarDock,
  WhiteboardTool,
} from './types';
import { isPenFamilyTool, PEN_FAMILY_TOOLS } from './types';

import BackgroundSelector from './BackgroundSelector';
import ColorPicker from './ColorPicker';
import { HIGHLIGHTER_INKS } from './palette';
import { ShapeStylePanel } from './ShapeStylePanel';
import type { ShapeStyleSettings } from './utils/shapeStyle';
import type { ShapeStylePatch } from './utils/shapeStylePaint';
import EraserSettings from './EraserSettings';
import StrokeSettingsComponent from './StrokeSettings';
import TabletInputSettingsComponent from './TabletInputSettings';
import { penSurface, TOOLBAR_SURFACE } from './toolbarSurfaces';
import { createDragScroll, scrollEdges, type ScrollEdges } from './utils/toolbarScroll';
import { useWbStrings } from '../../i18n/context';
import type { WbStringKey } from '../../i18n/strings';

interface ToolbarProps {
  overlayPortalContainer?: Element;
  activeTool: WhiteboardTool;
  openToolSettings: 'pen' | 'eraser' | 'highlighter' | null;
  onOpenToolSettings: (tool: 'pen' | 'eraser' | 'highlighter' | null) => void;
  dock: ToolbarDock;
  onToolChange: (tool: WhiteboardTool) => void;
  onDockChange: (dock: ToolbarDock) => void;
  strokeSettings: StrokeSettings;
  onStrokeSettingsChange: (settings: StrokeSettings) => void;
  onColorSwap?: () => void;
  eraserMode: EraserMode;
  eraserSize: number;
  forceObjectEraserMode?: boolean;
  tabletInputSettings: TabletInputSettings;
  /** Hide the training-capture switch entirely — see `WhiteboardEditorProps.penCaptureLocked`. */
  penCaptureLocked?: boolean;
  onEraserModeChange: (mode: EraserMode) => void;
  onEraserSizeChange: (size: number) => void;
  onTabletInputSettingsChange: (settings: TabletInputSettings) => void;
  smoothingEnabled: boolean;
  onSmoothingChange: (enabled: boolean) => void;
  fillColor: string;
  onFillColorChange: (color: string) => void;
  /** With these, the fill button opens the shape panel (outline, background, pattern, line style…) instead. */
  shapeStyle?: ShapeStyleSettings;
  onShapeStyleChange?: (patch: ShapeStylePatch) => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onClear: () => void;
  onUploadPdf: () => void;
  /**
   * How imported PDF pages are shown: one page at a time, or every page stacked in one scrollable
   * column (`WhiteboardEditor.pdfLayout`). The toggle button renders only when `onPdfLayoutChange` is
   * given — hosts that have not opted in never see it.
   */
  pdfLayout?: 'paged' | 'scroll';
  onPdfLayoutChange?: (layout: 'paged' | 'scroll') => void;
  /** The current page carries a PDF/image background — the only case where rotating means anything. */
  hasPdfPageBackground: boolean;
  onRotatePageBackground: () => void;
  onExportDocument: () => void;
  onExportImage: () => void;
  onExportPdf: () => void;
  onPublishVersion?: () => void;
  onInsertImage: () => void;
  onDuplicatePage: () => void;
  /** Paste the in-app clipboard at the middle of the view; absent = nothing copied (button hidden). */
  onPaste?: () => void;
  /**
   * Put the select arrow in the collapsed row, right after the eraser (and not again in the drawer).
   * Off by default: the whiteboard app traded it for «Upload PDF» on purpose (e374260b).
   */
  compactSelectTool?: boolean;
  /**
   * Put Undo / Redo in the collapsed row too (at its end, before ☰), so a tablet that keeps the
   * toolbar collapsed is never one tap away from undo. Off by default: the whiteboard app's row is
   * unchanged. They then leave the drawer.
   */
  compactUndoRedo?: boolean;
  /**
   * How a top/bottom dock lays out. `'wrap'` (default): a centred pill that wraps into rows inside the
   * gap the chrome leaves, with the rarer tools behind ☰. `'full-scroll'`: one row spanning the whole
   * width the host gives it, EVERY tool in it (no ☰ drawer), scrolling sideways — touch, pen or wheel —
   * with an edge fade where tools are hidden. A side dock is unchanged.
   */
  layout?: 'wrap' | 'full-scroll';
  /**
   * `layout='full-scroll'` only: a group pinned at the row's END edge, outside the scrolling tools and
   * behind a divider — the host's page navigation (prev / page / next / add / page list), so it stays
   * reachable while the tools scroll. Ignored by every other layout.
   */
  trailing?: React.ReactNode;
  onInsertGeometryStencil: (kind: GeometryStencilKind) => void;
  /** Insert a clean, stretchable square-root sign (√). Omitted → no tile. */
  onInsertRadical?: () => void;
  isExportingPdf: boolean;
  isPublishingVersion?: boolean;
  isLocked: boolean;
  onToggleLock: () => void;
  backgroundType: BackgroundType;
  backgroundImageOpacity: number;
  onBackgroundTypeChange: (type: BackgroundType) => void;
  /** Board paper spacing in mm (see BackgroundSelector); the control shows only with the handler. */
  paperSpacingMm?: number;
  onPaperSpacingChange?: (mm: number) => void;
  onBackgroundImageOpacityChange: (opacity: number) => void;
  hasSharedBackgroundImage: boolean;
  onClearSharedBackground: () => void;
  onEnterFocusMode: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onUploadSharedBackground: () => void;
  /** Board AI entry points; absent = the board has no AI service and shows no AI buttons. */
  ai?: ToolbarAiControls;
}

export interface ToolbarAiControls {
  /** The one-shot «Ask AI» lasso is armed. */
  lassoActive: boolean;
  onAsk: () => void;
  onGenerate: () => void;
  onAnalyzePage: () => void;
  onRemakePage: () => void;
  /** «Explain on my page» — only when the service can plan pen actions. */
  onPenExplain?: () => void;
  /** Reopens this page's AI chat thread; absent = no menu entry. */
  onChat?: () => void;
}

interface ToolButtonProps {
  overlayPortalContainer?: Element;
  tool: WhiteboardTool;
  activeTool: WhiteboardTool;
  icon: React.ReactNode;
  label: string;
  onToolChange: (tool: WhiteboardTool) => void;
}

interface ActionButtonProps {
  overlayPortalContainer?: Element;
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
  color?: 'default' | 'primary' | 'danger' | 'warning' | 'success' | 'secondary';
}

interface ToolbarSectionProps {
  children: React.ReactNode;
  isVertical: boolean;
  tone?: 'accent' | 'default';
}

const TOOL_LABELS: Record<WhiteboardTool, WbStringKey> = {
  select: 'tool.select',
  pen: 'tool.pen',
  brush: 'tool.brush',
  marker: 'tool.marker',
  script: 'tool.script',
  highlighter: 'tool.highlighter',
  eraser: 'tool.eraser',
  line: 'tool.line',
  arrow: 'tool.arrow',
  rect: 'tool.rect',
  circle: 'tool.circle',
  triangle: 'tool.triangle',
  text: 'tool.text',
  sticky: 'tool.sticky',
  image: 'tool.image',
  laser: 'tool.laser',
  pan: 'tool.pan',
};

// Layout only. Face, label, rim and hover wash are the clay Button's to paint, from the `--clay-*`
// values in `TOOLBAR_SURFACE` — a `bg-*`/`text-*` utility here would fight the Button's own rules for
// the same property and lose on hover (see toolbarSurfaces.ts for the white-on-white that caused).
/**
 * A toolbar popover's own size cap. Off a horizontal dock (placement top/bottom) it may take the whole
 * height on its side of the toolbar — the Popover itself caps it to the room left above/below the
 * trigger and scrolls inside — instead of an arbitrary 80dvh that cut the pen menu at «Opacity» while
 * half the screen above it sat empty. A side dock keeps the old cap.
 */
function popoverPanelClassName(placement: 'top' | 'bottom' | 'left' | 'right'): string {
  return placement === 'top' || placement === 'bottom'
    ? 'max-h-[calc(100dvh-1.5rem)] max-w-[calc(100vw-1.5rem)] overflow-y-auto overflow-x-hidden p-0'
    : 'max-h-[min(80dvh,42rem)] overflow-y-auto overflow-x-hidden p-0';
}

const ICON_BUTTON_BASE_CLASS =
  'h-8 w-8 min-w-8 rounded-xl border-2 p-0 transition-all duration-150';

// Buttons that live inside a themed popover: layout only, and NO surface at rest — the Button's own
// flat default follows the theme there, where a literal light fill would not.
// Tiles wrap icon + label in their own column span: the Button's inner span is a row, which squeezed «Rectangle» / «Protractor» past the edge.
const POPOVER_TILE_CLASS =
  '!h-auto min-h-0 min-w-0 rounded-2xl !px-1.5 !py-2.5 text-[11px] font-semibold';

const DOCK_OPTIONS: Array<{ dock: ToolbarDock; icon: React.ReactNode; label: WbStringKey }> = [
  { dock: 'top', icon: <ArrowUp className='h-4 w-4' />, label: 'toolbar.dock.top' },
  { dock: 'right', icon: <ArrowRight className='h-4 w-4' />, label: 'toolbar.dock.right' },
  { dock: 'bottom', icon: <ArrowDown className='h-4 w-4' />, label: 'toolbar.dock.bottom' },
  { dock: 'left', icon: <ArrowLeft className='h-4 w-4' />, label: 'toolbar.dock.left' },
];

const GEOMETRY_DRAW_TOOLS: Array<{ icon: React.ReactNode; label: WbStringKey; tool: WhiteboardTool }> = [
  { tool: 'line', label: TOOL_LABELS.line, icon: <Minus className='h-4 w-4' /> },
  { tool: 'arrow', label: TOOL_LABELS.arrow, icon: <MoveRight className='h-4 w-4' /> },
  { tool: 'rect', label: TOOL_LABELS.rect, icon: <Square className='h-4 w-4' /> },
  { tool: 'circle', label: TOOL_LABELS.circle, icon: <Circle className='h-4 w-4' /> },
  { tool: 'triangle', label: TOOL_LABELS.triangle, icon: <Triangle className='h-4 w-4' /> },
];

/** A √ glyph drawn like the inserted sign itself (serif, tick, stem, bar), sized like the other icons. */
const RadicalIcon: React.FC = () => (
  <svg
    aria-hidden='true'
    className='h-4 w-4'
    fill='none'
    stroke='currentColor'
    strokeLinecap='round'
    strokeLinejoin='round'
    strokeWidth={1.8}
    viewBox='0 0 24 24'
  >
    <path d='M2.5 14.5 4.5 13.4 8 20 12 4H22' />
  </svg>
);

const GEOMETRY_STENCILS: Array<{ icon: React.ReactNode; kind: GeometryStencilKind; label: WbStringKey }> = [
  { kind: 'protractor', label: 'editor.geo.protractor', icon: <Ruler className='h-4 w-4' /> },
  { kind: 'set-square', label: 'editor.geo.setSquare', icon: <Triangle className='h-4 w-4' /> },
  { kind: 'compass', label: 'editor.geo.compass', icon: <Compass className='h-4 w-4' /> },
];

const CORE_TOOLS: WhiteboardTool[] = ['select', 'pen', 'eraser', 'pan'];
// The dock force-expands whenever the active tool is NOT in this set, so the teacher can always see what
// is selected. The brush and marker ARE reachable from the collapsed row — they live inside the pen
// button's own settings popover — so they belong here. Without them, picking either one pinned the dock
// open: `showExpandedTools` ORs `isExpanded`, so the toggle could not close it again, and the only way
// out was switching back to the plain pen.
const CORE_TOOL_SET = new Set<WhiteboardTool>([...CORE_TOOLS, ...PEN_FAMILY_TOOLS]);

const ToolbarSection: React.FC<ToolbarSectionProps> = ({ children, isVertical, tone = 'default' }) => (
  <div
    data-wb-toolbar-section={tone}
    className={`shrink-0 rounded-lg border p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.78)] backdrop-blur-sm ${
      isVertical ? 'flex w-full flex-col items-center gap-1' : 'flex items-center gap-1'
    } ${
      tone === 'accent'
        ? 'border-amber-200/75 bg-[linear-gradient(135deg,rgba(255,251,235,0.95),rgba(255,247,237,0.84))]'
        : 'border-white/85 bg-[linear-gradient(135deg,rgba(255,255,255,0.9),rgba(248,250,252,0.78))]'
    }`}
  >
    {children}
  </div>
);

const MemoizedToolbarSection = React.memo(ToolbarSection);

const ToolButton: React.FC<ToolButtonProps> = ({
  overlayPortalContainer,
  tool,
  activeTool,
  icon,
  label,
  onToolChange,
}) => {
  const isActive = activeTool === tool;

  return (
    <Tooltip content={label} delay={400} portalContainer={overlayPortalContainer} size='sm'>
      <Button
        aria-label={label}
        className={`${ICON_BUTTON_BASE_CLASS} shrink-0`}
        color='default'
        isIconOnly
        size='sm'
        style={TOOLBAR_SURFACE[isActive ? 'active' : 'idle']}
        variant='flat'
        onPress={() => onToolChange(tool)}
      >
        {icon}
      </Button>
    </Tooltip>
  );
};

const MemoizedToolButton = React.memo(ToolButton);

const SettingsToolButton: React.FC<{
  // 'pen' here means "the pen button", which may currently stand for any of the pen-family nibs.
  tool: WhiteboardTool;
  activeTool: WhiteboardTool;
  icon: React.ReactNode;
  isOpen: boolean;
  placement: 'top' | 'bottom' | 'left' | 'right';
  overlayPortalContainer?: Element;
  onToolChange: (tool: WhiteboardTool) => void;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** When active, paint the key in this colour (the pen key wears the pen's ink). */
  activeColor?: string;
}> = ({ tool, activeTool, icon, isOpen, placement, overlayPortalContainer, onToolChange, onOpenChange, children, activeColor }) => {
  const isActive = activeTool === tool;
  const handlePress = useCallback(() => {
    if (!isActive) {
      onToolChange(tool);

      return;
    }

    onOpenChange(!isOpen);
  }, [isActive, isOpen, tool, onToolChange, onOpenChange]);

  return (
    <Popover isOpen={isOpen} placement={placement} portalContainer={overlayPortalContainer} onOpenChange={onOpenChange}>
      <PopoverTrigger>
        <Button
          className={`${ICON_BUTTON_BASE_CLASS} shrink-0`}
          color='default'
          isIconOnly
          size='sm'
          style={isActive ? (activeColor ? penSurface(activeColor) : TOOLBAR_SURFACE.active) : TOOLBAR_SURFACE.idle}
          variant='flat'
          onClick={(e) => e.preventDefault()}
          onPress={handlePress}
        >
          {icon}
        </Button>
      </PopoverTrigger>
      {/* Cap the settings panel to the viewport and scroll inside it — tall menus (pen/eraser with the
          whole-hand controls) were overflowing off-screen with no way to reach the lower items. */}
      <PopoverContent className={popoverPanelClassName(placement)}>
        {children}
      </PopoverContent>
    </Popover>
  );
};

const MemoizedSettingsToolButton = React.memo(SettingsToolButton);

/** Highlighter inks (drawn at the highlighter's own translucency, so these are full-strength hexes). */
const HIGHLIGHTER_PALETTE: string[] = [...HIGHLIGHTER_INKS];

const ActionButton: React.FC<ActionButtonProps> = ({
  overlayPortalContainer,
  icon,
  label,
  onPress,
  isDisabled = false,
  color = 'default',
}) => {
  return (
    <Tooltip content={label} delay={400} portalContainer={overlayPortalContainer} size='sm'>
      <Button
        aria-label={label}
        className={`${ICON_BUTTON_BASE_CLASS} shrink-0 ${isDisabled ? 'opacity-45' : ''}`}
        color='default'
        isDisabled={isDisabled}
        isIconOnly
        size='sm'
        style={TOOLBAR_SURFACE[color === 'default' ? 'idle' : color]}
        variant='flat'
        onPress={onPress}
      >
        {icon}
      </Button>
    </Tooltip>
  );
};

const MemoizedActionButton = React.memo(ActionButton);

const Toolbar: React.FC<ToolbarProps> = ({
  overlayPortalContainer,
  activeTool,
  openToolSettings,
  onOpenToolSettings,
  dock,
  onToolChange,
  onDockChange,
  strokeSettings,
  onStrokeSettingsChange,
  onColorSwap,
  eraserMode,
  eraserSize,
  forceObjectEraserMode = false,
  tabletInputSettings,
  penCaptureLocked = false,
  onEraserModeChange,
  onEraserSizeChange,
  onTabletInputSettingsChange,
  smoothingEnabled,
  onSmoothingChange,
  fillColor,
  onFillColorChange,
  shapeStyle,
  onShapeStyleChange,
  zoom,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onClear,
  onUploadPdf,
  pdfLayout = 'paged',
  onPdfLayoutChange,
  hasPdfPageBackground,
  onRotatePageBackground,
  onExportDocument,
  onExportImage,
  onExportPdf,
  onPublishVersion,
  onInsertImage,
  onInsertGeometryStencil,
  onInsertRadical,
  onDuplicatePage,
  onPaste,
  compactSelectTool = false,
  compactUndoRedo = false,
  layout = 'wrap',
  trailing,
  isExportingPdf,
  isPublishingVersion = false,
  isLocked,
  onToggleLock,
  backgroundType,
  backgroundImageOpacity,
  onBackgroundTypeChange,
  paperSpacingMm,
  onPaperSpacingChange,
  onBackgroundImageOpacityChange,
  hasSharedBackgroundImage,
  onClearSharedBackground,
  onEnterFocusMode,
  isFullscreen,
  onToggleFullscreen,
  onUploadSharedBackground,
  ai,
}) => {
  const { t, dir } = useWbStrings();
  // The fill button shows the background new shapes get (the shape panel's, when there is one).
  const shownFill = shapeStyle && onShapeStyleChange ? shapeStyle.fill : fillColor;
  const [isExpanded, setIsExpanded] = useState(false);
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
  // Which nib the pen button re-selects when tapped. Without this, a teacher writing with the brush who
  // taps the pen button to reach its settings would be silently dropped back to the plain pen — the
  // button must return them to the nib they were actually using.
  const [lastPenTool, setLastPenTool] = useState<WhiteboardTool>('pen');

  useEffect(() => {
    if (isPenFamilyTool(activeTool)) setLastPenTool(activeTool);
  }, [activeTool]);
  const handleStrokeColorChange = useCallback(
    (color: string) => {
      onStrokeSettingsChange({ ...strokeSettings, color });
    },
    [strokeSettings, onStrokeSettingsChange],
  );
  const handleSecondaryColorChange = useCallback(
    (secondaryColor: string) => {
      onStrokeSettingsChange({ ...strokeSettings, secondaryColor });
    },
    [strokeSettings, onStrokeSettingsChange],
  );
  const handleColorSwap = useCallback(() => {
    if (onColorSwap) {
      onColorSwap();

      return;
    }

    onStrokeSettingsChange({
      ...strokeSettings,
      color: strokeSettings.secondaryColor,
      secondaryColor: strokeSettings.color,
    });
  }, [onColorSwap, strokeSettings, onStrokeSettingsChange]);

  const zoomPercentage = Math.round(zoom * 100);
  const isVertical = dock === 'left' || dock === 'right';
  // A full-width scrolling row has room for everything: nothing hides behind ☰ there.
  const isScrollRow = layout === 'full-scroll';
  // The same full-scroll bar turned on its side: a flush column down the left/right edge.
  const isScrollColumn = isScrollRow && isVertical;
  // A bottom-docked scroll row is a plain bar flush with the screen's bottom edge — edge to edge, square,
  // no elevation, a 1px top rule, padded above the Android gesture bar. The editor lays it out IN FLOW
  // under the canvas, so the page is never hidden behind it.
  const isFlatBar = isScrollRow && dock !== 'top';
  const showExpandedTools = isScrollRow || isExpanded || !CORE_TOOL_SET.has(activeTool);
  const scrollRowRef = useRef<HTMLDivElement>(null);
  const [rowEdges, setRowEdges] = useState<ScrollEdges>({ start: false, end: false });

  useEffect(() => {
    const row = scrollRowRef.current;
    if (!isScrollRow || !row) return;
    const update = () => {
      const next = isVertical
        ? scrollEdges(row.scrollTop, row.scrollHeight, row.clientHeight)
        : scrollEdges(row.scrollLeft, row.scrollWidth, row.clientWidth);
      setRowEdges((current) => (current.start === next.start && current.end === next.end ? current : next));
    };
    // A mouse wheel scrolls the row sideways too; touch and pen swipe it natively.
    const onWheel = (event: WheelEvent) => {
      if (isVertical || row.scrollWidth <= row.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      row.scrollLeft += event.deltaY;
    };

    // Pen / mouse drag scrolls the row too: Android WebView never pans a scroller on an S Pen drag.
    // Past the threshold the press on the button underneath is cancelled (a synthetic pointercancel,
    // which react-aria's press tracking honours) and the click that follows the release is swallowed.
    const drag = createDragScroll();
    let pressTarget: EventTarget | null = null;
    let swallowClickTimer: ReturnType<typeof setTimeout> | null = null;
    const swallowClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const stopSwallowing = () => {
      if (swallowClickTimer !== null) clearTimeout(swallowClickTimer);
      swallowClickTimer = null;
      row.removeEventListener('click', swallowClick, true);
    };
    const onPointerDown = (event: PointerEvent) => {
      // A row that fits has nothing to scroll: a wobbly pen tap must stay a tap.
      const fits = isVertical ? row.scrollHeight <= row.clientHeight + 1 : row.scrollWidth <= row.clientWidth + 1;
      if (event.pointerType === 'touch' || event.button !== 0 || fits) return;
      pressTarget = event.target;
      drag.down(event.pointerId, isVertical ? event.clientY : event.clientX, isVertical ? row.scrollTop : row.scrollLeft);
    };
    const onPointerMove = (event: PointerEvent) => {
      const next = drag.move(event.pointerId, isVertical ? event.clientY : event.clientX);

      if (!next) return;
      if (next.started) {
        if (pressTarget && pressTarget !== row && typeof PointerEvent !== 'undefined') {
          pressTarget.dispatchEvent(
            new PointerEvent('pointercancel', { bubbles: true, pointerId: event.pointerId, pointerType: event.pointerType }),
          );
        }
        try {
          row.setPointerCapture(event.pointerId);
        } catch {
          // The pointer is already gone; the next move / up resolves it.
        }
      }
      if (isVertical) row.scrollTop = next.scrollLeft;
      else row.scrollLeft = next.scrollLeft;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!drag.up(event.pointerId)) return;
      pressTarget = null;
      stopSwallowing();
      row.addEventListener('click', swallowClick, true);
      swallowClickTimer = setTimeout(stopSwallowing, 400);
    };
    const onPointerCancel = (event: PointerEvent) => {
      // Our own synthetic cancel bubbles through here: it must not end the drag it started.
      if (!event.isTrusted) return;
      drag.cancel();
      pressTarget = null;
    };

    update();
    row.addEventListener('scroll', update, { passive: true });
    row.addEventListener('wheel', onWheel, { passive: false });
    row.addEventListener('pointerdown', onPointerDown);
    row.addEventListener('pointermove', onPointerMove);
    row.addEventListener('pointerup', onPointerUp);
    row.addEventListener('pointercancel', onPointerCancel);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(row);
    if (row.firstElementChild) observer?.observe(row.firstElementChild);

    return () => {
      row.removeEventListener('scroll', update);
      row.removeEventListener('wheel', onWheel);
      row.removeEventListener('pointerdown', onPointerDown);
      row.removeEventListener('pointermove', onPointerMove);
      row.removeEventListener('pointerup', onPointerUp);
      row.removeEventListener('pointercancel', onPointerCancel);
      stopSwallowing();
      observer?.disconnect();
    };
  }, [isScrollRow, isVertical, dir]);
  const popoverPlacement = dock === 'left' ? 'right' : dock === 'right' ? 'left' : dock === 'bottom' ? 'top' : 'bottom';
  const enterAnimation =
    dock === 'left'
      ? { opacity: 0, x: -20 }
      : dock === 'right'
        ? { opacity: 0, x: 20 }
        : { opacity: 0, y: dock === 'bottom' ? 20 : -20 };
  // Horizontal docks WRAP into rows; vertical docks scroll. The top row used to be a hidden-scrollbar
  // scroller capped at `calc(100vw - 19rem)` — a guess at the width of the chrome beside it — and on a
  // tablet the expanded row ran under the title bar and the record cluster with its first buttons
  // clipped off-screen and no scrollbar to say so. The editor's wrapper now pads the row by the
  // measured chrome (see utils/chromeInsets), so `max-w-full` IS the gap, and wrapping keeps every
  // button on screen without a scroll nobody can see. A side dock has the viewport height to fill
  // instead, so it keeps its cap and scroll.
  // The scroll row: `w-max min-w-full` keeps the tools centred while they fit and lets the row grow
  // past the viewport (scrolling from its start edge) once they do not — never squeezed, never wrapped.
  const containerClassName = isScrollColumn
    ? 'flex h-max min-h-full w-full flex-col flex-nowrap items-center justify-center gap-1.5 px-1.5 py-1.5'
    : isVertical
    ? 'flex min-h-min flex-col items-center gap-1.5 px-1.5 py-1.5'
    : isScrollRow
      ? 'flex w-max min-w-full flex-nowrap items-center justify-center gap-1.5 px-1.5 py-1.5'
      : 'flex flex-wrap items-center justify-center gap-1.5 px-1.5 py-1.5';
  const viewportClassName = isScrollColumn
    ? 'h-full overflow-y-auto overflow-x-hidden overscroll-y-contain [-ms-overflow-style:none] [scrollbar-width:none] [touch-action:pan-y] [&::-webkit-scrollbar]:hidden'
    : isVertical
    ? 'max-h-[min(calc(100dvh-8rem),46rem)] overflow-y-auto overflow-x-hidden rounded-lg [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
    : isScrollRow
      ? `w-full overflow-x-auto overflow-y-hidden overscroll-x-contain ${isFlatBar ? '' : 'rounded-lg'} [-ms-overflow-style:none] [scrollbar-width:none] [touch-action:pan-x] [&::-webkit-scrollbar]:hidden`
      : 'max-w-full rounded-lg';
  const shellClassName = isScrollColumn
    ? `relative flex h-full flex-col items-stretch overflow-hidden border-t bg-white ${dock === 'left' ? 'rounded-se-2xl border-e' : 'rounded-ss-2xl border-s'} border-slate-200`
    : isFlatBar
    ? 'relative flex w-full max-w-full items-stretch overflow-hidden border-t border-slate-200 bg-white'
    : `relative ${isScrollRow ? 'flex w-full items-stretch' : ''} max-w-full overflow-hidden rounded-lg border border-white/75 bg-[linear-gradient(135deg,rgba(255,255,255,0.94),rgba(248,250,252,0.86),rgba(255,247,237,0.78))] shadow-[0_26px_60px_rgba(15,23,42,0.16)] backdrop-blur-xl`;
  const fadeEdgeClassName = 'pointer-events-none absolute inset-x-2 z-10 h-10';

  return (
    <motion.div
      animate={{ opacity: 1, x: 0, y: 0 }}
      className={isScrollColumn ? 'h-full' : isScrollRow ? 'w-full max-w-full' : 'max-w-full'}
      initial={enterAnimation}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      <div className={shellClassName} data-wb-toolbar-bar={isFlatBar ? 'flush' : undefined} style={isFlatBar && !isScrollColumn ? FLAT_BAR_STYLE : undefined}>
        {/* Scroll hints belong to the dock that scrolls. */}
        {isVertical && !isScrollColumn ? (
          <>
            <div className={`${fadeEdgeClassName} from-white/96 top-0 bg-gradient-to-b to-transparent`} />
            <div className={`${fadeEdgeClassName} from-white/96 bottom-0 bg-gradient-to-t to-transparent`} />
          </>
        ) : null}
        <ScrollRowFrame enabled={isScrollRow} trailing={trailing} vertical={isScrollColumn}>
        {isScrollColumn ? (
          <>
            <div
              aria-hidden
              className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-10 transition-opacity duration-150 ${rowEdges.start ? 'opacity-100' : 'opacity-0'}`}
              style={{ background: `linear-gradient(to bottom, var(--wb-tb-fade, rgba(255,255,255,0.96)), rgba(255,255,255,0))` }}
            />
            <div
              aria-hidden
              className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-10 transition-opacity duration-150 ${rowEdges.end ? 'opacity-100' : 'opacity-0'}`}
              style={{ background: `linear-gradient(to top, var(--wb-tb-fade, rgba(255,255,255,0.96)), rgba(255,255,255,0))` }}
            />
          </>
        ) : isScrollRow ? (
          <>
            <div
              aria-hidden
              className={`pointer-events-none absolute inset-y-0 start-0 z-10 w-10 ${isFlatBar ? '' : 'rounded-s-lg'} transition-opacity duration-150 ${rowEdges.start ? 'opacity-100' : 'opacity-0'}`}
              style={{ background: `linear-gradient(to right, var(--wb-tb-fade, rgba(255,255,255,0.96)), rgba(255,255,255,0))` }}
            />
            <div
              aria-hidden
              className={`pointer-events-none absolute inset-y-0 end-0 z-10 w-10 ${isFlatBar || trailing ? '' : 'rounded-e-lg'} transition-opacity duration-150 ${rowEdges.end ? 'opacity-100' : 'opacity-0'}`}
              style={{ background: `linear-gradient(to left, var(--wb-tb-fade, rgba(255,255,255,0.96)), rgba(255,255,255,0))` }}
            />
          </>
        ) : null}

        <div ref={scrollRowRef} className={viewportClassName} data-wb-toolbar-row={isScrollRow ? 'scroll' : undefined}>
          <div className={containerClassName}>
            <MemoizedToolbarSection isVertical={isVertical} tone='accent'>
              <MemoizedSettingsToolButton
                // The pen button now covers three nib types, so it stays lit for any of them — the type
                // itself is chosen inside the popover rather than from separate toolbar buttons.
                activeColor={strokeSettings.color}
                activeTool={isPenFamilyTool(activeTool) ? lastPenTool : activeTool}
                icon={
                  // Live color dot so a pen-button COLOR swap (primary<->secondary) is visible the
                  // instant it fires — the color analog of the eraser's active-state affordance.
                  <span className='relative inline-flex h-4 w-4 items-center justify-center'>
                    <Pencil className='h-4 w-4' />
                    <span
                      aria-hidden
                      className='absolute -bottom-0.5 -end-0.5 h-1.5 w-1.5 rounded-full border border-white shadow-sm'
                      style={{ backgroundColor: strokeSettings.color }}
                    />
                  </span>
                }
                isOpen={openToolSettings === 'pen'}
                overlayPortalContainer={overlayPortalContainer}
                placement={popoverPlacement}
                tool={lastPenTool}
                onOpenChange={(open) => onOpenToolSettings(open ? 'pen' : null)}
                onToolChange={onToolChange}
              >
                {/* Off a horizontal dock on a wide screen the pen menu lays out in two columns (nib +
                    colour | stroke) — one column was ~800px tall and could not fit above a bottom
                    toolbar on a landscape tablet, so its lower half was cut off. */}
                <div className={`flex flex-col ${isVertical ? '' : 'min-[720px]:flex-row min-[720px]:items-stretch'}`}>
                  <div className='flex min-w-0 flex-col'>
                  <div className='flex flex-col gap-2 p-3'>
                    <span className='text-ink/60 text-xs font-bold'>{t('toolbar.penType')}</span>
                    {/* Four nibs in an ~16rem column: a tighter side padding lets them share one row, and
                        the row wraps (the Button keeps its min-w-fit) rather than clip a label. */}
                    <div className='flex flex-wrap gap-2'>
                      {PEN_FAMILY_TOOLS.map((penTool) => (
                        <Button
                          key={penTool}
                          className='flex-1 px-2'
                          size='sm'
                          style={activeTool === penTool ? TOOLBAR_SURFACE.brand : undefined}
                          variant='flat'
                          onPress={() => onToolChange(penTool)}
                        >
                          {t(TOOL_LABELS[penTool])}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <Divider />
                  <ColorPicker
                    color={strokeSettings.color}
                    label={t('toolbar.strokeColor')}
                    secondaryColor={strokeSettings.secondaryColor}
                    onChange={handleStrokeColorChange}
                    onSecondaryChange={handleSecondaryColorChange}
                    onSwap={handleColorSwap}
                  />
                  </div>
                  <Divider className={isVertical ? '' : 'min-[720px]:hidden'} />
                  <div
                    aria-hidden
                    className={`hidden w-px shrink-0 bg-divider ${isVertical ? '' : 'min-[720px]:block'}`}
                  />
                  <StrokeSettingsComponent
                    settings={strokeSettings}
                    smoothingEnabled={smoothingEnabled}
                    onChange={onStrokeSettingsChange}
                    onSmoothingChange={onSmoothingChange}
                  />
                </div>
              </MemoizedSettingsToolButton>
              {/* The highlighter is a pen too: it sits beside the pen key, with its own colour (the editor
                  keeps the highlighter colour apart from the pen's and swaps it in on this tool). */}
              <MemoizedSettingsToolButton
                activeColor={activeTool === 'highlighter' ? strokeSettings.color : undefined}
                activeTool={activeTool}
                icon={<Highlighter className='h-4 w-4' />}
                isOpen={openToolSettings === 'highlighter'}
                overlayPortalContainer={overlayPortalContainer}
                placement={popoverPlacement}
                tool='highlighter'
                onOpenChange={(open) => onOpenToolSettings(open ? 'highlighter' : null)}
                onToolChange={onToolChange}
              >
                <ColorPicker
                  color={strokeSettings.color}
                  colors={HIGHLIGHTER_PALETTE}
                  label={t(TOOL_LABELS.highlighter)}
                  onChange={handleStrokeColorChange}
                />
              </MemoizedSettingsToolButton>
              <MemoizedSettingsToolButton
                activeTool={activeTool}
                icon={<Eraser className='h-4 w-4' />}
                isOpen={openToolSettings === 'eraser'}
                overlayPortalContainer={overlayPortalContainer}
                placement={popoverPlacement}
                tool='eraser'
                onOpenChange={(open) => onOpenToolSettings(open ? 'eraser' : null)}
                onToolChange={onToolChange}
              >
                <EraserSettings
                  forceObjectMode={forceObjectEraserMode}
                  mode={eraserMode}
                  size={eraserSize}
                  wholeHandEraser={tabletInputSettings.wholeHandEraser}
                  onModeChange={onEraserModeChange}
                  onSizeChange={onEraserSizeChange}
                  onWholeHandEraserChange={(next) =>
                    onTabletInputSettingsChange({ ...tabletInputSettings, wholeHandEraser: next })
                  }
                />
              </MemoizedSettingsToolButton>
              {compactSelectTool ? (
                <MemoizedToolButton
                  activeTool={activeTool}
                  icon={<MousePointer2 className='h-4 w-4' />}
                  label={t(TOOL_LABELS.select)}
                  overlayPortalContainer={overlayPortalContainer}
                  tool='select'
                  onToolChange={onToolChange}
                />
              ) : null}
              <MemoizedToolButton
                activeTool={activeTool}
                icon={<Hand className='h-4 w-4' />}
                label={t(TOOL_LABELS.pan)}
                overlayPortalContainer={overlayPortalContainer}
                tool='pan'
                onToolChange={onToolChange}
              />
              {ai ? (
                <>
                  <Tooltip content={t('toolbar.askAiHint')} delay={400} portalContainer={overlayPortalContainer} size='sm'>
                    <Button
                      aria-label={t('toolbar.askAi')}
                      aria-pressed={ai.lassoActive}
                      className={`${ICON_BUTTON_BASE_CLASS} shrink-0`}
                      color='default'
                      isIconOnly
                      size='sm'
                      style={TOOLBAR_SURFACE[ai.lassoActive ? 'active' : 'idle']}
                      variant='flat'
                      onPress={ai.onAsk}
                    >
                      <Sparkles className='h-4 w-4' />
                    </Button>
                  </Tooltip>
                  <Popover
                    isOpen={isAiMenuOpen}
                    placement={popoverPlacement}
                    portalContainer={overlayPortalContainer}
                    onOpenChange={setIsAiMenuOpen}
                  >
                    <PopoverTrigger>
                      <Button
                        aria-label={t('toolbar.aiTools')}
                        className={`${ICON_BUTTON_BASE_CLASS} shrink-0`}
                        isIconOnly
                        size='sm'
                        style={TOOLBAR_SURFACE.idle}
                        variant='flat'
                      >
                        <WandSparkles className='h-4 w-4' />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className='p-0'>
                      <div className='flex w-[min(calc(100vw-2rem),15rem)] flex-col gap-1 p-2' dir={dir}>
                        <p className='px-1 pb-1 text-xs font-semibold text-slate-800 dark:text-ink'>{t('toolbar.aiHeading')}</p>
                        {[
                          { icon: <Sparkles className='h-4 w-4' />, label: t('toolbar.ai.ask'), run: ai.onAsk },
                          ...(ai.onChat ? [{ icon: <MessagesSquare className='h-4 w-4' />, label: t('toolbar.ai.chat'), run: ai.onChat }] : []),
                          { icon: <WandSparkles className='h-4 w-4' />, label: t('toolbar.ai.generate'), run: ai.onGenerate },
                          { icon: <ScanSearch className='h-4 w-4' />, label: t('toolbar.ai.analyze'), run: ai.onAnalyzePage },
                          { icon: <CopyPlus className='h-4 w-4' />, label: t('toolbar.ai.remake'), run: ai.onRemakePage },
                          ...(ai.onPenExplain ? [{ icon: <PenLine className='h-4 w-4' />, label: t('toolbar.ai.penExplain'), run: ai.onPenExplain }] : []),
                        ].map((item) => (
                          <Button
                            key={item.label}
                            className='justify-start gap-2'
                            size='sm'
                            variant='light'
                            onPress={() => {
                              setIsAiMenuOpen(false);
                              item.run();
                            }}
                          >
                            {item.icon}
                            {item.label}
                          </Button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                </>
              ) : null}
              <MemoizedActionButton
                color='primary'
                icon={<FileUp className='h-4 w-4' />}
                label={t('toolbar.uploadPdf')}
                overlayPortalContainer={overlayPortalContainer}
                onPress={onUploadPdf}
              />
              {onPdfLayoutChange ? (
                <MemoizedActionButton
                  color={pdfLayout === 'scroll' ? 'secondary' : 'default'}
                  icon={pdfLayout === 'scroll' ? <RectangleVertical className='h-4 w-4' /> : <Rows3 className='h-4 w-4' />}
                  label={pdfLayout === 'scroll' ? t('toolbar.pageByPage') : t('toolbar.continuousScroll')}
                  overlayPortalContainer={overlayPortalContainer}
                  onPress={() => onPdfLayoutChange(pdfLayout === 'scroll' ? 'paged' : 'scroll')}
                />
              ) : null}
              <MemoizedActionButton
                color='warning'
                icon={<FileDown className='h-4 w-4' />}
                isDisabled={isExportingPdf}
                label={t('toolbar.exportPdf')}
                overlayPortalContainer={overlayPortalContainer}
                onPress={onExportPdf}
              />
            </MemoizedToolbarSection>

            {compactUndoRedo ? (
              <MemoizedToolbarSection isVertical={isVertical}>
                <MemoizedActionButton
                  icon={<Undo2 className='h-4 w-4' />}
                  isDisabled={!canUndo}
                  label={t('toolbar.undo')}
                  overlayPortalContainer={overlayPortalContainer}
                  onPress={onUndo}
                />
                <MemoizedActionButton
                  icon={<Redo2 className='h-4 w-4' />}
                  isDisabled={!canRedo}
                  label={t('toolbar.redo')}
                  overlayPortalContainer={overlayPortalContainer}
                  onPress={onRedo}
                />
              </MemoizedToolbarSection>
            ) : null}

            {isScrollRow ? null : (
              <MemoizedToolbarSection isVertical={isVertical}>
                <MemoizedActionButton
                  color={isExpanded ? 'secondary' : 'default'}
                  icon={<Menu className='h-4 w-4' />}
                  label={showExpandedTools ? t('toolbar.hideMoreTools') : t('toolbar.allTools')}
                  overlayPortalContainer={overlayPortalContainer}
                  onPress={() => setIsExpanded((current) => !current)}
                />
              </MemoizedToolbarSection>
            )}

            {showExpandedTools ? (
              <>
                <MemoizedToolbarSection isVertical={isVertical}>
                  <Popover placement={popoverPlacement} portalContainer={overlayPortalContainer}>
                    <PopoverTrigger>
                      <Button
                        className={`${ICON_BUTTON_BASE_CLASS} shrink-0`}
                        isIconOnly
                        size='sm'
                        style={
                          TOOLBAR_SURFACE[
                            ['line', 'arrow', 'rect', 'circle', 'triangle'].includes(activeTool) ? 'active' : 'idle'
                          ]
                        }
                        variant='flat'
                      >
                        <DraftingCompass className='h-4 w-4' />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className={popoverPanelClassName(popoverPlacement)}>
                      <div className='flex w-[min(calc(100vw-2rem),17rem)] flex-col gap-3 p-3'>
                        <div className='space-y-1'>
                          <p className='text-xs font-semibold text-slate-800 dark:text-ink'>{t('toolbar.geometryTools')}</p>
                          <p className='text-[11px] leading-5 text-slate-500 dark:text-ink/60'>{t('toolbar.geometryHint')}</p>
                        </div>

                        <div className='grid grid-cols-3 gap-2'>
                          {GEOMETRY_DRAW_TOOLS.map((item) => (
                            <Button
                              key={item.tool}
                              className={POPOVER_TILE_CLASS}
                              color='default'
                              style={activeTool === item.tool ? TOOLBAR_SURFACE.active : undefined}
                              variant='flat'
                              onPress={() => onToolChange(item.tool)}
                            >
                              <span className='flex flex-col items-center gap-1 whitespace-normal text-center leading-tight'>
                                {item.icon}
                                {t(item.label)}
                              </span>
                            </Button>
                          ))}
                        </div>

                        <div className='grid grid-cols-3 gap-2'>
                          {GEOMETRY_STENCILS.map((item) => (
                            <Button
                              key={item.kind}
                              className={POPOVER_TILE_CLASS}
                              color='default'
                              variant='flat'
                              onPress={() => onInsertGeometryStencil(item.kind)}
                            >
                              <span className='flex flex-col items-center gap-1 whitespace-normal text-center leading-tight'>
                                {item.icon}
                                {t(item.label)}
                              </span>
                            </Button>
                          ))}
                          {onInsertRadical ? (
                            <Button className={POPOVER_TILE_CLASS} color='default' variant='flat' onPress={onInsertRadical}>
                              <span className='flex flex-col items-center gap-1 whitespace-normal text-center leading-tight'>
                                <RadicalIcon />
                                {t('editor.geo.radical')}
                              </span>
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>

                  <Popover placement={popoverPlacement} portalContainer={overlayPortalContainer}>
                    <PopoverTrigger>
                      <Button
                        className={`${ICON_BUTTON_BASE_CLASS} shrink-0`}
                        isIconOnly
                        size='sm'
                        style={TOOLBAR_SURFACE.idle}
                        variant='flat'
                      >
                        <div
                          className='h-4 w-4 rounded border-2 border-slate-300 dark:border-white/25'
                          style={{ backgroundColor: shownFill === 'transparent' ? 'transparent' : shownFill }}
                        >
                          {shownFill === 'transparent' ? (
                            <svg className='h-full w-full text-slate-400 dark:text-ink/50' viewBox='0 0 16 16'>
                              <line stroke='currentColor' strokeWidth='1.5' x1='2' x2='14' y1='14' y2='2' />
                            </svg>
                          ) : null}
                        </div>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className={popoverPanelClassName(popoverPlacement)}>
                      {shapeStyle && onShapeStyleChange ? (
                        <ShapeStylePanel rows={{ fill: true, shape: true, stroke: true }} value={shapeStyle} onChange={onShapeStyleChange} />
                      ) : (
                        <ColorPicker color={fillColor} label={t('toolbar.fillColor')} onChange={onFillColorChange} />
                      )}
                    </PopoverContent>
                  </Popover>
                </MemoizedToolbarSection>

                <MemoizedToolbarSection isVertical={isVertical}>
                  {compactSelectTool ? null : (
                    <MemoizedToolButton
                      activeTool={activeTool}
                      icon={<MousePointer2 className='h-4 w-4' />}
                      label={t(TOOL_LABELS.select)}
                      overlayPortalContainer={overlayPortalContainer}
                      tool='select'
                      onToolChange={onToolChange}
                    />
                  )}
                  <MemoizedToolButton
                    activeTool={activeTool}
                    icon={<Type className='h-4 w-4' />}
                    label={t(TOOL_LABELS.text)}
                    overlayPortalContainer={overlayPortalContainer}
                    tool='text'
                    onToolChange={onToolChange}
                  />
                  <MemoizedToolButton
                    activeTool={activeTool}
                    icon={<StickyNote className='h-4 w-4' />}
                    label={t(TOOL_LABELS.sticky)}
                    overlayPortalContainer={overlayPortalContainer}
                    tool='sticky'
                    onToolChange={onToolChange}
                  />
                  <MemoizedActionButton
                    icon={<ImagePlus className='h-4 w-4' />}
                    label={t(TOOL_LABELS.image)}
                    overlayPortalContainer={overlayPortalContainer}
                    onPress={onInsertImage}
                  />
                  <MemoizedToolButton
                    activeTool={activeTool}
                    icon={<Pointer className='h-4 w-4' />}
                    label={t(TOOL_LABELS.laser)}
                    overlayPortalContainer={overlayPortalContainer}
                    tool='laser'
                    onToolChange={onToolChange}
                  />
                </MemoizedToolbarSection>

                <MemoizedToolbarSection isVertical={isVertical}>
                  {compactUndoRedo ? null : (
                    <>
                      <MemoizedActionButton
                        icon={<Undo2 className='h-4 w-4' />}
                        isDisabled={!canUndo}
                        label={t('toolbar.undo')}
                        overlayPortalContainer={overlayPortalContainer}
                        onPress={onUndo}
                      />
                      <MemoizedActionButton
                        icon={<Redo2 className='h-4 w-4' />}
                        isDisabled={!canRedo}
                        label={t('toolbar.redo')}
                        overlayPortalContainer={overlayPortalContainer}
                        onPress={onRedo}
                      />
                    </>
                  )}
                  {onPaste ? (
                    <MemoizedActionButton
                      icon={<ClipboardPaste className='h-4 w-4' />}
                      label={t('selection.paste')}
                      overlayPortalContainer={overlayPortalContainer}
                      onPress={onPaste}
                    />
                  ) : null}
                  <MemoizedActionButton
                    color='danger'
                    icon={<Trash2 className='h-4 w-4' />}
                    label={t('toolbar.clearInk')}
                    overlayPortalContainer={overlayPortalContainer}
                    onPress={onClear}
                  />
                  <MemoizedActionButton
                    icon={<Copy className='h-4 w-4' />}
                    label={t('toolbar.duplicatePage')}
                    overlayPortalContainer={overlayPortalContainer}
                    onPress={onDuplicatePage}
                  />
                </MemoizedToolbarSection>

                {/* Import and PDF export live in the always-visible row now, so they are not repeated
                    here; the image and board-file exports have no other home. */}
                <MemoizedToolbarSection isVertical={isVertical}>
                  {/* Straightens a sideways/tilted scan. Only a page that HAS a background raster can
                      be rotated — a blank page has nothing to turn. */}
                  {hasPdfPageBackground ? (
                    <MemoizedActionButton
                      icon={<RotateCw className='h-4 w-4' />}
                      label={t('toolbar.rotatePage')}
                      overlayPortalContainer={overlayPortalContainer}
                      onPress={onRotatePageBackground}
                    />
                  ) : null}
                  <MemoizedActionButton
                    icon={<Download className='h-4 w-4' />}
                    label={t('toolbar.exportImage')}
                    overlayPortalContainer={overlayPortalContainer}
                    onPress={onExportImage}
                  />
                  <MemoizedActionButton
                    icon={<FileJson className='h-4 w-4' />}
                    label={t('toolbar.exportBoardFile')}
                    overlayPortalContainer={overlayPortalContainer}
                    onPress={onExportDocument}
                  />
                  {onPublishVersion ? (
                    <MemoizedActionButton
                      color='secondary'
                      icon={<CloudUpload className='h-4 w-4' />}
                      isDisabled={isPublishingVersion}
                      label={t('toolbar.saveVersion')}
                      overlayPortalContainer={overlayPortalContainer}
                      onPress={onPublishVersion}
                    />
                  ) : null}
                </MemoizedToolbarSection>

                <MemoizedToolbarSection isVertical={isVertical}>
                  <MemoizedActionButton
                    icon={<ZoomOut className='h-4 w-4' />}
                    label={t('toolbar.zoomOut')}
                    overlayPortalContainer={overlayPortalContainer}
                    onPress={onZoomOut}
                  />
                  <Tooltip content={t('toolbar.resetZoom')} delay={400} portalContainer={overlayPortalContainer} size='sm'>
                    <Button
                      className='min-w-[3.15rem] shrink-0 rounded-xl px-2.5 text-[11px] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]'
                      size='sm'
                      style={TOOLBAR_SURFACE.idle}
                      variant='flat'
                      onPress={onResetZoom}
                    >
                      {zoomPercentage}%
                    </Button>
                  </Tooltip>
                  <MemoizedActionButton
                    icon={<ZoomIn className='h-4 w-4' />}
                    label={t('toolbar.zoomIn')}
                    overlayPortalContainer={overlayPortalContainer}
                    onPress={onZoomIn}
                  />
                </MemoizedToolbarSection>

                <MemoizedToolbarSection isVertical={isVertical}>
                  <Popover placement={popoverPlacement} portalContainer={overlayPortalContainer}>
                    <PopoverTrigger>
                      <Button
                        className={`${ICON_BUTTON_BASE_CLASS} shrink-0`}
                        isIconOnly
                        size='sm'
                        style={TOOLBAR_SURFACE.idle}
                        variant='flat'
                      >
                        <Grid3X3 className='h-4 w-4' />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className={popoverPanelClassName(popoverPlacement)}>
                      <BackgroundSelector
                        backgroundType={backgroundType}
                        backgroundImageOpacity={backgroundImageOpacity}
                        hasBackgroundImage={hasSharedBackgroundImage}
                        paperSpacingMm={paperSpacingMm}
                        onChange={onBackgroundTypeChange}
                        onBackgroundImageOpacityChange={onBackgroundImageOpacityChange}
                        onPaperSpacingChange={onPaperSpacingChange}
                        onClearBackgroundImage={onClearSharedBackground}
                        onUploadBackgroundImage={onUploadSharedBackground}
                      />
                    </PopoverContent>
                  </Popover>

                  <Popover placement={popoverPlacement} portalContainer={overlayPortalContainer}>
                    <PopoverTrigger>
                      <Button
                        aria-label={t('tablet.title')}
                        className={`${ICON_BUTTON_BASE_CLASS} shrink-0`}
                        title={t('tablet.title')}
                        isIconOnly
                        size='sm'
                        style={TOOLBAR_SURFACE.idle}
                        variant='flat'
                      >
                        <Settings2 className='h-4 w-4' />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className={popoverPanelClassName(popoverPlacement)}>
                      <TabletInputSettingsComponent
                        penCaptureLocked={penCaptureLocked}
                        settings={tabletInputSettings}
                        onChange={onTabletInputSettingsChange}
                      />
                    </PopoverContent>
                  </Popover>

                  <Popover placement={popoverPlacement} portalContainer={overlayPortalContainer}>
                    <PopoverTrigger>
                      <Button
                        className={`${ICON_BUTTON_BASE_CLASS} shrink-0`}
                        isIconOnly
                        size='sm'
                        style={TOOLBAR_SURFACE.idle}
                        variant='flat'
                      >
                        <MoveRight
                          className={`h-4 w-4 ${dock === 'left' ? 'rotate-180' : dock === 'top' ? '-rotate-90' : dock === 'bottom' ? 'rotate-90' : ''}`}
                        />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className={popoverPanelClassName(popoverPlacement)}>
                      <div className='flex w-44 flex-col gap-3 p-3'>
                        <div className='space-y-1'>
                          <p className='text-xs font-semibold text-slate-800 dark:text-ink'>{t('toolbar.position')}</p>
                          <p className='text-[11px] text-slate-500 dark:text-ink/60'>{t('toolbar.positionHint')}</p>
                        </div>
                        <div className='grid grid-cols-2 gap-2'>
                          {DOCK_OPTIONS.map((option) => (
                            <Button
                              key={option.dock}
                              className='h-auto min-h-0 flex-col gap-1.5 rounded-2xl px-3 py-3 text-xs font-semibold'
                              color='default'
                              style={dock === option.dock ? TOOLBAR_SURFACE.active : undefined}
                              variant='flat'
                              onPress={() => onDockChange(option.dock)}
                            >
                              {option.icon}
                              {t(option.label)}
                            </Button>
                          ))}
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>

                  <MemoizedActionButton
                    icon={<EyeOff className='h-4 w-4' />}
                    label={t('toolbar.focusMode')}
                    overlayPortalContainer={overlayPortalContainer}
                    onPress={onEnterFocusMode}
                  />
                  <MemoizedActionButton
                    icon={isFullscreen ? <Minimize2 className='h-4 w-4' /> : <Maximize2 className='h-4 w-4' />}
                    label={isFullscreen ? t('editor.exitFullscreen') : t('editor.fullscreen')}
                    overlayPortalContainer={overlayPortalContainer}
                    onPress={onToggleFullscreen}
                  />
                </MemoizedToolbarSection>
              </>
            ) : null}
          </div>
        </div>
        </ScrollRowFrame>
      </div>
    </motion.div>
  );
};

const FLAT_BAR_STYLE: React.CSSProperties = { paddingBottom: 'env(safe-area-inset-bottom, 0px)' };

/**
 * The scroll row's layout: the scrolling tools (and their edge fades) fill what is left of the row,
 * and the host's `trailing` group sits pinned at the end edge behind a divider. Any other layout
 * renders its children untouched.
 */
const ScrollRowFrame: React.FC<{ children: React.ReactNode; enabled: boolean; trailing?: React.ReactNode; vertical?: boolean }> = ({
  children,
  enabled,
  trailing,
  vertical = false,
}) => {
  if (!enabled) return <>{children}</>;
  if (vertical) {
    return (
      <>
        <div className='relative min-h-0 flex-1'>{children}</div>
        {trailing ? (
          <div className='flex shrink-0 justify-center border-t border-slate-200 py-1.5' data-wb-toolbar-trailing>
            {trailing}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className='relative min-w-0 flex-1'>{children}</div>
      {trailing ? (
        <div className='flex shrink-0 items-center border-s border-slate-200 px-1.5' data-wb-toolbar-trailing>
          {trailing}
        </div>
      ) : null}
    </>
  );
};

const MemoizedToolbar = React.memo(Toolbar);

export { MemoizedToolbar as Toolbar };
export default MemoizedToolbar;
