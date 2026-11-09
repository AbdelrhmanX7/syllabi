import { useCallback, useEffect, useRef, useState } from 'react';

import type { ShapeStyleSettings } from './utils/shapeStyle';
import type { RefObject } from 'react';

import type { Canvas } from 'fabric';

import type {
  BackgroundType,
  CapturedContact,
  EraserMode,
  StrokeSettings,
  TabletInputSettings,
  WhiteboardPage,
  WhiteboardTool,
} from './types';
import { isPenFamilyTool } from './types';

import { NIB_WIDTH_SCALE } from './brushes/CalligraphyBrush';
import { SCRIPT_MAX_PRESSURE_SCALE } from './brushes/ScriptBrush';
import { SOFT_MARKER_WIDTH_SCALE } from './brushes/SoftMarkerBrush';
import { useOverscanBackdrop } from './hooks/useOverscanBackdrop';
import { useWhiteboardCanvas } from './hooks/useWhiteboardCanvas';
import {
  currentBoardBaseColor,
  drawBackgroundPattern,
  drawOverlayImage,
  drawScreenFitImage,
  getScreenFitPlacement,
  normalizeRotationDeg,
} from './utils/backgroundLayers';
import { registerDarkBoardSurface, setBoardTheme } from './utils/darkBoard';
import { invalidateInkBake } from './utils/inkBake';
import {
  getScaledRasterTarget,
  isStrokeInProgress,
  resolveBackgroundRedrawQuality,
  shouldSkipDuplicateLowPass,
} from './utils/backgroundRedrawPolicy';
import { createBackgroundLuminanceCache, type BackgroundLuminanceCache } from './utils/backgroundLuminanceCache';
import { PAPER_LUMINANCE, readCanvasLuminance } from './utils/inkContrast';
import { isPointerDown } from './utils/inputActivity';
import { drawLockedImages, getLockedImages, onLockedImagesChanged } from './utils/lockedImages';
import { clampTransitionDurationMs, createTransitionFrame, resolveTransitionFrame } from './utils/pageTransitions';
import { drawNotebookMargins } from './utils/notebookPage';
import { backdropPaintTransform } from './utils/overscanBackdrop';
import { loadPdfPageImage } from './utils/pdfPageImageLoader';
import { getPdfBackgroundPixelRatio, getPdfQualityMode } from './utils/pdfRenderSizing';
import { recordPerf } from './utils/perfHud';
import { perfSpan } from './utils/perfSpan';
import { resolveFrozenPdfFit } from './utils/snapshotGeometry';
import { JS_BUNDLE_BUILD as PDF_DEBUG_JS_BUILD } from '../../jsBuild';

import type { RulerEdgesRef } from './brushes/rulerSnap';
import type { BackgroundRedrawQuality } from './utils/backgroundRedrawPolicy';
import type { TransitionFrame, TransitionLayerFrame } from './utils/pageTransitions';
import type { PdfScrollPainter } from './utils/pdfScrollLayout';
import type { PdfBackgroundFrame } from './utils/snapshotGeometry';
import type { ViewportConstraints } from './utils/viewportConstraints';
import { useWbStrings } from '../../i18n/context';

/**
 * Stable identity for a page raster, so a pre-scaled copy can be keyed without dragging a data URL
 * (the `src` of a pdf.js-rendered page can be megabytes long) through a string compare per frame.
 */
const imageIdentities = new WeakMap<HTMLImageElement, number>();
let nextImageIdentity = 1;

function getImageIdentity(image: HTMLImageElement): number {
  let identity = imageIdentities.get(image);

  if (identity === undefined) {
    identity = nextImageIdentity;
    nextImageIdentity += 1;
    imageIdentities.set(image, identity);
  }

  return identity;
}

/**
 * One slide transition, as the editor asks for it.
 *
 * `native` draws the movement here, between a snapshot of the outgoing page and the incoming one.
 * `hold` is for a clip that was rendered WITH its transition already in it: nothing is animated,
 * the outgoing page is simply held on screen until the video has a frame to show, so the teacher
 * never sees the new page flash up before its own transition plays.
 */
export interface PageTransitionRequest {
  mode: 'native' | 'hold';
  /** `native` only; anything unrecognized is drawn as a fade (see utils/pageTransitions). */
  kind?: string;
  direction?: string;
  option?: string;
  orient?: 'horz' | 'vert';
  /** `native`: how long the movement runs. `hold`: how long the ink stays hidden once it plays. */
  durationMs: number;
  /** Fired when the movement ends, whether it finished or was cancelled by another page. */
  onDone?: () => void;
}

/** The imperative surface the editor drives a transition through. */
export interface PageTransitionHandle {
  /**
   * Snapshot what is on the background layer RIGHT NOW, synchronously, before the next page is
   * loaded. One drawImage. Without a snapshot there is nothing to transition from, and `begin`
   * degrades to no transition at all.
   */
  capturePrevious: () => void;
  begin: (request: PageTransitionRequest) => void;
  cancel: () => void;
}

/**
 * Paint one side of a transition: a whole-screen image, offset, scaled and clipped in CSS pixels.
 *
 * The layers are screen-sized rather than page-sized on purpose. A transition moves the SLIDE, and
 * on this canvas the slide is the whole background layer — its raster, the pattern behind it and
 * anything pinned to it. Compositing at screen level also means the geometry is one drawImage per
 * layer with no re-derivation of the page rect, so a transition frame costs about what a pan frame
 * costs.
 */
function drawTransitionLayer(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  layer: TransitionLayerFrame,
  pixelRatio: number,
  cssWidth: number,
  cssHeight: number,
): void {
  if (!layer.visible || layer.alpha <= 0) return;

  ctx.save();
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.globalAlpha = layer.alpha;

  // Clipped BEFORE any scale: a wipe's band is a screen-space edge, not something that grows with
  // the page it reveals.
  if (layer.clipA.active || layer.clipB.active) {
    ctx.beginPath();

    if (layer.clipA.active) {
      ctx.rect(layer.clipA.x, layer.clipA.y, layer.clipA.width, layer.clipA.height);
    }

    if (layer.clipB.active) {
      ctx.rect(layer.clipB.x, layer.clipB.y, layer.clipB.width, layer.clipB.height);
    }

    ctx.clip();
  }

  if (layer.scale !== 1) {
    ctx.translate(cssWidth / 2, cssHeight / 2);
    ctx.scale(layer.scale, layer.scale);
    ctx.translate(-cssWidth / 2, -cssHeight / 2);
  }

  ctx.drawImage(source, layer.dx, layer.dy, cssWidth, cssHeight);
  ctx.restore();
}

/** How long a `native` transition waits for the incoming page's raster before running regardless. */
const TRANSITION_RASTER_WAIT_MS = 1_200;
/**
 * How long the outgoing page is held while the page loads and the editor decides whether it has a
 * transition. Every navigation reports back — with a transition or with a cancel — so this is a
 * backstop for a load that was superseded and never reported, not a wait anyone should see. It is
 * generous on purpose: expiring early during a slow page load would reveal the incoming page and
 * then animate it in, which is the flicker the cover exists to prevent.
 */
const TRANSITION_VERDICT_WAIT_MS = 2_000;
/** How long a `hold` waits for the clip's first frame before giving up and showing the new page. */
const CLIP_TRANSITION_HOLD_MS = 1_500;
/**
 * How long the two full-resolution scratch canvases are kept after the last transition. Long enough
 * that stepping through a deck reuses them; short enough that a board left open overnight is not
 * holding two screen-sized buffers for a transition nobody is going to run.
 */
const TRANSITION_BUFFER_IDLE_MS = 5_000;
/** A shown pen/finger cursor fades after this long without pointer input (the pen left hover range). */
const CURSOR_INDICATOR_IDLE_HIDE_MS = 1_500;

export interface WhiteboardCanvasProps {
  activeTool: WhiteboardTool;
  strokeSettings: StrokeSettings;
  eraserMode: EraserMode;
  eraserSize: number;
  tabletInputSettings?: TabletInputSettings;
  fillColor: string;
  /** The shape panel's settings for new shapes. */
  shapeStyle?: ShapeStyleSettings;
  zoomLocked?: boolean;
  backgroundType: BackgroundType;
  /** Pattern spacing in board px (utils/paperSpacing). Absent = the original 30 px. */
  backgroundSpacingPx?: number;
  /** Draw the page's grid / lines / dots OVER the PDF too (multiplied, so it shows on the paper, not on ink-dark content). */
  paperOverPdf?: boolean;
  /** Dark board (utils/darkBoard): a view setting; default 'light'. */
  boardTheme?: 'light' | 'dark';
  hasPdfPageBackground?: boolean;
  /** Degrees CLOCKWISE to turn the PDF/image BACKGROUND raster only — ink is never rotated. Any angle;
   *  absent/0 = unrotated. The fit frame recomputes from the rotated bounding box inside
   *  drawScreenFitImage, so nothing here touches the frozen-fit logic. */
  pdfRotationDeg?: number;
  pdfPageImageUrl?: string;
  isPdfPageLoading?: boolean;
  pdfPageIdentity?: string;
  /**
   * The current page's recorded frame (`canvasWidthPx` / `pdfPlacement`). When present, the PDF is
   * frozen to THAT frame on open instead of the live container, so ink written on another window
   * size stays aligned with the page and the record never drifts (see utils/snapshotGeometry). Read
   * once per page open — later changes to the record (its own re-save) never re-freeze anything.
   */
  pdfFrameRecord?: Pick<WhiteboardPage, 'canvasWidthPx' | 'pdfPlacement'> | null;
  backgroundImageUrl?: string;
  backgroundImageOpacity?: number;
  /** Viewport cage — see `useWhiteboardCanvas`'s prop of the same name. Absent/null = unconstrained. */
  viewportConstraintsRef?: RefObject<ViewportConstraints | null>;
  /** Apply touch pans to Fabric per frame instead of previewing them — see `useWhiteboardCanvas`. */
  directTouchPanRef?: RefObject<boolean>;
  /** The host ruler's edges (client px) for stroke straight-edge snapping. */
  rulerEdgesRef?: RulerEdgesRef;
  /** Never build or show the blurred overscan backdrop (the page-covers-view modes). */
  overscanBackdropDisabled?: boolean;
  /**
   * Vertical notebook page (utils/notebookPage): while `.current` is set the paper is drawn only
   * between `pageLeft` and `pageRight` (scene px) and the rest is margin. Read at paint time.
   */
  notebookPageRef?: RefObject<{ pageLeft: number; pageRight: number } | null>;
  /** Lock each finger pan to one axis — see `useWhiteboardCanvas`'s `panAxisLock`. */
  panAxisLock?: boolean;
  /**
   * Continuous PDF layout: while `.current` is set, the background layer paints the stacked pages
   * through it instead of fitting ONE page raster (`pdfPageImageUrl` is then unused). The painter
   * receives the live viewport transform, so its pages pan and zoom with the ink exactly as the
   * single raster does.
   */
  pdfScrollPainterRef?: RefObject<PdfScrollPainter | null>;
  /**
   * Populated by the canvas with "repaint the background layer at the next quiet frame" — what the
   * scroll-layout painter calls when a page raster lands or the layout moves (neither changes the
   * viewport, so nothing else would repaint).
   */
  backgroundRepaintRef?: RefObject<(() => void) | null>;
  backgroundCanvasRef?: RefObject<HTMLCanvasElement | null>;
  backgroundOverlayCanvasRef?: RefObject<HTMLCanvasElement | null>;
  /**
   * The hidden, muted `<video>` that decodes the current page's slide intro (see
   * hooks/usePageIntroPlayback). While {@link isIntroPlaying} its frames are blitted into the page
   * BACKGROUND layer in place of the static raster, with the identical fit/rotation/viewport
   * geometry — so the clip lands exactly in the page's rect and the ink canvas above it stays live.
   */
  introVideoRef?: RefObject<HTMLVideoElement | null>;
  /** True while a slide intro is playing: the background layer repaints per frame from the video. */
  isIntroPlaying?: boolean;
  /**
   * Populated by the canvas with the slide-transition controls (see {@link PageTransitionHandle}).
   * The editor captures the outgoing page through it before a forward page load, and the intro hook
   * starts and cancels transitions through it.
   */
  transitionHandleRef?: RefObject<PageTransitionHandle | null>;
  onCanvasReady?: (canvas: Canvas) => void;
  /**
   * Fired once per pinch/wheel gesture on settle, with the committed canvas zoom, so the owner can
   * re-rasterize the PDF page at the new zoom. Wired straight into the hook's onZoomCommit (fired from
   * the actual canvas-zoom application against the live zoom), so the owner never diverges from the
   * canvas. Toolbar zoom updates the owner directly, so this only carries the gesture-driven zoom.
   */
  onZoomChange?: (zoom: number) => void;
  /** Fired with the LIVE container size on init + every resize, so the owner can size the PDF raster to
   *  the real display width (the Fabric canvas resizes imperatively without a React re-render). */
  onCanvasResize?: (size: { width: number; height: number }) => void;
  /**
   * Publishes what the background painter knows about the current page's PDF frame — the frozen fit
   * size the page opened at (`pdfFitSizeRef`) plus the loaded raster's natural size — or null while
   * either is unknown (no PDF page, raster still loading, page just switched). The owner records it
   * into the page snapshot (`canvasWidthPx` / `pdfPlacement`) so the server-side ink renderer gets the
   * exact frame the ink was drawn in rather than a re-derivation from the live canvas size.
   */
  onPdfBackgroundFrameChange?: (frame: PdfBackgroundFrame | null) => void;
  /** Sink for finished touch contacts (training capture). Absent = nothing is recorded. */
  onContactCaptured?: (contact: CapturedContact) => void;
  onObjectModified?: () => void;
  onShortcutColorCycle?: () => void;
  onShortcutColorToggle?: () => void;
  onShortcutToolToggle?: () => void;
  /** A pen button bound to «Open pen shortcuts» opens (or closes) the quick pen menu, optionally at the
   *  pen's position (a fraction of the board container — transient, never the saved anchor). */
  onShortcutQuickMenu?: (anchor?: { x: number; y: number }) => void;
  onUndo?: () => void;
  onRedo?: () => void;
}

function getCursorClass(tool: WhiteboardTool): string {
  switch (tool) {
    case 'select':
      return 'cursor-default';
    case 'pen':
    case 'brush':
    case 'marker':
    case 'script':
    case 'highlighter':
    case 'eraser':
    case 'line':
    case 'arrow':
    case 'rect':
    case 'circle':
    case 'triangle':
    case 'laser':
      return 'cursor-crosshair';
    case 'sticky':
      return 'cursor-crosshair';
    case 'image':
      return 'cursor-copy';
    case 'text':
      return 'cursor-text';
    case 'pan':
      return 'cursor-grab';
    default:
      return 'cursor-default';
  }
}

export function WhiteboardCanvas({
  activeTool,
  strokeSettings,
  eraserMode,
  eraserSize,
  tabletInputSettings,
  fillColor,
  shapeStyle,
  zoomLocked = false,
  backgroundType,
  backgroundSpacingPx,
  paperOverPdf = false,
  boardTheme = 'light',
  hasPdfPageBackground = false,
  pdfRotationDeg = 0,
  pdfPageImageUrl,
  isPdfPageLoading = false,
  pdfPageIdentity,
  pdfFrameRecord,
  backgroundImageUrl,
  backgroundImageOpacity = 1,
  viewportConstraintsRef,
  directTouchPanRef,
  rulerEdgesRef,
  overscanBackdropDisabled = false,
  notebookPageRef,
  panAxisLock = false,
  pdfScrollPainterRef,
  backgroundRepaintRef,
  backgroundCanvasRef,
  backgroundOverlayCanvasRef,
  introVideoRef,
  isIntroPlaying = false,
  transitionHandleRef,
  onCanvasReady,
  onObjectModified,
  onShortcutColorCycle,
  onShortcutColorToggle,
  onShortcutToolToggle,
  onShortcutQuickMenu,
  onUndo,
  onRedo,
  onZoomChange,
  onCanvasResize,
  onPdfBackgroundFrameChange,
  onContactCaptured,
}: WhiteboardCanvasProps) {
  const { t } = useWbStrings();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomLayerRef = useRef<HTMLDivElement>(null);
  const backdropCanvasRef = useRef<HTMLCanvasElement>(null);
  const backdropInkCanvasRef = useRef<HTMLCanvasElement>(null);
  const wholeHandEraserCursorRef = useRef<HTMLDivElement>(null);
  const internalBackgroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const internalOverlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const onUndoRef = useRef(onUndo);
  const onRedoRef = useRef(onRedo);
  const viewportSignatureRef = useRef('');
  const cursorIndicatorRef = useRef<HTMLDivElement>(null);
  const containerBoundsRef = useRef<DOMRect | null>(null);
  const pendingIndicatorStateRef = useRef<{ visible: boolean; x: number; y: number } | null>(null);
  const indicatorFrameRef = useRef<number | null>(null);
  const indicatorIdleTimerRef = useRef<number | null>(null);
  // Assigned once scheduleCursorIndicatorUpdate exists (below the hook call): a native-driven contact
  // (S Pen landed with its button held — the WebView sends no pointer events) moves the cursor from here.
  const nativePenPointHandlerRef = useRef<((point: { x: number; y: number } | null) => void) | null>(null);
  // Lets the hook synchronously re-rasterize the background/PDF/overlay when it commits a zoom/pan
  // preview (assigned once updateBackgroundLayers is defined, below).
  const paperOverlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const updateBackgroundLayersRef = useRef<((quality?: ImageSmoothingQuality) => void) | null>(null);
  // The policy-aware entry points (assigned once the redraw scheduler is defined, below): what the
  // hook's viewport commit calls, and what an asynchronously finished pre-scaled raster calls.
  const viewportCommitRedrawRef = useRef<(() => void) | null>(null);
  const requestBackgroundRepaintRef = useRef<((quality: BackgroundRedrawQuality) => void) | null>(null);
  const [backgroundImage, setBackgroundImage] = useState<HTMLImageElement | null>(null);
  const [pdfPageImage, setPdfPageImage] = useState<HTMLImageElement | null>(null);
  const [isPdfImageLoading, setIsPdfImageLoading] = useState(false);
  const [isPdfLoadingOverlayVisible, setIsPdfLoadingOverlayVisible] = useState(false);
  // Canvas size captured when the current PDF page opened. The PDF background is pinned to the scene
  // rect this size implies, so it (and the ink over it) refit together on resize instead of the
  // background drifting off the writing. Shared with useWhiteboardCanvas's resize handler.
  const pdfFitSizeRef = useRef<{ width: number; height: number } | null>(null);
  // Which page the frozen fit belongs to. `pdfFitSizeRef` deliberately keeps its last value when a
  // page opens inside a 0-sized container (legacy behaviour); this tag keeps such a stale fit from
  // ever being PUBLISHED as that page's frame.
  const pdfFitIdentityRef = useRef<string | undefined>(undefined);
  // Latest frame publisher + page record, read from inside effects so a new callback identity or a
  // re-saved record never re-issues an image load or re-freezes the fit.
  const onPdfBackgroundFrameChangeRef = useRef(onPdfBackgroundFrameChange);
  const pdfFrameRecordRef = useRef(pdfFrameRecord);

  onPdfBackgroundFrameChangeRef.current = onPdfBackgroundFrameChange;
  pdfFrameRecordRef.current = pdfFrameRecord;

  // Mirror the image states in refs that updateBackgroundLayers reads. A background redraw can be
  // SCHEDULED (rAF + 160ms settle timer) while a PDF page is open and then FIRE after the user has
  // navigated to a different (often blank) page — with a stale closure it would repaint the previous
  // page's PDF over the new one. That is the "insert a blank page mid-PDF → the blank shows the last
  // page's content" bug. Reading the live ref makes every redraw, even a stale-scheduled one, paint
  // the CURRENT page's image (null on a blank page → clears).
  const pdfPageImageRef = useRef<HTMLImageElement | null>(null);
  const backgroundImageRef = useRef<HTMLImageElement | null>(null);
  // Rotation is mirrored in a ref for a SECOND reason: keeping it out of updateBackgroundLayers' deps
  // keeps that callback's identity stable across a slider drag. As a dep it would re-run the
  // image-state effect (a SYNCHRONOUS 'high' repaint) and re-bind the canvas after:render listener on
  // every degree — the drag is coalesced through scheduleBackgroundRedraw instead (effect below).
  const pdfRotationDegRef = useRef(pdfRotationDeg);

  pdfPageImageRef.current = pdfPageImage;
  backgroundImageRef.current = backgroundImage;
  pdfRotationDegRef.current = pdfRotationDeg;

  // Slide-intro playback state, mirrored for the SAME reason as the refs above: the per-frame draw
  // must read the live value without re-creating updateBackgroundLayers (and re-binding its
  // after:render listener) when playback starts or stops.
  const isIntroPlayingRef = useRef(false);
  // The REF OBJECT is mirrored, not the element it holds: a ref is only attached after commit, so
  // reading `.current` during render would cache a null for the whole first render pass.
  const introVideoRefRef = useRef(introVideoRef);

  isIntroPlayingRef.current = isIntroPlaying;
  introVideoRefRef.current = introVideoRef;

  // --- Slide transitions ---
  // A copy of the background layer as it looked on the page being LEFT. Taken synchronously by the
  // editor before the next page loads, because by the time a transition can be decided on, the new
  // page's raster has already replaced the old one in state.
  const previousScreenRef = useRef<HTMLCanvasElement | null>(null);
  const hasPreviousScreenRef = useRef(false);
  // Where the INCOMING page is composed while a transition runs, so the two can be blitted into the
  // visible canvas with their own offsets. Allocated once and resized with the canvas.
  const transitionCompositionRef = useRef<HTMLCanvasElement | null>(null);
  const transitionFrameStateRef = useRef<TransitionFrame>(createTransitionFrame());
  /**
   * `cover` — the outgoing page is held on screen (ink hidden) while the next one loads and the
   * editor decides whether it has a transition. `native` — the movement is being drawn.
   * `clip` — a clip carrying its own transition is spinning up: cover until its first frame, then
   * keep the ink hidden for the length of the transition baked into it.
   */
  const transitionRef = useRef<{
    phase: 'idle' | 'cover' | 'native' | 'clip';
    request: PageTransitionRequest | null;
    startedAt: number;
    durationMs: number;
    /** When to stop waiting — for a verdict, for the incoming raster, or for the clip's first frame. */
    deadline: number;
    covering: boolean;
    inkRestoreAt: number;
  }>({
    covering: false,
    deadline: 0,
    durationMs: 0,
    inkRestoreAt: 0,
    phase: 'idle',
    request: null,
    startedAt: 0,
  });
  // Read by the frame driver: is the incoming page's raster on hand, so a movement can start?
  const pageRasterReadyRef = useRef(true);
  const transitionBufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Flips twice per transition (start, end) — never per frame.
  const [isTransitionRunning, setIsTransitionRunning] = useState(false);

  const bgCanvasRef = backgroundCanvasRef ?? internalBackgroundCanvasRef;
  const overlayCanvasRef = backgroundOverlayCanvasRef ?? internalOverlayCanvasRef;

  // PDF sharpness diagnostic. When the teacher enables it (localStorage `whiteboard-debug-pdf`='1',
  // toggled on the Touch test page), a small overlay prints the exact numbers that decide PDF
  // crispness — devicePixelRatio, the background canvas backing-store vs CSS size, the rendered raster
  // size, and the "raster ÷ needed device px" ratio (< 1 ⇒ the page is being upscaled → soft). Written
  // by updateBackgroundLayers via a ref (no React re-render on the draw hot path). Off by default.
  const pdfDebugRef = useRef<HTMLPreElement>(null);
  const [pdfDebugEnabled] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem('whiteboard-debug-pdf') === '1',
  );

  // Input self-heal diagnostic. When enabled (localStorage `whiteboard-debug-input`='1'), a second
  // overlay prints the live input/override state the hook publishes to `window.__wbInputDebug` —
  // effective tool, isDrawingMode, each override, the tracked-pointer counts, the whole-hand session,
  // and the reaper's `recovered` counter. It confirms on-device that the stranded-touch-state watchdog
  // fired (recovered increments; touchOverride/panMode drop back to null; draw flips back on). Off by
  // default; positioned bottom-left so it never overlaps the (top-left) PDF debug overlay.
  const inputDebugRef = useRef<HTMLPreElement>(null);
  const [inputDebugEnabled] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem('whiteboard-debug-input') === '1',
  );

  onUndoRef.current = onUndo;
  onRedoRef.current = onRedo;

  // Mirrored for the sampler below, which must stay one stable callback.
  const hasPdfPageBackgroundRef = useRef(hasPdfPageBackground);

  hasPdfPageBackgroundRef.current = hasPdfPageBackground;

  // Smart ink contrast: what is under a stroke's first point. A plain page is its paper and costs no
  // pixel read. A page with something painted on the background canvas — a PDF raster (single page or
  // the continuous layout), a pinned image — is answered from a cache of readings taken OFF the input
  // path (pen hover, idle time; see utils/backgroundLuminanceCache): a readback of the GPU background
  // canvas at pen-down cost 19–34 ms of touchstart on a Tab S9 Ultra. Reads refs only, so the hook
  // keeps one stable callback for the board's life.
  const pdfPageIdentityRef = useRef(pdfPageIdentity);

  pdfPageIdentityRef.current = pdfPageIdentity;

  const lockedImagesVersionRef = useRef(0);
  const luminanceCanvasRef = useRef<Canvas | null>(null);
  const luminanceCacheRef = useRef<BackgroundLuminanceCache | null>(null);

  if (!luminanceCacheRef.current) {
    luminanceCacheRef.current = createBackgroundLuminanceCache({
      isBusy: isPointerDown,
      schedule: (task) => {
        if (typeof window === 'undefined') return;

        if (typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(() => task(), { timeout: 300 });
        } else {
          window.setTimeout(task, 16);
        }
      },
      // Scene → CSS px through the live viewport, then → the background canvas's device px (its
      // backing store is the container's CSS size × the PDF pixel ratio; see drawBackgroundPattern).
      read: (x, y) => {
        const fabricCanvas = luminanceCanvasRef.current;
        const bgCanvas = bgCanvasRef.current;
        const container = containerRef.current;

        if (!fabricCanvas || !bgCanvas || !container) return undefined;

        const vt = fabricCanvas.viewportTransform;
        const cssX = vt[0] * x + vt[2] * y + vt[4];
        const cssY = vt[1] * x + vt[3] * y + vt[5];

        // Off screen: the background canvas holds nothing there to read.
        if (cssX < 0 || cssY < 0 || cssX >= container.clientWidth || cssY >= container.clientHeight) return undefined;

        const ratio = bgCanvas.width / Math.max(1, container.clientWidth);
        const startedAt = performance.now();

        // A raster that cannot be read (a tainted canvas) is treated as the paper most PDFs are printed on.
        return readCanvasLuminance(bgCanvas, cssX * ratio, cssY * ratio).then((luminance) => {
          recordPerf('ink-contrast-read', performance.now() - startedAt);

          return luminance ?? PAPER_LUMINANCE;
        });
      },
    });
  }

  /** Whether the background canvas paints anything but paper under the ink; keys the cache when so. */
  const paintedBackgroundKey = useCallback(
    (fabricCanvas: Canvas): string | null => {
      const scrollPainter = pdfScrollPainterRef?.current ?? null;
      const paintsBackground =
        hasPdfPageBackgroundRef.current || scrollPainter != null || getLockedImages(fabricCanvas).length > 0;

      if (!paintsBackground) return null;

      return `${hasPdfPageBackgroundRef.current ? pdfPageIdentityRef.current ?? '' : ''}|${scrollPainter ? 'scroll' : ''}|${lockedImagesVersionRef.current}`;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const sampleBackgroundLuminance = useCallback(
    (fabricCanvas: Canvas, x: number, y: number): number | null => {
      if (!bgCanvasRef.current || !containerRef.current) return PAPER_LUMINANCE;

      const key = paintedBackgroundKey(fabricCanvas);

      if (key === null) return PAPER_LUMINANCE;

      const cache = luminanceCacheRef.current;

      if (!cache) return PAPER_LUMINANCE;

      luminanceCanvasRef.current = fabricCanvas;
      cache.setBackgroundKey(key);

      // Never a pixel read here. A cell nobody has read yet is taken as paper for this one stroke, and
      // read in the background for the next.
      return cache.lookup(x, y) ?? PAPER_LUMINANCE;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { canvas, effectiveTool, isWholeHandEraserActive } = useWhiteboardCanvas({
    canvasRef,
    containerRef,
    zoomLayerRef,
    wholeHandEraserCursorRef,
    activeTool,
    strokeSettings,
    eraserMode,
    eraserSize,
    tabletInputSettings,
    fillColor,
    shapeStyle,
    zoomLocked,
    hasPdfPageBackground,
    pdfFitSizeRef,
    viewportConstraintsRef,
    directTouchPanRef,
    rulerEdgesRef,
    panAxisLock,
    onCanvasReady,
    onObjectModified,
    onShortcutColorCycle,
    onShortcutColorToggle,
    onShortcutToolToggle,
    onShortcutQuickMenu,
    onShortcutUndo: onUndo,
    onNativePenPoint: (point) => nativePenPointHandlerRef.current?.(point),
    // Redraw the background in the SAME frame the gesture preview commits (no 1-frame flash). 'low'
    // matches the in-gesture quality; the existing settle timer re-crisps it to 'high'. Goes through
    // the redraw policy (assigned below) so the duplicate after:render pass for this viewport is skipped.
    onViewportCommit: () => viewportCommitRedrawRef.current?.(),
    // Re-rasterize the PDF page at the new zoom after a pinch/wheel gesture. Fired from the hook's
    // commit against the LIVE canvas zoom, so the owner's zoom never diverges from the canvas (no
    // React-state equality bail-out, no cross-page debounce). Toolbar zoom updates the owner directly.
    onZoomCommit: onZoomChange,
    // Surface the live container size so the owner sizes the PDF raster to the real display width
    // (the Fabric canvas resizes imperatively without a React re-render).
    onCanvasResize,
    onContactCaptured,
    sampleBackgroundLuminance,
  });

  // Each nib gets the dot the teacher actually draws with — the brush and marker are both wider than the
  // pen at the same width setting, so showing them at the pen's size would under-report the mark.
  const indicatorSize =
    effectiveTool === 'highlighter'
      ? Math.max(strokeSettings.width * 4, 24)
      : effectiveTool === 'eraser'
        ? eraserSize
        : effectiveTool === 'brush'
          ? Math.max(strokeSettings.width * NIB_WIDTH_SCALE, 8)
          : effectiveTool === 'marker'
            ? Math.max(strokeSettings.width * SOFT_MARKER_WIDTH_SCALE, 8)
            : effectiveTool === 'script'
              ? Math.max(strokeSettings.width * SCRIPT_MAX_PRESSURE_SCALE, 8)
              : Math.max(strokeSettings.width, 8);
  const indicatorSizeRef = useRef(indicatorSize);
  const shouldShowIndicatorRef = useRef(false);

  const indicatorStyle =
    effectiveTool === 'eraser'
      ? {
          backgroundColor: eraserMode === 'object' ? 'rgba(244, 63, 94, 0.14)' : 'rgba(15, 23, 42, 0.08)',
          borderColor: eraserMode === 'object' ? '#f43f5e' : '#111827',
          borderStyle: eraserMode === 'object' ? 'dashed' : 'solid',
        }
      : {
          backgroundColor: strokeSettings.color,
          borderColor: strokeSettings.color,
          borderStyle: 'solid' as const,
        };
  // Hide the small single-point cursor while a REAL touch palm-eraser pass is active — that pass draws its
  // own big circle (wholeHandEraserCursorRef), and leaving this one up made a tiny dot flicker between
  // fingers. In mouse test-emulation there is no big circle, so keep this one as the eraser cursor.
  const isRealPalmEraserActive = isWholeHandEraserActive && !tabletInputSettings?.wholeHandEraser?.testEmulation;
  const shouldShowIndicator =
    (isPenFamilyTool(effectiveTool) || effectiveTool === 'highlighter' || effectiveTool === 'eraser') &&
    !isRealPalmEraserActive;

  indicatorSizeRef.current = indicatorSize;
  shouldShowIndicatorRef.current = shouldShowIndicator;

  const applyCursorIndicatorUpdate = useCallback(
    (nextState: { visible: boolean; x: number; y: number }) => {
      const indicator = cursorIndicatorRef.current;

      if (!indicator) {
        return;
      }

      const isVisible = nextState.visible && shouldShowIndicatorRef.current;

      // The whole pen family gets the pen's faint ghost. Falling through to '1' gave the brush and marker
      // a fully-opaque ink-coloured disc — and since their indicator is scaled to the nib (1.6x / 2.2x the
      // width), it sat on top of the letter being formed instead of hinting at it.
      indicator.style.opacity = isVisible
        ? effectiveTool === 'highlighter'
          ? '0.35'
          : isPenFamilyTool(effectiveTool)
            ? '0.22'
            : '1'
        : '0';
      indicator.style.transform = `translate3d(${nextState.x - indicatorSizeRef.current / 2}px, ${nextState.y - indicatorSizeRef.current / 2}px, 0)`;
    },
    [effectiveTool],
  );

  const updateContainerBounds = useCallback(() => {
    const container = containerRef.current;

    if (!container) {
      return null;
    }

    const bounds = container.getBoundingClientRect();

    containerBoundsRef.current = bounds;

    return bounds;
  }, []);

  const scheduleCursorIndicatorUpdate = useCallback(
    (nextState: { visible: boolean; x: number; y: number }) => {
      // The pen leaving the glass's hover range often sends nothing (Samsung S Pen in Chrome and in the
      // WebView), so a shown cursor fades after a moment without pen input instead of waiting for a leave.
      // A tip resting on the glass (a hold-to-snap, a pause mid-word) is still pointing at something: the
      // timer only re-arms while a contact is down, so the dot never blinks under a held pen.
      if (indicatorIdleTimerRef.current !== null) window.clearTimeout(indicatorIdleTimerRef.current);

      indicatorIdleTimerRef.current = nextState.visible
        ? window.setTimeout(() => {
            indicatorIdleTimerRef.current = null;
            scheduleCursorIndicatorUpdate(isPointerDown() ? nextState : { visible: false, x: nextState.x, y: nextState.y });
          }, CURSOR_INDICATOR_IDLE_HIDE_MS)
        : null;
      pendingIndicatorStateRef.current = nextState;

      if (indicatorFrameRef.current !== null) {
        return;
      }

      indicatorFrameRef.current = window.requestAnimationFrame(() => {
        indicatorFrameRef.current = null;

        const pendingState = pendingIndicatorStateRef.current;

        pendingIndicatorStateRef.current = null;

        if (!pendingState) {
          return;
        }

        applyCursorIndicatorUpdate(pendingState);
      });
    },
    [applyCursorIndicatorUpdate],
  );

  nativePenPointHandlerRef.current = (point: { x: number; y: number } | null) => {
    if (!point) {
      scheduleCursorIndicatorUpdate({ visible: false, x: 0, y: 0 });

      return;
    }

    if (!shouldShowIndicatorRef.current) return;

    const bounds = containerBoundsRef.current ?? updateContainerBounds();

    if (!bounds) return;

    scheduleCursorIndicatorUpdate({ visible: true, x: point.x - bounds.left, y: point.y - bounds.top });
  };

  const getViewportSignature = useCallback(() => {
    const viewport = canvas?.viewportTransform ?? [1, 0, 0, 1, 0, 0];

    return viewport.map((value) => Number(value).toFixed(3)).join(',');
  }, [canvas]);

  // A pre-scaled copy of the page raster at the exact device-pixel size it is drawn at. The decoded
  // page is ~7 MP; resampling it on every pass (three per viewport commit) is what made a stray palm
  // pan hitch the pen on the studio boards. With the copy, every pass is a 1:1 blit. Keyed by image
  // identity + target size; built off the main thread by createImageBitmap; the full raster is drawn
  // until the copy lands, then one crisp repaint swaps it in.
  const scaledRasterRef = useRef<{ bitmap: ImageBitmap; imageIdentity: number; key: string } | null>(null);
  const scaledRasterPendingKeyRef = useRef<string | null>(null);
  const scaledRasterUnsupportedRef = useRef(false);

  const resolveScaledPdfSource = useCallback(
    (image: HTMLImageElement, fitWidth: number, fitHeight: number, pixelRatio: number): CanvasImageSource | null => {
      if (scaledRasterUnsupportedRef.current || typeof createImageBitmap !== 'function') {
        return null;
      }

      // The rotated draw path sizes from the unrotated raster; keep it on the source.
      if (normalizeRotationDeg(pdfRotationDegRef.current) !== 0) {
        return null;
      }

      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;
      const placement = getScreenFitPlacement(fitWidth, fitHeight, sourceWidth, sourceHeight);
      const zoom = canvas?.viewportTransform?.[0] ?? 1;
      const target = getScaledRasterTarget(placement.width, placement.height, zoom, pixelRatio, sourceWidth, sourceHeight);

      if (!target) {
        return null;
      }

      const key = `${getImageIdentity(image)}:${target.width}x${target.height}`;
      const cached = scaledRasterRef.current;

      if (cached?.key === key) {
        return cached.bitmap;
      }

      if (scaledRasterPendingKeyRef.current === null) {
        scaledRasterPendingKeyRef.current = key;

        createImageBitmap(image, { resizeHeight: target.height, resizeQuality: 'high', resizeWidth: target.width })
          .then((bitmap) => {
            scaledRasterPendingKeyRef.current = null;

            // The page changed while the copy was being built — it belongs to nobody now.
            if (pdfPageImageRef.current !== image) {
              bitmap.close();
              // The page that replaced it painted while this build held the single slot, so it has no
              // copy yet — one repaint schedules its own.
              requestBackgroundRepaintRef.current?.('high');

              return;
            }

            scaledRasterRef.current?.bitmap.close();
            scaledRasterRef.current = { bitmap, imageIdentity: getImageIdentity(image), key };
            requestBackgroundRepaintRef.current?.('high');
          })
          .catch(() => {
            // A tainted/undecodable source: fall back to drawing the raster directly, for good.
            scaledRasterPendingKeyRef.current = null;
            scaledRasterUnsupportedRef.current = true;
          });
      }

      return null;
    },
    [canvas],
  );

  useEffect(
    () => () => {
      scaledRasterRef.current?.bitmap.close();
      scaledRasterRef.current = null;
    },
    [],
  );

  // --- Draw background pattern ---
  const updateBackgroundLayers = useCallback(
    (quality: ImageSmoothingQuality = 'high') => {
      const bgCanvas = bgCanvasRef.current;
      const overlayCanvas = overlayCanvasRef.current;
      const container = containerRef.current;
      const bgContext = bgCanvas?.getContext('2d');

      if (!bgCanvas || !overlayCanvas || !container || !bgContext) return;

      // --- Slide transition: where does this pass paint? ---
      // While a movement runs, the incoming page is composed OFF screen and the visible canvas is
      // built from two blits (outgoing + incoming) instead. Every other pass paints straight into
      // the visible canvas exactly as before, so nothing about the normal path changes.
      const transition = transitionRef.current;
      const isCompositingTransition = transition.phase === 'native' && hasPreviousScreenRef.current;
      let compositionCanvas = bgCanvas;

      if (isCompositingTransition) {
        if (!transitionCompositionRef.current) {
          transitionCompositionRef.current = document.createElement('canvas');
        }

        compositionCanvas = transitionCompositionRef.current;
      }

      const compositionContext = compositionCanvas === bgCanvas ? bgContext : compositionCanvas.getContext('2d');

      if (!compositionContext) return;

      // Rasterize the background/PDF/overlay at device pixels (bounded by the active quality mode) so
      // the PDF matches the retina-scaled Fabric ink layer instead of looking soft on HiDPI panels.
      const pixelRatio = getPdfBackgroundPixelRatio();

      drawBackgroundPattern(
        compositionCanvas,
        backgroundType,
        container.clientWidth,
        container.clientHeight,
        { spacing: backgroundSpacingPx, viewportTransform: canvas?.viewportTransform },
        pixelRatio,
      );

      const notebookPage = notebookPageRef?.current;

      if (notebookPage) {
        drawNotebookMargins(
          compositionContext,
          notebookPage,
          canvas?.viewportTransform,
          pixelRatio,
          container.clientWidth,
          container.clientHeight,
        );
      }
      // Place the PDF against the FROZEN fit size (captured at page open), not the live canvas size,
      // so its scene rect is stable across resizes and the ink stays glued to it. The bg canvas
      // itself is still the live size; only the fit math is frozen.
      const pdfFit = pdfFitSizeRef.current;
      // Read the live refs (not closure state) so a stale-scheduled redraw paints the current page.
      // GATE on hasPdfPageBackground: a non-PDF page must NEVER paint a PDF raster, even when a
      // stale image is still in state — the load effect below can race a page switch (its cached
      // stale-URL reload lands between commits while loadPage keeps the main thread busy) and
      // commit the OUTGOING page's image after the switch. hasPdfPageBackground is derived
      // synchronously from the current page, so it is always correct for the page on screen.
      const pdfImage = hasPdfPageBackground ? pdfPageImageRef.current : null;
      const overlayImage = backgroundImageRef.current;
      const fitWidth = pdfFit?.width ?? container.clientWidth;
      const fitHeight = pdfFit?.height ?? container.clientHeight;
      // Draw the pre-scaled copy when one exists for this exact size; the placement math below still
      // runs on the SOURCE dimensions, so the page lands in the same rect either way.
      const pdfDrawSource = pdfImage ? (resolveScaledPdfSource(pdfImage, fitWidth, fitHeight, pixelRatio) ?? pdfImage) : null;
      // While a slide intro plays, the VIDEO is the page image: same fit frame, same rotation, same
      // viewport transform, so the clip occupies exactly the rect the raster will occupy when it
      // settles. Placement keeps using the RASTER's intrinsic size when there is one — a clip whose
      // encoder padded the aspect by a pixel then still lands on the page rect instead of beside it.
      // Until the first frame is decoded (readyState < HAVE_CURRENT_DATA) the raster keeps painting,
      // so starting playback never flashes an empty page.
      const introVideo = introVideoRefRef.current?.current ?? null;
      const introSource =
        isIntroPlayingRef.current && introVideo && introVideo.readyState >= 2 && introVideo.videoWidth > 0
          ? introVideo
          : null;
      const pageDrawSource = introSource ?? pdfDrawSource;
      const scrollPainter = pdfScrollPainterRef?.current ?? null;

      if (scrollPainter) {
        // Continuous PDF layout: the stacked pages replace the single fitted raster. Same viewport
        // transform and pixel ratio, so they stay glued to the ink exactly as one page does.
        scrollPainter(compositionContext, {
          height: container.clientHeight,
          pixelRatio,
          quality,
          viewportTransform: canvas?.viewportTransform ?? [1, 0, 0, 1, 0, 0],
          width: container.clientWidth,
        });
      } else {
        drawScreenFitImage(
          compositionContext,
          fitWidth,
          fitHeight,
          pageDrawSource,
          pdfImage?.naturalWidth || pdfImage?.width || introSource?.videoWidth || container.clientWidth,
          pdfImage?.naturalHeight || pdfImage?.height || introSource?.videoHeight || container.clientHeight,
          1,
          canvas?.viewportTransform,
          quality,
          pixelRatio,
          // Rotates the RASTER only; the fit frame is recomputed from the rotated bounding box in there,
          // so pdfFitSizeRef (the frozen fit) stays the unrotated page rect it has always been.
          pdfRotationDegRef.current,
        );
      }

      // The paper pattern over the PDF page: a white PDF sheet hides the pattern drawn underneath, so it
      // is painted again on top with `multiply` — white stays the page, the lines show on it.
      // The continuous layout rules each PDF page itself (per page, clipped to its sheet), so this
      // full-screen pass is for the single fitted page only — running it too re-drew and re-blended
      // the whole screen a second time on every scroll frame.
      if (paperOverPdf && backgroundType !== 'blank' && pdfImage && !scrollPainter) {
        const patternCanvas = (paperOverlayCanvasRef.current ??= document.createElement('canvas'));

        drawBackgroundPattern(
          patternCanvas,
          backgroundType,
          container.clientWidth,
          container.clientHeight,
          { paper: true, spacing: backgroundSpacingPx, viewportTransform: canvas?.viewportTransform },
          pixelRatio,
        );
        compositionContext.save();
        compositionContext.setTransform(1, 0, 0, 1, 0, 0);
        compositionContext.globalCompositeOperation = 'multiply';
        compositionContext.drawImage(patternCanvas, 0, 0);
        compositionContext.restore();
      }

      // Pinned images ride the background canvas for the same reason the PDF page does: it sits BELOW
      // the transparent Fabric canvas, so the `destination-out` erasers can never punch them. Painted
      // LAST (pattern → PDF → pins) so a pin dropped over a PDF page covers it, and with the same
      // viewportTransform/pixelRatio as the draws above so it stays glued to the scene.
      if (canvas) {
        drawLockedImages(compositionContext, getLockedImages(canvas), canvas.viewportTransform, pixelRatio);
      }

      // --- Slide transition: composite, or hold the outgoing page ---
      const previousScreen = previousScreenRef.current;

      if (isCompositingTransition && previousScreen) {
        const cssWidth = container.clientWidth;
        const cssHeight = container.clientHeight;
        const elapsed = performance.now() - transition.startedAt;
        const progress = transition.durationMs > 0 ? Math.min(1, Math.max(0, elapsed / transition.durationMs)) : 1;
        const frame = resolveTransitionFrame(
          {
            direction: transition.request?.direction,
            kind: transition.request?.kind,
            option: transition.request?.option,
            orient: transition.request?.orient,
          },
          progress,
          cssWidth,
          cssHeight,
          transitionFrameStateRef.current,
        );

        bgContext.setTransform(1, 0, 0, 1, 0, 0);
        bgContext.globalAlpha = 1;
        bgContext.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
        // A sliding page leaves the area it came from empty for part of the movement; paint the
        // BOARD's own base colour under both layers so that gap reads as the board rather than as a
        // white flash on a board that is not white.
        bgContext.fillStyle = currentBoardBaseColor();
        bgContext.fillRect(0, 0, bgCanvas.width, bgCanvas.height);

        if (frame.previousOnTop) {
          drawTransitionLayer(bgContext, compositionCanvas, frame.next, pixelRatio, cssWidth, cssHeight);
          drawTransitionLayer(bgContext, previousScreen, frame.previous, pixelRatio, cssWidth, cssHeight);
        } else {
          drawTransitionLayer(bgContext, previousScreen, frame.previous, pixelRatio, cssWidth, cssHeight);
          drawTransitionLayer(bgContext, compositionCanvas, frame.next, pixelRatio, cssWidth, cssHeight);
        }

        bgContext.setTransform(1, 0, 0, 1, 0, 0);
        bgContext.globalAlpha = 1;
      } else if (transition.covering && previousScreen) {
        // The clip carries its own transition, so the page it transitions FROM has to still be on
        // screen when the first frame lands. Until then the outgoing screen covers everything.
        bgContext.save();
        bgContext.setTransform(1, 0, 0, 1, 0, 0);
        bgContext.globalAlpha = 1;
        bgContext.drawImage(previousScreen, 0, 0, bgCanvas.width, bgCanvas.height);
        bgContext.restore();
      }

      drawOverlayImage(
        overlayCanvas,
        container.clientWidth,
        container.clientHeight,
        overlayImage,
        backgroundImageOpacity,
        pixelRatio,
      );

      // PDF sharpness diagnostic readout (off unless the debug flag is set). The key line is `ratio`:
      // rasterWidth ÷ (bgCss.w × dpr). ≥1 ⇒ the page has enough pixels to be crisp; <1 ⇒ it is being
      // upscaled onto the display → soft. `backing/needed` tells us whether the DPR fix is in effect.
      if (pdfDebugEnabled && pdfDebugRef.current) {
        const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
        const cssW = bgCanvas.clientWidth || container.clientWidth;
        const cssH = bgCanvas.clientHeight || container.clientHeight;
        const neededW = Math.round(cssW * dpr);
        const rasterW = pdfImage?.naturalWidth ?? 0;
        const rasterH = pdfImage?.naturalHeight ?? 0;
        const ratio = rasterW > 0 && neededW > 0 ? (rasterW / neededW).toFixed(2) : '—';
        const backing = neededW > 0 ? (bgCanvas.width / neededW).toFixed(2) : '—';
        // js= proves which BUNDLE is live (vs the native splash version). sw= reveals a stale service
        // worker still controlling the page. sizer cw/edge = the ACTUAL inputs resolvePdfLiveRenderEdge
        // received: cw≈480 with a full-width display ⇒ the raster is sized off a stale pre-layout width
        // (width-wiring bug); cw≈1916 but raster small ⇒ the native PDFium render under-produced.
        const swState =
          typeof navigator !== 'undefined' && 'serviceWorker' in navigator
            ? navigator.serviceWorker.controller
              ? 'CONTROLLED'
              : 'none'
            : 'n/a';
        const sizer = (window as unknown as { __pdfDebugSizer?: { cw?: number; edge?: number; path?: string } })
          .__pdfDebugSizer;

        pdfDebugRef.current.textContent = [
          `PDF DEBUG  js=${PDF_DEBUG_JS_BUILD}  sw=${swState}`,
          `dpr=${dpr}  pdfPR=${pixelRatio}  mode=${getPdfQualityMode()}`,
          `bg backing=${bgCanvas.width}×${bgCanvas.height}  css=${cssW}×${cssH}`,
          `container=${container.clientWidth}×${container.clientHeight}  fit=${pdfFit?.width ?? '—'}×${pdfFit?.height ?? '—'}`,
          `sizer cw=${sizer?.cw ?? '—'}  edge=${sizer?.edge ?? '—'}  via=${sizer?.path ?? '—'}`,
          `raster=${rasterW}×${rasterH}  needed(w×dpr)=${neededW}`,
          `ratio raster/needed=${ratio}   backing/needed=${backing}`,
        ].join('\n');
      }
    },
    [
      backgroundImageOpacity,
      backgroundSpacingPx,
      backgroundType,
      paperOverPdf,
      bgCanvasRef,
      canvas,
      hasPdfPageBackground,
      notebookPageRef,
      overlayCanvasRef,
      pdfDebugEnabled,
      pdfScrollPainterRef,
      resolveScaledPdfSource,
    ],
  );

  // Keep the ref the hook calls on zoom/pan commit pointed at the latest updateBackgroundLayers.
  updateBackgroundLayersRef.current = updateBackgroundLayers;

  // --- Overscan backdrop (what a gesture reveals outside the viewport; see utils/overscanBackdrop) ---
  const backgroundTypeRef = useRef(backgroundType);
  const backgroundSpacingRef = useRef(backgroundSpacingPx);

  backgroundTypeRef.current = backgroundType;
  backgroundSpacingRef.current = backgroundSpacingPx;

  const backdrop = useOverscanBackdrop({
    backdropCanvasRef,
    backdropInkCanvasRef,
    canvas,
    containerRef,
    getBackgroundType: () => backgroundTypeRef.current,
    getBackgroundSpacing: () => backgroundSpacingRef.current,
    // Same recipe as updateBackgroundLayers (frozen PDF fit, rotation, pinned images), just against the
    // backdrop's shifted transform with its low ratio as the pixel ratio. The source raster, not the
    // pre-scaled copy: that one is sized for the live DPR and building it has side effects.
    paintPage: (ctx, plan) => {
      const container = containerRef.current;

      if (!container) return;

      const transform = backdropPaintTransform(plan);
      const notebookPage = notebookPageRef?.current;

      if (notebookPage) {
        drawNotebookMargins(ctx, notebookPage, transform, plan.ratio, plan.pixelWidth / plan.ratio, plan.pixelHeight / plan.ratio);
      }

      const pdfImage = hasPdfPageBackground ? pdfPageImageRef.current : null;

      if (pdfImage) {
        const pdfFit = pdfFitSizeRef.current;

        drawScreenFitImage(
          ctx,
          pdfFit?.width ?? container.clientWidth,
          pdfFit?.height ?? container.clientHeight,
          pdfImage,
          pdfImage.naturalWidth || pdfImage.width || container.clientWidth,
          pdfImage.naturalHeight || pdfImage.height || container.clientHeight,
          1,
          transform,
          'medium',
          plan.ratio,
          pdfRotationDegRef.current,
        );
      }

      if (canvas) {
        drawLockedImages(ctx, getLockedImages(canvas), transform, plan.ratio);
      }
    },
    zoomLayerRef,
    disabled: overscanBackdropDisabled,
  });
  const invalidateBackdropRef = useRef(backdrop.invalidate);

  invalidateBackdropRef.current = backdrop.invalidate;

  // A different page: whatever the backdrop holds is another page's content — take it down now.
  useEffect(() => {
    invalidateBackdropRef.current({ hide: true });
  }, [pdfPageIdentity, hasPdfPageBackground]);

  // Same page, different pixels: rebuild at the next quiet moment (the stale one stays up until then).
  useEffect(() => {
    invalidateBackdropRef.current();
  }, [pdfPageImage, pdfRotationDeg, backgroundType, backgroundSpacingPx]);

  useEffect(() => {
    if (!canvas) return;

    return onLockedImagesChanged(canvas, () => invalidateBackdropRef.current());
  }, [canvas]);

  // Smart ink contrast cache (see sampleBackgroundLuminance): readings of a raster that has since been
  // replaced or rotated describe pixels that are gone.
  useEffect(() => {
    luminanceCacheRef.current?.clear();
  }, [pdfPageImage, pdfRotationDeg]);

  useEffect(() => {
    if (!canvas) return;

    return onLockedImagesChanged(canvas, () => {
      lockedImagesVersionRef.current += 1;
    });
  }, [canvas]);

  // …and filled while the pen HOVERS, so the stroke that follows finds its reading waiting: an S Pen
  // reports hover well before it touches. Throttled — one cell lookup per ~50 ms is plenty, and the
  // read itself runs in idle time. The lift point is read too: the next stroke usually starts nearby.
  const smartInkContrastEnabled = tabletInputSettings?.smartInkContrast === true;

  useEffect(() => {
    const container = containerRef.current;

    if (!canvas || !container || !smartInkContrastEnabled) return;

    let lastAt = 0;
    const prefetchAt = (event: PointerEvent) => {
      const key = paintedBackgroundKey(canvas);
      const cache = luminanceCacheRef.current;

      if (key === null || !cache) return;

      const rect = container.getBoundingClientRect();
      const vt = canvas.viewportTransform;
      const det = vt[0] * vt[3] - vt[1] * vt[2];

      if (!det) return;

      const cssX = event.clientX - rect.left - vt[4];
      const cssY = event.clientY - rect.top - vt[5];

      luminanceCanvasRef.current = canvas;
      cache.setBackgroundKey(key);
      cache.prefetch((vt[3] * cssX - vt[2] * cssY) / det, (vt[0] * cssY - vt[1] * cssX) / det);
    };
    const handleMove = (event: PointerEvent) => {
      if (event.pointerType !== 'pen' || event.buttons !== 0) return;

      const now = event.timeStamp;

      if (now - lastAt < 50) return;

      lastAt = now;
      prefetchAt(event);
    };
    const handleUp = (event: PointerEvent) => {
      if (event.pointerType === 'pen') prefetchAt(event);
    };

    // Capture phase: the board's own handlers may stop a pen event from bubbling.
    container.addEventListener('pointermove', handleMove, { capture: true, passive: true });
    container.addEventListener('pointerup', handleUp, { capture: true, passive: true });

    return () => {
      container.removeEventListener('pointermove', handleMove, { capture: true });
      container.removeEventListener('pointerup', handleUp, { capture: true });
    };
  }, [canvas, containerRef, paintedBackgroundKey, smartInkContrastEnabled]);

  // A movement may not start before the page it moves TO exists: on a PDF/slide page that means its
  // raster has landed. A blank page is ready as soon as it is loaded.
  pageRasterReadyRef.current = !hasPdfPageBackground || pdfPageImage !== null;

  // --- Slide transition control ---
  /**
   * Hide or restore the whole ink layer. Fabric wraps the drawing canvas in its own container that
   * also holds the upper (interaction) canvas, so the wrapper is what has to be hidden — hiding the
   * lower canvas alone would leave a half-visible layer. Direct DOM, because this runs from the
   * frame driver and must not cost a render.
   */
  const setInkHidden = useCallback((hidden: boolean) => {
    const element = canvasRef.current?.parentElement ?? canvasRef.current;

    if (!element) return;

    element.style.opacity = hidden ? '0' : '';
    element.style.pointerEvents = hidden ? 'none' : '';
  }, []);

  /** Hand both scratch canvases back: a zero-sized canvas frees its backing store immediately. */
  const releaseTransitionBuffers = useCallback(() => {
    for (const bufferRef of [previousScreenRef, transitionCompositionRef]) {
      const buffer = bufferRef.current;

      if (!buffer) continue;

      buffer.width = 0;
      buffer.height = 0;
      bufferRef.current = null;
    }

    hasPreviousScreenRef.current = false;
  }, []);

  const scheduleTransitionBufferRelease = useCallback(() => {
    if (transitionBufferTimerRef.current !== null) {
      clearTimeout(transitionBufferTimerRef.current);
    }

    transitionBufferTimerRef.current = setTimeout(() => {
      transitionBufferTimerRef.current = null;

      // A transition that started in the meantime owns the buffers again.
      if (transitionRef.current.phase !== 'idle') return;

      releaseTransitionBuffers();
    }, TRANSITION_BUFFER_IDLE_MS);
  }, [releaseTransitionBuffers]);

  /** End whatever is running, put the ink back, and repaint the page as it actually is. */
  const endTransition = useCallback(() => {
    const transition = transitionRef.current;
    const { request } = transition;

    transition.phase = 'idle';
    transition.request = null;
    transition.covering = false;
    hasPreviousScreenRef.current = false;
    setInkHidden(false);
    setIsTransitionRunning(false);
    updateBackgroundLayersRef.current?.('high');
    scheduleTransitionBufferRelease();
    // Fired last, and after the state is already clean, so a handler that starts the page's clip
    // (or begins another transition) is not fighting the one that just ended.
    request?.onDone?.();
  }, [scheduleTransitionBufferRelease, setInkHidden]);

  const capturePreviousScreen = useCallback(() => {
    // The buffers are in use again; whatever release was pending is off.
    if (transitionBufferTimerRef.current !== null) {
      clearTimeout(transitionBufferTimerRef.current);
      transitionBufferTimerRef.current = null;
    }

    const bgCanvas = bgCanvasRef.current;

    if (!bgCanvas || bgCanvas.width === 0 || bgCanvas.height === 0) {
      hasPreviousScreenRef.current = false;

      return;
    }

    if (!previousScreenRef.current) {
      previousScreenRef.current = document.createElement('canvas');
    }

    const snapshot = previousScreenRef.current;

    if (snapshot.width !== bgCanvas.width || snapshot.height !== bgCanvas.height) {
      snapshot.width = bgCanvas.width;
      snapshot.height = bgCanvas.height;
    }

    const snapshotContext = snapshot.getContext('2d');

    if (!snapshotContext) {
      hasPreviousScreenRef.current = false;

      return;
    }

    snapshotContext.setTransform(1, 0, 0, 1, 0, 0);
    snapshotContext.clearRect(0, 0, snapshot.width, snapshot.height);
    snapshotContext.drawImage(bgCanvas, 0, 0);
    hasPreviousScreenRef.current = true;

    // Hold the outgoing page from THIS moment, not from when a transition is decided on: the page
    // load and the intro lookup both happen in between, and without the cover the teacher would see
    // the new page appear and then be animated in, which is not a transition — it is a flicker.
    const transition = transitionRef.current;

    transition.phase = 'cover';
    transition.request = null;
    transition.covering = true;
    transition.deadline = performance.now() + TRANSITION_VERDICT_WAIT_MS;
    setInkHidden(true);
    setIsTransitionRunning(true);
  }, [bgCanvasRef, setInkHidden]);

  const beginTransition = useCallback(
    (request: PageTransitionRequest) => {
      const transition = transitionRef.current;
      const durationMs = clampTransitionDurationMs(request.durationMs);

      // Nothing was captured (the board just opened, or the canvas had no pixels yet), or there is
      // no movement to draw: reveal the page and let the caller carry on.
      if (!hasPreviousScreenRef.current || (request.mode === 'native' && durationMs <= 0)) {
        transition.request = request;
        endTransition();

        return;
      }

      transition.request = request;
      transition.durationMs = durationMs;
      transition.covering = true;
      setIsTransitionRunning(true);
      setInkHidden(true);

      if (request.mode === 'hold') {
        transition.phase = 'clip';
        transition.deadline = performance.now() + CLIP_TRANSITION_HOLD_MS;

        return;
      }

      // Stay covered until the incoming raster exists, so the movement animates the real page
      // rather than an empty frame that fills in halfway through.
      transition.phase = 'cover';
      transition.deadline = performance.now() + TRANSITION_RASTER_WAIT_MS;
    },
    [endTransition, setInkHidden],
  );

  const cancelTransition = useCallback(() => {
    if (transitionRef.current.phase === 'idle') return;

    endTransition();
  }, [endTransition]);

  useEffect(() => {
    if (!transitionHandleRef) return;

    transitionHandleRef.current = {
      begin: beginTransition,
      cancel: cancelTransition,
      capturePrevious: capturePreviousScreen,
    };

    return () => {
      transitionHandleRef.current = null;
    };
  }, [beginTransition, cancelTransition, capturePreviousScreen, transitionHandleRef]);

  // --- Slide intro / transition frame pump ---
  // One loop drives both: a clip being painted frame by frame, and a transition being animated.
  // Deliberately the SAME routine a pan/zoom frame uses (one pass, 'low' smoothing, no allocations,
  // no React state per frame) rather than a second geometry path that could drift from the raster's.
  // The phase machine is advanced here too, so every timing decision happens on a frame boundary
  // instead of in a timer that could fire between paints.
  useEffect(() => {
    if (!isIntroPlaying && !isTransitionRunning) return;

    let frame = requestAnimationFrame(function pump() {
      updateBackgroundLayersRef.current?.('low');

      const transition = transitionRef.current;
      const now = performance.now();

      switch (transition.phase) {
        case 'cover': {
          const request = transition.request;

          if (request?.mode === 'native') {
            // Start once the incoming page can actually be drawn, or once waiting for it has gone
            // on long enough that a frozen screen is the worse outcome.
            if (pageRasterReadyRef.current || now >= transition.deadline) {
              transition.phase = 'native';
              transition.covering = false;
              transition.startedAt = now;
            }
          } else if (now >= transition.deadline) {
            // No verdict came back in time — reveal the page rather than sit on the old one.
            endTransition();
          }

          break;
        }

        case 'native': {
          if (now - transition.startedAt >= transition.durationMs) {
            endTransition();
          }

          break;
        }

        case 'clip': {
          if (transition.covering) {
            const video = introVideoRefRef.current?.current;
            const hasFirstFrame =
              isIntroPlayingRef.current && (video?.readyState ?? 0) >= 2 && (video?.videoWidth ?? 0) > 0;

            if (hasFirstFrame) {
              // The clip opens with the transition itself, so the ink stays hidden for exactly as
              // long as that part runs; the animations after it are written over normally.
              transition.covering = false;
              transition.inkRestoreAt = now + transition.durationMs;
            } else if (now >= transition.deadline) {
              // The clip never got going. Show the page it belongs to; no transition is better than
              // a frozen board.
              transition.covering = false;
              transition.inkRestoreAt = now;
            }
          }

          if (!transition.covering && now >= transition.inkRestoreAt) {
            endTransition();
          }

          break;
        }

        default:
          break;
      }

      frame = requestAnimationFrame(pump);
    });

    return () => {
      cancelAnimationFrame(frame);
      updateBackgroundLayersRef.current?.('high');
    };
  }, [endTransition, isIntroPlaying, isTransitionRunning]);

  // The canvas going away mid-transition must not leave the ink layer hidden on whatever replaces
  // it, nor leave two screen-sized buffers behind.
  useEffect(
    () => () => {
      transitionRef.current.phase = 'idle';
      transitionRef.current.covering = false;

      if (transitionBufferTimerRef.current !== null) {
        clearTimeout(transitionBufferTimerRef.current);
        transitionBufferTimerRef.current = null;
      }

      releaseTransitionBuffers();
    },
    [releaseTransitionBuffers],
  );

  // Pan/zoom redraws the PDF background every frame. Draw at low smoothing inside one rAF per frame
  // (coalescing bursts), then schedule a single crisp 'high' redraw once the gesture settles.
  const bgRedrawFrameRef = useRef<number | null>(null);
  const bgSettleTimerRef = useRef<number | null>(null);
  // Stroke bookkeeping for the redraw policy (utils/backgroundRedrawPolicy): when the pen went down in
  // drawing mode, whether a crisp pass is owed at pen-up, and which viewport the commit already painted.
  const strokeDownAtRef = useRef<number | null>(null);
  const deferredCrispRedrawRef = useRef(false);
  const committedLowSignatureRef = useRef<string | null>(null);

  // Every scheduled pass goes through here: a 'high' pass mid-stroke is postponed to pen-up (one pass,
  // not one per palm contact), a 'low' pass always paints so the page stays glued under the ink.
  const paintBackground = useCallback(
    (requested: BackgroundRedrawQuality) => {
      const strokeInProgress = isStrokeInProgress(strokeDownAtRef.current, canvas?.isDrawingMode === true, Date.now());
      const resolved = resolveBackgroundRedrawQuality(requested, strokeInProgress);

      if (resolved === 'defer') {
        deferredCrispRedrawRef.current = true;

        // Fabric never registers pointercancel, so a palm-rejected or gesture-stolen stroke may never
        // fire mouse:up. Keep retrying on the settle cadence; the pass lands the moment the stroke is
        // over (pen-up, an override flipping drawing off, or the 8 s cap).
        if (bgSettleTimerRef.current !== null) {
          window.clearTimeout(bgSettleTimerRef.current);
        }

        bgSettleTimerRef.current = window.setTimeout(() => {
          bgSettleTimerRef.current = null;
          requestBackgroundRepaintRef.current?.('high');
        }, 160);

        return;
      }

      if (requested === 'high') {
        deferredCrispRedrawRef.current = false;
      }

      // Telemetry seam: `bg-paint:<quality>` spans land in the diagnostics bundle (renderer perf trace).
      perfSpan(`bg-paint:${resolved}`, () => updateBackgroundLayers(resolved));
    },
    [canvas, updateBackgroundLayers],
  );

  requestBackgroundRepaintRef.current = paintBackground;
  viewportCommitRedrawRef.current = () => {
    paintBackground('low');
    committedLowSignatureRef.current = getViewportSignature();
  };

  // `reason` 'content' = something other than the viewport changed (pins, rotation): the commit's
  // painted signature must not silence the pass, since the same viewport now shows different pixels.
  const scheduleBackgroundRedraw = useCallback((reason: 'content' | 'viewport' = 'viewport') => {
    if (reason === 'content') {
      committedLowSignatureRef.current = null;
    }

    if (bgRedrawFrameRef.current === null) {
      bgRedrawFrameRef.current = window.requestAnimationFrame(() => {
        bgRedrawFrameRef.current = null;

        // The commit's own renderAll queued this pass; when the commit already painted this exact
        // viewport there is nothing left to draw.
        const committedLowSignature = committedLowSignatureRef.current;

        committedLowSignatureRef.current = null;

        if (shouldSkipDuplicateLowPass(getViewportSignature(), committedLowSignature)) {
          return;
        }

        paintBackground('low');
      });
    }

    if (bgSettleTimerRef.current !== null) {
      window.clearTimeout(bgSettleTimerRef.current);
    }

    bgSettleTimerRef.current = window.setTimeout(() => {
      bgSettleTimerRef.current = null;
      paintBackground('high');
    }, 160);
  }, [getViewportSignature, paintBackground]);

  useEffect(() => {
    if (!backgroundRepaintRef) return;

    backgroundRepaintRef.current = () => scheduleBackgroundRedraw('content');

    return () => {
      backgroundRepaintRef.current = null;
    };
  }, [backgroundRepaintRef, scheduleBackgroundRedraw]);

  useEffect(() => {
    return () => {
      if (bgRedrawFrameRef.current !== null) {
        window.cancelAnimationFrame(bgRedrawFrameRef.current);
        bgRedrawFrameRef.current = null;
      }

      if (bgSettleTimerRef.current !== null) {
        window.clearTimeout(bgSettleTimerRef.current);
        bgSettleTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setPdfPageImage(null);
    // The previous page's frame must never be recorded onto the page that just opened; the load
    // effect below republishes once THIS page's raster has landed.
    onPdfBackgroundFrameChangeRef.current?.(null);
  }, [pdfPageIdentity]);

  // Freeze the fit size when a PDF page opens (clear it on non-PDF pages). useWhiteboardCanvas's
  // resize handler refits this frozen rect so the page + ink scale together, and the background draw
  // below uses it so the PDF's scene placement never changes with the live canvas size.
  //
  // WHICH size: a page that already carries a recorded frame (`pdfFrameRecord.canvasWidthPx`) is
  // pinned to THAT frame — the one its ink was written in — however wide this window is; the owner
  // opens it at the matching viewport zoom. Only a page with no record freezes at the live container,
  // and gets recorded on its first save. Re-freezing from the live container on every open was the
  // bug where a board reopened on a narrower window drew the PDF at 1/3 the size of its own ink AND
  // then re-recorded that wrong frame over the right one.
  useEffect(() => {
    if (!hasPdfPageBackground) {
      pdfFitSizeRef.current = null;
      pdfFitIdentityRef.current = undefined;
      onPdfBackgroundFrameChangeRef.current?.(null);

      return;
    }

    const container = containerRef.current;
    const fit = resolveFrozenPdfFit({
      container: { height: container?.clientHeight ?? 0, width: container?.clientWidth ?? 0 },
      record: pdfFrameRecordRef.current,
    });

    if (fit) {
      pdfFitSizeRef.current = fit;
      pdfFitIdentityRef.current = pdfPageIdentity;
    }

    // Publish the frame as soon as it is frozen (raster still loading) so a snapshot can already pin
    // the page to it; the load effect below adds the raster size when it lands. Nothing is published
    // for a page whose fit could not be frozen (0-sized container, no record).
    onPdfBackgroundFrameChangeRef.current?.(
      fit && pdfPageIdentity ? { fitHeight: fit.height, fitWidth: fit.width, image: null, pageId: pdfPageIdentity } : null,
    );
  }, [containerRef, hasPdfPageBackground, pdfPageIdentity]);

  useEffect(() => {
    // !hasPdfPageBackground: on a switch TO a non-PDF page, `pdfPageImageUrl` still holds the
    // OUTGOING page's URL for a commit (the owner's usePdfPageImage clears it one commit later),
    // and the identity-keyed re-run below would reload it. That cached load can win the race
    // against the cleared-URL commit (loadPage's async Fabric work yields the event loop) and
    // stamp the LAST OPENED PDF page onto the blank page — the "insert a blank page mid-PDF"
    // ghost. hasPdfPageBackground comes from the current page synchronously, so gating here
    // means the stale load is never even issued. setPdfPageImage(null) (not just the loading
    // flag) makes state converge even if a raced load already committed a stale image.
    if (!pdfPageImageUrl || !hasPdfPageBackground) {
      setPdfPageImage(null);
      setIsPdfImageLoading(false);
      onPdfBackgroundFrameChangeRef.current?.(null);

      return;
    }

    let isActive = true;

    setIsPdfImageLoading(true);

    // ONE fetch + ONE decode per raster. This used to be a hand-rolled `new Image()` with
    // crossOrigin='anonymous' — and usePdfPageImage had ALREADY loaded this exact URL moments
    // earlier into its own verification image WITHOUT crossOrigin, which is a different Chromium
    // image-cache key, so the two loads could never share anything. WebView2 does not HTTP-cache
    // the pdfpage:// protocol either (WebView2Feedback#4687), so both loads went all the way to
    // Rust and each decoded ~37 MB of RGBA (2546x3600 at the default `high` quality) on the main
    // thread the teacher is writing on. `loadPdfPageImage` keeps the crossOrigin consistent and
    // hands back the already-decoded element the hook just verified.
    void loadPdfPageImage(pdfPageImageUrl).then((img) => {
      if (!isActive) return;

      if (!img) {
        setPdfPageImage(null);
        setIsPdfImageLoading(false);
        onPdfBackgroundFrameChangeRef.current?.(null);

        return;
      }

      setPdfPageImage(img);
      setIsPdfImageLoading(false);

      // Publish the frame the painter will draw this raster against: the fit frozen when the page
      // opened (the freeze effect above runs before this one in the same commit, so it is current)
      // plus the raster's own size. A fit that was frozen for a DIFFERENT page (the page opened
      // inside a 0-sized container and the ref kept its last value) is not this page's frame — the
      // painter still falls back to it, but nothing is published and the record stays as it was.
      const fit = pdfFitIdentityRef.current === pdfPageIdentity ? pdfFitSizeRef.current : null;
      const imageWidth = img.naturalWidth || img.width;
      const imageHeight = img.naturalHeight || img.height;

      onPdfBackgroundFrameChangeRef.current?.(
        fit && pdfPageIdentity
          ? {
              fitHeight: fit.height,
              fitWidth: fit.width,
              image: imageWidth > 0 && imageHeight > 0 ? { height: imageHeight, width: imageWidth } : null,
              pageId: pdfPageIdentity,
            }
          : null,
      );
    });

    return () => {
      isActive = false;
    };
    // pdfPageIdentity is a DELIBERATE extra dep: the effect above clears the image on every page
    // switch (anti-ghosting), and this effect is what brings it back. Keying the reload on the URL
    // alone deadlocked OLF-imported boards — their pages share ONE identical template data URL, so
    // a page switch cleared the image and the unchanged URL never re-triggered the load → every
    // page after the first rendered blank (live-repro'd). A same-URL reload costs one memory-cache
    // decode; native pages have per-page URLs and are unaffected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfPageImageUrl, pdfPageIdentity, hasPdfPageBackground]);

  const shouldShowPdfLoadingOverlay = hasPdfPageBackground && !pdfPageImage && (isPdfPageLoading || isPdfImageLoading);

  useEffect(() => {
    if (!shouldShowPdfLoadingOverlay) {
      setIsPdfLoadingOverlayVisible(false);
      return;
    }

    // Only surface the loading indicator if the page image is genuinely slow to appear. Prefetched
    // / cached pages resolve well under this, so flipping through a prefetched window shows no flash
    // (the spinner flashing on fast loads is what made switching *feel* slow).
    const timeout = window.setTimeout(() => {
      setIsPdfLoadingOverlayVisible(true);
    }, 400);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [shouldShowPdfLoadingOverlay]);

  useEffect(() => {
    if (!backgroundImageUrl) {
      setBackgroundImage(null);

      return;
    }

    let isActive = true;
    const img = new Image();

    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      if (!isActive) return;

      setBackgroundImage(img);
    };
    img.onerror = () => {
      if (!isActive) return;

      setBackgroundImage(null);
    };
    img.src = backgroundImageUrl;

    return () => {
      isActive = false;
    };
  }, [backgroundImageUrl]);

  useEffect(() => {
    const indicator = cursorIndicatorRef.current;

    if (!indicator) {
      return;
    }

    if (!shouldShowIndicator) {
      indicator.style.opacity = '0';

      return;
    }

    // The opacity is written only when the cursor MOVES; a tool swap with the pen still (the S Pen
    // erase-hold restoring the nib) left the eraser's opaque '1' on the small ink-coloured nib cursor — a
    // solid dot where the erase ended. Re-derive it for the new tool.
    if (indicator.style.opacity !== '' && indicator.style.opacity !== '0') {
      indicator.style.opacity =
        effectiveTool === 'highlighter' ? '0.35' : isPenFamilyTool(effectiveTool) ? '0.22' : '1';
    }
  }, [effectiveTool, shouldShowIndicator]);

  useEffect(() => {
    return () => {
      if (indicatorFrameRef.current !== null) {
        window.cancelAnimationFrame(indicatorFrameRef.current);
        indicatorFrameRef.current = null;
      }

      if (indicatorIdleTimerRef.current !== null) {
        window.clearTimeout(indicatorIdleTimerRef.current);
        indicatorIdleTimerRef.current = null;
      }

      pendingIndicatorStateRef.current = null;
    };
  }, []);

  // Repaint whenever the image STATE changes (PDF loads, or clears to null on a blank page).
  // updateBackgroundLayers reads the images from refs, so these deps drive the redraw timing while the
  // ref read guarantees a stale-scheduled redraw still paints the current image.
  useEffect(() => {
    updateBackgroundLayers();
  }, [backgroundImage, pdfPageImage, updateBackgroundLayers]);

  // The previous page's pre-scaled copy is dead weight (~20 MB) the moment its image is gone.
  useEffect(() => {
    const cached = scaledRasterRef.current;

    if (cached && (!pdfPageImage || cached.imageIdentity !== getImageIdentity(pdfPageImage))) {
      cached.bitmap.close();
      scaledRasterRef.current = null;
    }
  }, [pdfPageImage]);

  // Repaint when the page's background rotation changes. Goes through the SAME rAF + settle scheduler
  // the pan/zoom path uses because a rotation slider emits a change per degree: the drag stays on one
  // cheap 'low' redraw per frame and only re-crisps to 'high' once the teacher lets go.
  useEffect(() => {
    scheduleBackgroundRedraw('content');
  }, [pdfRotationDeg, scheduleBackgroundRedraw]);

  const invalidateBackdrop = backdrop.invalidate;

  // Dark board: the paper and every on-screen paint of the ink follow the theme; storage and exports
  // never do (utils/darkBoard). A toggle repaints the paper, the overscan backdrop and the ink (bake
  // dropped, object caches re-rendered for the new theme on their next paint).
  useEffect(() => {
    if (!canvas) return;
    registerDarkBoardSurface(canvas.getElement());
    registerDarkBoardSurface(canvas.upperCanvasEl);
    setBoardTheme(boardTheme);
    invalidateInkBake(canvas);
    canvas.clearContext(canvas.contextTop);
    canvas.requestRenderAll();
    scheduleBackgroundRedraw('content');
    invalidateBackdrop();
  }, [boardTheme, canvas, invalidateBackdrop, scheduleBackgroundRedraw]);

  useEffect(() => () => setBoardTheme('light'), []);

  useEffect(() => {
    if (!canvas) {
      viewportSignatureRef.current = '';

      return;
    }

    const handleAfterRender = () => {
      const nextSignature = getViewportSignature();

      if (nextSignature === viewportSignatureRef.current) {
        return;
      }

      viewportSignatureRef.current = nextSignature;
      // Viewport changed (pan/zoom) — redraw cheaply this frame, crisp on settle.
      scheduleBackgroundRedraw();
    };

    // Stroke bounds for the redraw policy. Fabric fires mouse:down/up for every pointer; only a
    // pen-down while the canvas is in drawing mode counts, and a pan/eraser override (which flips
    // isDrawingMode off) releases it on its own — see isStrokeInProgress.
    const handleMouseDown = () => {
      strokeDownAtRef.current = canvas.isDrawingMode ? Date.now() : null;
    };
    const handleMouseUp = () => {
      strokeDownAtRef.current = null;

      if (deferredCrispRedrawRef.current) {
        deferredCrispRedrawRef.current = false;
        updateBackgroundLayers('high');
      }
    };

    viewportSignatureRef.current = getViewportSignature();
    canvas.on('after:render', handleAfterRender);
    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:up', handleMouseUp);
    // Pin/unpin, a page load carrying pinned images, and an undo/redo restore all change the pinned
    // set WITHOUT moving the viewport, so after:render's signature diff never fires for them — this is
    // the only thing that repaints the background for them.
    const unsubscribeLockedImages = onLockedImagesChanged(canvas, () => scheduleBackgroundRedraw('content'));

    updateBackgroundLayers();

    return () => {
      canvas.off('after:render', handleAfterRender);
      canvas.off('mouse:down', handleMouseDown);
      canvas.off('mouse:up', handleMouseUp);
      strokeDownAtRef.current = null;
      deferredCrispRedrawRef.current = false;
      unsubscribeLockedImages();
    };
  }, [canvas, getViewportSignature, scheduleBackgroundRedraw, updateBackgroundLayers]);

  // Redraw background on container resize
  useEffect(() => {
    const container = containerRef.current;

    if (!container) return;

    const resizeObserver = new ResizeObserver(() => {
      updateContainerBounds();
      updateBackgroundLayers();
    });

    updateContainerBounds();
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [updateBackgroundLayers, updateContainerBounds]);

  // --- Keyboard shortcuts (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z) ---
  // Calls onUndo/onRedo directly via refs for stable references.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input or textarea
      const tag = (e.target as HTMLElement)?.tagName;

      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const isCtrl = e.ctrlKey || e.metaKey;

      if (isCtrl && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        onUndoRef.current?.();
      }

      if (isCtrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        onRedoRef.current?.();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Input self-heal diagnostic overlay: poll the snapshot the hook publishes and paint it. A cheap
  // 150ms interval (only while enabled) is plenty for a human-readable readout and, unlike the PDF
  // overlay's after:render path, keeps ticking even when nothing is drawing (so a stuck/recovered
  // state is visible at rest). `recovered` climbing + `override t` dropping to null proves the fix.
  useEffect(() => {
    if (!inputDebugEnabled) {
      return;
    }

    const yesNo = (value: unknown) => (value ? 'y' : 'n');
    const render = () => {
      const el = inputDebugRef.current;

      if (!el) {
        return;
      }

      const debug = (window as unknown as { __wbInputDebug?: Record<string, unknown> }).__wbInputDebug;

      if (!debug) {
        el.textContent = `INPUT js=${PDF_DEBUG_JS_BUILD}  (waiting for input…)`;

        return;
      }

      el.textContent = [
        `INPUT js=${PDF_DEBUG_JS_BUILD}  draw=${debug.isDrawingMode}  eff=${debug.effTool}`,
        `override t=${debug.touchOverride} k=${debug.keyboardOverride}`,
        `panMode=${debug.touchPanMode}  actPtrs=${debug.activePtrs}  actPen=${debug.activePen}  multiLock=${debug.multiLock}  palmMs=${debug.penPalmMs}`,
        `recovered=${debug.recovered}  lastEvent=${debug.lastEvent}  seenPen=${yesNo(debug.hasSeenRealPen)}`,
        `touchMode=${debug.touchInputMode}  routedAsPen=${yesNo(debug.routedAsPen)}`,
      ].join('\n');
    };

    render();
    const intervalId = window.setInterval(render, 150);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [inputDebugEnabled]);

  const cursorClass = getCursorClass(effectiveTool);

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full flex-1 touch-none overflow-hidden bg-white ${cursorClass}`}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (!shouldShowIndicator) return;

        const bounds = containerBoundsRef.current ?? updateContainerBounds();

        if (!bounds) {
          return;
        }

        scheduleCursorIndicatorUpdate({
          visible: true,
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        });
      }}
      onPointerEnter={(event) => {
        if (!shouldShowIndicator) return;

        const bounds = containerBoundsRef.current ?? updateContainerBounds();

        if (!bounds) {
          return;
        }

        scheduleCursorIndicatorUpdate({
          visible: true,
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        });
      }}
      onPointerUp={(event) => {
        // A finger has no hover: once it lifts there is nothing left to point at.
        if (event.pointerType === 'touch') scheduleCursorIndicatorUpdate({ visible: false, x: 0, y: 0 });
      }}
      onPointerLeave={() => {
        scheduleCursorIndicatorUpdate({
          visible: false,
          x: 0,
          y: 0,
        });
      }}
      onPointerMove={(event) => {
        if (!shouldShowIndicator) return;

        const bounds = containerBoundsRef.current ?? updateContainerBounds();

        if (!bounds) {
          return;
        }

        scheduleCursorIndicatorUpdate({
          visible: true,
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        });
      }}
    >
      {/* Zoom/pan preview layer: the SCENE-anchored canvas layers (background pattern/PDF + the Fabric ink
          canvas) live inside ONE wrapper so an active pan/zoom gesture can be previewed with a single
          GPU-composited CSS transform (no per-frame canvas re-rasterization — see the hook's zoom-preview
          commit), then snapped crisp on settle. The overlay is screen-fixed, so it stays OUTSIDE. */}
      <div ref={zoomLayerRef} className='absolute inset-0 origin-top-left'>
        {/* Overscan backdrop: a low-res, blurred copy of the board around (and under) the viewport, so
            what a pan/pinch/fling drags into view shows the real content softly instead of blank white
            until the gesture commits. Behind both crisp layers — the opaque background canvas hides it
            inside the viewport. Sized/positioned/shown imperatively by useOverscanBackdrop. */}
        <canvas
          ref={backdropCanvasRef}
          aria-hidden='true'
          className='pointer-events-none invisible absolute left-0 top-0 origin-top-left touch-none'
          draggable={false}
        />
        {/* …and its ink, on a layer of its own so an erase can wipe it on the spot (see the hook). */}
        <canvas
          ref={backdropInkCanvasRef}
          aria-hidden='true'
          className='pointer-events-none invisible absolute left-0 top-0 origin-top-left touch-none'
          draggable={false}
        />

        {/* Background pattern layer */}
        <canvas ref={bgCanvasRef} className='pointer-events-none absolute inset-0 h-full w-full touch-none' draggable={false} />

        {/* Fabric.js canvas layer */}
        <canvas ref={canvasRef} className='absolute inset-0 touch-none' draggable={false} />
      </div>

      {/* Shared background image overlay layer — screen-fixed (drawn in screen space, not scene space), so
          it must NOT live in the transformed zoom layer or it would scale/snap during a gesture. */}
      <canvas ref={overlayCanvasRef} className='pointer-events-none absolute inset-0 h-full w-full touch-none' draggable={false} />

      {/* PDF sharpness diagnostic overlay (only when whiteboard-debug-pdf='1'). Reads a screenshot's
          worth of numbers so a soft PDF can be pinpointed to source-raster size vs canvas backing. */}
      {pdfDebugEnabled ? (
        <pre
          ref={pdfDebugRef}
          className='pointer-events-none absolute left-1 top-1 z-30 m-0 whitespace-pre rounded bg-black/75 px-2 py-1.5 font-mono text-xs leading-4 text-lime-300'
          dir='ltr'
        />
      ) : null}

      {/* Input self-heal diagnostic overlay (only when whiteboard-debug-input='1'). Upper-left, next to
          the Perf HUD panel, so neither covers the page switcher in the bottom-left corner. Shows the live tool/override/pointer state + the
          reaper's recovery count, so an on-device screenshot proves the stranded-touch-state fix fired. */}
      {inputDebugEnabled ? (
        <pre
          ref={inputDebugRef}
          className='pointer-events-none absolute left-[440px] top-[140px] z-30 m-0 whitespace-pre rounded bg-black/75 px-2 py-1.5 font-mono text-xs leading-4 text-sky-300'
          dir='ltr'
        />
      ) : null}

      {isPdfLoadingOverlayVisible ? (
        <div className='pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6'>
          <div className='rounded-sk-lg border-sk border-ink bg-paper text-ink shadow-sk-xl flex max-w-xs items-center gap-3 px-5 py-4 text-start'>
            <div className='border-ink/20 border-t-sk-blue h-5 w-5 shrink-0 animate-spin rounded-full border-2' />
            <div>
              <p className='text-ink text-sm font-semibold'>{t('canvas.preparingPdf')}</p>
              <p className='text-ink/65 mt-1 text-xs leading-5'>{t('canvas.preparingPdfHint')}</p>
            </div>
          </div>
        </div>
      ) : null}

      {isWholeHandEraserActive && (
        <div className='border-sk border-citrine bg-ink text-paper shadow-sk pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-sm px-3 py-1.5 text-xs font-semibold'>
          {t('canvas.palmActive')}
        </div>
      )}

      {/* Whole-hand (palm) eraser cursor — a circle covering the contacts, positioned + sized by the
          hook via its ref. Always mounted (hidden) so the ref exists before the first erase frame. */}
      <div
        ref={wholeHandEraserCursorRef}
        aria-hidden
        className='border-citrine bg-citrine/10 pointer-events-none absolute left-0 top-0 z-20 rounded-full border-2 border-dashed will-change-transform'
        style={{ display: 'none' }}
      />

      {shouldShowIndicator && (
        <div
          ref={cursorIndicatorRef}
          className='pointer-events-none absolute z-20 rounded-full will-change-transform'
          style={{
            width: indicatorSize,
            height: indicatorSize,
            left: 0,
            top: 0,
            opacity: 0,
            borderWidth: effectiveTool === 'pen' ? 1.5 : 2,
            transform: 'translate3d(-9999px, -9999px, 0)',
            ...indicatorStyle,
          }}
        >
          {effectiveTool === 'pen' && (
            <span
              className='absolute left-1/2 top-1/2 rounded-full'
              style={{
                width: Math.max(strokeSettings.width, 4),
                height: Math.max(strokeSettings.width, 4),
                backgroundColor: strokeSettings.color,
                transform: 'translate(-50%, -50%)',
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
