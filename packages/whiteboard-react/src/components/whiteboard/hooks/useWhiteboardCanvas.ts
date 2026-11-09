import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Canvas,
  Circle,
  Ellipse,
  FabricImage,
  FabricObject,
  Group,
  Line,
  Path,
  PencilBrush,
  Point,
  Rect,
  Shadow,
  Textbox,
  Triangle,
} from 'fabric';

import type { TPointerEvent, TPointerEventInfo } from 'fabric';
import type { RulerEdgesRef } from '../brushes/rulerSnap';

import type {
  CapturedContact,
  ContactState,
  EraserMode,
  StrokeSettings,
  TabletInputSettings,
  WhiteboardTool,
} from '../types';
import {
  computeWholeHandEraserCircle,
  CONTACT_SETTLE_MS,
  ContactRecorder,
  scoreContactPriority,
  createContactState,
  DEFAULT_TABLET_INPUT_SETTINGS,
  isPenFamilyTool,
  isPenTwinTouchStart,
  resolveHeadColourRole,
  STICKY_COLORS,
  updateContactState,
} from '../types';
import { CalligraphyBrush } from '../brushes/CalligraphyBrush';
import {
  selectCoalescedSamples,
  splitPenFrame,
  type PenContactPressureState,
  type PenSampleVerdict,
} from '../brushes/coalesced-samples';
import { LowLatencyPencilBrush } from '../brushes/LowLatencyPencilBrush';
import { RulerSnapInterceptor } from '../brushes/rulerSnap';
import { ScriptBrush } from '../brushes/ScriptBrush';
import { dashArrayFor, installSnappedShapeSupport, ShapeSnapController } from '../brushes/shapeSnap';
import { SOFT_MARKER_OPACITY, SOFT_MARKER_WIDTH_SCALE, SoftMarkerBrush } from '../brushes/SoftMarkerBrush';
import { isHoverWithoutContact } from '../utils/hoverContact';
import { createStrokeInkContrast, type StrokeInkContrast } from '../utils/inkContrast';
import { installInkBake, snapPanStep, type InkBakeHandle } from '../utils/inkBake';
import { applyInkCachePolicy } from '../utils/inkCachePolicy';
import { isInputTraceEnabled, refreshInputTraceEnabled, traceInput } from '../utils/inputTrace';
import {
  estimateReleaseVelocity,
  FLING_RELEASE_DEFAULTS,
  FLING_TAU_MS,
  pushPanSample,
  stepFling,
  type PanSample,
  type Velocity,
} from '../utils/flingPhysics';
import { penOffsetToCanvasDelta } from '../utils/penPointerOffset';
import {
  createPenButtonDispatcher,
  detectPenSignalEdges,
  hasPenButtonBindings,
  NATIVE_PEN_EVENT,
  PEN_BUTTON_MAP_CHANGED_EVENT,
  PEN_BUTTON_MAP_STORAGE_KEY,
  readPenButtonMap,
  boardAiCommandForPenAction,
  withDefaultStylusBinding,
  type PenButtonAction,
  type PenButtonBinding,
  type PenButtonDispatchEvent,
  type PenSignal,
} from '../utils/penButtonMap';
import { requestBoardAiCommand } from '../ai/commands';
import {
  PEN_BUTTON_GESTURE_IDLE,
  stepPenButtonGesture,
  type PenButtonGestureInput,
  type PenButtonGestureState,
} from '../utils/penButtonGesture';
import { createNativeMoveRateMeter, recordPenNativeTrace } from '../utils/penNativeTrace';
import { perfSpan } from '../utils/perfSpan';
import { restoreRenderInvariants } from '../utils/restoreRenderInvariants';
import {
  applyImageLockState,
  enforceLockedImageInvariants,
  getLockedImages,
  isLockedImage,
  notifyLockedImagesChanged,
  registerLockedImagePersistence,
} from '../utils/lockedImages';
import { noteExternalContact } from '../utils/inputActivity';
import { createObjectEraseIndex } from '../utils/objectEraseIndex';
import { capsulesBBox, collectSweepHits, sweepCapsules } from '../utils/objectEraseSweep';
import { installGeometryTargetFind } from '../utils/selectionHitTest';
import { installStrokeScaleBake } from '../utils/strokeScaleBake';
import { serializeCanvasJson } from '../utils/canvasJson';
import { installItemIds } from '../utils/itemIds';
import { applyShapeStyle, installShapeStylePaint, isClosedShape, newShapeOptions } from '../utils/shapeStylePaint';
import { roundCornerRadius } from '../utils/shapeStyle';
import type { ShapeStyleSettings } from '../utils/shapeStyle';
import {
  clampPanDelta,
  clampViewportTransform,
  clampZoom,
  isSameViewportTransform,
  type ViewportConstraints,
} from '../utils/viewportConstraints';
import { createPanAxisLock, filterPanDelta, type PanAxisLockState } from '../utils/panAxisLock';
import { eraserSceneDiameter, eraserSceneRadius } from '../utils/eraserGeometry';
import { objectHitsEraser } from '../utils/eraserHitTest';

// Must run before the first `toJSON()` of the session: fabric only serializes whitelisted props, so
// without this every save AND every undo snapshot silently drops the pin flag.
registerLockedImagePersistence();

/**
 * Persisted per-device flag: this machine has a real stylus (a `pointerType==='pen'` event was seen,
 * incl. hover, on this or a prior session). This is the "PEN DEVICE" signal that drives the deterministic
 * touch model: on a pen device a single finger PANS (the pen draws), on a touch-only panel (ViewSonic —
 * its capacitive pen reports as 'touch', so this stays false forever) a single finger DRAWS.
 */
const HAS_SEEN_PEN_STORAGE_KEY = 'whiteboard-has-seen-pen';

function readPersistedHasSeenPen(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(HAS_SEEN_PEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistHasSeenPen(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(HAS_SEEN_PEN_STORAGE_KEY, '1');
  } catch {
    // Best-effort; the in-session ref still blocks finger drawing this run.
  }
}

// An active whole-hand (palm) eraser pass. `size` is the erase diameter for this pass.
type WholeHandEraserSession = {
  size: number;
  /** true = real palm (touch): the destination-out brush is driven MANUALLY at the CENTROID of all
   *  contacts (sized to span them), so Fabric's own drawing stays off (else the palm's many contacts
   *  double-drive it). Always true for the touch trigger; the field is kept for the settings shape. */
  manual: boolean;
  /** Whether a destination-out erase stroke is currently open on the brush. */
  strokeActive: boolean;
  /** The erase circle's on-screen diameter (screen px) when the currently-open segment was started.
   *  A new segment is split off only once the live diameter drifts more than the re-segment epsilon
   *  AWAY from this base — so jitter oscillating around a steady spread never churns out segments, and
   *  a committed segment is never retroactively widened by more than the epsilon. Tracked in SCREEN px
   *  (not scene px) so the threshold behaves the same at every zoom level. */
  segmentBaseScreenSize: number;
};

export interface UseWhiteboardCanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Wrapper around all canvas layers. A live pan/zoom gesture is previewed by CSS-transforming THIS
   *  element (GPU-composited, no per-frame canvas re-raster), then committed to Fabric on settle. */
  zoomLayerRef?: React.RefObject<HTMLDivElement | null>;
  /** Optional cursor element the whole-hand (palm) eraser positions + sizes to show its erase area. */
  wholeHandEraserCursorRef?: React.RefObject<HTMLDivElement | null>;
  activeTool: WhiteboardTool;
  strokeSettings: StrokeSettings;
  eraserMode: EraserMode;
  eraserSize: number;
  tabletInputSettings?: TabletInputSettings;
  fillColor: string;
  /** The shape panel's settings for new shapes (outline, background, pattern, …). Absent = the pen's colour and width with `fillColor`. */
  shapeStyle?: ShapeStyleSettings;
  /** When true, two-finger gestures pan only — zoom in/out is blocked. Also enables two-finger pan
   *  in pen mode (where two fingers are otherwise reserved for zoom). */
  zoomLocked?: boolean;
  /** Whether the current page has a PDF/image background. Resize handling differs by page type:
   *  blank pages recenter the viewport so content does not jump to the corner; PDF pages refit a
   *  frozen scene rect (see {@link pdfFitSizeRef}) so the page and its ink scale together. */
  hasPdfPageBackground?: boolean;
  /** Canvas size captured when the current PDF page opened. The PDF background is pinned to the
   *  scene rect this size implies, so on resize we refit that rect into the new canvas (scaling +
   *  centering PDF and ink as one) instead of letting the background re-fit and drift off the ink. */
  pdfFitSizeRef?: { current: { width: number; height: number } | null };
  /**
   * Optional cage for the viewport (see utils/viewportConstraints). While `.current` is set, every
   * viewport write — pinch/wheel zoom, finger/hand pan, fling, toolbar zoom, the resize refit — is
   * clamped into it: zoom never drops below its `minZoom` (the page's fit-width zoom) and panning
   * never shows past its scene rect. A ref, not a value: the owner updates it on layout changes
   * without re-registering any gesture handler. `null` = the unconstrained board as before.
   */
  viewportConstraintsRef?: React.RefObject<ViewportConstraints | null>;
  /**
   * While `.current` is true a touch PAN is applied to Fabric every frame instead of being previewed
   * as a CSS translate and committed on settle. The continuous PDF layout needs the real viewport to
   * move: pages scrolling into view have to be painted as they arrive, which the preview (a translated
   * snapshot of what was already on screen) cannot do. Pinch zoom keeps the preview.
   */
  directTouchPanRef?: React.RefObject<boolean>;
  /** The host's on-screen ruler edges (client px); a stroke drawn along one commits straight (`brushes/rulerSnap.ts`). */
  rulerEdgesRef?: RulerEdgesRef;
  /**
   * Lock each finger pan to the axis its first few px went along (utils/panAxisLock): a mostly
   * vertical scroll never drifts sideways. Touch pans and their flings only; pen, hand tool and
   * zoom are untouched. Read live.
   */
  panAxisLock?: boolean;
  onCanvasReady?: (canvas: Canvas) => void;
  onObjectModified?: () => void;
  onShortcutColorCycle?: () => void;
  /** Binary primary<->secondary color swap, fired once per physical pen COLOR-button press. */
  onShortcutColorToggle?: () => void;
  onShortcutToolToggle?: () => void;
  /**
   * A pen button bound to «Open pen shortcuts» (by default: the S Pen button pressed while hovering).
   * `anchor` is the pen's position as a fraction of the board container — a TRANSIENT spot for the
   * menu, never the saved trigger anchor. Absent = the menu's usual place.
   */
  onShortcutQuickMenu?: (anchor?: { x: number; y: number }) => void;
  /** A LEARNED pen button bound to «Undo». */
  onShortcutUndo?: () => void;
  /**
   * The pen's position (client px) while a NATIVE-driven contact is erasing — a stylus that landed with
   * its button held, which the WebView reports no pointer events for. The owner moves its cursor
   * indicator from this; its DOM pointer listeners never fire during such a contact. `null` = hide it:
   * the contact ended (or the pen left) and no DOM hover will arrive to move or hide it.
   */
  onNativePenPoint?: (point: { x: number; y: number } | null) => void;
  /** Called synchronously when a zoom/pan gesture preview is committed, so the owner can re-rasterize
   *  the separate background/PDF/overlay canvases in the SAME frame as the ink (no 1-frame flash). */
  onViewportCommit?: () => void;
  /** Called with the committed canvas zoom whenever a pinch/wheel gesture actually CHANGES the zoom
   *  (fired from commitZoomPreview against the live canvas zoom, so it never diverges and has no
   *  React-state equality bail-out). The owner uses it to re-rasterize the PDF page at the new zoom. */
  onZoomCommit?: (zoom: number) => void;
  /** Called with the LIVE container size on init and whenever the ResizeObserver fires. The Fabric
   *  canvas is resized imperatively (setDimensions, no setState), so without this the owner's
   *  `fabricCanvas.getWidth()` stays frozen at the small pre-layout value it had on the last React
   *  render — which then sizes the PDF raster too small and the display upscales it (soft PDF). The
   *  owner stores this size in state and feeds it to the PDF renderer so the raster matches the display. */
  onCanvasResize?: (size: { width: number; height: number }) => void;
  /** Receives every finished touch contact — its frames plus what the classifier decided about it —
   *  for the training capture. Omitted (the default) means nothing is recorded at all. */
  onContactCaptured?: (contact: CapturedContact) => void;
  /**
   * Smart ink contrast (utils/inkContrast): the luminance (0–1) of what the owner paints UNDER the ink
   * at scene point (`x`, `y`) — the page's paper, a PDF raster, a pinned image — or null when it cannot
   * be known. Called once per pen/brush/marker stroke, at pen-down, while the setting is on; the owner
   * is expected to answer a plain page without touching a pixel. Omitted = the stroke is never adjusted.
   */
  sampleBackgroundLuminance?: (canvas: Canvas, x: number, y: number) => number | null;
}

export interface UseWhiteboardCanvasReturn {
  canvas: Canvas | null;
  effectiveTool: WhiteboardTool;
  /** True while a whole-hand (palm) eraser pass is live. Drives the on-screen badge + suppresses the
   *  small single-point cursor (the pass shows its own big circle instead). */
  isWholeHandEraserActive: boolean;
  zoom: number;
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  deleteSelected: () => void;
  clearCanvas: () => void;
  getCanvasJSON: () => string;
  loadCanvasJSON: (json: string) => Promise<void>;
  getThumbnail: () => string;
  addImageToCanvas: (url: string) => Promise<void>;
  /** Pins ("locks") an image so no tool can touch it and the background layer paints it, or unpins it. */
  setImageLockState: (target: FabricObject, locked: boolean) => void;
  setBackgroundImage: (url: string) => Promise<void>;
  triggerImageUpload: () => void;
  addStickyNote: (x: number, y: number, color?: string) => void;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4.0;
const ZOOM_STEP = 0.1;
// How long after the last zoom/pan input the CSS preview is committed to Fabric (re-rasterized crisp).
// Short enough to feel instant on release; long enough that a continuous scroll/pinch stays one preview.
const ZOOM_COMMIT_DELAY_MS = 90;
// Hard cap on simultaneous touch contacts the PAN/ZOOM gesture logic reacts to. Extra contacts
// beyond this (resting palm, stray fingers) are ignored by the gesture machinery.
const MAX_SIMULTANEOUS_TOUCHES = 2;
const MULTI_TOUCH_PAN_ACTIVATION_DISTANCE = 18;
// A two-finger gesture commits to EITHER pan OR zoom (never both at once). These thresholds
// classify intent at gesture start: pan once the midpoint travels this many px, zoom once the
// finger spread changes by this fraction. Pan is biased to win ties (it is the common gesture
// and the one that must never accidentally zoom). Tuned up for large touchscreens, where a small
// 8–12px wobble would otherwise read as deliberate pan/zoom (noise). Lower per-device via the
// touch pan/zoom tolerance slider if a smaller panel feels sluggish.
const MULTI_TOUCH_ZOOM_ACTIVATION_DELTA = 0.06;
// Once locked to pan, a clearly deliberate pinch (this much spread change vs the gesture-start
// span) re-arms zoom mode mid-gesture.
const MULTI_TOUCH_ZOOM_REARM_DELTA = 0.14;
const MULTI_TOUCH_PAN_FRAME_DEADZONE = 0.5;
// Two-finger zoom distance smoothing. Touch pointers fire one finger at a time, so the measured
// inter-finger distance carries temporal-skew jitter (one fresh sample, one stale) even when the
// real finger gap is constant — which, mapped straight to zoom, makes the canvas oscillate in/out.
// A 1€ (One-Euro) adaptive low-pass filter smooths the distance: heavy smoothing at low velocity
// (kills jitter on a near-still gap), light smoothing at high velocity (a deliberate pinch stays
// responsive). See Casiez et al., "1€ Filter" (CHI 2012).
const ZOOM_DISTANCE_1E_MINCUTOFF = 0.5; // Cutoff (Hz) at rest; lower = more smoothing of jitter.
const ZOOM_DISTANCE_1E_BETA = 0.1; // Velocity coupling; higher = more responsive to fast pinches.
const ZOOM_DISTANCE_1E_DCUTOFF = 1.0; // Derivative cutoff (Hz); damps the velocity estimate itself.
const ZOOM_DISTANCE_1E_DISCONTINUITY_S = 0.5; // dt above this = dropped events / pause → reset filter.
// Hysteresis deadband (CSS px) on the smoothed distance. Residual jitter on a large high-DPI
// touchscreen sits around ~2-3px even after low-pass filtering; holding the applied distance until
// it moves beyond this band guarantees a constant finger gap produces EXACTLY zero zoom drift, then
// tracks while trailing by the band width (no jump). Raise if a noisier panel still breathes.
const ZOOM_DISTANCE_DEADBAND_PX = 3;
// Single-finger PAN (pen device): a lone finger begins panning only once it drags past this distance,
// so a resting/jittering palm that slipped the pen-palm time window still won't pan until it deliberately
// moves.
const SINGLE_TOUCH_PAN_ACTIVATION_DISTANCE = 10;
const HIGHLIGHTER_OPACITY = 0.22;
// Single-finger pan on a TOUCH-ONLY device: the finger tentatively DRAWS through Fabric until the pan
// activates, so the few px of tentative ink must be discarded. When a touch pan starts we open this brief
// window; any small freehand path Fabric commits inside it (the interrupted tentative stroke) is removed
// in the path:created handler. Scoped to touch-only devices — on a pen device a finger never inks.
const TOUCH_PAN_ARTIFACT_SUPPRESS_WINDOW_MS = 180;
// Dual-tip stylus (touch-only device): how long a contact keeps refining which head it is before the
// stroke colour is locked. The first frames of a contact are the least trustworthy — the tip rolls onto
// the glass and a tilted head briefly reports a fatter patch than it really is — so the head is decided
// from the smallest footprint seen across this window rather than from the touch-down frame alone.
// The value is CONTACT_SETTLE_MS in whiteboard-core, refitted there from a labelled capture whenever the
// teacher's pen changes; a local copy is what let the live board and the replay harness disagree.
// The freehand tools whose stroke colour the dual-tip pen's heads may switch: the pen family plus the
// highlighter, all of which draw from the pen's colour settings.
const isDualTipColouredTool = (tool: WhiteboardTool): boolean => isPenFamilyTool(tool) || tool === 'highlighter';
// PALM GUARD window. On a PEN DEVICE the hand/palm rests on the glass while the pen tip is OFF it
// (hovering between strokes), so `activePen === 0` for those palm 'touch' events — contact SIZE can't
// tell a palm from an intentional finger (both report the panel's fixed footprint). A time window keyed
// to the last PEN activity (down/move/hover/up, refreshed even on hover) is what actually rejects the
// palm: any touch within this window of recent pen activity is treated as an accidental palm and ignored.
const PEN_PALM_REJECT_MS = 400;
// On a pen device the pen inks THROUGH Fabric's raw touch stream, so the Fabric-touch guard must let the
// pen's OWN contact reach Fabric while starving every finger/palm touch. The twin is identified
// POSITIVELY (isPenTwinTouchStart): a touchstart contact is the pen's twin iff a 'pen' pointerdown is
// still down, landed within this window, and landed this close to it. Blink dispatches the pointerdown
// before the matching touchstart in the same task, so the window only absorbs clock granularity and the
// distance only the panel's own jitter between the two reports; both stay far below what a second
// contact (a finger landing next to the tip mid-stroke) would need. No radius, no proximity-to-live-pen
// guessing: the Samsung tablet reported palm contacts with tip-sized radii, which the old heuristic
// passed as the pen — dots where the hand rests, and straight lines when a palm touchstart RESET
// Fabric's open path to the palm's position (PencilBrush.onMouseDown starts over) and the next pen
// move drew from there.
const PEN_TWIN_START_WINDOW_MS = 150;
const PEN_TWIN_START_DISTANCE_PX = 24;
const STYLUS_TILT_OFFSET_MIN_ANGLE = 1;
// Constant upward calibration (CSS px) applied to drawing input so ink lands at the nib
// rather than slightly below it. Positive = lift the drawn point up. Applies to any drawing
// contact (real stylus and pen-reported-as-touch).
const PEN_VERTICAL_DRAW_OFFSET_PX: number = 2;
// --- Stranded-touch-state self-heal watchdog ---
// The transient TOUCH state (touchOverrideToolRef='pan', touchPanModeRef, the tracked pointer maps) is
// normally cleared when a pointerup/pointercancel reaches the container's capture-phase listener. On a
// pen+touch panel the OS routinely DROPS that release during pen/palm interleaving — leaving the state
// STRANDED with no recovery: touchOverrideToolRef stuck 'pan' forces isDrawingMode=false so the PEN inks
// nothing. These windows drive a watchdog that reaps only DEMONSTRABLY stale pointers and then restores
// drawing.
//
// A pointer is "stale" once no event has refreshed its lastSeenAt for this long. A MOVING gesture fires
// pointermove far more often than this (60–120 Hz), but a finger held deliberately STILL (aiming a pan,
// the paused anchor of a pinch, a late second finger) emits no move and would look "stale" — so staleness
// ALONE is not the safety guarantee. The reaper additionally (a) never runs while a live gesture MODE is
// active (touchPanMode — recovered precisely by the lostpointercapture handler instead), and (b) never
// reaps the active-draw or pending-pan pointer id. The long window here is just a floor for the rare
// full-event-drop backstop; a dropped release is normally caught immediately by lostpointercapture, so 3s
// costs nothing and keeps a deliberate hold from ever tripping it.
const STALE_POINTER_MS = 3000;
// Interval-backstop idle guard: only run the reaper from the timer once no input has arrived for this
// long, so the no-retry case (dropped release, then the user just waits) still self-heals within ~2s.
const INPUT_IDLE_RECOVERY_MS = 1200;

// After the LAST pen lifts, how long the healthy path (the pen twin's touchend reaching Fabric) gets to
// end the brush stroke before the failsafe force-commits it. When that ending event is lost — the OS
// drops/reorders touch events during pen/finger interleaving; teacher-repro'd via finger-pan → pen-down —
// Fabric stays mid-stroke FOREVER and every later hover/touch extends one endless line.
const PEN_STROKE_END_FAILSAFE_MS = 150;
// Whole-hand (palm) eraser: the erase circle covers ALL contacts. Its diameter = the spread of the
// contacts (max distance across them) + a finger-radius pad on each side, so spreading the fingers
// grows it and pinching shrinks it. Floored by the configured min size, capped for sanity.
const WHOLE_HAND_ERASER_FINGER_PADDING_PX = 8;
const WHOLE_HAND_ERASER_MAX_SIZE_PX = 600;
// When the finger spread changes the erase width by more than this (scene px), close the current
// destination-out segment and start a fresh one — so growing/shrinking the circle never retroactively
// re-widens what was already erased earlier in the same pass. Tuned above the small frame-to-frame
// jitter of a steady wipe (so it stays ONE segment) while still re-segmenting on a real spread change.
const WHOLE_HAND_ERASER_RESEGMENT_EPS_PX = 12;
const PEN_JITTER_FILTER_MIN_PX = 0;
const PEN_JITTER_FILTER_MAX_PX = 15;
// W3C PointerEvent.buttons bitmask bits surfaced by pen barrel buttons while pointerType==='pen'.
// A barrel button sets the secondary (right-click) bit; the eraser-mapped end sets the eraser bit.
const PEN_BARREL_BUTTON_BIT = 2; // secondary / barrel button
const PEN_ERASER_BUTTON_BIT = 32; // eraser-end / second barrel button

// A release immediately followed by a press of the same button (a state blip at a hover/contact
// boundary) must not end the hold and kill the live drag.
const PEN_BUTTON_RELEASE_GRACE_MS = 120;
const PEN_BUTTON_HAPTIC_MS = 12;
// A DOM pen position older than this is not where the pen is now; use the native one instead.
const PEN_POINT_FRESH_MS = 1500;

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Resolve the freehand brush `decimate` value (in screen px) from the configured
 * pen jitter filter. Points closer than this distance are dropped when the path is
 * finalized, so small hover/contact jitter does not become a stray stroke. `0` keeps
 * raw input. Falls back to the default for missing/invalid (e.g. legacy) settings.
 */
function resolvePenJitterDecimate(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TABLET_INPUT_SETTINGS.penJitterFilter;
  }

  return Math.min(PEN_JITTER_FILTER_MAX_PX, Math.max(PEN_JITTER_FILTER_MIN_PX, value));
}

type DownEventInfo = TPointerEventInfo<TPointerEvent> & {
  alreadySelected: boolean;
};
type MoveEventInfo = TPointerEventInfo<TPointerEvent>;
type UpEventInfo = TPointerEventInfo<TPointerEvent> & { isClick: boolean };
type TouchPoint = { x: number; y: number };
type ActiveTouchPointer = TouchPoint & {
  maxTravel: number;
  startedAt: number;
  startX: number;
  startY: number;
  // Wall-clock ms of the last event that refreshed this pointer's position. Refreshed on every
  // move/down for the id; the self-heal reaper only removes a pointer once this is > STALE_POINTER_MS
  // old, which a live gesture (continuous pointermove) never is — the reaper safety invariant.
  lastSeenAt: number;
  // TILT-STABLE contact size: the SMALLEST usable minor axis (min of width/height) seen so far in this
  // contact's life, or 0 while every reading was the <=1px placeholder. A digitizer never reports a
  // patch SMALLER than the physical tip — tilt and pressure only ever inflate it, and tilt inflates the
  // MAJOR axis hardest — so the running minimum of the minor axis is the best estimate of the true head
  // size. Single-frame readings (what the dual-tip routing used to classify off) are exactly what a
  // tilted contact corrupts. Lives on the pointer record so it is cleaned up by every existing
  // delete/clear/reap path for free.
  // Dual-tip decision state for this contact (running size, frozen routing verdict, head colour).
  // Owned by whiteboard-core/dual-tip-contact so the offline replay harness
  // (`whiteboard-core/tools/replay-dualtip.mjs`) scores a real capture through THIS code rather than a
  // paraphrase of it — tune there, then ship. Lives on the pointer record, so every existing
  // delete/clear/reap path cleans it up for free.
  contact: ContactState;
};
type PendingTouchViewportUpdate = {
  absoluteZoom: number | null;
  center: TouchPoint | null;
  deltaX: number;
  deltaY: number;
  scale: number;
  zoomAnchor: TouchPoint | null;
};
type PendingSingleTouchPan = {
  pointerId: number;
  startPoint: TouchPoint;
};
type MultiTouchGestureBaseline = {
  center: TouchPoint | null;
  distance: number | null;
};
type TouchPanMode = 'single' | 'multi';

interface CustomListenerEntry {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => void;
  /** Remove this specific listener from the canvas. */
  remove: () => void;
}

const isEraserMark = (obj: FabricObject | null | undefined): boolean =>
  (obj as (FabricObject & { globalCompositeOperation?: string }) | null | undefined)?.globalCompositeOperation ===
  'destination-out';

// Recursive state for the two-finger zoom distance filter (1€ low-pass + hysteresis deadband).
// `smoothed`/`timestamp`/`dxdt` carry the 1€ filter forward; `applied` is the deadbanded output
// actually fed to zoom. Reset (replace with a fresh object) whenever a zoom gesture starts or ends.
type ZoomDistanceFilterState = {
  applied: number | null;
  dxdt: number;
  smoothed: number | null;
  timestamp: number | null;
};

const createZoomDistanceFilterState = (): ZoomDistanceFilterState => ({
  applied: null,
  dxdt: 0,
  smoothed: null,
  timestamp: null,
});

// One 1€ filter step over the raw inter-finger distance. Returns the smoothed distance and the
// smoothed velocity estimate; the caller persists them back into the filter state. `timestamp` is a
// monotonic ms clock (PointerEvent.timeStamp). On the first sample or after a discontinuity (paused
// gesture / dropped events) it cold-starts by passing the raw distance through untouched.
const stepZoomDistanceFilter = (
  rawDistance: number,
  timestamp: number,
  state: ZoomDistanceFilterState,
): { dxdt: number; smoothed: number } => {
  const prior = state.smoothed;
  const priorTimestamp = state.timestamp;

  if (prior === null || priorTimestamp === null) {
    return { dxdt: 0, smoothed: rawDistance };
  }

  const dt = (timestamp - priorTimestamp) / 1000;

  if (dt <= 0 || dt > ZOOM_DISTANCE_1E_DISCONTINUITY_S) {
    return { dxdt: 0, smoothed: rawDistance };
  }

  // Smooth the velocity estimate first (its own low-pass), then use it to set the adaptive cutoff.
  const rawVelocity = (rawDistance - prior) / dt;
  const derivativeAlpha = dt / (dt + 1 / (2 * Math.PI * ZOOM_DISTANCE_1E_DCUTOFF));
  const dxdt = Math.abs(rawVelocity) < 0.001 ? 0 : state.dxdt + derivativeAlpha * (rawVelocity - state.dxdt);

  const cutoff = ZOOM_DISTANCE_1E_MINCUTOFF + ZOOM_DISTANCE_1E_BETA * Math.abs(dxdt);
  const tau = 1 / (2 * Math.PI * cutoff);
  const alpha = dt / (dt + tau);
  const smoothed = prior + alpha * (rawDistance - prior);

  return { dxdt, smoothed };
};

const isTransientCanvasObject = (obj: FabricObject | null | undefined): boolean =>
  Boolean((obj as (FabricObject & { excludeFromExport?: boolean }) | null | undefined)?.excludeFromExport);

// What the object eraser's broad phase stores per object (utils/objectEraseIndex). The box is SCENE
// coords; the half stroke pads the query so a wide stroke whose box ends short of the ring is still a
// candidate (the exact test, objectHitsEraser, decides).
const createCanvasObjectEraseIndex = () =>
  createObjectEraseIndex<FabricObject>({
    bboxOf: (obj) => {
      obj.setCoords();

      const r = obj.getBoundingRect();

      return { minX: r.left, minY: r.top, maxX: r.left + r.width, maxY: r.top + r.height };
    },
    halfStrokeOf: (obj) => (obj.stroke ? (obj.strokeWidth ?? 0) / 2 : 0),
    isIndexable: (obj) => !isEraserMark(obj) && !isLockedImage(obj),
  });

function withAlpha(color: string, alpha: number) {
  const normalizedAlpha = Math.max(0, Math.min(1, alpha));

  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const normalizedHex =
      hex.length === 3
        ? hex
            .split('')
            .map((part) => `${part}${part}`)
            .join('')
        : hex.length >= 6
          ? hex.slice(0, 6)
          : null;

    if (normalizedHex) {
      const red = Number.parseInt(normalizedHex.slice(0, 2), 16);
      const green = Number.parseInt(normalizedHex.slice(2, 4), 16);
      const blue = Number.parseInt(normalizedHex.slice(4, 6), 16);

      return `rgba(${red}, ${green}, ${blue}, ${normalizedAlpha})`;
    }
  }

  const rgbMatch = color.match(/rgba?\(([^)]+)\)/i);

  if (rgbMatch) {
    const parts = rgbMatch[1]
      .split(',')
      .map((part) => part.trim())
      .slice(0, 3);

    if (parts.length === 3) {
      return `rgba(${parts.join(', ')}, ${normalizedAlpha})`;
    }
  }

  return color;
}

class LiveEraserBrush extends LowLatencyPencilBrush {
  declare canvas: Canvas & { lowerCanvasEl?: HTMLCanvasElement };

  // Ink smoothing trails the pen by up to a pixel — harmless for ink, a missed sliver for an eraser.
  override smoothing = false;

  /**
   * The erase diameter in SCREEN px — the number on the slider, the disc in the settings preview and the
   * ring over the board. `width` is in SCENE units, so it is derived from this at every pen-down against
   * the LIVE zoom (see `utils/eraserGeometry`). It cannot be fixed once in the tool effect: that effect
   * re-runs on tool/size changes, not on zoom, so a width computed there went stale the moment the
   * teacher pinched — and a stale width erases `zoom`× the ring they can see.
   */
  screenDiameter: number | null = null;

  override needsFullRender() {
    return true;
  }

  private syncPreview() {
    const ctx = this.canvas.contextTop;
    const lowerCanvasEl = this.canvas.lowerCanvasEl;

    if (!ctx || !lowerCanvasEl) {
      return;
    }

    this.canvas.clearContext(ctx);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(lowerCanvasEl, 0, 0);
    ctx.restore();
  }

  private setLowerCanvasVisibility(isVisible: boolean) {
    const lowerCanvasEl = this.canvas.lowerCanvasEl;

    if (!lowerCanvasEl) {
      return;
    }

    lowerCanvasEl.style.opacity = isVisible ? '1' : '0';
  }

  override _render(ctx: CanvasRenderingContext2D = this.canvas.contextTop) {
    this.syncPreview();
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    super._render(ctx);
    ctx.restore();
  }

  override createPath(pathData: Parameters<PencilBrush['createPath']>[0]): Path {
    const path = super.createPath(pathData);

    path.set({
      globalCompositeOperation: 'destination-out',
      selectable: false,
      evented: false,
    });

    return path;
  }

  override onMouseDown(pointer: Point, eventData: Parameters<PencilBrush['onMouseDown']>[1]) {
    if (this.screenDiameter !== null) {
      this.width = eraserSceneDiameter(this.screenDiameter, this.canvas.getZoom());
    }

    this.setLowerCanvasVisibility(false);
    super.onMouseDown(pointer, eventData);
  }

  /**
   * Undo both things an erase pass does to the live surfaces: the lower canvas is hidden while erasing
   * (the teacher looks at the destination-out preview on contextTop instead), and `syncPreview` blits the
   * whole board onto contextTop every frame.
   *
   * This MUST run however a stroke ends, which is why it is public rather than living inside `onMouseUp`.
   * A leftover blit is pixel-identical to the live board EVERYWHERE EXCEPT inside the erased region —
   * where it still holds the un-erased ink, because a partial erase composites a `destination-out` path
   * and never removes the object. So the next stroke appears to resurrect exactly what was erased last,
   * for as long as that stroke lasts. Fabric never cleans it up: `renderAll()` skips clearing contextTop
   * while `isDrawingMode` is true.
   */
  restoreLiveSurface() {
    this.setLowerCanvasVisibility(true);

    if (this.canvas.contextTop) {
      this.canvas.clearContext(this.canvas.contextTop);
    }
  }

  override onMouseUp(eventData: Parameters<PencilBrush['onMouseUp']>[0]) {
    const result = super.onMouseUp(eventData);

    this.restoreLiveSurface();

    return result;
  }
}

export function useWhiteboardCanvas({
  canvasRef,
  containerRef,
  zoomLayerRef,
  wholeHandEraserCursorRef,
  activeTool,
  strokeSettings,
  eraserMode,
  eraserSize,
  tabletInputSettings = DEFAULT_TABLET_INPUT_SETTINGS,
  fillColor,
  shapeStyle,
  zoomLocked = false,
  hasPdfPageBackground = false,
  pdfFitSizeRef,
  viewportConstraintsRef,
  directTouchPanRef,
  rulerEdgesRef,
  panAxisLock = false,
  onCanvasReady,
  onObjectModified,
  onShortcutColorCycle,
  onShortcutColorToggle,
  onShortcutToolToggle,
  onShortcutQuickMenu,
  onShortcutUndo,
  onNativePenPoint,
  onViewportCommit,
  onZoomCommit,
  onCanvasResize,
  onContactCaptured,
  sampleBackgroundLuminance,
}: UseWhiteboardCanvasProps): UseWhiteboardCanvasReturn {
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  // Read inside the resize handler (registered once with empty deps) to branch the recenter logic
  // by live page type without re-registering the ResizeObserver.
  const hasPdfBackgroundRef = useRef(hasPdfPageBackground);

  hasPdfBackgroundRef.current = hasPdfPageBackground;
  const [zoom, setZoomState] = useState(1);
  const [effectiveTool, setEffectiveTool] = useState<WhiteboardTool>(activeTool);
  // Drives the on-screen "whole-hand eraser active" badge + cursor swap. Mirrors wholeHandEraserSessionRef
  // so the UI can react (the ref alone doesn't trigger a render).
  const [isWholeHandEraserActive, setIsWholeHandEraserActive] = useState(false);

  const activeToolRef = useRef(activeTool);
  const effectiveToolRef = useRef(activeTool);
  const strokeSettingsRef = useRef(strokeSettings);
  const eraserModeRef = useRef(eraserMode);
  const eraserSizeRef = useRef(eraserSize);
  const tabletInputSettingsRef = useRef(tabletInputSettings);
  const fillColorRef = useRef(fillColor);
  const shapeStyleRef = useRef(shapeStyle);
  const zoomLockedRef = useRef(zoomLocked);
  const onObjectModifiedRef = useRef(onObjectModified);
  const onShortcutColorCycleRef = useRef(onShortcutColorCycle);
  const onShortcutColorToggleRef = useRef(onShortcutColorToggle);
  const onShortcutToolToggleRef = useRef(onShortcutToolToggle);
  const onShortcutQuickMenuRef = useRef(onShortcutQuickMenu);
  const onShortcutUndoRef = useRef(onShortcutUndo);
  const onNativePenPointRef = useRef(onNativePenPoint);
  // Pen buttons LEARNED on the «Pen buttons» page (per device, localStorage). Read once here and
  // refreshed by the effect below when the page (or another window) rewrites it.
  const penButtonMapRef = useRef(readPenButtonMap(typeof window === 'undefined' ? null : safeLocalStorage()));
  const penButtonDispatcherRef = useRef(createPenButtonDispatcher());
  // True while a momentary «Erase while held» press switched the tool to the eraser; its release
  // switches back. A press that found the eraser already active leaves this false (nothing to undo).
  // The learned map plus the built-in S Pen binding — what the board actually dispatches against.
  const penButtonEffectiveMapRef = useRef(withDefaultStylusBinding(penButtonMapRef.current));
  // Per-binding hover/contact gesture (utils/penButtonGesture) + its long-press timer + release grace.
  const penButtonGesturesRef = useRef<Map<string, PenButtonGestureState>>(new Map());
  const penButtonGestureTimersRef = useRef<Map<string, number>>(new Map());
  const penButtonReleaseTimersRef = useRef<Map<string, number>>(new Map());
  // «Erase while held»: the eraser is an OVERRIDE on top of the toolbar tool while the button is held
  // on the glass — applied synchronously (no React round-trip), so a pen put down with the button
  // already held erases from its very first touch, and releasing restores whatever nib was active.
  const penButtonOverrideToolRef = useRef<WhiteboardTool | null>(null);
  // A pen-button tool swap while the pen was ON the glass committed the drag in progress; the next pen
  // move restarts the drag with the new tool from the current contact (no new pen-down needed).
  const penButtonStrokeRestartRef = useRef(false);
  // Latest native Android MotionEvent buttonState (MainActivity → `wb-native-pen`); 0 = none held.
  const nativeStylusButtonStateRef = useRef(0);
  // Where the pen last was — DOM hover/contact position (client px), and the native fallback.
  const lastPenPointerPointRef = useRef({ x: 0, y: 0, at: 0 });
  const lastNativePenPointRef = useRef({ x: 0, y: 0, at: 0 });
  // A contact the page never saw: the stylus touched down with its button already held, and the Samsung
  // WebView delivered no pointerdown/touch for it. True while the eraser is driven from MainActivity's
  // forwarded `kind:'contact'` samples instead (see handleNativePenContact).
  const nativePenDragRef = useRef(false);
  // The TAIL of a native-driven erase-hold (device log, SM-X910): after the native UP, while the button is
  // still held in the air, the WebView keeps emitting pen pointermove/rawupdate with buttons=1 and
  // pressure 0 every ~9 ms — a "contact" that is not one. Armed when a native erase ends and when a pen
  // button override is released; until a genuine pen-down (pressure > 0) or a real hover (buttons 0),
  // such zero-pressure pen events that no real pointerdown opened never reach the board (see
  // guardNativeEraseTail), and a tiny stroke committed meanwhile is discarded (path:created).
  const nativeTailGuardRef = useRef(false);
  // A zero-pressure pen-down swallowed by that guard: its compat mouse events are swallowed too.
  const swallowCompatMouseRef = useRef(false);
  const onViewportCommitRef = useRef(onViewportCommit);
  const onZoomCommitRef = useRef(onZoomCommit);
  const onCanvasResizeRef = useRef(onCanvasResize);
  const sampleBackgroundLuminanceRef = useRef(sampleBackgroundLuminance);

  sampleBackgroundLuminanceRef.current = sampleBackgroundLuminance;
  const keyboardOverrideToolRef = useRef<WhiteboardTool | null>(null);
  // While a touch pan/zoom gesture is live this holds 'pan' so the effective tool is pan (isDrawingMode
  // off). It is the ONLY transient touch override left (whole-hand eraser / mouse-hold / barrel-hold are
  // gone — the barrel now TOGGLES the tool instead of latching an override).
  const touchOverrideToolRef = useRef<WhiteboardTool | null>(null);
  const penBrushRef = useRef<LowLatencyPencilBrush | null>(null);
  const highlighterBrushRef = useRef<PencilBrush | null>(null);
  const calligraphyBrushRef = useRef<CalligraphyBrush | null>(null);
  const softMarkerBrushRef = useRef<SoftMarkerBrush | null>(null);
  const scriptBrushRef = useRef<ScriptBrush | null>(null);
  const eraserBrushRef = useRef<LiveEraserBrush | null>(null);
  // The pen's line mode (straight on hold / always straight) works even with hold-to-snap shapes off.
  const lineShapeActive = () =>
    isPenFamilyTool(effectiveToolRef.current) && (strokeSettingsRef.current.lineShape ?? 'free') !== 'free';
  // Hold-to-snap shapes (`brushes/shapeSnap.ts`), shared by every inking brush — never the eraser.
  const shapeSnapRef = useRef<ShapeSnapController | null>(null);

  if (!shapeSnapRef.current) {
    shapeSnapRef.current = new ShapeSnapController({
      isEnabled: () =>
        // The highlighter always straightens on a hold (a straight highlight is what it is mostly for).
        (tabletInputSettingsRef.current.shapeSnapOnHold !== false || lineShapeActive() || effectiveToolRef.current === 'highlighter') &&
        // Never while a pen button is held: the hold is the button gesture, not a shape hold.
        penButtonOverrideToolRef.current === null &&
        nativeStylusButtonStateRef.current === 0 &&
        (isPenFamilyTool(effectiveToolRef.current) || effectiveToolRef.current === 'highlighter'),
      // Same rule as the path:created handler: the pen family honours the opacity slider, the
      // highlighter's translucency is already in its colour.
      getOpacity: () => (isPenFamilyTool(effectiveToolRef.current) ? strokeSettingsRef.current.opacity : 1),
      getLineShape: () => {
        const lineShape = strokeSettingsRef.current.lineShape ?? 'free';

        if (isPenFamilyTool(effectiveToolRef.current)) return lineShape;

        // The highlighter: with hold-to-snap shapes on and the pen freehand, a hold recognises the shape
        // like the pen's (a wobbly line becomes straight, a ring an ellipse). Otherwise — shapes off, or
        // the pen set to straight lines — a hold turns the highlight into a straight line that follows the
        // pen, like the pen's «straight on hold». Never «always»: a highlight stays freehand until a hold.
        if (effectiveToolRef.current === 'highlighter') {
          return tabletInputSettingsRef.current.shapeSnapOnHold !== false && lineShape === 'free' ? 'free' : 'hold';
        }

        return 'free';
      },
      isDashed: () => isPenFamilyTool(effectiveToolRef.current) && strokeSettingsRef.current.dashed === true,
      // A closed shape drawn with the pen takes the remembered background (the brush's swept outline is
      // already a filled mark, and the highlighter never fills).
      decorate: (object) => {
        const style = shapeStyleRef.current;

        if (!style || !isPenFamilyTool(effectiveToolRef.current) || !isClosedShape(object)) return;
        if (!style.fill || style.fill === 'transparent') return;

        applyShapeStyle(object, { fill: style.fill, fillStyle: style.fillStyle });
      },
    });
  }
  // Ruler straight-edge in front of hold-to-snap: the interceptor the pen, highlighter, brush and marker share.
  const rulerEdgesHostRef = useRef(rulerEdgesRef);

  rulerEdgesHostRef.current = rulerEdgesRef;

  const strokeInterceptorRef = useRef<RulerSnapInterceptor | null>(null);

  if (!strokeInterceptorRef.current) {
    strokeInterceptorRef.current = new RulerSnapInterceptor(
      {
        getEdges: () => rulerEdgesHostRef.current?.current?.() ?? null,
        getOpacity: () => (isPenFamilyTool(effectiveToolRef.current) ? strokeSettingsRef.current.opacity : 1),
      },
      shapeSnapRef.current,
    );
  }
  // Smart ink contrast (`utils/inkContrast.ts`), shared by the pen, brush and marker — never the
  // highlighter (its wash is meant to be faint) and never the eraser.
  const inkContrastRef = useRef<StrokeInkContrast<Canvas> | null>(null);

  if (!inkContrastRef.current) {
    inkContrastRef.current = createStrokeInkContrast<Canvas>({
      isEnabled: () => tabletInputSettingsRef.current.smartInkContrast === true,
      sampleBackground: (c, x, y) => sampleBackgroundLuminanceRef.current?.(c, x, y) ?? null,
      // The pen family's opacity slider lands on the committed path (see the path:created handler), so
      // the stroke the teacher sees is this much fainter than its colour says.
      getOpacity: () => (isPenFamilyTool(effectiveToolRef.current) ? strokeSettingsRef.current.opacity : 1),
    });
  }
  // The dense-page ink bake (see `utils/inkBake.ts`). Held so page switches and history restores can
  // drop the bitmap in the same tick rather than paying one stale frame for the identity check to
  // notice the object list was replaced under it.
  const inkBakeRef = useRef<InkBakeHandle | null>(null);
  // The pen nib-lift + tilt correction, in CLIENT px, for the contact Fabric is about to resolve.
  //
  // WHY A REF AND NOT THE EVENT. The correction can only be computed from a real PointerEvent — that is
  // the only place `tiltX`/`tiltY` exist. But Fabric never sees that event: this canvas is deliberately
  // built WITHOUT pointer-event mode (so a resting palm can be starved out of the touch stream), which
  // means Fabric takes its coordinates from the raw `TouchEvent.changedTouches[0]` or from the browser's
  // compat `MouseEvent` — different objects from the PointerEvent we patch. Mutating the PointerEvent
  // therefore never moved a single pixel of ink; both offsets had been inert since they were written.
  // Parking the value here and applying it inside Fabric's own pointer resolution fixes that for every
  // consumer at once — brush, target finding, selection.
  const penPointerOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Which tool this canvas is currently configured for. applyCanvasToolState runs on far more than tool
  // changes — its effect also depends on strokeSettings, eraserMode and eraserSize — so "did the tool
  // actually change?" cannot be inferred from the fact that it ran.
  const appliedToolRef = useRef<WhiteboardTool | null>(null);
  const objectInteractionModeRef = useRef<'erase' | 'none' | 'select' | null>(null);
  const activeTouchPointersRef = useRef<Map<number, ActiveTouchPointer>>(new Map());
  // Records touch contacts (frames + the decision taken on them) for the training capture.
  //
  // The old comment here claimed "null unless an owner supplied a sink, so a board with capture off
  // allocates nothing". That was FALSE in production: the app passes `onContactCaptured`
  // UNCONDITIONALLY, and the capture switch was only consulted at stroke END (inside capturePenContact).
  // So every touch move on every board — capture on or off — paid an updateContactState() call with two
  // freshly allocated options objects, a CapturedFrame object, an array push and two Date.now() calls.
  // The real switch is {@link isContactCaptureRecording}, read per move from the live settings.
  const contactRecorderRef = useRef<ContactRecorder | null>(null);
  const onContactCapturedRef = useRef(onContactCaptured);

  onContactCapturedRef.current = onContactCaptured;

  /**
   * Is the training capture actually recording right now?
   *
   * `penCaptureEnabled` is the SAME switch the app's own `isPenCaptureEnabled()` reads — both resolve to
   * the `whiteboard-tablet-input-settings` blob — it just reaches us as a live prop instead of a
   * localStorage parse, so it costs one boolean read per move rather than a JSON.parse. Consulted on
   * every move so a teacher turning capture off mid-lesson stops paying for it immediately.
   */
  const isContactCaptureRecording = () =>
    onContactCapturedRef.current != null && tabletInputSettingsRef.current.penCaptureEnabled === true;

  if (onContactCaptured && tabletInputSettings.penCaptureEnabled && contactRecorderRef.current === null) {
    contactRecorderRef.current = new ContactRecorder({
      newId: () =>
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `contact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
  }

  /** Bands for a rulebook, read from the live settings (each rulebook keeps its own set). */
  const bandsForRulebook = (mode: 'height-aware' | 'legacy') => {
    const dualTip = tabletInputSettingsRef.current.dualTipStylus;

    return mode === 'legacy'
      ? {
          smallHeadMaxWidth: dualTip.legacyBands.smallHeadMaxWidth,
          bigHeadMaxWidth: dualTip.legacyBands.bigHeadMaxWidth,
          fingerMinWidth: dualTip.legacyBands.fingerMinWidth,
        }
      : {
          smallHeadMaxWidth: dualTip.smallHeadMaxWidth,
          bigHeadMaxWidth: dualTip.bigHeadMaxWidth,
          fingerMinWidth: tabletInputSettingsRef.current.singleFingerPan.minWidth,
        };
  };

  /**
   * Replay a finished contact under the OTHER rulebook and score how much it deserves review.
   *
   * Running both is what makes the priority meaningful: where the two rulebooks part company IS the
   * decision boundary, so the disagreements are exactly the contacts whose label teaches something.
   * It costs one pass over frames already in memory, once per contact — never per frame.
   */
  const withReviewPriority = (contact: CapturedContact): CapturedContact => {
    const liveMode = tabletInputSettingsRef.current.dualTipStylus.classifier === 'legacy' ? 'legacy' : 'height-aware';
    const otherMode = liveMode === 'legacy' ? 'height-aware' : 'legacy';
    const otherBands = bandsForRulebook(otherMode);
    const [firstFrame] = contact.frames;
    let altState = createContactState();

    for (const frame of contact.frames) {
      altState = updateContactState(
        altState,
        {
          width: frame.w,
          height: frame.h,
          travelPx: firstFrame ? Math.hypot(frame.x - firstFrame.x, frame.y - firstFrame.y) : 0,
          elapsedMs: frame.t,
        },
        { ...otherBands, dualTipEnabled: true, mode: otherMode, settleMs: CONTACT_SETTLE_MS, activationPx: SINGLE_TOUCH_PAN_ACTIVATION_DISTANCE },
      );
    }

    return {
      ...contact,
      priority: scoreContactPriority({
        head: contact.decision.head,
        altHead: altState.head,
        routing: contact.decision.routing,
        altRouting: altState.routing,
        size: altState.size,
        bands: bandsForRulebook(liveMode),
      }),
    };
  };

  /** Hand a finished contact to the owner. Never let a capture failure reach the lesson. */
  const emitCapturedContact = (contact: CapturedContact | null) => {
    if (!contact) return;

    try {
      onContactCapturedRef.current?.(withReviewPriority(contact));
    } catch {
      // Capture is best-effort by design.
    }
  };
  const ignoredTouchPointerIdsRef = useRef<Set<number>>(new Set());
  // On a TOUCH-ONLY device (or touchInputMode 'capacitive-pen', which forces that routing) a single
  // finger DRAWS; this holds that contact's pointerId so its move events get the nib-landing offset.
  // Also used on a PEN DEVICE while touchInputMode is 'finger-draws' (see handlePointerDown) — otherwise
  // stays null there (a single finger pans, never draws).
  const touchDrawingPointerIdRef = useRef<number | null>(null);
  // touchInputMode 'finger-draws' on a PEN DEVICE: armed the instant handlePointerDown decides a lone,
  // non-palm-rejected touch should draw; consumed by blockTouchFromFabricOnPenDevice's very next
  // touchstart, which captures that TouchEvent's raw `identifier` into fingerDrawTouchIdentifierRef
  // below. PointerEvent.pointerId and Touch.identifier live in separate id spaces (no cross-API equality
  // to rely on), so this two-step arm→capture handshake — rather than id matching — is what lets the
  // SAME contact's later touchmove/touchend be recognised there. Always false/null on a touch-only-routed
  // device (that path never sets it; see the DRAW branch below).
  const fingerDrawArmedRef = useRef(false);
  // The raw touch `identifier` (Touch Events API — NOT PointerEvent.pointerId) currently recognised as
  // the 'finger-draws'-mode contact, captured off its touchstart per the handshake above and cleared by
  // that same contact's own touchend/touchcancel. Keys blockTouchFromFabricOnPenDevice's pass-through so
  // only THIS one contact reaches Fabric's raw touch drawing pipeline while that mode is on — mirroring
  // the identifier-keyed pass-through of the pen's own twin touch (penTwinTouchIdentifiersRef).
  const fingerDrawTouchIdentifierRef = useRef<number | null>(null);
  // Mirrors penStrokeEndFailsafeTimerRef for the finger-draw contact: after it lifts, give Fabric's own
  // touchend (let through above) PEN_STROKE_END_FAILSAFE_MS to close the brush before force-committing —
  // the same dropped-event self-heal the pen relies on, so a lost touchend can never leave the brush
  // open for a later hover/touch to extend into an endless line.
  const touchDrawStrokeEndFailsafeTimerRef = useRef<number | null>(null);
  // Date.now() of the latest 'pen' pointerdown. With lastPenClientPointRef (seeded from that same event,
  // raw, before any nib offset) it is the PenDownRecord isPenTwinTouchStart judges a touchstart against.
  const penDownAtRef = useRef(0);
  // Touch.identifier of the pen's own twin contact(s) — established POSITIVELY at touchstart and the ONLY
  // raw touches Fabric may see on a pen device for their whole life (plus a 'finger-draws' session's
  // own contact). Re-decided on every touchstart (identifiers are reused), dropped on touchend/cancel
  // and on the next pen-down (a twin whose end was lost must not outlive its pen contact).
  const penTwinTouchIdentifiersRef = useRef<Set<number>>(new Set());
  // Per live pen contact: has it reported pressure > 0 yet? Feeds splitPenFrame so a pressure-0 sample
  // reads as "the tip is leaving" only on a digitizer that reports pressure at all.
  const penContactPressureRef = useRef<Map<number, PenContactPressureState>>(new Map());
  // The CURRENT pen frame's own sample is a 'skip' (tip leaving: pressure 0, contact bit still set).
  // injectCoalescedSamples never appends that sample — but Fabric is about to, from this frame's twin
  // touchmove / compat mousemove, which are dispatched right after the pointermove that set this. The
  // raw-touch guard and the mouse-channel guard starve those while it is set. Overwritten by every pen
  // pointermove, cleared on pen down/up/heal, so it can never outlive the contact and swallow a later
  // mouse stroke's moves.
  const penFrameSkipRef = useRef(false);
  // Dual-tip stylus (touch-only device only): once we get a usable contact-size reading for the active
  // touch draw, we LOCK the classified head colour so later size jitter can't recolour mid-stroke. Reset
  // to false at each touch-down; handlePointerMove re-classifies until it locks. Inert on a pen device.
  // Timestamp until which a small freehand path committed by Fabric is treated as the leftover of a
  // touch-only finger's tentative stroke (interrupted when it became a pan) and removed. See
  // TOUCH_PAN_ARTIFACT_SUPPRESS_WINDOW_MS. 0 = inactive. Only ever armed on a touch-only device.
  const touchPanArtifactSuppressUntilRef = useRef(0);
  const touchPanModeRef = useRef<TouchPanMode | null>(null);
  const pendingSingleTouchPanRef = useRef<PendingSingleTouchPan | null>(null);
  const multiTouchGestureBaselineRef = useRef<MultiTouchGestureBaseline | null>(null);
  const multiTouchGestureLockRef = useRef<'pan' | 'zoom' | null>(null);
  const lastTouchPanCenterRef = useRef<TouchPoint | null>(null);
  const lastTouchDistanceRef = useRef<number | null>(null);
  // Captured when a gesture commits to zoom: pinch is scaled relative to THIS fixed baseline
  // (never frame-to-frame), anchored at this fixed midpoint — so per-event distance noise
  // cannot accumulate into jitter.
  const zoomGestureBaselineRef = useRef<{ center: TouchPoint | null; distance: number; zoom: number } | null>(null);
  // 1€ low-pass + hysteresis-deadband state that de-noises the pinch distance feeding zoom. Reset
  // alongside zoomGestureBaselineRef so each zoom gesture starts from a clean filter.
  const zoomDistanceFilterRef = useRef<ZoomDistanceFilterState>(createZoomDistanceFilterState());
  /** Sub-device-pixel remainder of the continuous layout's direct touch pan, carried frame to frame. */
  const directPanCarryRef = useRef({ x: 0, y: 0 });
  const pendingTouchViewportUpdateRef = useRef<PendingTouchViewportUpdate>({
    absoluteZoom: null,
    center: null,
    deltaX: 0,
    deltaY: 0,
    scale: 1,
    zoomAnchor: null,
  });
  const touchViewportFrameRef = useRef<number | null>(null);
  // --- Pan inertia (fling) --- the raw pan samples of the last ~100ms (velocity estimate on release)
  // and the fling in flight. See startFling.
  const panVelocitySamplesRef = useRef<PanSample[]>([]);
  const flingRef = useRef<{ velocity: Velocity; lastT: number; frame: number | null; mode: 'hand' | 'touch' } | null>(
    null,
  );
  // True while the fling itself writes the viewport, so the setViewportTransform wrapper (which cancels
  // a fling on any OTHER viewport write: page load, zoom reset, fit) does not cancel its own frames.
  const flingApplyingRef = useRef(false);
  const cancelFlingRef = useRef<(() => void) | null>(null);
  // Viewport constraints (see the prop): the zoom floor/ceiling every zoom path clamps with, and the
  // clamp applied after every viewport write. Both read the ref live, so they stay stable callbacks.
  const getZoomBounds = useCallback((): { min: number; max: number } => {
    const constraints = viewportConstraintsRef?.current;

    if (!constraints) return { max: MAX_ZOOM, min: MIN_ZOOM };

    return { max: clampZoom(Number.POSITIVE_INFINITY, constraints), min: clampZoom(0, constraints) };
  }, [viewportConstraintsRef]);
  const clampZoomValue = useCallback(
    (zoom: number) => {
      const bounds = getZoomBounds();

      return Math.min(bounds.max, Math.max(bounds.min, zoom));
    },
    [getZoomBounds],
  );
  /** Pull the live viewport back inside the constraints. Returns true when it had to move. */
  const constrainViewport = useCallback(
    (c: Canvas): boolean => {
      const constraints = viewportConstraintsRef?.current;

      if (!constraints) return false;

      const current = c.viewportTransform;
      const clamped = clampViewportTransform(current, constraints, c.getWidth(), c.getHeight());

      if (isSameViewportTransform(current, clamped)) return false;

      c.setViewportTransform(clamped);

      return true;
    },
    [viewportConstraintsRef],
  );
  // The current finger pan's axis lock (see the prop); a fresh one per pan gesture.
  const panAxisLockEnabledRef = useRef(panAxisLock);
  const panAxisLockStateRef = useRef<PanAxisLockState>(createPanAxisLock());

  panAxisLockEnabledRef.current = panAxisLock;
  // Set by a direct (non-preview) touch pan frame that the constraints stopped dead — the fling reads
  // it to end a coast that has hit the page edge.
  const directPanBlockedRef = useRef(false);
  // The resize handler is registered once (empty deps) — it reaches the clamp through this ref.
  const constrainViewportRef = useRef(constrainViewport);

  constrainViewportRef.current = constrainViewport;
  // Pan/zoom perf: the React `zoom` state only feeds the toolbar % readout and PDF render
  // resolution — neither needs a per-frame update. Calling setZoomState on every gesture frame
  // (60-120 Hz on a pen tablet) forces a full editor re-render and makes pan/zoom choppy even on an
  // empty page. canvas.getZoom() is the live source of truth; React state is trailing-throttled and
  // the final value flushed on settle (see syncZoomStateSoon).
  const zoomSyncTimerRef = useRef<number | null>(null);
  const pendingZoomSyncRef = useRef<number | null>(null);
  // Zoom/pan PREVIEW: re-rasterizing the canvas every gesture frame is paint/compositor-bound (the JS
  // render is ~0.3ms; the cost is the browser re-uploading the changed canvas bitmap), which tanks the
  // framerate on big/high-DPR touch panels. So during an active gesture we DON'T touch Fabric — we
  // CSS-transform the whole canvas layer (the GPU just re-scales the existing texture: ~free), and
  // commit the real zoom/pan to Fabric + re-rasterize ONCE when the gesture settles.
  const zoomPreviewRef = useRef<{
    mode: 'zoom' | 'pan';
    anchorX: number;
    anchorY: number;
    baseZoom: number;
    scale: number;
    panX: number;
    panY: number;
  } | null>(null);
  const zoomPreviewFrameRef = useRef<number | null>(null);
  const zoomCommitTimerRef = useRef<number | null>(null);
  // Pan/zoom perf: the canvas DOM rect is invariant under Fabric viewport transforms, so reading
  // getBoundingClientRect() on every gesture frame is pure layout-thrash. Cache it and invalidate
  // only on resize/scroll (the only things that move the element), registered once below.
  const viewportBoundsRef = useRef<DOMRect | null>(null);
  // DRAW perf: the screen geometry Fabric's pointer funnel needs, cached across frames.
  //
  // WHAT IT REPLACES. `_getPointerImpl` (fabric 7.2.0, SelectableCanvas.ts) re-measures the DOM on
  // EVERY call: `upperCanvasEl.getBoundingClientRect()`, then `calcOffset()` → `getElementOffset()`
  // → `getComputedStyle()` + a SECOND `getBoundingClientRect()` (on the lower canvas). Our own nib
  // -offset patch below used to add a THIRD rect read. Three layout reads + one style read per call.
  // That was tolerable while Fabric called the funnel once per event and cached the result on the
  // event (`_scenePoint`/`_viewportPoint`). Since v0.1.142 `injectCoalescedSamples` drives the SAME
  // funnel once per BUFFERED SUB-FRAME SAMPLE, bypassing that cache — so a 120 Hz digitizer reporting
  // 2 coalesced samples per frame made 3 calls = 9 layout/style reads per drawn frame (15 at 240 Hz)
  // where the pre-v0.1.142 board made 3. Each read that follows a style mutation (Fabric sets
  // `upperCanvasEl.style.cursor` inside its own event path; React commits between events) is a FORCED
  // synchronous layout — cost scales with DOM size, not with stroke length, which is exactly the
  // "slow from the very first stroke" the teacher reported.
  //
  // WHY CACHING IS SAFE. None of this geometry can change between two coalesced samples of one event:
  // they are processed in a single synchronous task. Across frames it can only change when the element
  // actually moves, which is the complete invalidation list wired to {@link invalidatePointerGeometry}:
  // container resize (ResizeObserver + setDimensions), window resize, any ancestor scroll, and the
  // zoom-preview CSS transform being applied or cleared. As a backstop against a layout shift nothing
  // observes (surrounding chrome toggling without changing the container's SIZE, which the
  // ResizeObserver cannot see), it is also dropped at every pointerdown — one measurement per contact,
  // paid while the tip is landing rather than mid-stroke.
  const pointerGeometryRef = useRef<{ rect: DOMRect; offset: { left: number; top: number } } | null>(null);
  // A canvas resize the ResizeObserver reported WHILE a stroke was in flight and we chose to postpone
  // (see handleResize), plus the handler that applies it. Flushed by every release path.
  const deferredResizeRef = useRef(false);
  const runDeferredResizeRef = useRef<(() => void) | null>(null);
  // Samples the object eraser has not swept yet — one pass per frame takes all of them (utils/objectEraseSweep).
  const pendingObjectErasePointsRef = useRef<Point[]>([]);
  const objectEraseFrameRef = useRef<number | null>(null);
  // Where the object eraser last tested, within the current drag. The ring is swept from here to the next
  // sample as a capsule, so a stroke crossed between two frames is still caught — and nothing outside
  // that swept ring ever is (see `utils/eraserGeometry`).
  const lastObjectErasePointRef = useRef<Point | null>(null);
  // Spatial broad-phase index for object-erase candidate selection, kept up to date per added / removed /
  // modified object instead of rebuilt after every erase (utils/objectEraseIndex has the history).
  const objectHitIndexRef = useRef<ReturnType<typeof createCanvasObjectEraseIndex> | null>(null);

  objectHitIndexRef.current ??= createCanvasObjectEraseIndex();

  const objectHitIndex = objectHitIndexRef.current;
  const wholeHandEraserSessionRef = useRef<WholeHandEraserSession | null>(null);
  // Container bounding-rect captured at pass start, to place the absolute eraser cursor (client→local).
  const wholeHandCursorRectRef = useRef<DOMRect | null>(null);
  // Coalesces palm-eraser updates to one per animation frame: each finger fires its own pointermove, so
  // running the geometry+erase per event would compute from a half-updated contact set (transient
  // asymmetry that churns out spurious segments) and waste work. We instead just record contacts on every
  // move and recompute ONCE per frame from the settled set.
  const wholeHandEraserFrameRef = useRef<number | null>(null);
  // RAW, UNCAPPED touch contacts (pointerId -> latest position) tracked solely for the whole-hand eraser:
  // this panel reports a fixed pixel size per touch, so a palm is detected by how MANY contacts land at
  // once (and erases along their centroid). Kept SEPARATE from activeTouchPointersRef so the pan/zoom
  // 2-touch cap is untouched. The `lastSeenAt` feeds the self-heal reaper (stale-contact eviction).
  const rawTouchContactsRef = useRef<Map<number, { x: number; y: number; lastSeenAt: number }>>(new Map());
  // Assigned by the touch effect to its local stopWholeHandEraser() so the top-level reaper can end a
  // leaked palm-eraser session cleanly (commit its open destination-out path) without duplicating it.
  const stopWholeHandEraserRef = useRef<(() => void) | null>(null);
  // Pen pointerIds currently in contact (tip down). Size > 0 is one half of the palm guard (a touch while
  // the pen tip is physically down is a palm).
  const activePenPointersRef = useRef<Set<number>>(new Set());
  // Length of the last pointermove's coalesced list (1 = the browser buffered nothing between frames).
  // Surfaced on the input-debug overlay so a device can prove whether sub-frame samples ever arrive.
  const lastCoalescedCountRef = useRef(1);
  // Latest CLIENT position of the pen WHILE IT IS DOWN (null when no pen is down). On this hardware the
  // pen inks THROUGH Fabric's raw touch stream; at pen-down this is the raw pointerdown position the
  // pen's own twin touchstart is identified against (isPenTwinTouchStart, with penDownAtRef). Kept fresh
  // on pen down/move/rawupdate, cleared on the last pen release.
  const lastPenClientPointRef = useRef<{ x: number; y: number } | null>(null);
  // Previous PointerEvent.buttons bitmask per pen pointerId, so we can diff for rising/falling edges
  // of the barrel-button bits across down/move/up events.
  const penButtonsPrevButtonsRef = useRef<Map<number, number>>(new Map());
  // Wall-clock ms of the last PEN event (down/move/HOVER/up). The PALM GUARD rejects any touch within
  // PEN_PALM_REJECT_MS of this — the time window (not contact size) that catches a palm resting while the
  // pen tip is off the glass (activePen === 0). Refreshed on hover so it stays warm between strokes.
  const lastPenActivityAtRef = useRef(0);
  // --- Stranded-touch-state self-heal watchdog state (see STALE_POINTER_MS / INPUT_IDLE_RECOVERY_MS) ---
  // Wall-clock ms of the last pen/touch/mouse event this hook saw. The interval backstop only reaps once
  // this is INPUT_IDLE_RECOVERY_MS stale, so recovery never fights a burst of real input.
  const lastInputActivityAtRef = useRef(0);
  // How many times the reaper has actually cleared stranded touch state (surfaced in the input-debug
  // overlay so an on-device screenshot proves the self-heal fired).
  const inputRecoveryCountRef = useRef(0);
  // Human-readable label of the most recent input/recovery event, for the input-debug overlay.
  const lastInputEventRef = useRef<string>('idle');
  // Points at publishInputDebug once it is defined, so applyCanvasToolState (declared earlier) can
  // publish a fresh snapshot on every tool-state recompute without a forward reference.
  const publishInputDebugRef = useRef<((lastEvent?: string) => void) | null>(null);
  // True once a REAL stylus (pointerType 'pen') has ever been used this session (persisted). This is the
  // "PEN DEVICE" signal for the deterministic touch model: on a pen device a single finger PANS; on a
  // touch-only panel (ViewSonic — capacitive pen reports as 'touch', never fires 'pen') it stays false so
  // a single finger DRAWS.
  const hasSeenRealPenRef = useRef(false);
  // Latch (and persist) that a real stylus exists so the pen-device model applies from the next launch's
  // first frame, not only after the pen is used again this session.
  const markRealPenSeen = useCallback(() => {
    if (!hasSeenRealPenRef.current) {
      hasSeenRealPenRef.current = true;
      persistHasSeenPen();
    }
  }, []);

  // The ONLY raw touches Fabric may consume on a pen device: the pen's twin (established at touchstart),
  // a 'finger-draws' session's own contact, or a contact the browser itself labels 'stylus' (WebKit).
  // Shared by the container's capture-phase guard and by the patch on Fabric's DOCUMENT-level handlers.
  const isFabricAllowedTouch = useCallback(
    (touch: Touch) =>
      penTwinTouchIdentifiersRef.current.has(touch.identifier) ||
      fingerDrawTouchIdentifierRef.current === touch.identifier ||
      (touch as Touch & { touchType?: string }).touchType === 'stylus',
    [],
  );

  // Whether TOUCH input should be ROUTED as a "pen device" (single finger PANS by default;
  // blockTouchFromFabricOnPenDevice's raw-touch block applies) vs a "touch-only" device (single finger
  // DRAWS via the dual-tip/single-finger-pan contact-size model). This is the ONLY thing `touchInputMode`
  // changes about routing:
  //   - 'auto' (default): exactly hasSeenRealPenRef, unchanged from the original deterministic model.
  //   - 'capacitive-pen': FORCES touch-only routing regardless of hasSeenRealPenRef — for a device with a
  //     purely capacitive stylus (reports as 'touch', never fires a real 'pen' event) that still needs
  //     the size-based classification, independent of the (unrelated) screen-recording deviceMode.
  //   - 'finger-draws' does NOT change this value (a real pen device is still routed as a pen device);
  //     it only changes what a lone, non-palm-rejected finger does INSIDE that branch — see
  //     handlePointerDown and blockTouchFromFabricOnPenDevice's finger-drawing passthrough.
  const isRoutedAsPenDevice = useCallback(
    () => hasSeenRealPenRef.current && tabletInputSettingsRef.current.touchInputMode !== 'capacitive-pen',
    [],
  );

  // On mount: adopt the persisted "a real stylus was seen HERE" flag so the pen-device touch model is
  // live from the first frame. It is set ONLY by an OBSERVED pointerType==='pen' event (markRealPenSeen).
  useEffect(() => {
    if (readPersistedHasSeenPen()) {
      hasSeenRealPenRef.current = true;
    }

    refreshInputTraceEnabled();
  }, []);

  const isDrawingShapeRef = useRef(false);
  const isObjectErasingRef = useRef(false);
  const shapeStartPointRef = useRef<Point | null>(null);
  const activeShapeRef = useRef<FabricObject | null>(null);
  const isPanningRef = useRef(false);
  const lastPanPointRef = useRef<Point | null>(null);
  // Pending PEN_STROKE_END_FAILSAFE_MS timer (armed on last-pen-up, disarmed by the next pen-down check).
  const penStrokeEndFailsafeTimerRef = useRef<number | null>(null);
  const laserDotRef = useRef<Circle | null>(null);
  const laserTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track custom event handlers so we can remove them by reference
  const customHandlersRef = useRef<CustomListenerEntry[]>([]);

  activeToolRef.current = activeTool;
  strokeSettingsRef.current = strokeSettings;
  eraserModeRef.current = eraserMode;
  eraserSizeRef.current = eraserSize;
  tabletInputSettingsRef.current = tabletInputSettings;
  fillColorRef.current = fillColor;
  shapeStyleRef.current = shapeStyle;
  zoomLockedRef.current = zoomLocked;
  onObjectModifiedRef.current = onObjectModified;
  onShortcutColorCycleRef.current = onShortcutColorCycle;
  onShortcutColorToggleRef.current = onShortcutColorToggle;
  onShortcutToolToggleRef.current = onShortcutToolToggle;
  onShortcutQuickMenuRef.current = onShortcutQuickMenu;
  onShortcutUndoRef.current = onShortcutUndo;
  onNativePenPointRef.current = onNativePenPoint;
  onViewportCommitRef.current = onViewportCommit;
  onZoomCommitRef.current = onZoomCommit;
  onCanvasResizeRef.current = onCanvasResize;

  /**
   * Remove all custom listeners tracked in customHandlersRef, by reference.
   * This avoids the blanket `canvas.off('event')` call that would destroy
   * Fabric.js internal listeners.
   */
  function cleanupCustomListeners() {
    for (const entry of customHandlersRef.current) {
      entry.remove();
    }

    customHandlersRef.current = [];
  }

  /**
   * Add a custom listener to the canvas and track it for later cleanup.
   * The `remove` closure captures the correctly-typed `.off()` call at
   * registration time so we never need to pass a bare `string` to `.off()`.
   */
  function addCustomMouseDown(c: Canvas, handler: (opt: DownEventInfo) => void) {
    c.on('mouse:down', handler);
    customHandlersRef.current.push({ event: 'mouse:down', handler, remove: () => c.off('mouse:down', handler) });
  }

  function addCustomMouseMove(c: Canvas, handler: (opt: MoveEventInfo) => void) {
    c.on('mouse:move', handler);
    customHandlersRef.current.push({ event: 'mouse:move', handler, remove: () => c.off('mouse:move', handler) });
  }

  function addCustomMouseUp(c: Canvas, handler: (opt: UpEventInfo) => void) {
    c.on('mouse:up', handler);
    customHandlersRef.current.push({ event: 'mouse:up', handler, remove: () => c.off('mouse:up', handler) });
  }

  function addCustomPathCreated(c: Canvas, handler: () => void) {
    c.on('path:created', handler);
    customHandlersRef.current.push({ event: 'path:created', handler, remove: () => c.off('path:created', handler) });
  }

  /**
   * Keep the object-erase spatial index in step with the object set: each added / removed / modified
   * object is applied on its own (no rebuild per erased stroke), a cleared canvas rebuilds. Registered
   * via the same tracked-listener mechanism as the pointer handlers so it is cleaned up alongside them.
   */
  function setupObjectHitIndexInvalidation(c: Canvas) {
    const added = ({ target }: { target: FabricObject }) => objectHitIndex.noteAdded(target);
    const removed = ({ target }: { target: FabricObject }) => objectHitIndex.noteRemoved(target);
    const modified = ({ target }: { target?: FabricObject }) => {
      if (target) objectHitIndex.noteModified(target);
      else objectHitIndex.markDirty();
    };
    const cleared = () => objectHitIndex.markDirty();

    // A fresh listener set means a canvas we have not been following: start from its list.
    objectHitIndex.markDirty();
    c.on('object:added', added);
    c.on('object:removed', removed);
    c.on('object:modified', modified);
    c.on('canvas:cleared', cleared);
    customHandlersRef.current.push({
      event: 'object:added',
      handler: added,
      remove: () => {
        c.off('object:added', added);
        c.off('object:removed', removed);
        c.off('object:modified', modified);
        c.off('canvas:cleared', cleared);
      },
    });
  }

  const resolveEffectiveTool = useCallback(
    (): WhiteboardTool =>
      // A live touch pan/zoom forces 'pan'; a held Space/E keyboard shortcut overrides too; otherwise the
      // toolbar's active tool.
      touchOverrideToolRef.current ??
      penButtonOverrideToolRef.current ??
      keyboardOverrideToolRef.current ??
      activeToolRef.current,
    [],
  );

  const getOrCreatePenBrush = useCallback((c: Canvas) => {
    if (!penBrushRef.current || penBrushRef.current.canvas !== c) {
      const brush = new LowLatencyPencilBrush(c);

      brush.strokeInterceptor = strokeInterceptorRef.current;
      brush.inkContrast = inkContrastRef.current;
      penBrushRef.current = brush;
    }

    return penBrushRef.current;
  }, []);

  const getOrCreateHighlighterBrush = useCallback((c: Canvas) => {
    if (!highlighterBrushRef.current || highlighterBrushRef.current.canvas !== c) {
      const brush = new LowLatencyPencilBrush(c);

      brush.strokeInterceptor = strokeInterceptorRef.current;
      highlighterBrushRef.current = brush;
    }

    return highlighterBrushRef.current;
  }, []);

  const getOrCreateCalligraphyBrush = useCallback((c: Canvas) => {
    if (!calligraphyBrushRef.current || calligraphyBrushRef.current.canvas !== c) {
      const brush = new CalligraphyBrush(c);

      brush.strokeInterceptor = strokeInterceptorRef.current;
      brush.inkContrast = inkContrastRef.current;
      calligraphyBrushRef.current = brush;
    }

    return calligraphyBrushRef.current;
  }, []);

  const getOrCreateSoftMarkerBrush = useCallback((c: Canvas) => {
    if (!softMarkerBrushRef.current || softMarkerBrushRef.current.canvas !== c) {
      const brush = new SoftMarkerBrush(c);

      brush.strokeInterceptor = strokeInterceptorRef.current;
      brush.inkContrast = inkContrastRef.current;
      softMarkerBrushRef.current = brush;
    }

    return softMarkerBrushRef.current;
  }, []);

  const getOrCreateScriptBrush = useCallback((c: Canvas) => {
    if (!scriptBrushRef.current || scriptBrushRef.current.canvas !== c) {
      const brush = new ScriptBrush(c);

      brush.strokeInterceptor = strokeInterceptorRef.current;
      brush.inkContrast = inkContrastRef.current;
      scriptBrushRef.current = brush;
    }

    return scriptBrushRef.current;
  }, []);

  const getOrCreateEraserBrush = useCallback((c: Canvas) => {
    if (!eraserBrushRef.current || eraserBrushRef.current.canvas !== c) {
      eraserBrushRef.current = new LiveEraserBrush(c);
    }

    return eraserBrushRef.current;
  }, []);

  // Centroid of all RAW touch contacts — where the whole-hand eraser erases when driven by a real palm.
  // Returns null when no contacts are tracked. (The erase geometry uses computeWholeHandEraserCircle,
  // which derives the same centroid plus the spread-sized diameter; this exposes the bare centroid.)
  const getRawTouchCentroid = useCallback((): TouchPoint | null => {
    const points = Array.from(rawTouchContactsRef.current.values());

    if (points.length === 0) {
      return null;
    }

    let sumX = 0;
    let sumY = 0;

    for (const point of points) {
      sumX += point.x;
      sumY += point.y;
    }

    return { x: sumX / points.length, y: sumY / points.length };
  }, []);

  // Keep the freehand brushes' jitter filter in sync when the setting changes mid-session
  // (the tool-switch effect only re-applies it when the active tool changes).
  useEffect(() => {
    const decimate = resolvePenJitterDecimate(tabletInputSettings.penJitterFilter);

    if (penBrushRef.current) {
      penBrushRef.current.decimate = decimate;
    }

    if (highlighterBrushRef.current) {
      highlighterBrushRef.current.decimate = decimate;
    }

    if (calligraphyBrushRef.current) {
      calligraphyBrushRef.current.decimate = decimate;
    }

    if (softMarkerBrushRef.current) {
      softMarkerBrushRef.current.decimate = decimate;
    }

    if (scriptBrushRef.current) {
      scriptBrushRef.current.decimate = decimate;
    }
  }, [tabletInputSettings.penJitterFilter]);

  const getTouchPanZoomToleranceFactor = useCallback(() => {
    const tolerance = tabletInputSettingsRef.current.touchPanZoomTolerance;

    return (
      (typeof tolerance === 'number' && Number.isFinite(tolerance)
        ? tolerance
        : DEFAULT_TABLET_INPUT_SETTINGS.touchPanZoomTolerance) / 100
    );
  }, []);

  // Lift the drawn point up by a constant so ink lands at the nib, not below it. Works for any
  // pointer type (real stylus or pen-reported-as-touch).
  //
  // The event mutation below is kept because our OWN handlers downstream read the corrected
  // coordinates — but it is not what moves the ink. See penPointerOffsetRef: Fabric never reads this
  // PointerEvent, so the offset has to be handed to it separately.
  const applyPenVerticalDrawOffset = useCallback((event: PointerEvent) => {
    if (PEN_VERTICAL_DRAW_OFFSET_PX === 0) {
      penPointerOffsetRef.current = { x: 0, y: 0 };

      return;
    }

    const deltaY = -PEN_VERTICAL_DRAW_OFFSET_PX;

    penPointerOffsetRef.current = { x: 0, y: deltaY };

    try {
      Object.defineProperties(event, {
        clientY: { configurable: true, value: event.clientY + deltaY },
        pageY: { configurable: true, value: event.pageY + deltaY },
        screenY: { configurable: true, value: event.screenY + deltaY },
      });
    } catch {
      // Some browsers expose pointer coordinates as non-configurable fields.
    }
  }, []);

  /**
   * Drop the nib correction the moment the pen is no longer the thing being resolved.
   *
   * This MUST be called from every release path. The correction lives in a ref because Fabric resolves a
   * DIFFERENT event object than the PointerEvent it was computed from, and a ref that is only ever
   * written on pen-down is a ref that stays applied forever: after one stroke, every later click, drag,
   * marquee origin and caret placement — with the pen, a finger, or a mouse — would be silently displaced
   * by the pen's last nib/tilt offset. It also feeds the whole-hand eraser, which resolves a synthetic
   * MouseEvent through the same funnel, so a stale value moves the erase circle off the palm.
   */
  const clearPenPointerOffset = useCallback(() => {
    const current = penPointerOffsetRef.current;

    if (current.x !== 0 || current.y !== 0) {
      penPointerOffsetRef.current = { x: 0, y: 0 };
    }
  }, []);

  /**
   * Feed the open stroke every sub-frame sample the digitizer produced since the last frame.
   *
   * This is the piece that was missing. The brush cannot read them itself — `getCoalescedEvents()` lives
   * only on `PointerEvent`, and Fabric is deliberately bound to the raw touch / compat-mouse stream here
   * so a resting palm can be starved out of it. So the samples have to be handed over from a handler that
   * actually receives the PointerEvent, which is this one.
   *
   * Called from CAPTURE phase, so the intermediate samples land BEFORE Fabric processes its own event for
   * the same frame and the points stay in chronological order. The last coalesced entry IS that event, so
   * it is dropped here rather than committed twice.
   *
   * ONLY for the contact that is actually drawing. A second finger firing moves during a stroke would
   * otherwise push its own coordinates into the teacher's line — the palm-contamination failure this
   * hardware exists to avoid.
   */
  // Returns the PEN frame's verdict (see the lift-tail block below): 'lift' when a sample showed the tip
  // switch open — the caller, which can reach commitInterruptedFreehandStroke, closes the stroke before
  // Fabric's own twin touchmove for this frame could append the lifted position; 'skip' when the frame's
  // own sample is a tip-leaving one Fabric must not append either. Always 'contact' for touch.
  const injectCoalescedSamples = useCallback((c: Canvas, event: PointerEvent): PenSampleVerdict => {
    const drawingCanvas = c as Canvas & { _isCurrentlyDrawing?: boolean };

    if (!drawingCanvas.isDrawingMode || !drawingCanvas._isCurrentlyDrawing) {
      return 'contact';
    }

    // Belt and braces for the touch-only panels: when Fabric is already drawing from this contact but the
    // drawing-pointer ref was never set for it (a routing edge on the ViewSonic's IR pen), the lone primary
    // touch contact IS the stroke. The single-contact guard keeps a resting palm out, exactly as before.
    const isLoneTouchStroke =
      event.pointerType === 'touch' &&
      event.isPrimary &&
      touchDrawingPointerIdRef.current === null &&
      activeTouchPointersRef.current.size <= 1 &&
      rawTouchContactsRef.current.size <= 1;

    const isDrawingContact =
      event.pointerType === 'pen'
        ? activePenPointersRef.current.has(event.pointerId)
        : touchDrawingPointerIdRef.current === event.pointerId || isLoneTouchStroke;

    if (!isDrawingContact) {
      return 'contact';
    }

    const brush = c.freeDrawingBrush as (LowLatencyPencilBrush & { appendCoalescedSample?: unknown }) | undefined;
    const canAppend = !!brush && typeof brush.appendCoalescedSample === 'function';
    const samples = selectCoalescedSamples(event);

    lastCoalescedCountRef.current = samples?.length ?? 1;

    // THE LIFT TAIL (pen only): the digitizer keeps reporting the pen for a frame or two after it leaves
    // the glass — pressure 0 with the contact bit still set, or the bit already clear in a coalesced
    // sample — BEFORE the stroke-ending event reaches Fabric. Those samples are where a pen that has
    // already lifted is, not ink; appending them (here, or by Fabric from this frame's own twin touchmove)
    // draws the short tail past the real lift point. Walk every sample of this frame, dispatched event
    // included (splitPenFrame): append only the in-contact ones; a pressure-0 sample is SKIPPED, never
    // appended, but only a clear contact bit is a LIFT that closes the stroke — a flaky pressure reading
    // mid-letter must cost at most a sample, never the rest of the letter. Predicted samples are never
    // read anywhere.
    const lastIndex = samples ? samples.length - 1 : 0;
    let appendIndices: number[] = samples ? Array.from({ length: lastIndex }, (_, index) => index) : [];
    let verdict: PenSampleVerdict = 'contact';

    if (event.pointerType === 'pen') {
      let pressureState = penContactPressureRef.current.get(event.pointerId);

      if (!pressureState) {
        pressureState = { pressureSeen: false };
        penContactPressureRef.current.set(event.pointerId, pressureState);
      }

      const split = splitPenFrame(samples ?? [event], pressureState);

      verdict = split.verdict;
      // The last sample is the dispatched event: Fabric appends that one itself (from its twin touchmove).
      appendIndices = split.contactIndices.filter((index) => index < lastIndex);
    }

    // Pen pressure for the script nib (the only brush that reads it). Each appended sample carries its
    // own; the dispatched event's goes in last, for the point Fabric is about to add from its twin event.
    // Pen only: a finger's or mouse's "pressure" is not something the ink should follow.
    const isPen = event.pointerType === 'pen';
    const notePressure = () => {
      if (isPen && brush && typeof brush.notePressure === 'function') brush.notePressure(event.pressure);
    };

    if (!samples || !canAppend || appendIndices.length === 0) {
      notePressure();

      return verdict;
    }

    // Resolve through Fabric's own (patched) pointer funnel so these points get the identical transform —
    // and the identical pen nib/tilt correction — as the sample Fabric is about to resolve itself.
    const pointerCanvas = c as unknown as {
      _getPointerImpl: (e: PointerEvent, fromViewport?: boolean) => Point;
    };

    if (typeof pointerCanvas._getPointerImpl !== 'function') {
      notePressure();

      return verdict;
    }

    for (let i = 0; i < appendIndices.length; i += 1) {
      const sample = samples[appendIndices[i]];

      brush.appendCoalescedSample(pointerCanvas._getPointerImpl(sample), isPen ? sample.pressure : undefined);
    }

    notePressure();

    return verdict;
  }, []);

  const applyPenTiltOffset = useCallback(
    (event: PointerEvent) => {
      if (event.pointerType !== 'pen') {
        // A finger or a mouse must never inherit the pen's nib correction.
        penPointerOffsetRef.current = { x: 0, y: 0 };

        return;
      }

      applyPenVerticalDrawOffset(event);

      const offset = tabletInputSettingsRef.current.penTiltOffset;

      if (typeof offset !== 'number' || !Number.isFinite(offset) || Math.abs(offset) < 0.01) {
        return;
      }

      const tiltX = typeof event.tiltX === 'number' && Number.isFinite(event.tiltX) ? event.tiltX : 0;
      const tiltY = typeof event.tiltY === 'number' && Number.isFinite(event.tiltY) ? event.tiltY : 0;
      const tiltLength = Math.hypot(tiltX, tiltY);

      if (tiltLength < STYLUS_TILT_OFFSET_MIN_ANGLE) {
        return;
      }

      const deltaX = -(tiltX / tiltLength) * offset;
      const deltaY = -(tiltY / tiltLength) * offset;

      penPointerOffsetRef.current = {
        x: penPointerOffsetRef.current.x + deltaX,
        y: penPointerOffsetRef.current.y + deltaY,
      };

      try {
        Object.defineProperties(event, {
          clientX: { configurable: true, value: event.clientX + deltaX },
          clientY: { configurable: true, value: event.clientY + deltaY },
          pageX: { configurable: true, value: event.pageX + deltaX },
          pageY: { configurable: true, value: event.pageY + deltaY },
          screenX: { configurable: true, value: event.screenX + deltaX },
          screenY: { configurable: true, value: event.screenY + deltaY },
        });
      } catch {
        // Some browsers expose pointer coordinates as non-configurable fields.
      }
    },
    [applyPenVerticalDrawOffset],
  );

  const isObjectEraserToolActive = useCallback(
    (tool: WhiteboardTool) =>
      // The whole-hand (palm) eraser always does a PARTIAL wipe, never object-delete — so a live
      // whole-hand pass is NEVER object-mode. The normal eraser honours its menu setting.
      tool === 'eraser' && wholeHandEraserSessionRef.current === null && eraserModeRef.current === 'object',
    [],
  );

  const cancelScheduledTouchViewportUpdate = useCallback(() => {
    if (touchViewportFrameRef.current !== null) {
      window.cancelAnimationFrame(touchViewportFrameRef.current);
      touchViewportFrameRef.current = null;
    }

    pendingTouchViewportUpdateRef.current = {
      absoluteZoom: null,
      center: null,
      deltaX: 0,
      deltaY: 0,
      scale: 1,
      zoomAnchor: null,
    };
  }, []);

  // Trailing-throttle the React zoom state so the toolbar % and PDF render resolution still track a
  // gesture without a setState (and full editor re-render) on every frame. Re-arms per change; the
  // last change's flush lands the final zoom ~140ms after motion stops.
  const syncZoomStateSoon = useCallback((nextZoom: number) => {
    pendingZoomSyncRef.current = nextZoom;

    if (zoomSyncTimerRef.current !== null) {
      return;
    }

    zoomSyncTimerRef.current = window.setTimeout(() => {
      zoomSyncTimerRef.current = null;

      const pendingZoom = pendingZoomSyncRef.current;

      if (pendingZoom !== null) {
        pendingZoomSyncRef.current = null;
        setZoomState(pendingZoom);
      }
    }, 140);
  }, []);

  /** Drop the cached pointer geometry. Called from everything that can move the canvas element. */
  const invalidatePointerGeometry = useCallback(() => {
    pointerGeometryRef.current = null;
  }, []);

  /**
   * Apply a canvas resize that was postponed because a stroke was in flight (see handleResize).
   *
   * Called from every release path. A no-op unless a resize was actually deferred, so the common case
   * costs one boolean read.
   */
  const flushDeferredResize = useCallback(() => {
    if (!deferredResizeRef.current) return;

    deferredResizeRef.current = false;
    // NEXT frame, not now: our capture-phase release handler runs BEFORE Fabric's own touchend/mouseup
    // closes the path, so resizing here would still wipe a live bitmap — the exact thing the deferral
    // exists to avoid. The ref is nulled on canvas teardown, so a board closed in between applies nothing.
    window.requestAnimationFrame(() => runDeferredResizeRef.current?.());
  }, []);

  // Cached canvas screen rect (invariant under Fabric viewport transforms). Recomputed only after a
  // resize/scroll invalidated viewportBoundsRef, never per gesture frame.
  const getCanvasBounds = useCallback(
    (_c: Canvas): DOMRect | null => {
      let bounds = viewportBoundsRef.current;

      if (!bounds) {
        // Measure the OUTER container, not the canvas — the canvas now lives inside the zoom-preview
        // wrapper, so during an active gesture its getBoundingClientRect would be CSS-transformed
        // (wrong anchor). The container is a sibling of the wrapper and never transformed; at rest the
        // canvas fills it, so their rects match.
        bounds = containerRef.current?.getBoundingClientRect() ?? null;
        viewportBoundsRef.current = bounds;
      }

      return bounds;
    },
    [containerRef],
  );

  // --- Zoom/pan CSS preview (see zoomPreviewRef) ---
  const applyZoomPreviewStyle = useCallback(() => {
    const layer = zoomLayerRef?.current;
    const preview = zoomPreviewRef.current;

    if (!layer || !preview) return;

    layer.style.transformOrigin = `${preview.anchorX}px ${preview.anchorY}px`;
    layer.style.willChange = 'transform';
    layer.style.transform =
      preview.panX !== 0 || preview.panY !== 0
        ? `translate(${preview.panX}px, ${preview.panY}px) scale(${preview.scale})`
        : `scale(${preview.scale})`;
    // The canvas lives INSIDE this layer, so its client rect just moved — see pointerGeometryRef.
    // Once per preview frame, and only while a gesture is live (a stroke never runs this).
    invalidatePointerGeometry();
  }, [invalidatePointerGeometry, zoomLayerRef]);

  const scheduleZoomPreviewStyle = useCallback(() => {
    if (zoomPreviewFrameRef.current !== null) return;

    zoomPreviewFrameRef.current = window.requestAnimationFrame(() => {
      zoomPreviewFrameRef.current = null;
      applyZoomPreviewStyle();
    });
  }, [applyZoomPreviewStyle]);

  const resetZoomPreviewStyle = useCallback(() => {
    const layer = zoomLayerRef?.current;

    if (layer) {
      layer.style.transform = '';
      layer.style.willChange = '';
      // The canvas snapped back out of the CSS transform — its client rect moved again.
      invalidatePointerGeometry();
    }
  }, [invalidatePointerGeometry, zoomLayerRef]);

  // Commit the previewed zoom/pan to Fabric and re-rasterize crisply, then drop the CSS transform —
  // all in ONE synchronous block, so there is never a frame where the CSS scale and the real Fabric
  // zoom are both applied (a double transform) or neither (a jump). No-op when no preview is active.
  const commitZoomPreview = useCallback(
    (c: Canvas) => {
      if (zoomPreviewFrameRef.current !== null) {
        window.cancelAnimationFrame(zoomPreviewFrameRef.current);
        zoomPreviewFrameRef.current = null;
      }

      if (zoomCommitTimerRef.current !== null) {
        window.clearTimeout(zoomCommitTimerRef.current);
        zoomCommitTimerRef.current = null;
      }

      const preview = zoomPreviewRef.current;

      if (!preview) return;

      zoomPreviewRef.current = null;

      // The canvas can be disposed before a trailing/cleanup commit fires (board swap, unmount mid-
      // gesture). Drop the CSS preview and bail rather than calling into a torn-down Fabric instance.
      if ((c as Canvas & { lowerCanvasEl?: HTMLCanvasElement | null }).lowerCanvasEl == null) {
        resetZoomPreviewStyle();

        return;
      }

      if (preview.mode === 'zoom') {
        const target = clampZoomValue(preview.baseZoom * preview.scale);

        if (Math.abs(target - c.getZoom()) > 0.0001) {
          c.zoomToPoint(new Point(preview.anchorX, preview.anchorY), target);
          syncZoomStateSoon(target);
          // Report the committed zoom against the LIVE canvas value (not the throttled React state),
          // so the owner can re-rasterize the PDF at the new zoom. Firing here — inside the actual
          // canvas-zoom application — means the owner's zoom never diverges from the canvas and there
          // is no equality bail-out or cross-page debounce window.
          onZoomCommitRef.current?.(target);
        }
      }

      if (preview.panX !== 0 || preview.panY !== 0) {
        c.relativePan(new Point(preview.panX, preview.panY));
      }

      // A zoom about an anchor near a page edge can leave the page short of the canvas edge; the pan
      // preview is already clamped, so this only ever corrects that.
      constrainViewport(c);

      // Remove the CSS preview FIRST, then synchronously render the real viewport, so the layer never
      // shows the CSS scale stacked on top of the committed Fabric zoom.
      resetZoomPreviewStyle();
      c.renderAll();
      // Re-rasterize the separate background/PDF/overlay canvases in this SAME frame (they were only
      // CSS-scaled during the preview) so the crisp background lands with the ink — no 1-frame flash.
      onViewportCommitRef.current?.();
    },
    [clampZoomValue, constrainViewport, resetZoomPreviewStyle, syncZoomStateSoon],
  );

  const scheduleZoomCommit = useCallback(
    (c: Canvas) => {
      if (zoomCommitTimerRef.current !== null) {
        window.clearTimeout(zoomCommitTimerRef.current);
      }

      zoomCommitTimerRef.current = window.setTimeout(() => {
        zoomCommitTimerRef.current = null;
        commitZoomPreview(c);
      }, ZOOM_COMMIT_DELAY_MS);
    },
    [commitZoomPreview],
  );

  const applyPendingTouchViewportUpdate = useCallback(
    (c: Canvas) => {
      const pending = pendingTouchViewportUpdateRef.current;

      touchViewportFrameRef.current = null;
      pendingTouchViewportUpdateRef.current = {
        absoluteZoom: null,
        center: null,
        deltaX: 0,
        deltaY: 0,
        scale: 1,
        zoomAnchor: null,
      };

      const hasAbsoluteZoom = pending.absoluteZoom != null && pending.zoomAnchor != null;

      if (!hasAbsoluteZoom && !pending.center) {
        return;
      }

      // Cached container rect (invariant under Fabric viewport transforms AND the CSS preview, since the
      // container is outside the transformed wrapper) — recomputed only after resize/scroll, never/frame.
      const bounds = getCanvasBounds(c);

      if (!bounds) {
        return;
      }

      // Zoom mode: an absolute, baseline-relative target zoom anchored at the FIXED pinch midpoint (no
      // pan, no moving anchor) — keeps a pinch from breathing. Previewed via a GPU CSS scale; the real
      // Fabric zoom + re-raster happen ONCE on settle (commit), so the pinch runs at compositor speed.
      if (hasAbsoluteZoom && pending.zoomAnchor) {
        const anchorX = pending.zoomAnchor.x - bounds.left;
        const anchorY = pending.zoomAnchor.y - bounds.top;

        if (!zoomPreviewRef.current || zoomPreviewRef.current.mode !== 'zoom') {
          commitZoomPreview(c);
          zoomPreviewRef.current = {
            mode: 'zoom',
            anchorX,
            anchorY,
            baseZoom: c.getZoom(),
            scale: 1,
            panX: 0,
            panY: 0,
          };
        }

        const preview = zoomPreviewRef.current;
        const target = clampZoomValue(pending.absoluteZoom as number);

        preview.scale = target / preview.baseZoom;
        scheduleZoomPreviewStyle();
        scheduleZoomCommit(c);

        return;
      }

      if (!pending.center) {
        return;
      }

      if (panAxisLockEnabledRef.current) {
        const locked = filterPanDelta(panAxisLockStateRef.current, pending.deltaX, pending.deltaY);

        pending.deltaX = locked.dx;
        pending.deltaY = locked.dy;
      }

      // Direct pan (continuous PDF layout): move the real viewport this frame so pages scrolling into
      // view are painted as they arrive. The after:render listeners (background repaint, persistence)
      // see the move exactly as they see a hand-tool pan; a preview in flight (a pinch that just
      // ended) is committed first so the two never stack.
      if (directTouchPanRef?.current) {
        if (zoomPreviewRef.current) {
          commitZoomPreview(c);
        }

        // Whole device pixels per frame, the remainder carried to the next: the ink bake can then shift
        // its bitmap by an exact pixel copy and paint only the revealed strip, instead of re-rendering
        // every stroke on screen each frame (see `bakeTranslation` in utils/inkBake.ts). Sub-pixel
        // carry is invisible; the total distance is unchanged.
        const step = snapPanStep(pending.deltaX, pending.deltaY, c.getRetinaScaling(), directPanCarryRef.current);

        directPanCarryRef.current = step.carry;

        if (step.x !== 0 || step.y !== 0) {
          const before = c.viewportTransform ? [...c.viewportTransform] : null;

          c.relativePan(new Point(step.x, step.y));
          constrainViewport(c);
          directPanBlockedRef.current = isSameViewportTransform(before ?? undefined, c.viewportTransform);
          c.requestRenderAll();
        }

        return;
      }

      // Pan mode: translation only (pending.scale stays 1). Previewed via CSS translate; committed on
      // settle. The per-frame deltas accumulate into the live preview.
      if (!zoomPreviewRef.current || zoomPreviewRef.current.mode !== 'pan') {
        commitZoomPreview(c);
        zoomPreviewRef.current = {
          mode: 'pan',
          anchorX: 0,
          anchorY: 0,
          baseZoom: c.getZoom(),
          scale: 1,
          panX: 0,
          panY: 0,
        };
      }

      if (pending.deltaX !== 0 || pending.deltaY !== 0) {
        const preview = zoomPreviewRef.current;
        const constraints = viewportConstraintsRef?.current;
        // Clamp the PREVIEW, not just the commit: the finger must stop at the page edge, not drag a
        // blank margin in and have it snap back 90 ms later.
        const zoom = c.getZoom();
        const previewed = [zoom, 0, 0, zoom, (c.viewportTransform?.[4] ?? 0) + preview.panX, (c.viewportTransform?.[5] ?? 0) + preview.panY];
        const delta = constraints
          ? clampPanDelta(previewed, pending.deltaX, pending.deltaY, constraints, c.getWidth(), c.getHeight())
          : { dx: pending.deltaX, dy: pending.deltaY };

        preview.panX += delta.dx;
        preview.panY += delta.dy;
        scheduleZoomPreviewStyle();
      }

      scheduleZoomCommit(c);
    },
    [
      clampZoomValue,
      commitZoomPreview,
      constrainViewport,
      directTouchPanRef,
      getCanvasBounds,
      scheduleZoomCommit,
      scheduleZoomPreviewStyle,
      viewportConstraintsRef,
    ],
  );

  const scheduleTouchViewportUpdate = useCallback(
    (c: Canvas) => {
      if (touchViewportFrameRef.current !== null) {
        return;
      }

      touchViewportFrameRef.current = window.requestAnimationFrame(() => {
        applyPendingTouchViewportUpdate(c);
      });
    },
    [applyPendingTouchViewportUpdate],
  );

  // --- Pan inertia ("sliding") ---
  // After a pan gesture lifts — single finger, two fingers (translation only; the zoom never coasts), or
  // the hand tool — the board keeps sliding with the release velocity and decays like a scroll view
  // (utils/flingPhysics). Touch flings feed the SAME pending-delta → CSS-preview → settle-commit pipeline
  // the live pan uses, so nothing re-renders per frame and the final viewport lands through
  // commitZoomPreview (relativePan + renderAll → the editor's after:render persistence); the hand tool
  // pans Fabric directly, so its fling does too. Cancelled on any pointerdown, wheel, tool change, page
  // change / any external viewport write, and unmount; never started under prefers-reduced-motion.
  // Cancels the ANIMATION only. The velocity window belongs to the gesture: it is reset when a contact
  // lands / a pan starts, and consumed by startFling — never here, because the pan's own teardown
  // (stopTouchPan → tool sync → applyCanvasToolState) cancels on the way to startFling.
  const cancelFling = useCallback(() => {
    const fling = flingRef.current;

    if (!fling) return;

    if (fling.frame !== null) {
      window.cancelAnimationFrame(fling.frame);
    }

    flingRef.current = null;
  }, []);

  cancelFlingRef.current = cancelFling;

  const recordPanSample = useCallback((x: number, y: number, t: number) => {
    panVelocitySamplesRef.current = pushPanSample(
      panVelocitySamplesRef.current,
      { x, y, t },
      FLING_RELEASE_DEFAULTS.windowMs,
    );
  }, []);

  const startFling = useCallback(
    (c: Canvas, releaseT: number, mode: 'hand' | 'touch') => {
      const samples = panVelocitySamplesRef.current;

      panVelocitySamplesRef.current = [];
      cancelFling();

      if (
        typeof window === 'undefined' ||
        (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      ) {
        return;
      }

      const velocity = estimateReleaseVelocity(samples, releaseT);

      if (!velocity) return;

      const fling = { velocity, lastT: performance.now(), frame: null as number | null, mode };

      flingRef.current = fling;

      const step = (now: number) => {
        // Cancelled (or replaced) since this frame was requested.
        if (flingRef.current !== fling) return;

        fling.frame = null;

        // The canvas can be disposed mid-fling (board swap, unmount).
        if ((c as Canvas & { lowerCanvasEl?: HTMLCanvasElement | null }).lowerCanvasEl == null) {
          flingRef.current = null;

          return;
        }

        const result = stepFling(fling.velocity, now - fling.lastT, FLING_TAU_MS, FLING_RELEASE_DEFAULTS.minSpeed);

        fling.lastT = now;
        fling.velocity = result.velocity;

        // A coast that the viewport constraints stop (the page edge) is over: nothing left to slide.
        let blocked = false;

        if (mode === 'hand') {
          flingApplyingRef.current = true;

          try {
            const before = c.viewportTransform ? [...c.viewportTransform] : null;

            c.relativePan(new Point(result.dx, result.dy));
            blocked = constrainViewport(c) && isSameViewportTransform(before ?? undefined, c.viewportTransform);
          } finally {
            flingApplyingRef.current = false;
          }

          c.requestRenderAll();
        } else {
          const pending = pendingTouchViewportUpdateRef.current;

          pending.center = pending.center ?? { x: 0, y: 0 };
          pending.deltaX += result.dx;
          pending.deltaY += result.dy;
          directPanBlockedRef.current = false;
          // Already inside a frame: apply now (CSS translate + re-armed settle commit), no extra rAF hop.
          flingApplyingRef.current = true;

          try {
            applyPendingTouchViewportUpdate(c);
          } finally {
            flingApplyingRef.current = false;
          }

          blocked = directPanBlockedRef.current;
        }

        if (result.done || blocked) {
          flingRef.current = null;

          if (mode === 'touch') {
            // Settle NOW rather than after the commit debounce: the crisp viewport (and its persistence)
            // lands the moment the slide ends.
            flingApplyingRef.current = true;

            try {
              commitZoomPreview(c);
            } finally {
              flingApplyingRef.current = false;
            }
          }

          publishInputDebugRef.current?.('fling end');

          return;
        }

        fling.frame = window.requestAnimationFrame(step);
      };

      fling.frame = window.requestAnimationFrame(step);
      // Declared later in the component — reached through its ref, like applyCanvasToolState does.
      publishInputDebugRef.current?.('fling');
    },
    [applyPendingTouchViewportUpdate, cancelFling, commitZoomPreview, constrainViewport],
  );

  const cancelScheduledObjectErase = useCallback(() => {
    if (objectEraseFrameRef.current !== null) {
      window.cancelAnimationFrame(objectEraseFrameRef.current);
      objectEraseFrameRef.current = null;
    }

    pendingObjectErasePointsRef.current = [];
  }, []);

  const commitInterruptedFreehandStroke = useCallback((c: Canvas) => {
    const drawingCanvas = c as Canvas & { _isCurrentlyDrawing?: boolean };

    if (!drawingCanvas.isDrawingMode || !drawingCanvas._isCurrentlyDrawing) {
      return;
    }

    drawingCanvas._isCurrentlyDrawing = false;

    const brush = c.freeDrawingBrush as
      | (PencilBrush & { _finalizeAndAddPath?: () => void; _reset?: () => void; oldEnd?: unknown })
      | undefined;

    try {
      brush?._finalizeAndAddPath?.();
    } finally {
      if (brush) {
        // Mirror PencilBrush.onMouseUp: _reset() clears _points but NOT oldEnd — the last point the
        // incremental preview renderer drew. A stale oldEnd makes the next stroke's first segment
        // bridge from where the interrupted stroke stopped (the "phantom line").
        brush.oldEnd = undefined;
      }

      brush?._reset?.();

      // _finalizeAndAddPath is Fabric's INTERNAL, not its onMouseUp, so the LiveEraserBrush override
      // never runs and the erase preview's surfaces stay as the erase left them.
      if (brush instanceof LiveEraserBrush) {
        brush.restoreLiveSurface();
      } else if (c.contextTop) {
        // Fabric's own early-out: _finalizeAndAddPath returns BEFORE its clearContext when the stroke
        // was too short to make a path. Whatever the interrupted stroke drew would otherwise sit on
        // contextTop for the whole of the next stroke, and Fabric will not clear it while
        // isDrawingMode is true.
        c.clearContext(c.contextTop);
      }
    }
  }, []);

  const applyCanvasToolState = useCallback(
    (c: Canvas, nextTool = resolveEffectiveTool()) => {
      const lowerCanvasEl = (c as Canvas & { lowerCanvasEl?: HTMLCanvasElement }).lowerCanvasEl;
      const isObjectEraserTool = isObjectEraserToolActive(nextTool);
      const isPartialEraserTool = nextTool === 'eraser' && !isObjectEraserTool;

      // Close any stroke still in flight BEFORE tearing down drawing mode, or it is stranded forever:
      // Fabric routes mouse-up through `isDrawingMode && _isCurrentlyDrawing`, so clearing isDrawingMode
      // below means the brush's onMouseUp — the ONLY thing that clears `oldEnd` and restores the eraser's
      // hidden lower canvas — never runs. A stranded oldEnd makes the next stroke's incremental preview
      // bridge a straight line from where the interrupted stroke stopped to wherever the pen now is, and a
      // stranded erase preview leaves a full-board blit on contextTop that still shows the just-erased
      // ink. Neither is in `_points`, so neither is committed and both vanish on lift.
      //
      // This became a routine path, not an edge case, when the brush/marker buttons moved inside the pen
      // settings popover: that popover stays open while writing, so a mid-stroke tool change is one tap.
      // ONLY on a real tool change. This effect also fires whenever strokeSettings changes identity, and
      // one of those paths is the pen's COLOUR barrel button, which is deliberately designed to latch
      // mid-stroke without changing the tool. Committing there truncated the stroke AND cleared Fabric's
      // `_isCurrentlyDrawing`, after which `_onMouseMoveInDrawingMode` silently dropped every remaining
      // move and pen-up committed nothing — the rest of the teacher's letter was simply gone. Same for
      // the toolbar colour swap, the pen popover's colour/width controls (that popover stays open while
      // writing), and the eraser-size slider mid-erase.
      const isToolChange = appliedToolRef.current !== nextTool;

      if (isToolChange) {
        commitInterruptedFreehandStroke(c);
        // A sliding board must not keep sliding under a tool the teacher just picked.
        cancelFlingRef.current?.();

        // Picking the object eraser: bring its spatial index up to date now, off the tap, rather than
        // on the first erase sample — a rebuild there (one setCoords per object) was the biggest single
        // cost of the first frame of a drag on a dense page.
        if (isObjectEraserTool) {
          window.setTimeout(() => {
            if (!c.destroyed && isObjectEraserToolActive(effectiveToolRef.current)) objectHitIndex.sync(c.getObjects());
          }, 0);
        }
      }

      c.isDrawingMode = false;
      c.selection = false;
      // Only the select tool reads Fabric's hit target. The object eraser never does (every erase goes
      // through the swept-ring test below), yet it used to leave target finding on — a box test of
      // every object on every pen move, paid for nothing on a dense page.
      c.skipTargetFind = nextTool !== 'select';
      c.defaultCursor = 'default';
      c.hoverCursor = 'default';
      isObjectErasingRef.current = false;
      isPanningRef.current = false;
      lastPanPointRef.current = null;

      if (lowerCanvasEl) {
        lowerCanvasEl.style.opacity = '1';
      }

      // contextTop is undefined on a disposed / not-yet-initialized canvas (mount/dispose races,
      // error-boundary recreate, HMR). Guard so syncing the tool state never throws.
      if (c.contextTop) {
        c.clearContext(c.contextTop);
      }

      const nextObjectInteractionMode = nextTool === 'select' ? 'select' : isObjectEraserTool ? 'erase' : 'none';

      if (objectInteractionModeRef.current !== nextObjectInteractionMode) {
        objectInteractionModeRef.current = nextObjectInteractionMode;
        c.forEachObject((obj) => {
          // A pinned image is out of every tool's reach; this per-tool sweep would otherwise hand it
          // back to select/erase the first time the teacher switches tools after pinning.
          if (isLockedImage(obj)) {
            obj.selectable = false;
            obj.evented = false;

            return;
          }

          const isLockedEraserMark = isEraserMark(obj);

          obj.selectable = nextTool === 'select' && !isLockedEraserMark;
          obj.evented = nextObjectInteractionMode !== 'none' && !isLockedEraserMark;
        });
      }

      switch (nextTool) {
        case 'select':
          c.selection = true;
          c.skipTargetFind = false;
          c.defaultCursor = 'default';
          c.hoverCursor = 'move';
          break;

        // `setStrokeColor`, not `color =`: this pass also runs mid-stroke (the colour barrel button, the
        // pen popover's colour swatches), and the smart-contrast adjustment has to follow the new colour.
        case 'pen': {
          const brush = getOrCreatePenBrush(c);

          brush.setStrokeColor(strokeSettingsRef.current.color);
          brush.width = strokeSettingsRef.current.width;
          brush.strokeDashArray = dashArrayFor(strokeSettingsRef.current);
          brush.decimate = resolvePenJitterDecimate(tabletInputSettingsRef.current.penJitterFilter);
          c.freeDrawingBrush = brush;
          c.isDrawingMode = true;
          c.defaultCursor = 'crosshair';
          break;
        }

        // Both new brushes share the pen's colour and width (the teacher's answer when this was added),
        // so they read strokeSettings directly rather than carrying settings of their own.
        case 'brush': {
          // The calligraphy nib commits a filled outline, which can't carry a dash: a dashed stroke
          // draws with the pen's stroked line instead.
          if (strokeSettingsRef.current.dashed) {
            const penBrush = getOrCreatePenBrush(c);

            penBrush.setStrokeColor(strokeSettingsRef.current.color);
            penBrush.width = strokeSettingsRef.current.width;
            penBrush.strokeDashArray = dashArrayFor(strokeSettingsRef.current);
            penBrush.decimate = resolvePenJitterDecimate(tabletInputSettingsRef.current.penJitterFilter);
            c.freeDrawingBrush = penBrush;
            c.isDrawingMode = true;
            c.defaultCursor = 'crosshair';
            break;
          }

          const brush = getOrCreateCalligraphyBrush(c);

          brush.setStrokeColor(strokeSettingsRef.current.color);
          brush.width = strokeSettingsRef.current.width;
          brush.decimate = resolvePenJitterDecimate(tabletInputSettingsRef.current.penJitterFilter);
          c.freeDrawingBrush = brush;
          c.isDrawingMode = true;
          c.defaultCursor = 'crosshair';
          break;
        }

        // Script: gel / fountain ink — a tapered, pressure-breathing monoline (brushes/ScriptBrush.ts).
        // Like the calligraphy nib it commits a filled outline, so a dashed stroke falls back to the pen.
        case 'script': {
          if (strokeSettingsRef.current.dashed) {
            const penBrush = getOrCreatePenBrush(c);

            penBrush.setStrokeColor(strokeSettingsRef.current.color);
            penBrush.width = strokeSettingsRef.current.width;
            penBrush.strokeDashArray = dashArrayFor(strokeSettingsRef.current);
            penBrush.decimate = resolvePenJitterDecimate(tabletInputSettingsRef.current.penJitterFilter);
            c.freeDrawingBrush = penBrush;
            c.isDrawingMode = true;
            c.defaultCursor = 'crosshair';
            break;
          }

          const brush = getOrCreateScriptBrush(c);

          brush.setStrokeColor(strokeSettingsRef.current.color);
          brush.width = strokeSettingsRef.current.width;
          brush.decimate = resolvePenJitterDecimate(tabletInputSettingsRef.current.penJitterFilter);
          c.freeDrawingBrush = brush;
          c.isDrawingMode = true;
          c.defaultCursor = 'crosshair';
          break;
        }

        case 'marker': {
          const brush = getOrCreateSoftMarkerBrush(c);

          brush.setStrokeColor(withAlpha(strokeSettingsRef.current.color, SOFT_MARKER_OPACITY));
          brush.width = strokeSettingsRef.current.width * SOFT_MARKER_WIDTH_SCALE;
          brush.strokeDashArray = dashArrayFor(strokeSettingsRef.current, SOFT_MARKER_WIDTH_SCALE);
          brush.decimate = resolvePenJitterDecimate(tabletInputSettingsRef.current.penJitterFilter);
          c.freeDrawingBrush = brush;
          c.isDrawingMode = true;
          c.defaultCursor = 'crosshair';
          break;
        }

        case 'highlighter': {
          const brush = getOrCreateHighlighterBrush(c);

          brush.color = withAlpha(strokeSettingsRef.current.color, HIGHLIGHTER_OPACITY);
          brush.width = Math.max(strokeSettingsRef.current.width * 4, 24);
          brush.decimate = resolvePenJitterDecimate(tabletInputSettingsRef.current.penJitterFilter);
          c.freeDrawingBrush = brush;
          c.isDrawingMode = true;
          c.defaultCursor = 'crosshair';
          break;
        }

        case 'eraser':
          c.defaultCursor = 'crosshair';

          if (isPartialEraserTool) {
            const brush = getOrCreateEraserBrush(c);

            brush.color = '#000000';
            // A live whole-hand (palm) pass drives the erase circle sized from the finger spread; otherwise
            // the normal eraser size.
            // Both are SCREEN diameters; the brush paints in scene units. The brush re-derives its width
            // from `screenDiameter` at every pen-down, so a zoom change between here and the stroke
            // cannot widen the swath past the ring.
            brush.screenDiameter = wholeHandEraserSessionRef.current?.size ?? eraserSizeRef.current;
            brush.width = eraserSceneDiameter(brush.screenDiameter, c.getZoom());
            c.freeDrawingBrush = brush;
            // A real-palm (manual) whole-hand pass drives the brush itself along the contacts' centroid, so
            // keep Fabric's own drawing OFF (else the palm's many contacts double-drive it). The normal
            // partial eraser keeps Fabric drawing on.
            c.isDrawingMode = wholeHandEraserSessionRef.current?.manual !== true;
          }

          break;

        case 'text':
          c.defaultCursor = 'text';
          break;

        case 'pan':
          c.defaultCursor = 'grab';
          c.hoverCursor = 'grab';
          break;

        case 'image':
          c.defaultCursor = 'copy';
          break;

        default:
          c.defaultCursor = 'crosshair';
          break;
      }

      // Belt to commitInterruptedFreehandStroke's braces. The brushes are cached per canvas and reused
      // for the life of the board, so whichever one is installed here may still be carrying the points
      // and the oldEnd of the last stroke it drew — from a swallowed touchend, or from being swapped out
      // mid-stroke. `_reset()` is the only thing that empties `_points`, and it clears everything except
      // oldEnd, so clear that by hand exactly as PencilBrush.onMouseUp does.
      const nextBrush = c.freeDrawingBrush as
        | (PencilBrush & { _reset?: () => void; oldEnd?: unknown })
        | undefined;

      // _reset() writes brush styles to contextTop, which is undefined on a disposed / not-yet-built
      // canvas — the same race the clear above guards against.
      // Gated on the same flag, and that is load-bearing: the brushes are cached per canvas, so on a
      // same-tool re-apply `nextBrush` IS the brush holding the live stroke. Resetting it there would
      // discard the in-flight points outright — worse than the truncation above, not better.
      if (isToolChange && nextBrush && c.contextTop) {
        nextBrush.oldEnd = undefined;
        nextBrush._reset?.();
      }

      appliedToolRef.current = nextTool;

      c.requestRenderAll();

      // Publish a fresh input-debug snapshot on every tool-state recompute (via a ref so this
      // earlier-declared callback doesn't forward-reference publishInputDebug). Off unless the
      // input-debug overlay is enabled; the publisher itself is cheap.
      publishInputDebugRef.current?.('tool state');
    },
    [
      commitInterruptedFreehandStroke,
      getOrCreateCalligraphyBrush,
      getOrCreateEraserBrush,
      getOrCreateHighlighterBrush,
      getOrCreatePenBrush,
      getOrCreateScriptBrush,
      getOrCreateSoftMarkerBrush,
      isObjectEraserToolActive,
      resolveEffectiveTool,
    ],
  );

  const syncEffectiveTool = useCallback(
    (nextCanvas?: Canvas | null) => {
      const resolvedTool = resolveEffectiveTool();

      effectiveToolRef.current = resolvedTool;
      setEffectiveTool((current) => (current === resolvedTool ? current : resolvedTool));

      if (nextCanvas) {
        applyCanvasToolState(nextCanvas, resolvedTool);
      } else if (canvas) {
        applyCanvasToolState(canvas, resolvedTool);
      }
    },
    [applyCanvasToolState, canvas, resolveEffectiveTool],
  );

  // --- On-device input diagnostic ---
  // Publishes a snapshot of the whole input/override state to `window.__wbInputDebug`, which the gated
  // input-debug overlay in WhiteboardCanvas renders. Keeps the read-side dead simple (poll one object)
  // and stays cheap: it's just field reads + one assignment, called from input handlers, tool-state
  // recomputes, and after each reaper run. `lastEvent` (when supplied) is latched so the overlay shows
  // what most recently drove the state.
  const publishInputDebug = useCallback(
    (lastEvent?: string) => {
      if (typeof window === 'undefined') {
        return;
      }

      if (lastEvent) {
        lastInputEventRef.current = lastEvent;
      }

      (window as unknown as { __wbInputDebug?: unknown }).__wbInputDebug = {
        effTool: resolveEffectiveTool(),
        isDrawingMode: canvas?.isDrawingMode ?? false,
        touchOverride: touchOverrideToolRef.current,
        keyboardOverride: keyboardOverrideToolRef.current,
        touchPanMode: touchPanModeRef.current,
        activePtrs: activeTouchPointersRef.current.size,
        activePen: activePenPointersRef.current.size,
        rawContacts: rawTouchContactsRef.current.size,
        wholeHand: !!wholeHandEraserSessionRef.current,
        multiLock: multiTouchGestureLockRef.current,
        penPalmMs: Math.max(0, PEN_PALM_REJECT_MS - (Date.now() - lastPenActivityAtRef.current)),
        hasSeenRealPen: hasSeenRealPenRef.current,
        touchInputMode: tabletInputSettingsRef.current.touchInputMode,
        routedAsPen: isRoutedAsPenDevice(),
        lastEvent: lastInputEventRef.current,
        recovered: inputRecoveryCountRef.current,
        coalesced: lastCoalescedCountRef.current,
        fling: flingRef.current !== null,
      };
    },
    [canvas, isRoutedAsPenDevice, resolveEffectiveTool],
  );

  // Let applyCanvasToolState (declared earlier) reach publishInputDebug without a forward reference.
  publishInputDebugRef.current = publishInputDebug;

  // Stamp "input just happened" + publish a debug snapshot. Called at the TOP of every pointer/touch/pen
  // /mouse handler this hook binds, so the idle-guard on the interval backstop knows whether any real
  // input is in flight (and never runs recovery mid-burst).
  const noteInputActivity = useCallback(
    (lastEvent: string) => {
      lastInputActivityAtRef.current = Date.now();
      publishInputDebug(lastEvent);
    },
    [publishInputDebug],
  );

  // --- Stranded-touch-state self-heal reaper (the actual fix) ---
  // Remove pointers that are DEMONSTRABLY stale (no event for > STALE_POINTER_MS) and, once no touch
  // pointer remains at all, clear the TOUCH-derived transient state a dropped pointerup/pointercancel
  // would otherwise strand (touchOverride='pan' → isDrawingMode=false → the pen inks nothing). Then it
  // recomputes isDrawingMode from the REAL tool.
  //
  // SAFETY INVARIANT: this can NEVER tear down a live gesture. It only removes a pointer whose
  // `lastSeenAt` is older than `now - STALE_POINTER_MS`; an in-progress draw/pan fires pointermove
  // continuously (<<STALE_POINTER_MS apart) so its `lastSeenAt` stays fresh and it is never reaped —
  // which means the "map empty" branch that clears transient state is unreachable while anything is
  // genuinely happening. Pen/keyboard overrides are intentionally left untouched (a dropped TOUCH
  // release must never disturb a held pen or a Space-pan).
  const recoverIfTouchMapsEmpty = useCallback(() => {
    // BOTH touch maps must be empty: the active (pan/zoom/draw) map AND the raw palm-contact map. A live
    // palm wipe keeps rawTouchContacts non-empty even though activeTouchPointers is cleared for its pass,
    // so gating on both means recovery never tears down a genuinely-live whole-hand session.
    if (activeTouchPointersRef.current.size > 0 || rawTouchContactsRef.current.size > 0) {
      return;
    }

    if (ignoredTouchPointerIdsRef.current.size > 0) {
      ignoredTouchPointerIdsRef.current.clear();
    }

    const hadStrandedTouchState =
      touchOverrideToolRef.current !== null ||
      touchPanModeRef.current !== null ||
      pendingSingleTouchPanRef.current !== null ||
      multiTouchGestureLockRef.current !== null ||
      wholeHandEraserSessionRef.current !== null;

    if (!hadStrandedTouchState) {
      return;
    }

    // End any leaked whole-hand-eraser session cleanly FIRST (commits its open destination-out path), so a
    // dropped palm-release can't strand an open erase pass. Prefer the touch effect's own stop() closure
    // (full teardown); fall back to a minimal reset if the effect has torn down.
    if (wholeHandEraserSessionRef.current) {
      const stop = stopWholeHandEraserRef.current;

      if (stop) {
        stop();
      } else {
        wholeHandEraserSessionRef.current = null;
        setIsWholeHandEraserActive(false);
      }
    }

    // Clear ONLY the TOUCH-derived transient state — never the pen/keyboard overrides.
    touchOverrideToolRef.current = null;
    touchPanModeRef.current = null;
    pendingSingleTouchPanRef.current = null;
    multiTouchGestureLockRef.current = null;

    inputRecoveryCountRef.current += 1;

    // Recompute isDrawingMode from the real tool now the phantom touch override is gone, and mirror the
    // recovered effective tool into React state so the UI (cursor/badge) reflects it.
    syncEffectiveTool(canvas);

    publishInputDebug('reap');
  }, [canvas, publishInputDebug, syncEffectiveTool]);

  // Staleness backstop for the on-pointerdown reap and the idle interval. Removes touch pointers that have
  // gone DEMONSTRABLY stale (a full event drop that even lostpointercapture missed), then recovers if that
  // empties the map. Guard rails that keep it from tearing down a LIVE held gesture:
  //   • unless `ignoreMode`, it does NOT run while a gesture MODE is active (touchPanMode) — a genuinely
  //     stranded pan is recovered precisely by the lostpointercapture handler, and while a mode is live it
  //     means a real (possibly held-still) gesture. `ignoreMode` is passed by the PEN-down path only: a
  //     pen-down is unambiguous intent to draw, and reaping can still only ever remove a STALE touch
  //     phantom (a live pan keeps a FRESH pointer the staleness check never removes), so it safely
  //     un-sticks the pen without disturbing a real gesture;
  //   • it never reaps the active-draw pointer or the pending-single-pan anchor (either can be held still).
  const reapStalePointersAndRecover = useCallback(
    (now: number, ignoreMode = false) => {
      // Unless `ignoreMode`, never run while a live gesture MODE is active — a pan (touchPanMode) OR a
      // whole-hand session — since a genuinely held-still gesture emits no move and would look "stale".
      // A stranded one is recovered precisely by lostpointercapture instead. `ignoreMode` (PEN-down path)
      // can still only remove a STALE phantom, so it safely un-sticks the pen without disturbing a real one.
      if (!ignoreMode && (touchPanModeRef.current !== null || wholeHandEraserSessionRef.current !== null)) {
        return;
      }

      const staleBefore = now - STALE_POINTER_MS;
      const protectedDrawId = touchDrawingPointerIdRef.current;
      const protectedPanId = pendingSingleTouchPanRef.current?.pointerId ?? null;

      // Reap stale ACTIVE (pan/zoom/draw-tracked) touch pointers. Snapshot via Array.from before mutating.
      for (const [id, pointer] of Array.from(activeTouchPointersRef.current.entries())) {
        if (id === protectedDrawId || id === protectedPanId) {
          continue;
        }

        if (pointer.lastSeenAt <= staleBefore) {
          activeTouchPointersRef.current.delete(id);

          // Drop the raw-contact twin of this stale active pointer only if IT is also stale — a live palm
          // wipe refreshes the raw entry while its active twin can freeze; never drop a live contact.
          const rawTwin = rawTouchContactsRef.current.get(id);

          if (!rawTwin || rawTwin.lastSeenAt <= staleBefore) {
            rawTouchContactsRef.current.delete(id);
          }

          ignoredTouchPointerIdsRef.current.delete(id);
        }
      }

      // Reap stale RAW contacts (palm contacts tracked only for the whole-hand eraser), so a dropped
      // palm-release can't strand a phantom contact that keeps the "map empty" recovery from firing.
      for (const [id, contact] of Array.from(rawTouchContactsRef.current.entries())) {
        if (id === protectedDrawId || id === protectedPanId) {
          continue;
        }

        if (contact.lastSeenAt <= staleBefore) {
          rawTouchContactsRef.current.delete(id);
          ignoredTouchPointerIdsRef.current.delete(id);
        }
      }

      recoverIfTouchMapsEmpty();
    },
    [recoverIfTouchMapsEmpty],
  );

  // --- Canvas initialization ---
  useEffect(() => {
    const canvasEl = canvasRef.current;
    const containerEl = containerRef.current;

    if (!canvasEl || !containerEl) return;

    const fabricCanvas = new Canvas(canvasEl, {
      width: containerEl.clientWidth,
      height: containerEl.clientHeight,
      backgroundColor: 'transparent',
      selection: true,
      preserveObjectStacking: true,
      allowTouchScrolling: false,
    });

    // Stable ids on every object (live co-editing matches items by them). Listeners go with the canvas.
    installItemIds(fabricCanvas);

    // --- Any viewport write that is not the fling's own cancels the fling ---
    // Page load, zoom reset, fit-to-page, a wheel zoom's commit: they all land through
    // setViewportTransform (relativePan/zoomToPoint call it too). A fling still coasting across such a
    // write would drag the new viewport away from where it was just put.
    const originalSetViewportTransform = fabricCanvas.setViewportTransform.bind(fabricCanvas);

    fabricCanvas.setViewportTransform = (vpt) => {
      if (flingRef.current !== null && !flingApplyingRef.current) {
        cancelFlingRef.current?.();
      }

      return originalSetViewportTransform(vpt);
    };

    // --- Fabric's DOCUMENT-level touch handlers must not see a palm either ---
    // For a touch-opened stroke Fabric moves touchmove/touchend to the DOCUMENT (_onTouchStart), so a palm
    // that lands OUTSIDE the board container — on the floating toolbar, right where a right-handed
    // writer's hand rests — never passes the container's capture-phase guard yet still reaches those
    // handlers: its touchmove is appended to the pen's open path (a straight line out to the palm) and
    // its touchend can close it. Fabric binds the handlers as own instance properties and reads them at
    // registration time (`addListener(doc, 'touchmove', this._onMouseMove)`), so wrapping them here
    // filters exactly those document listeners; the upper-canvas ones registered at construction keep the
    // originals and stay covered by the container guard. Restored before dispose so Fabric's own removal
    // matches what it registered.
    const fabricHandlers = fabricCanvas as unknown as {
      _onMouseMove: (e: Event) => void;
      _onTouchEnd: (e: TouchEvent) => void;
    };
    const originalOnMouseMove = fabricHandlers._onMouseMove;
    const originalOnTouchEnd = fabricHandlers._onTouchEnd;
    const isStarvedRawTouchEvent = (e: Event): boolean => {
      const touches = (e as TouchEvent).changedTouches;

      if (!touches || !isRoutedAsPenDevice()) {
        return false;
      }

      if (e.type === 'touchmove' && penFrameSkipRef.current) {
        return true;
      }

      for (let i = 0; i < touches.length; i += 1) {
        if (isFabricAllowedTouch(touches[i])) {
          return false;
        }
      }

      return true;
    };

    fabricHandlers._onMouseMove = (e) => {
      if (isStarvedRawTouchEvent(e)) return;

      originalOnMouseMove(e);
    };
    fabricHandlers._onTouchEnd = (e) => {
      // With nothing left on the glass, let Fabric close the stroke whoever lifted last.
      if (e.touches.length > 0 && isStarvedRawTouchEvent(e)) return;

      originalOnTouchEnd(e);
    };

    // --- Pointer-funnel geometry cache (see pointerGeometryRef for the measured cost + safety argument) ---
    //
    // Both of Fabric's own per-call DOM measurements are served from one cached snapshot. We patch the
    // MEASUREMENT SOURCES rather than reimplementing `_getPointerImpl`: its coordinate extraction
    // (`getPointer` → `getTouchInfo`, which reads `TouchEvent.changedTouches[0]` — this canvas is
    // deliberately bound to the raw touch stream, not pointer events) is exactly the part that must not
    // drift, so it keeps running verbatim.
    //
    //   1. `upperCanvasEl.getBoundingClientRect` — an own-property override on an element FABRIC
    //      created and destroys with itself, so nothing outside this canvas is affected. Every caller
    //      of it wants the same rect we cached, by construction: the cache is dropped whenever the
    //      element can have moved.
    //   2. `canvas.calcOffset` — the instance override also writes `_offset`, which `_getPointerImpl`
    //      reads immediately after calling it.
    const upperCanvasEl = fabricCanvas.upperCanvasEl;
    const measureUpperRect = upperCanvasEl.getBoundingClientRect.bind(upperCanvasEl);
    const measureCanvasOffset = fabricCanvas.calcOffset.bind(fabricCanvas);
    const offsetHost = fabricCanvas as unknown as { _offset: { left: number; top: number } };
    const readPointerGeometry = () => {
      let geometry = pointerGeometryRef.current;

      if (!geometry) {
        // measureCanvasOffset() is Fabric's own calcOffset, so it already wrote `_offset`.
        geometry = { rect: measureUpperRect(), offset: measureCanvasOffset() };
        pointerGeometryRef.current = geometry;
      }

      return geometry;
    };

    Object.defineProperty(upperCanvasEl, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value: () => readPointerGeometry().rect,
    });

    fabricCanvas.calcOffset = () => {
      const { offset } = readPointerGeometry();

      offsetHost._offset = offset;

      return offset;
    };

    // Apply the pen nib-lift/tilt correction inside Fabric's own pointer resolution — the single funnel
    // every coordinate in the library passes through. See penPointerOffsetRef for why it cannot be done
    // on the event.
    //
    // The stored value is a CLIENT-space (CSS px) screen displacement, so it has to go through the same
    // transforms `_getPointerImpl` applies to a point — minus the translations, because a displacement
    // is a VECTOR: the inverse viewport transform's linear part when the caller asked for scene
    // coordinates, then the retina divide, then the CSS-to-backing-store scale.
    const canvasPointerImpl = fabricCanvas as unknown as {
      _getPointerImpl: (e: TPointerEvent, fromViewport?: boolean) => Point;
    };
    const resolveFabricPointer = canvasPointerImpl._getPointerImpl.bind(fabricCanvas);

    canvasPointerImpl._getPointerImpl = (e: TPointerEvent, fromViewport = false): Point => {
      const point = resolveFabricPointer(e, fromViewport);
      const { x: clientDeltaX, y: clientDeltaY } = penPointerOffsetRef.current;

      // Reached by a MOUSE, and by anything resolved between strokes (the offset is cleared on every
      // release path). It does NOT fire for a drawing contact: PEN_VERTICAL_DRAW_OFFSET_PX is a
      // non-zero constant, so applyPenVerticalDrawOffset parks {x:0,y:-2} on every move of the pen /
      // touch-stylus that is inking. That is why the branch below had to stop costing a layout read.
      if (clientDeltaX === 0 && clientDeltaY === 0) {
        return point;
      }

      // Cached — no DOM measurement. `upperCanvasEl.width` is the backing-store size, a plain property
      // read that only changes via setDimensions (which invalidates the cache).
      const bounds = readPointerGeometry().rect;
      const delta = penOffsetToCanvasDelta({
        clientDelta: { x: clientDeltaX, y: clientDeltaY },
        fromViewport,
        viewportTransform: fabricCanvas.viewportTransform,
        retinaScaling: fabricCanvas.getRetinaScaling(),
        cssScale:
          bounds.width > 0 && bounds.height > 0
            ? { x: upperCanvasEl.width / bounds.width, y: upperCanvasEl.height / bounds.height }
            : { x: 1, y: 1 },
      });

      return new Point(point.x + delta.x, point.y + delta.y);
    };

    // Input hardening for touch panels and phones. `touch-action: none` is already set by the canvas
    // component's class, but it is the HOOK that owns the gesture model, so it states the whole
    // invariant here for any consumer: no browser scroll/zoom, no rubber-band handover to the page, no
    // long-press selection or iOS callout bubble, no tap highlight — each of which fires a
    // `pointercancel` that truncates the stroke mid-letter. Fabric's hidden text-editing textarea is
    // appended to `document.body`, outside this element, so `user-select: none` cannot reach it.
    //
    // NOT FIXABLE FROM HERE: iOS Safari ignores `touch-action` (and `user-scalable=no`) for the
    // system pinch-zoom, so a two-finger pinch on iOS still zooms the PAGE and cancels the stroke.
    const containerStyle = containerEl.style as CSSStyleDeclaration & {
      webkitTouchCallout?: string;
      webkitTapHighlightColor?: string;
      webkitUserSelect?: string;
    };

    containerStyle.touchAction = 'none';
    containerStyle.overscrollBehavior = 'contain';
    containerStyle.userSelect = 'none';
    containerStyle.webkitUserSelect = 'none';
    containerStyle.webkitTouchCallout = 'none';
    containerStyle.webkitTapHighlightColor = 'transparent';
    // A pen long-press on the Samsung WebView starts a native drag of the canvas (dragstart, ~250 ms of
    // browser-side work before the event even dispatches — device log 2026-10-12). Not inherited, so
    // it goes on the container AND on every canvas inside it (Fabric's upper canvas included).
    containerStyle.setProperty('-webkit-user-drag', 'none');
    for (const el of Array.from(containerEl.querySelectorAll('canvas'))) {
      el.draggable = false;
      el.style.setProperty('-webkit-user-drag', 'none');
      el.style.setProperty('-webkit-touch-callout', 'none');
      el.style.userSelect = 'none';
      el.style.setProperty('-webkit-user-select', 'none');
    }

    appliedToolRef.current = null;
    penBrushRef.current = null;
    highlighterBrushRef.current = null;
    // These two were missed when the brush and marker were added; harmless only because getOrCreate*
    // also compares `brush.canvas`, but a stale ref across a canvas rebuild is exactly the shape of bug
    // that took a week to find last time.
    calligraphyBrushRef.current = null;
    softMarkerBrushRef.current = null;
    scriptBrushRef.current = null;
    eraserBrushRef.current = null;
    objectInteractionModeRef.current = null;
    activeTouchPointersRef.current.clear();
    ignoredTouchPointerIdsRef.current.clear();
    rawTouchContactsRef.current.clear();
    wholeHandEraserSessionRef.current = null;
    touchDrawingPointerIdRef.current = null;
    fingerDrawArmedRef.current = false;
    fingerDrawTouchIdentifierRef.current = null;
    pendingSingleTouchPanRef.current = null;
    multiTouchGestureBaselineRef.current = null;
    multiTouchGestureLockRef.current = null;
    zoomGestureBaselineRef.current = null;
    zoomDistanceFilterRef.current = createZoomDistanceFilterState();
    touchPanModeRef.current = null;
    lastTouchPanCenterRef.current = null;
    lastTouchDistanceRef.current = null;
    cancelScheduledTouchViewportUpdate();
    cancelScheduledObjectErase();
    activePenPointersRef.current.clear();
    lastPenClientPointRef.current = null;
    penButtonsPrevButtonsRef.current.clear();
    lastPenActivityAtRef.current = 0;
    // Dense pages: bake the settled prefix of the object list into one bitmap so a pen lift blits it
    // instead of re-rendering every stroke. Purely a lower-canvas paint optimisation — see `inkBake.ts`
    // for the validity contract that keeps export, undo, selection and both erasers untouched.
    const inkBake = installInkBake(fabricCanvas);

    inkBakeRef.current = inkBake;

    // The select tool picks a stroke by its ink, not its box: a tap in the empty bend of a curve, or
    // on one line of handwriting whose boxes all overlap, used to select the wrong thing.
    const uninstallGeometryTargetFind = installGeometryTargetFind(fabricCanvas);
    // First `object:modified` listener on the canvas: everything after it sees the baked stroke.
    const uninstallStrokeScaleBake = installStrokeScaleBake(fabricCanvas);

    setCanvas(fabricCanvas);
    onCanvasReady?.(fabricCanvas);

    const handleResize = () => {
      if (!containerEl) return;

      // BEFORE the unchanged-size early-return: a ResizeObserver fire means the layout around the board
      // just ran, which can move the canvas on screen even when its SIZE came back identical. Nulling a
      // ref costs nothing; resolving a stroke against a rect that moved costs the ink its position.
      invalidatePointerGeometry();

      const nextWidth = containerEl.clientWidth;
      const nextHeight = containerEl.clientHeight;
      const prevWidth = fabricCanvas.getWidth();
      const prevHeight = fabricCanvas.getHeight();

      // Surface the LIVE container size to React on EVERY observer fire (incl. the initial one that
      // ResizeObserver dispatches on observe) so the owner can size the PDF raster to the real display
      // width. Done BEFORE the unchanged-size early-return: the very first fire often reports the same
      // size the canvas was created at, but that "same" value may be the small pre-layout width the
      // owner is still holding in state — the owner needs it regardless to escape the stale value.
      onCanvasResizeRef.current?.({ width: nextWidth, height: nextHeight });

      if (nextWidth === prevWidth && nextHeight === prevHeight) {
        return;
      }

      // The canvas just resized — its cached screen rect may have moved (e.g. surrounding chrome
      // toggled), so drop the pan/zoom bounds cache to avoid anchoring the next gesture off a stale rect.
      viewportBoundsRef.current = null;

      // MID-STROKE VIEWPORT-HEIGHT CHANGE (phones). `setDimensions` below clears BOTH bitmaps, so the
      // ink the teacher is in the middle of drawing vanishes until they lift (Fabric's `_points` survive,
      // so the finished path reappears — it just looks like the pen died). On a phone the URL bar
      // showing/hiding fires exactly this, mid-letter. The WIDTH is what the PDF fit and the recentering
      // math depend on, so a pure height change is the one we can safely postpone: defer it to the
      // release path (flushDeferredResize) and leave the live stroke's bitmap alone.
      const drawingCanvas = fabricCanvas as Canvas & { _isCurrentlyDrawing?: boolean };

      if (drawingCanvas._isCurrentlyDrawing && nextWidth === prevWidth) {
        deferredResizeRef.current = true;

        return;
      }

      // Fabric leaves the viewport transform untouched on setDimensions, so content stays anchored
      // to the scene origin (top-left) when the canvas grows/shrinks (fullscreen, window resize).
      // How we compensate depends on the page type:
      const pdfFit = pdfFitSizeRef?.current ?? null;

      if (hasPdfBackgroundRef.current && pdfFit && pdfFit.width > 0 && pdfFit.height > 0) {
        // PDF page: the background is pinned to a frozen scene rect captured when the page opened
        // (the canvas size back then). Re-fill the width via the viewport zoom; the PDF and ink both
        // live in that scene space so they scale together and the writing stays glued to the page.
        // PRESERVE the current vertical scroll (rescaled for the zoom change) instead of force-
        // recentering — recentering wiped both the top-aligned open position (new PDF pages open at
        // their top) and any manual pan on every resize / fullscreen toggle.
        const scale = nextWidth / pdfFit.width;
        const prevViewport = fabricCanvas.viewportTransform;
        const prevScale = prevViewport?.[0] ?? scale;
        const prevOffsetY = prevViewport?.[5] ?? 0;
        const nextOffsetY =
          prevScale > 0 ? prevOffsetY * (scale / prevScale) : (nextHeight - scale * pdfFit.height) / 2;

        fabricCanvas.setViewportTransform([scale, 0, 0, scale, 0, nextOffsetY]);
      } else if (!hasPdfBackgroundRef.current && prevWidth > 0 && prevHeight > 0) {
        // Blank/grid/lined page: there is no fixed page frame, so just keep the previous center in
        // place. A stroke drawn in the middle of a smaller canvas would otherwise jump toward the
        // corner once the canvas grows. Shifting the translation by half the size delta pins the
        // center (zoom and pan are preserved).
        const viewport = fabricCanvas.viewportTransform;

        if (viewport) {
          fabricCanvas.setViewportTransform([
            viewport[0] ?? 1,
            viewport[1] ?? 0,
            viewport[2] ?? 0,
            viewport[3] ?? 1,
            (viewport[4] ?? 0) + (nextWidth - prevWidth) / 2,
            (viewport[5] ?? 0) + (nextHeight - prevHeight) / 2,
          ]);
        }
      }

      fabricCanvas.setDimensions({
        width: nextWidth,
        height: nextHeight,
      });
      // The refit above is written against the new size; the constraints (if any) are too.
      constrainViewportRef.current?.(fabricCanvas);
      // setDimensions rewrote the element's CSS size, so the rect cached a moment ago is stale — and
      // Fabric's own internal calcOffset() inside setDimensions read it through our override.
      invalidatePointerGeometry();
      fabricCanvas.requestRenderAll();
    };

    // Published so the release paths can flush a resize deferred mid-stroke (see handleResize).
    runDeferredResizeRef.current = handleResize;

    const resizeObserver = new ResizeObserver(handleResize);

    resizeObserver.observe(containerEl);

    return () => {
      cleanupCustomListeners();
      const lowerCanvasEl = (fabricCanvas as Canvas & { lowerCanvasEl?: HTMLCanvasElement }).lowerCanvasEl;

      if (lowerCanvasEl) {
        lowerCanvasEl.style.opacity = '1';
      }

      // The cache and the deferred-resize handler both close over THIS canvas; a board swap must not
      // leave the next one resolving pointers against the dead one's rect.
      pointerGeometryRef.current = null;
      deferredResizeRef.current = false;
      runDeferredResizeRef.current = null;
      keyboardOverrideToolRef.current = null;
      touchOverrideToolRef.current = null;
      activeTouchPointersRef.current.clear();
      ignoredTouchPointerIdsRef.current.clear();
      touchDrawingPointerIdRef.current = null;
      fingerDrawArmedRef.current = false;
      fingerDrawTouchIdentifierRef.current = null;
      pendingSingleTouchPanRef.current = null;
      multiTouchGestureBaselineRef.current = null;
      multiTouchGestureLockRef.current = null;
      touchPanModeRef.current = null;
      lastTouchPanCenterRef.current = null;
      lastTouchDistanceRef.current = null;
      cancelScheduledTouchViewportUpdate();
      cancelScheduledObjectErase();
      activePenPointersRef.current.clear();
      lastPenClientPointRef.current = null;
      lastPenActivityAtRef.current = 0;
      penBrushRef.current = null;
      highlighterBrushRef.current = null;
      // The teardown half of the same omission fixed at canvas creation: without these, every board close
      // strands a CalligraphyBrush and a SoftMarkerBrush still holding the DISPOSED canvas and both of its
      // DOM canvas elements.
      calligraphyBrushRef.current = null;
      softMarkerBrushRef.current = null;
      scriptBrushRef.current = null;
      eraserBrushRef.current = null;
      objectInteractionModeRef.current = null;
      resizeObserver.disconnect();
      // Before Fabric's own teardown: the bake holds an instance override of `_renderObjects` and a
      // full-size bitmap, both of which must go back before the canvas that owns them does.
      inkBake.dispose();
      inkBakeRef.current = null;
      cancelFlingRef.current?.();
      // Put Fabric's own handlers back so its removeListeners() matches what it registered, after dropping
      // any document listener still registered with the wrapped ones (a stroke open at dispose).
      const ownerDocument = canvasEl.ownerDocument;

      ownerDocument.removeEventListener('touchmove', fabricHandlers._onMouseMove);
      ownerDocument.removeEventListener('mousemove', fabricHandlers._onMouseMove);
      ownerDocument.removeEventListener('touchend', fabricHandlers._onTouchEnd);
      fabricHandlers._onMouseMove = originalOnMouseMove;
      fabricHandlers._onTouchEnd = originalOnTouchEnd;
      uninstallGeometryTargetFind();
      uninstallStrokeScaleBake();
      fabricCanvas.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Shared pointer listeners (registered once, branch by refs) ---
  useEffect(() => {
    if (!canvas) return;

    cleanupCustomListeners();
    setupShapeDrawingListeners(canvas);
    setupTextListeners(canvas);
    setupPanListeners(canvas);
    setupObjectEraserListeners(canvas);
    setupObjectHitIndexInvalidation(canvas);
    setupLaserListeners(canvas);
    setupStickyListeners(canvas);

    const pathHandler = () => {
      const objects = canvas.getObjects();
      const lastObj = objects[objects.length - 1];

      if (!lastObj) {
        return;
      }

      // TOUCH-ONLY-ROUTED device single-finger pan: the finger tentatively inks through Fabric until the
      // pan activates, so the interrupted tentative stroke is committed here. If we're now in a pan (or
      // just opened the suppress window) and the committed path is small enough to be that leftover,
      // discard it so a finger-pan never leaves a stray mark. Gated to touch-only-ROUTED devices (real
      // touch-only hardware, or touchInputMode 'capacitive-pen' forcing that routing) so a pen device's
      // real strokes are never touched (there a finger never inks, and a small pen dot must survive).
      if (
        !isRoutedAsPenDevice() &&
        (touchPanModeRef.current !== null || Date.now() <= touchPanArtifactSuppressUntilRef.current)
      ) {
        const maxDimension = Math.max(18, strokeSettingsRef.current.width * 4);
        const isSmallFreehandArtifact =
          !isEraserMark(lastObj) &&
          !isTransientCanvasObject(lastObj) &&
          (lastObj instanceof Path || lastObj.type === 'path') &&
          (() => {
            const rect = lastObj.getBoundingRect();

            return rect.width <= maxDimension && rect.height <= maxDimension;
          })();

        if (isSmallFreehandArtifact) {
          canvas.remove(lastObj);
          canvas.requestRenderAll();

          return;
        }
      }

      // Erase-hold tail (nativeTailGuardRef): a stroke the WebView's zero-pressure button-held frames
      // managed to open is a dot the teacher never drew. A genuine pen-down disarms the guard first, so a
      // real dot always survives.
      if (
        nativeTailGuardRef.current &&
        !isEraserMark(lastObj) &&
        !isTransientCanvasObject(lastObj) &&
        (lastObj instanceof Path || lastObj.type === 'path')
      ) {
        const rect = lastObj.getBoundingRect();
        const maxDimension = (lastObj.strokeWidth || 1) * (canvas.getZoom() || 1) + 4;

        if (rect.width <= maxDimension && rect.height <= maxDimension) {
          canvas.remove(lastObj);
          canvas.requestRenderAll();
          recordPenNativeTrace('tail dot', 'zero-pressure dot after the eraser — removed'); // i18n-ignore: diagnostic trace

          return;
        }
      }

      // A committed stroke is drawn from Fabric's per-object cache, which gets downscaled once the
      // stroke's bounding box exceeds the cache size cap — large strokes on a big board looked blurry
      // after release while the live stroke was crisp. Disabling the cache for EVERY path fixed that
      // and made each lower-canvas render re-stroke all the ink on the page, which is what made a
      // densely annotated PDF page lag. The policy caches what Fabric can draw 1:1 and renders the
      // rest directly, re-deciding per render so zoom is covered; see `inkCachePolicy.ts`.
      applyInkCachePolicy(lastObj);
      lastObj.dirty = true;
      canvas.requestRenderAll();

      if (effectiveToolRef.current === 'highlighter') {
        lastObj.set('opacity', 1);
        canvas.requestRenderAll();

        return;
      }

      // The brush and marker draw with the PEN's colour and width settings, so they honour its opacity
      // slider too. They were left out when they were added, and the slider silently did nothing for
      // them. (The marker's ink is already translucent by design; the slider scales that further, which
      // is what a teacher who drags it down expects.)
      const usesPenOpacity = isPenFamilyTool(effectiveToolRef.current);

      if (usesPenOpacity && strokeSettingsRef.current.opacity < 1 && lastObj.opacity === 1) {
        lastObj.set('opacity', strokeSettingsRef.current.opacity);
        canvas.requestRenderAll();
      }
    };

    // Measured: a `path:created` span in the renderer perf trace is the per-stroke commit cost.
    addCustomPathCreated(canvas, () => perfSpan('path:created', pathHandler));
    syncEffectiveTool(canvas);

    return () => {
      cleanupCustomListeners();
    };
  }, [canvas, isRoutedAsPenDevice, syncEffectiveTool]);

  useEffect(() => {
    if (!canvas) return;

    const containerEl = containerRef.current;

    if (!containerEl) return;

    // ---- Pen buttons (learned map + the built-in S Pen binding) ------------------------------------
    // Everything below runs on button EDGES only (a `buttons` change, a key, a native edge), a pen-down,
    // or a timer — never per plain move — so it adds nothing to the inking path.
    const endObjectEraseDrag = () => {
      isObjectErasingRef.current = false;
      cancelScheduledObjectErase();
      lastObjectErasePointRef.current = null;
    };
    const setPenButtonOverride = (tool: WhiteboardTool | null) => {
      if (penButtonOverrideToolRef.current === tool) return;

      // Button let go while a native-driven contact is still on the glass: that erase stroke ends here.
      if (nativePenDragRef.current) {
        nativePenDragRef.current = false;
        traceNativeDragEnd(`button ${tool === null ? 'release' : `→ ${tool}`}`);
      }

      // Releasing an override (the button let go): the WebView's button-held "contact" frames may still be
      // in flight — they must not ink with the restored nib.
      if (tool === null) nativeTailGuardRef.current = true;

      shapeSnapRef.current?.cancel();
      // End the drag in progress cleanly (the ink / erase so far is kept) before the tool changes under it.
      commitInterruptedFreehandStroke(canvas);
      endObjectEraseDrag();
      penButtonOverrideToolRef.current = tool;
      syncEffectiveTool(canvas);
      penButtonStrokeRestartRef.current = activePenPointersRef.current.size > 0;
    };
    // Called from the first pen move after an override change while the pen stays down: start the new
    // tool's drag at this contact. The pen's own touch stream keeps feeding Fabric from here on.
    const restartPenButtonDrag = (event: PointerEvent) => {
      penButtonStrokeRestartRef.current = false;

      if (isObjectEraserToolActive(effectiveToolRef.current)) {
        isObjectErasingRef.current = true;
        lastObjectErasePointRef.current = null;
        eraseObjectsAlong(canvas, canvas.getScenePoint(event));

        return;
      }

      const drawingCanvas = canvas as Canvas & {
        _isCurrentlyDrawing?: boolean;
        _onMouseDownInDrawingMode?: (e: PointerEvent) => void;
      };

      if (drawingCanvas.isDrawingMode && !drawingCanvas._isCurrentlyDrawing) {
        drawingCanvas._onMouseDownInDrawingMode?.(event);
      }
    };
    const penPointForMenu = (): { x: number; y: number } | null => {
      const now = Date.now();
      const dom = lastPenPointerPointRef.current;

      if (dom.at && now - dom.at < PEN_POINT_FRESH_MS) return { x: dom.x, y: dom.y };

      const native = lastNativePenPointRef.current;

      if (native.at && now - native.at < PEN_POINT_FRESH_MS) return { x: native.x, y: native.y };

      return null;
    };
    const toContainerFraction = (point: { x: number; y: number } | null) => {
      if (!point) return undefined;

      const rect = containerEl.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) return undefined;

      return {
        x: Math.min(1, Math.max(0, (point.x - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (point.y - rect.top) / rect.height)),
      };
    };
    const showColorCue = (color: string, point: { x: number; y: number } | null) => {
      if (!point || typeof document === 'undefined') return;

      try {
        const cue = document.createElement('div');

        Object.assign(cue.style, {
          position: 'fixed',
          left: `${point.x - 16}px`,
          top: `${point.y - 16}px`,
          width: '32px',
          height: '32px',
          borderRadius: '50%',
          background: color,
          border: '3px solid #ffffff',
          boxShadow: '0 0 0 2px rgba(0, 0, 0, 0.35)',
          pointerEvents: 'none',
          zIndex: '60',
          opacity: '1',
          transform: 'scale(1)',
          transition: 'opacity 520ms ease, transform 520ms ease',
        });
        document.body.appendChild(cue);
        window.requestAnimationFrame(() => {
          cue.style.opacity = '0';
          cue.style.transform = 'scale(1.6)';
        });
        window.setTimeout(() => cue.remove(), 650);
      } catch {
        // A cue is decoration — never let it break input.
      }
    };
    const runPenButtonAction = (action: PenButtonAction, cue: boolean, why: string) => {
      if (action === 'pen-shortcuts') {
        // Every menu toggle lands in the «Pen buttons» trace with what fired it: a phantom toggle on a
        // device can then be read off the tablet instead of guessed at.
        recordPenNativeTrace('pen menu', `toggle — ${why}`); // i18n-ignore: diagnostic trace
        onShortcutQuickMenuRef.current?.(toContainerFraction(penPointForMenu()));
      } else if (action === 'color-toggle') {
        // The swap makes the secondary colour the active one — that is the colour the cue shows.
        const nextColor = strokeSettingsRef.current.secondaryColor;

        onShortcutColorToggleRef.current?.();

        if (cue && nextColor) showColorCue(nextColor, penPointForMenu());
      } else if (action === 'undo') {
        commitInterruptedFreehandStroke(canvas);
        onShortcutUndoRef.current?.();
      } else if (action === 'ai-lasso') {
        // Ends the stroke in progress so the lasso starts clean; the AI layer takes it from here.
        commitInterruptedFreehandStroke(canvas);

        const command = boardAiCommandForPenAction(action);

        if (command) requestBoardAiCommand(command);
      } else if (action === 'eraser-toggle' || action === 'erase-hold') {
        commitInterruptedFreehandStroke(canvas);
        endObjectEraseDrag();
        onShortcutToolToggleRef.current?.();
      }
    };
    const clearGestureTimer = (bindingId: string) => {
      const timer = penButtonGestureTimersRef.current.get(bindingId);

      if (timer !== undefined) {
        window.clearTimeout(timer);
        penButtonGestureTimersRef.current.delete(bindingId);
      }
    };
    const stepGesture = (binding: PenButtonBinding, input: PenButtonGestureInput) => {
      const current = penButtonGesturesRef.current.get(binding.id) ?? PEN_BUTTON_GESTURE_IDLE;
      const step = stepPenButtonGesture(current, input, { longPress: binding.longHoverAction !== 'none' });

      if (step.state.phase === 'idle') {
        penButtonGesturesRef.current.delete(binding.id);
      } else {
        penButtonGesturesRef.current.set(binding.id, step.state);
      }

      clearGestureTimer(binding.id);

      if (step.tickIn !== null) {
        penButtonGestureTimersRef.current.set(
          binding.id,
          window.setTimeout(() => {
            penButtonGestureTimersRef.current.delete(binding.id);
            stepGesture(binding, { type: 'tick', now: Date.now() });
          }, step.tickIn),
        );
      }

      for (const effect of step.effects) {
        if (effect === 'short-hover') {
          runPenButtonAction(binding.hoverAction, false, `short hover press (${binding.id})`);
        } else if (effect === 'long-hover') {
          try {
            navigator.vibrate?.(PEN_BUTTON_HAPTIC_MS);
          } catch {
            // No vibrator / not allowed — the on-canvas cue still shows.
          }

          runPenButtonAction(binding.longHoverAction, true, `long hover press (${binding.id})`);
        } else if (effect === 'contact-start') {
          if (binding.action === 'erase-hold') {
            setPenButtonOverride('eraser');
          } else {
            runPenButtonAction(binding.action, false, `contact press (${binding.id})`);
          }
        } else if (effect === 'contact-end' && binding.action === 'erase-hold') {
          setPenButtonOverride(null);
        }
      }
    };
    const executePenButtonEvents = (events: PenButtonDispatchEvent[]) => {
      const now = Date.now();

      for (const dispatched of events) {
        const { binding } = dispatched;

        if (dispatched.kind === 'release') {
          const state = penButtonGesturesRef.current.get(binding.id);

          if (state?.phase === 'contact-held') {
            // Grace: a release/press blip at the hover/contact boundary must not end the hold.
            const pending = penButtonReleaseTimersRef.current.get(binding.id);

            if (pending !== undefined) window.clearTimeout(pending);

            penButtonReleaseTimersRef.current.set(
              binding.id,
              window.setTimeout(() => {
                penButtonReleaseTimersRef.current.delete(binding.id);
                stepGesture(binding, { type: 'release', now: Date.now() });
              }, PEN_BUTTON_RELEASE_GRACE_MS),
            );
          } else {
            stepGesture(binding, { type: 'release', now });
          }

          continue;
        }

        const pendingRelease = penButtonReleaseTimersRef.current.get(binding.id);

        if (pendingRelease !== undefined) {
          // Released and pressed again within the grace: the button never really let go.
          window.clearTimeout(pendingRelease);
          penButtonReleaseTimersRef.current.delete(binding.id);
          continue;
        }

        const contact = dispatched.contact ?? activePenPointersRef.current.size > 0;

        if (!dispatched.momentary) {
          // A signal that never reports a release: one shot, by context.
          runPenButtonAction(contact ? binding.action : binding.hoverAction, false, `one-shot signal (${binding.id})`);
          continue;
        }

        stepGesture(binding, { type: 'press', contact, now });
      }
    };
    /** A real pen-down while a button is held in the air turns that press into a contact hold. */
    const notePenButtonContactStart = () => {
      if (penButtonGesturesRef.current.size === 0) return;

      const now = Date.now();

      for (const binding of penButtonEffectiveMapRef.current.bindings) {
        const state = penButtonGesturesRef.current.get(binding.id);

        if (state && state.phase !== 'contact-held') stepGesture(binding, { type: 'contact-start', now });
      }
    };
    const resetPenButtonGestures = () => {
      penButtonGestureTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      penButtonGestureTimersRef.current.clear();
      penButtonReleaseTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      penButtonReleaseTimersRef.current.clear();
      penButtonGesturesRef.current.clear();
      penButtonStrokeRestartRef.current = false;
    };
    /** Returns true when the signal hit a binding (so the caller may suppress its default). */
    const runLearnedPenSignal = (signal: PenSignal, map = penButtonEffectiveMapRef.current): boolean => {
      if (!hasPenButtonBindings(map)) return false;

      const edges = detectPenSignalEdges(signal);

      if (edges.length === 0) return false;

      const events = penButtonDispatcherRef.current.handle(map, edges, Date.now());

      executePenButtonEvents(events);

      return edges.some((edge) => map.bindings.some((binding) => binding.signatures.includes(edge.signature)));
    };

    // ThinkPad pen barrel buttons surface via PointerEvent.buttons (a bitmask) on EVERY pen event,
    // including hover (no tip contact). We diff the bitmask per pointerId to detect rising/falling edges
    // of the two barrel bits — an INSTANT LATCH: an edge TOGGLES the tool/colour (no timer, no hold).
    // Bits LEARNED on the «Pen buttons» page are routed through the learned map instead, and the legacy
    // ThinkPad mapping (gated by penButtonsEnabled) leaves those bits alone.
    const processPenButtons = (event: PointerEvent) => {
      const settings = tabletInputSettingsRef.current;
      const previousButtons = penButtonsPrevButtonsRef.current.get(event.pointerId) ?? 0;
      const currentButtons = event.buttons;
      const learnedMap = penButtonMapRef.current;
      let learnedBits = 0;

      if (hasPenButtonBindings(learnedMap)) {
        if (penButtonDispatcherRef.current.hasHeld()) {
          executePenButtonEvents(
            penButtonDispatcherRef.current.reconcilePointer(learnedMap, event.pointerType, currentButtons, Date.now()),
          );
        }

        if (currentButtons !== previousButtons) {
          runLearnedPenSignal(
            {
              source: 'pointer',
              pointerType: event.pointerType,
              buttons: currentButtons,
              prevButtons: previousButtons,
            },
            learnedMap,
          );

          const prefix = `pointer:${event.pointerType || 'unknown'}:bit:`;

          for (const binding of learnedMap.bindings) {
            for (const signature of binding.signatures) {
              if (signature.startsWith(prefix)) learnedBits |= Number(signature.slice(prefix.length)) || 0;
            }
          }
        }
      }

      // Always keep the per-pointer snapshot current so toggling the feature (or a re-appearing
      // pointer) can never synthesize a phantom edge from a stale baseline.
      penButtonsPrevButtonsRef.current.set(event.pointerId, currentButtons);

      // On-device diagnostics. The ThinkPad button→bit mapping can't be verified off-device, so
      // expose the raw bitmask: in the WebView2 console run `localStorage.setItem('wb-debug-pen','1')`,
      // press each pen button, and read which bit toggles. Use that to set penButtonsSwap correctly.
      if (currentButtons !== previousButtons) {
        try {
          if (typeof localStorage !== 'undefined' && localStorage.getItem('wb-debug-pen')) {
            // eslint-disable-next-line no-console
            console.debug('[pen-buttons]', {
              pointerId: event.pointerId,
              buttons: currentButtons,
              prev: previousButtons,
              barrelBit2: (currentButtons & PEN_BARREL_BUTTON_BIT) !== 0,
              eraserBit32: (currentButtons & PEN_ERASER_BUTTON_BIT) !== 0,
            });
          }
        } catch {
          // localStorage can throw in locked-down contexts — diagnostics must never break input.
        }
      }

      if (!settings.penButtonsEnabled) {
        return;
      }

      // swap=false: barrel(bit2)=pen<->eraser toggle, eraser(bit32)=COLOR-toggle. swap=true: reversed.
      const eraseBit = settings.penButtonsSwap ? PEN_ERASER_BUTTON_BIT : PEN_BARREL_BUTTON_BIT;
      const colorBit = settings.penButtonsSwap ? PEN_BARREL_BUTTON_BIT : PEN_ERASER_BUTTON_BIT;
      const eraseRising =
        (learnedBits & eraseBit) === 0 && (currentButtons & eraseBit) !== 0 && (previousButtons & eraseBit) === 0;
      const colorRising =
        (learnedBits & colorBit) === 0 && (currentButtons & colorBit) !== 0 && (previousButtons & colorBit) === 0;

      if (eraseRising) {
        // TOGGLE the active tool pen<->eraser (onShortcutToolToggle -> parent setActiveTool). Erasing
        // then happens with a normal pen-down and NO button held. Finalize any in-progress path first.
        commitInterruptedFreehandStroke(canvas);
        onShortcutToolToggleRef.current?.();
      }

      if (colorRising) {
        // TOGGLE between the two SELECTED colours (primary <-> secondary). Runs on hover too, so the
        // swap applies even before the next stroke and mid-erase.
        onShortcutColorToggleRef.current?.();
      }
    };
    // Dev input trace for pen contacts, so the exported timeline shows pen vs finger interleaving.
    const tracePen = (event: PointerEvent, phase: 'cancel' | 'down' | 'move' | 'up', decision: string) => {
      if (!isInputTraceEnabled()) return;

      traceInput({
        kind: 'pen',
        phase,
        decision,
        pointerId: event.pointerId,
        pointerType: event.pointerType || 'pen',
        width: event.width,
        height: event.height,
        buttons: event.buttons,
        hasSeenRealPen: hasSeenRealPenRef.current,
        activePen: activePenPointersRef.current.size,
        activeTouch: activeTouchPointersRef.current.size,
      });
    };
    // Every pen event (down/move/HOVER/up) marks this a PEN DEVICE and keeps the PALM GUARD window warm,
    // so a palm resting between strokes (pen tip off the glass, activePen === 0) is still time-rejected.
    const notePenActivity = () => {
      markRealPenSeen();
      lastPenActivityAtRef.current = Date.now();
    };
    const handlePenDown = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;

      // Re-measure the pointer funnel's geometry for this contact — the ONE layout read of the whole
      // stroke, paid while the tip is landing. It covers the layout shift no observer sees: chrome
      // toggling above the board moves the canvas without changing the container's SIZE, so the
      // ResizeObserver never fires. See pointerGeometryRef.
      invalidatePointerGeometry();
      // The pen landing ends any slide instantly — a fling must never run under a stroke.
      cancelFling();

      // Mark the pen physically DOWN first, before any other work: on this hardware the pen inks THROUGH
      // Fabric's raw touch stream, so `blockTouchFromFabricOnPenDevice` must see activePen>0 the instant the
      // pen's OWN touch contact arrives and let it reach Fabric. (Pointerdown is dispatched before the
      // matching touchstart, and JS is single-threaded, so this runs to completion first.)
      activePenPointersRef.current.add(event.pointerId);
      // Fresh per-contact pressure memory for the lift-tail filter (see injectCoalescedSamples).
      penContactPressureRef.current.set(event.pointerId, { pressureSeen: event.pressure > 0 });
      // The script nib's width follows pressure, which Fabric's compat events never carry: hand it over
      // before Fabric's own pen-down (the twin touchstart / mousedown) records the first point.
      (canvas.freeDrawingBrush as Partial<LowLatencyPencilBrush> | undefined)?.notePressure?.(event.pressure);
      penFrameSkipRef.current = false;
      // Seed the pen's live position + down time: the pen's OWN twin touchstart arrives right after this
      // (pointerdown lands before its touchstart, same task) and is identified POSITIVELY against them.
      // Any twin still recorded belongs to a contact whose end was lost — it must not outlive its pen.
      lastPenClientPointRef.current = { x: event.clientX, y: event.clientY };
      penDownAtRef.current = Date.now();
      penTwinTouchIdentifiersRef.current.clear();

      // Self-heal BEFORE anything else: a prior touch gesture whose release the OS dropped can leave
      // touchOverrideToolRef stuck 'pan' → isDrawingMode=false → this pen inks NOTHING. `ignoreMode:
      // true` clears a stranded touch mode too (it can only ever remove a STALE touch phantom, since a
      // live pan keeps a FRESH pointer the staleness check never touches). Runs before noteInputActivity
      // so the reap's own idle math isn't skewed by THIS event.
      reapStalePointersAndRecover(Date.now(), true);
      noteInputActivity('pen down');
      tracePen(event, 'down', 'pen-contact');

      notePenActivity();

      // Pen-down is unambiguous DRAW intent: any touch ALREADY on the glass is a resting palm/hand, not a
      // navigation gesture (a deliberate finger-pan only happens while the pen is AWAY). A palm can get
      // TRACKED if it landed during a pen-absent pause longer than the palm-reject window; the stale-reaper
      // above only clears an EMPTY touch map, so explicitly cancel any in-flight/pending touch pan and
      // DEMOTE every live touch contact to "ignored". Otherwise the resting palm slides into a single-finger
      // pan mid-stroke, or (if it already reached 'pan') touchOverride='pan' turns isDrawingMode off and the
      // pen inks nothing. (Adversarial review BROKEN-1/BROKEN-3. Pen events fire only on a real-pen device,
      // so this never affects a touch-only panel.) `stopTouchPan` lives in the separate touch effect, so
      // cancel the pan inline via the component-level refs + syncEffectiveTool.
      pendingSingleTouchPanRef.current = null;

      if (touchOverrideToolRef.current === 'pan') {
        touchOverrideToolRef.current = null;
        touchPanModeRef.current = null;
        syncEffectiveTool(canvas);
      }

      // FULL pan-gesture teardown (the stuck-ink trigger, teacher-repro'd: finger-pan live → pen lands →
      // "pen reads as pan" → the stroke that then opens never gets its ending event and draws forever).
      // The override clear above restores isDrawingMode, but the gesture BASELINES survived it — leaving
      // the interrupted pan half-alive under the new stroke. Drop every baseline so the pen starts from a
      // dead-idle gesture state.
      touchPanModeRef.current = null;
      lastTouchPanCenterRef.current = null;
      lastTouchDistanceRef.current = null;
      multiTouchGestureBaselineRef.current = null;
      multiTouchGestureLockRef.current = null;

      // Self-heal any STALE open brush path BEFORE the new stroke starts (its twin touchstart arrives
      // right after this handler). With the pen off the glass no stroke can legitimately be open on a
      // pen device, so this only ever commits stranded ink — otherwise the new stroke fuses onto the
      // stranded path and the "endless line" keeps growing.
      if (penStrokeEndFailsafeTimerRef.current !== null) {
        window.clearTimeout(penStrokeEndFailsafeTimerRef.current);
        penStrokeEndFailsafeTimerRef.current = null;
      }

      commitInterruptedFreehandStroke(canvas);

      for (const id of Array.from(activeTouchPointersRef.current.keys())) {
        ignoredTouchPointerIdsRef.current.add(id);
      }

      activeTouchPointersRef.current.clear();

      // Finger-drawing (opt-in, pen device only): REAL pen activity always outranks it. A touch that was
      // drawing (or armed to) must not survive the pen taking over, else its now-dead id would keep
      // shadowing getPrimaryTouchPointerId() for the NEXT genuine single-finger pan, and a stale armed
      // identifier would keep blockTouchFromFabricOnPenDevice passing a contact the pen has already
      // demoted to ignored. Clearing it re-arms that guard's default (block) immediately.
      touchDrawingPointerIdRef.current = null;
      fingerDrawArmedRef.current = false;
      fingerDrawTouchIdentifierRef.current = null;

      // Commit any in-flight zoom/pan preview so the pen draws against Fabric's real viewport.
      commitZoomPreview(canvas);

      // A fresh contact starts its own drag through Fabric's touchstart — after this pointerdown, so a
      // button already held in the air switches the tool HERE and the touch starts the right drag.
      lastPenPointerPointRef.current.x = event.clientX;
      lastPenPointerPointRef.current.y = event.clientY;
      lastPenPointerPointRef.current.at = Date.now();
      // A native-driven erase (contact the WebView had not reported) yields to the page's own contact.
      if (nativePenDragRef.current) endNativePenDrag(null, 'dom pointerdown');

      notePenButtonContactStart();
      penButtonStrokeRestartRef.current = false;
      processPenButtons(event);
      applyPenTiltOffset(event);
    };
    const handlePenMove = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;

      noteInputActivity('pen move');
      // Refresh the pen-device flag + palm-guard window on hover too (BEFORE the active-contact guard),
      // so a palm landing between strokes is still rejected by the time window.
      notePenActivity();

      // Where the pen is (hover or contact), for a pen-button menu opened at the pen. Plain field writes.
      lastPenPointerPointRef.current.x = event.clientX;
      lastPenPointerPointRef.current.y = event.clientY;
      lastPenPointerPointRef.current.at = Date.now();

      // Process barrel-button edges first — they must register even while the pen merely hovers.
      processPenButtons(event);

      if (!activePenPointersRef.current.has(event.pointerId)) return;

      // Track the pen's live position ONLY while the tip is down (past the hover guard above), so the
      // Fabric-starvation guard's proximity test follows the moving pen and never keys off a stale hover.
      lastPenClientPointRef.current = { x: event.clientX, y: event.clientY };

      applyPenTiltOffset(event);

      // A pen button swapped the tool while this pen was on the glass (the old drag was committed):
      // start the new tool's drag right here, from the current contact.
      if (penButtonStrokeRestartRef.current && (event.buttons & 1) !== 0) {
        restartPenButtonDrag(event);
      }

      // THE LIFT TAIL: this frame's samples (coalesced + the event itself) show the tip leaving the glass
      // before any stroke-ending event reached Fabric. 'lift' (contact bit clear): the in-contact samples
      // were appended; close the stroke HERE, at the last in-contact point, so Fabric's own twin touchmove
      // for this frame (dispatched right after this pointermove) cannot append the lifted position. 'skip'
      // (pressure 0, bit still set): nothing closes — only arm penFrameSkipRef so that twin touchmove /
      // compat mousemove is starved from Fabric for this one frame. The pen stays recorded as down: its
      // pointerup is still coming.
      const verdict = injectCoalescedSamples(canvas, event);

      penFrameSkipRef.current = verdict === 'skip';

      if (verdict === 'lift') {
        commitInterruptedFreehandStroke(canvas);
      }

      if (verdict !== 'contact') {
        tracePen(event, 'move', `lift-tail:${verdict}`);

        try {
          if (typeof localStorage !== 'undefined' && localStorage.getItem('wb-debug-pen')) {
            // eslint-disable-next-line no-console
            console.debug('[pen-lift-tail]', {
              verdict,
              pointerId: event.pointerId,
              buttons: event.buttons,
              pressure: event.pressure,
              coalesced: lastCoalescedCountRef.current,
            });
          }
        } catch {
          // localStorage can throw in locked-down contexts — diagnostics must never break input.
        }
      }
    };
    const releasePen = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;

      noteInputActivity(event.type === 'pointercancel' ? 'pen cancel' : 'pen up');
      tracePen(event, event.type === 'pointercancel' ? 'cancel' : 'up', 'pen-release');

      // Catch a barrel-button release that coincides with lifting the pen (buttons clears on up), then
      // drop this pointer's bitmask snapshot so a reused id starts from a clean baseline.
      processPenButtons(event);
      penButtonsPrevButtonsRef.current.delete(event.pointerId);
      penButtonStrokeRestartRef.current = false;

      // Clear it — never re-apply on the way up. Re-applying stored the tilt at the instant the pen was
      // flicked off the glass, which is the most extreme tilt of the whole stroke, and left THAT as the
      // standing offset for everything the teacher did next.
      clearPenPointerOffset();

      if (event.type === 'pointercancel') {
        commitInterruptedFreehandStroke(canvas);
      }

      activePenPointersRef.current.delete(event.pointerId);
      penContactPressureRef.current.delete(event.pointerId);
      penFrameSkipRef.current = false;
      // The pen twin's own touchend still carries a tiny tip radius, so the guard passes it on radius
      // even after this clears — but with no pen down there is no live point to match a finger against,
      // which is exactly right (a finger on a pen device must pan, not ink).
      if (activePenPointersRef.current.size === 0) {
        lastPenClientPointRef.current = null;

        // STUCK-INK FAILSAFE: normally the stroke ends when the pen twin's touchend reaches Fabric a few
        // ms after this pointerup. When that ending event is LOST (OS drop during pen/finger
        // interleaving — the finger-pan → pen-down repro), Fabric stays mid-stroke and every later
        // hover/touch extends the same endless line. Give the healthy path PEN_STROKE_END_FAILSAFE_MS to
        // land, then force-commit the stroke iff it is still open and no new pen contact has started.
        if (penStrokeEndFailsafeTimerRef.current !== null) {
          window.clearTimeout(penStrokeEndFailsafeTimerRef.current);
        }

        penStrokeEndFailsafeTimerRef.current = window.setTimeout(() => {
          penStrokeEndFailsafeTimerRef.current = null;

          if (activePenPointersRef.current.size === 0) {
            commitInterruptedFreehandStroke(canvas);
          }
        }, PEN_STROKE_END_FAILSAFE_MS);
      }
      // Keep the palm-guard window warm just after the pen lifts, so a palm settling as the pen leaves
      // the glass is still rejected.
      lastPenActivityAtRef.current = Date.now();
      // The stroke is over — apply a canvas resize the observer reported mid-stroke and we postponed.
      flushDeferredResize();
    };

    // Suppress the native context menu (and drag / selection) over the board. Three triggers, all of
    // which cost the teacher a stroke:
    //   - the pen's barrel button maps to a secondary/right-click, so pressing the tool/colour button
    //     would pop a menu;
    //   - a TOUCH long-press raises the OS selection/callout menu and fires `pointercancel`, truncating
    //     the stroke mid-letter;
    //   - a pen long-press (often with the S Pen side button held = object eraser) also raises
    //     contextmenu + dragstart, each a ~250 ms main-thread stall on the Samsung WebView when left to
    //     the browser (device log 2026-10-12). So contextmenu, dragstart and selectstart are now ALWAYS
    //     cancelled over the board — except inside a text field, where the native menu is wanted.
    // contextmenu is never a pen-button signal: on the Samsung WebView it is the ~600 ms long-press of
    // a still pen (device log 2026-10-04), so it is not learned or dispatched — only suppressed.
    const suppressPenContextMenu = (event: Event) => {
      // selectstart targets the Text node, which has neither a tag nor `closest` — read its element.
      const target = event.target as Node | null;
      const element = target?.nodeType === 3 /* TEXT_NODE */ ? target.parentElement : (target as Element | null);

      if (element?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;

      event.preventDefault();
    };
    // Compat mouse buttons other than the primary (a pen barrel can arrive as a right/middle mouse
    // button). Only consulted when something is learned; never touches the primary button.
    const handleLearnedMouseButton = (event: MouseEvent) => {
      if (event.button === 0 || !hasPenButtonBindings(penButtonMapRef.current)) return;

      runLearnedPenSignal({
        source: 'mouse',
        type: event.type === 'mousedown' ? 'mousedown' : 'mouseup',
        button: event.button,
      });
    };
    // Keys: some pens (and Samsung's S Pen in remote mode) send key events. Only LEARNED keys act, and
    // never while typing in a field.
    const handleLearnedKey = (event: KeyboardEvent) => {
      if (!hasPenButtonBindings(penButtonMapRef.current)) return;

      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;

      if (target?.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return;

      const hit = runLearnedPenSignal({
        source: 'key',
        type: event.type === 'keydown' ? 'keydown' : 'keyup',
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        repeat: event.repeat,
      });

      if (hit) event.preventDefault();
    };
    // Native stylus button/tool/key EDGES forwarded by the Android activity (MainActivity.kt) — the
    // fallback for when the WebView never surfaces the S Pen / M-Pen button to the page at all.
    // ---- Native-driven contact (button held BEFORE the pen touched) -------------------------------
    // Device report (SM-X910, APK 01642d3a): press the S Pen button in the air, keep holding, touch the
    // glass → no ink, no eraser, and the release opened the menu. MainActivity only forwarded button
    // EDGES, and touching down with the button already held changes no buttonState, so nothing told the
    // page the pen had landed; the WebView itself delivered no contact either (otherwise the pen-down
    // would have promoted the press and Fabric would have inked). MainActivity now forwards that
    // contact (down / per-frame move / up); this drives the erase-hold from it.
    const nativeContactEvent = (type: string, clientX: number, clientY: number) =>
      new window.MouseEvent(type, { clientX, clientY, buttons: type === 'mouseup' ? 0 : 1 });
    // The contact's samples in client px: `pts` is MainActivity's batch for the frame (the historical
    // samples Android coalesced into each ACTION_MOVE, then the current one — flat [x0,y0,x1,y1,…]),
    // falling back to the single x/y. Native coordinates are physical px relative to the WebView.
    const nativeContactPoints = (detail: Record<string, unknown>): Array<{ x: number; y: number }> => {
      const ratio = window.devicePixelRatio || 1;
      const points: Array<{ x: number; y: number }> = [];

      if (Array.isArray(detail.pts)) {
        const flat = detail.pts as unknown[];

        for (let i = 0; i + 1 < flat.length; i += 2) {
          const x = Number(flat[i]);
          const y = Number(flat[i + 1]);

          if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x: x / ratio, y: y / ratio });
        }
      }

      if (points.length === 0 && typeof detail.x === 'number' && typeof detail.y === 'number') {
        points.push({ x: detail.x / ratio, y: detail.y / ratio });
      }

      return points;
    };
    // «Pen buttons» proof lines: MOVE frames/samples per second while a native drag lasts, and the reason
    // each one ended (up / cancel / button release / the page's own contact took over / teardown).
    const nativeMoveMeter = createNativeMoveRateMeter();
    let nativeDragStartedAt = 0;
    let nativeDragFrames = 0;
    let nativeDragSamples = 0;
    function traceNativeDragEnd(reason: string) {
      const now = Date.now();
      const rate = nativeMoveMeter.flush(now);

      if (rate) recordPenNativeTrace('native MOVE/s', rate, now);

      recordPenNativeTrace(
        'native stroke end',
        `reason: ${reason} — after ${now - nativeDragStartedAt} ms, ${nativeDragFrames} frames / ${nativeDragSamples} samples`, // i18n-ignore: diagnostic trace
        now,
      );
    }
    const endNativePenDrag = (event: MouseEvent | null, reason: string) => {
      if (!nativePenDragRef.current) return;

      nativePenDragRef.current = false;
      traceNativeDragEnd(reason);
      // The pen is in the air now (or the page's own contact has it): no native sample will move the
      // cursor again, and the WebView's button-held frames are not a hover — hide it.
      onNativePenPointRef.current?.(null);

      if (reason === 'up' || reason === 'cancel') nativeTailGuardRef.current = true;

      if (isObjectErasingRef.current) {
        endObjectEraseDrag();

        return;
      }

      const drawingCanvas = canvas as Canvas & {
        _isCurrentlyDrawing?: boolean;
        _onMouseUpInDrawingMode?: (e: MouseEvent) => void;
      };

      if (drawingCanvas.isDrawingMode && drawingCanvas._isCurrentlyDrawing) {
        if (event && drawingCanvas._onMouseUpInDrawingMode) {
          drawingCanvas._onMouseUpInDrawingMode(event);
        } else {
          commitInterruptedFreehandStroke(canvas);
        }
      }
    };
    const handleNativePenContact = (detail: Record<string, unknown>) => {
      const points = nativeContactPoints(detail);
      const last = points[points.length - 1];

      if (last) {
        lastNativePenPointRef.current.x = last.x;
        lastNativePenPointRef.current.y = last.y;
        lastNativePenPointRef.current.at = Date.now();
      }

      // The forwarded contact IS input: without this the idle stuck-ink backstop (no DOM input for
      // INPUT_IDLE_RECOVERY_MS, no DOM pen down) took the native-driven erase stroke for a stranded one and
      // committed it ~1.2–1.9 s in — the eraser then stopped although the pen kept moving.
      noteInputActivity(`native contact ${String(detail.type)}`);
      // …and the page-wide idle gate's: the WebView sends no pointer event for this contact, so without it
      // every quiet-idle job (page snapshot + undo checkpoint, ink bake, backdrop, PDF warm) ran under it.
      noteExternalContact(detail.type === 'down' ? 'down' : detail.type === 'move' ? 'move' : 'up');

      if (detail.type === 'down') {
        // The page HAS this contact (a DOM pen-down already promoted the press): nothing to drive.
        if (activePenPointersRef.current.size > 0) return;

        // A button held in the air becomes a contact hold: the pending menu is cancelled, eraser on.
        notePenButtonContactStart();

        if (penButtonOverrideToolRef.current === null || !last) return;

        const down = nativeContactEvent('mousedown', last.x, last.y);

        nativePenDragRef.current = true;
        nativeDragStartedAt = Date.now();
        nativeDragFrames = 0;
        nativeDragSamples = 0;
        nativeMoveMeter.reset(nativeDragStartedAt);
        recordPenNativeTrace(
          'native stroke start',
          `${isObjectEraserToolActive(effectiveToolRef.current) ? 'object eraser' : 'partial eraser'} x=${Math.round( // i18n-ignore: diagnostic trace
            last.x,
          )} y=${Math.round(last.y)} (CSS px)`,
        );
        shapeSnapRef.current?.cancel();
        onNativePenPointRef.current?.({ x: last.x, y: last.y });

        if (isObjectEraserToolActive(effectiveToolRef.current)) {
          isObjectErasingRef.current = true;
          lastObjectErasePointRef.current = null;
          eraseObjectsAlong(canvas, canvas.getScenePoint(down));

          return;
        }

        const drawingCanvas = canvas as Canvas & {
          _isCurrentlyDrawing?: boolean;
          _onMouseDownInDrawingMode?: (e: MouseEvent) => void;
        };

        commitInterruptedFreehandStroke(canvas);

        if (drawingCanvas.isDrawingMode) drawingCanvas._onMouseDownInDrawingMode?.(down);

        return;
      }

      if (!nativePenDragRef.current) return;

      if (detail.type === 'move') {
        // The WebView found the contact after all: hand the drag back to its stream.
        if (activePenPointersRef.current.size > 0) {
          endNativePenDrag(null, 'dom contact took over');
          penButtonStrokeRestartRef.current = true;

          return;
        }

        if (points.length === 0) return;

        const now = Date.now();

        nativeDragFrames += 1;
        nativeDragSamples += points.length;

        const rate = nativeMoveMeter.frame(points.length, now);

        if (rate) recordPenNativeTrace('native MOVE/s', rate, now);

        if (isObjectErasingRef.current) {
          // The object eraser sweeps the path from its last point, so every batched sample counts — all of
          // them in ONE pass (one broad-phase query, one remove), not a full erase per sample.
          eraseObjectsAlongPoints(
            canvas,
            points.map((point) => canvas.getScenePoint(nativeContactEvent('mousemove', point.x, point.y))),
          );
        } else {
          const drawingCanvas = canvas as Canvas & { _onMouseMoveInDrawingMode?: (e: MouseEvent) => void };
          const brush = canvas.freeDrawingBrush as
            | (LowLatencyPencilBrush & { appendCoalescedSample?: unknown })
            | undefined;
          const canAppend = !!brush && typeof brush.appendCoalescedSample === 'function';

          // Like the DOM path's coalesced samples: every sample but the frame's last is APPENDED, and only
          // the last goes through Fabric's move — the one repaint of the frame. Feeding each sample to
          // Fabric's move repainted the partial eraser per sample (its full-render `_render` blits the
          // whole board and redraws the whole stroke so far), 2–6× a frame and growing with the stroke:
          // the button eraser lagged whenever this path drove it and was smooth when the WebView did.
          for (let i = 0; i < points.length; i += 1) {
            const event = nativeContactEvent('mousemove', points[i].x, points[i].y);

            if (canAppend && i < points.length - 1) {
              (brush as LowLatencyPencilBrush).appendCoalescedSample(canvas.getScenePoint(event));
            } else {
              drawingCanvas._onMouseMoveInDrawingMode?.(event);
            }
          }
        }

        onNativePenPointRef.current?.({ x: last.x, y: last.y });

        return;
      }

      // 'up' / 'cancel': end the erase stroke. The button release (a separate edge) restores the nib and,
      // because the press became a contact hold, never opens the menu.
      const end = last ?? { x: lastNativePenPointRef.current.x, y: lastNativePenPointRef.current.y };

      endNativePenDrag(nativeContactEvent('mouseup', end.x, end.y), detail.type === 'cancel' ? 'cancel' : 'up');
    };
    const handleNativePenSignal = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail as Record<string, unknown> | null;

      if (!detail || typeof detail !== 'object') return;

      if (detail.kind === 'contact') {
        handleNativePenContact(detail);

        return;
      }

      if (detail.kind === 'key') {
        runLearnedPenSignal({
          source: 'native',
          kind: 'key',
          type: detail.type === 'up' ? 'up' : 'down',
          keyCode: Number(detail.keyCode) || 0,
          repeat: Number(detail.repeat) || 0,
        });
      } else if (detail.kind === 'motion') {
        nativeStylusButtonStateRef.current = Number(detail.buttonState) || 0;

        // The pen left the glass's range: nothing on the page says so (no pen pointerleave arrives
        // after a button-held contact), so the cursor would stay where the pen was.
        if (detail.action === 'ACTION_HOVER_EXIT' && !nativePenDragRef.current) onNativePenPointRef.current?.(null);

        if (nativeStylusButtonStateRef.current !== 0) shapeSnapRef.current?.cancel();

        // Native coordinates are physical px in the WebView; the WebView fills the window.
        const ratio = window.devicePixelRatio || 1;

        if (typeof detail.x === 'number' && typeof detail.y === 'number') {
          lastNativePenPointRef.current.x = detail.x / ratio;
          lastNativePenPointRef.current.y = detail.y / ratio;
          lastNativePenPointRef.current.at = Date.now();
        }

        runLearnedPenSignal({
          source: 'native',
          kind: 'motion',
          buttonState: Number(detail.buttonState) || 0,
          prevButtonState: Number(detail.prevButtonState) || 0,
          toolType: Number(detail.toolType) || 0,
          prevToolType: Number(detail.prevToolType) || 0,
          ...(typeof detail.contact === 'boolean' ? { contact: detail.contact } : {}),
        });
      }
    };
    // A barrel-button press while the pen HOVERS (no tip contact, no positional move) may not produce a
    // pointermove. Chromium/WebView2 fires `pointerrawupdate` for hover + button-state changes that don't
    // yield a pointermove, so run the edge detector there too → an in-air button click toggles instantly.
    const handlePenRawUpdate = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;
      if (!tabletInputSettingsRef.current.penButtonsEnabled && !hasPenButtonBindings(penButtonMapRef.current)) return;

      notePenActivity();
      // pointerrawupdate fires uncoalesced at a higher rate than pointermove, so refresh the pen's live
      // position here too for the freshest proximity match — but ONLY while the tip is down (this event
      // also fires on hover, and a hover point must never let a finger ink).
      if (activePenPointersRef.current.has(event.pointerId)) {
        lastPenClientPointRef.current = { x: event.clientX, y: event.clientY };
      }

      processPenButtons(event);
    };
    // The container's listeners only see pen events whose target is INSIDE it. The quick pen menu is an
    // `inset-0` overlay beside the board (so are the popovers and the toolbar): a button edge while the
    // pen is over any of those used to be invisible — the per-pointer `buttons` baseline and the
    // hover/contact gesture went stale, and the next frame back over the board read the difference as a
    // phantom press or release (the menu toggling on its own after a colour pick). Button edges are
    // tracked on the WINDOW for every pen event the container will not get; nothing else about such an
    // event (no drawing, no pointer bookkeeping) is touched here.
    const trackPenButtonsOutside = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;

      const target = event.target as Node | null;

      if (target && containerEl.contains(target)) return;

      if (!tabletInputSettingsRef.current.penButtonsEnabled && !hasPenButtonBindings(penButtonMapRef.current)) return;

      notePenActivity();

      if (event.type !== 'pointerup' && event.type !== 'pointercancel') {
        lastPenPointerPointRef.current.x = event.clientX;
        lastPenPointerPointRef.current.y = event.clientY;
        lastPenPointerPointRef.current.at = Date.now();
      }

      processPenButtons(event);

      if (event.type === 'pointerup' || event.type === 'pointercancel') {
        penButtonsPrevButtonsRef.current.delete(event.pointerId);
      }
    };
    const outsidePenButtonEvents = ['pointerdown', 'pointermove', 'pointerrawupdate', 'pointerup', 'pointercancel'];

    // THE ENDLESS-INK INVARIANT (device-agnostic, no timer): a pen or mouse MOVING WITHOUT CONTACT cannot
    // be what holds a freehand stroke open — so if Fabric still has one open, its ending event was lost
    // and this hover is the only evidence the pen ever lifted. Commit the stroke NOW (kept, not
    // discarded — same routine as the pen-down / 150ms / idle-reaper failsafes) and keep this event
    // away from Fabric's brush.
    //
    // Why the three existing layers were not enough (Android S Pen / M-Pen, also seen on the ThinkPad):
    // Fabric v7 is bound to the raw touch + compat MOUSE streams, and `_onMouseMoveInDrawingMode`
    // extends the open path on EVERY mousemove while `_isCurrentlyDrawing` — it never looks at
    // `buttons`. A stylus hovering over the glass produces pointermove (pointerType 'pen', buttons 0,
    // pressure 0) AND compat mousemove (buttons 0), so a single lost touchend/mouseup lets the hover
    // path ink forever. The pen-down commit needs the NEXT contact, the 150ms failsafe needs the
    // pointerup to have ARRIVED, and the idle reaper needs activePen===0 — a lift whose pointerup was
    // lost too satisfies none of them. A hover frame satisfies this one immediately.
    //
    // Scope, so it can never truncate a LIVE stroke:
    //   • touch pointers are never judged (isHoverWithoutContact) — a finger has no hover state, and on
    //     the ViewSonic every capacitive-pen head reports as 'touch' and legitimately rests still;
    //   • contact is the PRIMARY `buttons` bit, so a pen writing with the barrel held (buttons 3) is in
    //     contact and a pen hovering with it held (buttons 2) is not;
    //   • while a FINGER owns the open stroke (touchInputMode 'finger-draws', or the touch-only panels'
    //     tentative ink), a hovering pen/mouse says nothing about that finger → leave it alone. On a
    //     touch-only-ROUTED device that means ANY live touch contact: the ViewSonic's IR pen can be
    //     mid-stroke in Fabric with the drawing-pointer ref unset (see injectCoalescedSamples'
    //     isLoneTouchStroke), and a mouse nudged on the desk must not end that stroke;
    //   • a MOUSE-like hover (real mouse, or a compat MouseEvent with no pointerType) while a pen is
    //     physically DOWN is a trackpad brush / stray mouse, not the pen lifting → leave it alone. A
    //     PEN hover is judged regardless: if the hovering pen is still recorded as down, its pointerup
    //     was lost as well, and that record is healed here too so the twin-touch guard and the idle
    //     reaper see the truth again.
    // Capture phase on the container (an ancestor of Fabric's upper canvas) runs before Fabric's own
    // listener; stopPropagation on the mouse channel is what keeps the brush from sampling the hover
    // point. The pointer channel is not Fabric's input (no enablePointerEvents), so it only commits.
    const commitStrokeOnHoverWithoutContact = (event: PointerEvent | MouseEvent) => {
      // The open stroke is driven from native samples (a contact the WebView never reported): whatever
      // hover the WebView emits meanwhile says nothing about it.
      if (nativePenDragRef.current) return;

      // The pen frame in flight is a tip-leaving 'skip' (see penFrameSkipRef): its compat mousemove — in
      // contact as far as `buttons` says — is the same lifted position Fabric must not append. Starve it.
      if (event.type === 'mousemove' && penFrameSkipRef.current && !isHoverWithoutContact(event)) {
        event.stopPropagation();

        return;
      }

      // Samsung WebView: hovering with the S Pen button held emits a pen pointerrawupdate/move with
      // buttons 1 and pressure 0 — a fake "contact" on a pen that never went down. With the native
      // button reported held and no pen-down recorded for that pointer, it is still hover.
      const isNativeButtonHoverGhost =
        event.type !== 'mousemove' &&
        (event as PointerEvent).pointerType === 'pen' &&
        (event.buttons & 1) !== 0 &&
        (event as PointerEvent).pressure === 0 &&
        nativeStylusButtonStateRef.current !== 0 &&
        activePenPointersRef.current.size === 0;

      if (!isHoverWithoutContact(event) && !isNativeButtonHoverGhost) return;

      const drawingCanvas = canvas as Canvas & { _isCurrentlyDrawing?: boolean };

      if (!drawingCanvas.isDrawingMode || !drawingCanvas._isCurrentlyDrawing) return;

      if (touchDrawingPointerIdRef.current !== null || fingerDrawTouchIdentifierRef.current !== null) return;

      if (
        !isRoutedAsPenDevice() &&
        (activeTouchPointersRef.current.size > 0 || rawTouchContactsRef.current.size > 0)
      ) {
        return;
      }

      const pointerType = (event as PointerEvent).pointerType;
      const isPenHover = pointerType === 'pen';

      if (!isPenHover && activePenPointersRef.current.size > 0) return;

      const pointerId = (event as PointerEvent).pointerId;
      const stalePenDown = isPenHover && activePenPointersRef.current.has(pointerId);

      commitInterruptedFreehandStroke(canvas);
      inputRecoveryCountRef.current += 1;

      penFrameSkipRef.current = false;

      if (stalePenDown) {
        activePenPointersRef.current.delete(pointerId);
        penContactPressureRef.current.delete(pointerId);
        clearPenPointerOffset();

        if (activePenPointersRef.current.size === 0) {
          lastPenClientPointRef.current = null;
        }
      }

      if (event.type === 'mousemove') {
        event.stopPropagation();
      }

      noteInputActivity('hover commit');

      if (isInputTraceEnabled()) {
        traceInput({
          kind: isPenHover ? 'pen' : 'mouse',
          phase: 'move',
          decision: stalePenDown ? 'hover-commit:stale-pen-down' : 'hover-commit',
          pointerId: pointerId ?? -1,
          pointerType: pointerType ?? 'mouse',
          width: 0,
          height: 0,
          buttons: event.buttons,
          hasSeenRealPen: hasSeenRealPenRef.current,
          activePen: activePenPointersRef.current.size,
          activeTouch: activeTouchPointersRef.current.size,
        });
      }

      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem('wb-debug-pen')) {
          // eslint-disable-next-line no-console
          console.debug('[pen-hover-commit]', {
            type: event.type,
            pointerType: pointerType ?? '(compat mouse)',
            pointerId,
            buttons: event.buttons,
            pressure: (event as PointerEvent).pressure,
            stalePenDown,
          });
        }
      } catch {
        // localStorage can throw in locked-down contexts — diagnostics must never break input.
      }
    };

    // The erase-hold tail guard (nativeTailGuardRef). On the WINDOW in the capture phase, so it runs before
    // every board listener (the container's, Fabric's on the canvas/document, React's on the root).
    const guardNativeEraseTail = (event: Event) => {
      if (!nativeTailGuardRef.current) return;

      if (event.type.startsWith('mouse')) {
        if (!swallowCompatMouseRef.current) return;

        if (event.type === 'mouseup') swallowCompatMouseRef.current = false;

        event.stopImmediatePropagation();

        return;
      }

      const pointer = event as PointerEvent;

      if (pointer.pointerType !== 'pen') return;

      if ((pointer.buttons & 1) === 0 && pointer.type !== 'pointerup' && pointer.type !== 'pointercancel') {
        // A real hover: the pen is plainly in the air, the tail is over.
        nativeTailGuardRef.current = false;
        swallowCompatMouseRef.current = false;

        return;
      }

      if (pointer.type === 'pointerdown' && pointer.pressure > 0) {
        // A genuine pen-down: the teacher is writing again.
        nativeTailGuardRef.current = false;
        swallowCompatMouseRef.current = false;

        return;
      }

      if (activePenPointersRef.current.has(pointer.pointerId)) return;

      if (pointer.type === 'pointerup' || pointer.type === 'pointercancel' || pointer.pressure !== 0) return;

      // buttons=1, pressure 0, and no real pointerdown opened it: the WebView's button-held "contact".
      if (pointer.type === 'pointerdown') {
        // Suppresses the compat mousedown/move/up (spec); they are swallowed as well in case it does not.
        if (pointer.cancelable) pointer.preventDefault();

        swallowCompatMouseRef.current = true;
        recordPenNativeTrace('tail guard', `zero-pressure pointerdown (id=${pointer.pointerId}) — ignored`); // i18n-ignore: diagnostic trace
      }

      event.stopImmediatePropagation();
    };
    const tailGuardEvents = [
      'pointerdown',
      'pointermove',
      'pointerrawupdate',
      'pointerover',
      'pointerenter',
      'mousedown',
      'mousemove',
      'mouseup',
    ];

    for (const type of tailGuardEvents) {
      window.addEventListener(type, guardNativeEraseTail, { capture: true, passive: false });
    }

    // After the tail guard on purpose: a zero-pressure frame it swallows never reaches this either.
    for (const type of outsidePenButtonEvents) {
      window.addEventListener(type as 'pointermove', trackPenButtonsOutside, { capture: true, passive: true });
    }

    containerEl.addEventListener('pointerdown', handlePenDown, { capture: true, passive: true });
    // Registered BEFORE handlePenMove / handlePenRawUpdate on purpose: same element, same phase, so
    // listeners run in registration order. A hover frame from a pen whose pointerup was lost must heal
    // the stale pen-down record FIRST, or handlePenMove would still take it for a contact and inject
    // the hover point into the brush before the commit.
    containerEl.addEventListener('pointermove', commitStrokeOnHoverWithoutContact, { capture: true, passive: true });
    containerEl.addEventListener('pointerrawupdate' as 'pointermove', commitStrokeOnHoverWithoutContact, {
      capture: true,
      passive: true,
    });
    containerEl.addEventListener('mousemove', commitStrokeOnHoverWithoutContact, { capture: true, passive: true });
    containerEl.addEventListener('pointermove', handlePenMove, { capture: true, passive: true });
    // `pointerrawupdate` isn't in the DOM lib's event map (but fires a PointerEvent at runtime) — cast
    // the name to a pointer-typed key so the handler keeps its PointerEvent typing.
    containerEl.addEventListener('pointerrawupdate' as 'pointermove', handlePenRawUpdate, {
      capture: true,
      passive: true,
    });
    containerEl.addEventListener('pointerup', releasePen, { capture: true });
    containerEl.addEventListener('pointercancel', releasePen, { capture: true });
    containerEl.addEventListener('contextmenu', suppressPenContextMenu);
    containerEl.addEventListener('dragstart', suppressPenContextMenu, { capture: true });
    containerEl.addEventListener('selectstart', suppressPenContextMenu, { capture: true });
    containerEl.addEventListener('mousedown', handleLearnedMouseButton, { capture: true, passive: true });
    containerEl.addEventListener('mouseup', handleLearnedMouseButton, { capture: true, passive: true });
    window.addEventListener('keydown', handleLearnedKey);
    window.addEventListener('keyup', handleLearnedKey);
    window.addEventListener(NATIVE_PEN_EVENT, handleNativePenSignal);

    return () => {
      for (const type of tailGuardEvents) window.removeEventListener(type, guardNativeEraseTail, true);

      for (const type of outsidePenButtonEvents) {
        window.removeEventListener(type as 'pointermove', trackPenButtonsOutside, true);
      }

      nativeTailGuardRef.current = false;
      swallowCompatMouseRef.current = false;
      containerEl.removeEventListener('pointerdown', handlePenDown, true);
      containerEl.removeEventListener('pointermove', handlePenMove, true);
      containerEl.removeEventListener('pointermove', commitStrokeOnHoverWithoutContact, true);
      containerEl.removeEventListener('pointerrawupdate' as 'pointermove', commitStrokeOnHoverWithoutContact, true);
      containerEl.removeEventListener('mousemove', commitStrokeOnHoverWithoutContact, true);
      containerEl.removeEventListener('pointerrawupdate' as 'pointermove', handlePenRawUpdate, true);
      containerEl.removeEventListener('pointerup', releasePen, true);
      containerEl.removeEventListener('pointercancel', releasePen, true);
      containerEl.removeEventListener('contextmenu', suppressPenContextMenu);
      containerEl.removeEventListener('dragstart', suppressPenContextMenu, true);
      containerEl.removeEventListener('selectstart', suppressPenContextMenu, true);
      containerEl.removeEventListener('mousedown', handleLearnedMouseButton, true);
      containerEl.removeEventListener('mouseup', handleLearnedMouseButton, true);
      window.removeEventListener('keydown', handleLearnedKey);
      window.removeEventListener('keyup', handleLearnedKey);
      window.removeEventListener(NATIVE_PEN_EVENT, handleNativePenSignal);
      penButtonDispatcherRef.current.reset();
      resetPenButtonGestures();
      penButtonOverrideToolRef.current = null;

      if (nativePenDragRef.current) traceNativeDragEnd('teardown');

      nativePenDragRef.current = false;
      activePenPointersRef.current.clear();
      penContactPressureRef.current.clear();
      penFrameSkipRef.current = false;
      lastPenClientPointRef.current = null;
      penButtonsPrevButtonsRef.current.clear();

      if (penStrokeEndFailsafeTimerRef.current !== null) {
        window.clearTimeout(penStrokeEndFailsafeTimerRef.current);
        penStrokeEndFailsafeTimerRef.current = null;
      }
    };
  }, [
    applyPenTiltOffset,
    cancelFling,
    cancelScheduledObjectErase,
    clearPenPointerOffset,
    injectCoalescedSamples,
    isObjectEraserToolActive,
    syncEffectiveTool,
    canvas,
    commitInterruptedFreehandStroke,
    clearPenPointerOffset,
    commitZoomPreview,
    containerRef,
    flushDeferredResize,
    invalidatePointerGeometry,
    isRoutedAsPenDevice,
    markRealPenSeen,
    noteInputActivity,
    reapStalePointersAndRecover,
  ]);

  // Keep the learned pen-button map current: the «Pen buttons» page fires PEN_BUTTON_MAP_CHANGED_EVENT
  // after a write; `storage` covers another window. A changed map drops any held press.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const reload = (event?: Event) => {
      // Duck-typed: `StorageEvent` is not a global in every runtime the hook mounts in (jsdom tests).
      const storageKey = event?.type === 'storage' ? (event as StorageEvent).key : null;

      if (storageKey !== null && storageKey !== PEN_BUTTON_MAP_STORAGE_KEY) return;

      penButtonMapRef.current = readPenButtonMap(safeLocalStorage());
      penButtonEffectiveMapRef.current = withDefaultStylusBinding(penButtonMapRef.current);
      penButtonDispatcherRef.current.reset();
      penButtonGesturesRef.current.clear();
    };

    reload();
    window.addEventListener(PEN_BUTTON_MAP_CHANGED_EVENT, reload);
    window.addEventListener('storage', reload);

    return () => {
      window.removeEventListener(PEN_BUTTON_MAP_CHANGED_EVENT, reload);
      window.removeEventListener('storage', reload);
    };
  }, []);

  // --- Tool + brush synchronization ---
  useEffect(() => {
    if (!canvas) return;

    syncEffectiveTool(canvas);
  }, [activeTool, canvas, eraserMode, eraserSize, strokeSettings, syncEffectiveTool]);

  // --- Desktop temporary overrides ---
  useEffect(() => {
    if (!canvas) return;

    const isEditableTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      const tagName = element?.tagName;

      return (
        element?.isContentEditable === true || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
      );
    };
    const clearKeyboardOverride = () => {
      if (!keyboardOverrideToolRef.current) return;

      keyboardOverrideToolRef.current = null;
      syncEffectiveTool(canvas);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      if (event.code === 'Space') {
        event.preventDefault();

        if (activeToolRef.current !== 'pan' && keyboardOverrideToolRef.current !== 'pan') {
          keyboardOverrideToolRef.current = 'pan';
          syncEffectiveTool(canvas);
        }

        return;
      }

      if (event.key.toLowerCase() !== 'e') return;

      if (activeToolRef.current !== 'eraser' && keyboardOverrideToolRef.current !== 'eraser') {
        keyboardOverrideToolRef.current = 'eraser';
        syncEffectiveTool(canvas);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' && keyboardOverrideToolRef.current === 'pan') {
        keyboardOverrideToolRef.current = null;
        syncEffectiveTool(canvas);

        return;
      }

      if (event.key.toLowerCase() === 'e' && keyboardOverrideToolRef.current === 'eraser') {
        keyboardOverrideToolRef.current = null;
        syncEffectiveTool(canvas);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', clearKeyboardOverride);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', clearKeyboardOverride);
    };
  }, [canvas, syncEffectiveTool]);

  // --- Mouse ---
  // The mouse simply DRAWS via Fabric's native mouse handlers (isDrawingMode by the current tool). The
  // only thing we do here is, capture-phase on mouse-down, commit any in-flight zoom/pan preview so a
  // click/draw right after a Ctrl+wheel zoom acts on the real committed viewport (correct scene coords).
  useEffect(() => {
    if (!canvas) return;

    const containerEl = containerRef.current;

    if (!containerEl) return;

    const handleMouseDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) {
        return;
      }

      // A mouse must never inherit the pen's nib correction — belt for the release paths above.
      clearPenPointerOffset();
      cancelFling();
      noteInputActivity('mouse down');
      commitZoomPreview(canvas);
    };

    containerEl.addEventListener('pointerdown', handleMouseDown, { capture: true, passive: true });

    return () => {
      containerEl.removeEventListener('pointerdown', handleMouseDown, true);
    };
  }, [cancelFling, canvas, clearPenPointerOffset, commitZoomPreview, containerRef, noteInputActivity]);

  // --- Touch-first two-finger pan ---
  useEffect(() => {
    if (!canvas) return;

    const containerEl = containerRef.current;

    if (!containerEl) return;

    const getPrimaryTouchPointerId = (): number | null =>
      touchDrawingPointerIdRef.current ?? Array.from(activeTouchPointersRef.current.keys())[0] ?? null;
    const getPrimaryTouchPoint = (): TouchPoint | null => {
      const primaryPointerId = getPrimaryTouchPointerId();

      return primaryPointerId === null ? null : (activeTouchPointersRef.current.get(primaryPointerId) ?? null);
    };
    const trackTouchPointer = (event: PointerEvent) => {
      const previousPointer = activeTouchPointersRef.current.get(event.pointerId);
      const startX = previousPointer?.startX ?? event.clientX;
      const startY = previousPointer?.startY ?? event.clientY;
      const startedAt = previousPointer?.startedAt ?? Date.now();
      const maxTravel = Math.max(
        previousPointer?.maxTravel ?? 0,
        Math.hypot(event.clientX - startX, event.clientY - startY),
      );
      const dualTip = tabletInputSettingsRef.current.dualTipStylus;
      // Each rulebook reads its OWN calibration: legacy measures single frames (and the major axis for
      // routing), height-aware measures a settled minor axis, so the same head sits in different bands
      // under each. Swapping the rulebook without swapping the numbers is what would make the switch
      // look broken. `settleMs`/`activationPx` are inert under legacy — it decides per frame.
      const isLegacyClassifier = dualTip.classifier === 'legacy';
      const contact = updateContactState(
        previousPointer?.contact ?? createContactState(),
        {
          width: event.width,
          height: event.height,
          travelPx: maxTravel,
          elapsedMs: Date.now() - startedAt,
        },
        {
          smallHeadMaxWidth: isLegacyClassifier ? dualTip.legacyBands.smallHeadMaxWidth : dualTip.smallHeadMaxWidth,
          bigHeadMaxWidth: isLegacyClassifier ? dualTip.legacyBands.bigHeadMaxWidth : dualTip.bigHeadMaxWidth,
          fingerMinWidth: isLegacyClassifier
            ? dualTip.legacyBands.fingerMinWidth
            : tabletInputSettingsRef.current.singleFingerPan.minWidth,
          dualTipEnabled: dualTip.enabled,
          mode: dualTip.classifier,
          settleMs: CONTACT_SETTLE_MS,
          activationPx: SINGLE_TOUCH_PAN_ACTIVATION_DISTANCE,
        },
      );
      // Training capture: open a contact on its first frame, then record every frame WITH the state the
      // live classifier just produced for it — never a recomputation, so a captured row can only ever
      // describe a decision the board actually took.
      //
      // Gated on the LIVE capture switch, not merely on the sink's existence: this block runs on every
      // touch move, and with capture off (the default, and what every teaching board runs) it used to
      // allocate a frame + two options objects per move for rows nothing would ever read. A contact that
      // started while capture was off is simply never opened, so `frame()`/`end()` no-op for it.
      const recorder = isContactCaptureRecording() ? contactRecorderRef.current : null;

      if (recorder) {
        if (!previousPointer) {
          emitCapturedContact(
            recorder.begin(event.pointerId, {
              startedAt,
              pointerType: event.pointerType,
              palmRejectActive: isPalmRejectActive(),
              activeTool: activeToolRef.current,
              effectiveTool: effectiveToolRef.current,
              // Frames are in CLIENT space, which is a panned/zoomed view of the page. Without the
              // viewport, contacts from different moments do not share a coordinate system and the
              // page cannot be redrawn for review.
              context: {
                zoom: canvas.getZoom(),
                panX: canvas.viewportTransform?.[4] ?? 0,
                panY: canvas.viewportTransform?.[5] ?? 0,
                canvasW: canvas.getWidth(),
                canvasH: canvas.getHeight(),
              },
            }),
          );
        }

        recorder.frame(
          event.pointerId,
          {
            t: Date.now() - startedAt,
            w: event.width,
            h: event.height,
            x: event.clientX,
            y: event.clientY,
            pressure: event.pressure,
            tiltX: event.tiltX,
            tiltY: event.tiltY,
            twist: event.twist,
            coalesced: false,
          },
          contact,
        );
      }

      const nextPointer: ActiveTouchPointer = {
        x: event.clientX,
        y: event.clientY,
        maxTravel,
        startedAt,
        startX,
        startY,
        // Refreshed on every event for this id; the self-heal reaper reads it to tell a live gesture
        // (fresh) from a phantom stranded by a dropped release (stale > STALE_POINTER_MS).
        lastSeenAt: Date.now(),
        contact,
      };

      activeTouchPointersRef.current.set(event.pointerId, nextPointer);

      return nextPointer;
    };
    // PALM GUARD predicate (the ONLY palm rejection): a pen is physically down, OR was active within
    // PEN_PALM_REJECT_MS (refreshed on pen down/move/HOVER/up). On a pen device the hand rests while the
    // tip is off the glass (activePen === 0), so this TIME WINDOW — not contact size — rejects the palm.
    const isPalmRejectActive = () =>
      activePenPointersRef.current.size > 0 || Date.now() - lastPenActivityAtRef.current < PEN_PALM_REJECT_MS;
    // Dual-tip stylus (TOUCH-ONLY device only): classify a single touch contact by its reported contact
    // size. On a ViewSonic the dual-tip pen's two heads and a finger ALL report `pointerType === 'touch'`,
    // so size is the only signal that separates them. Returns null when the feature is off OR the digitizer
    // doesn't expose a usable size (<=1px, which some panels report as a flat placeholder) — the caller then
    // keeps the normal single colour and re-classifies on later moves.
    // Both dual-tip answers for a contact come from its ContactState, which trackTouchPointer advances
    // once per event through whiteboard-core's updateContactState. Nothing here re-derives them: a
    // second implementation is exactly how the colour and the routing came to disagree about the same
    // contact in the first place.
    const contactStateFor = (event: PointerEvent): ContactState | null =>
      activeTouchPointersRef.current.get(event.pointerId)?.contact ?? null;
    const classifyDualTipHead = (event: PointerEvent): 'small' | 'big' | 'finger' | null =>
      contactStateFor(event)?.head ?? null;
    // Is this touch-only contact a FINGER (→ navigate) rather than a pen head (→ write)? true/false once
    // the panel has reported a usable footprint, null while it is still unknown (placeholder readings) so
    // the caller can defer instead of guessing.
    //
    // «Finger size» (singleFingerPan.minWidth) is the threshold, exactly as the teacher set it — what
    // changed is the RULER, not who holds it: it is measured against the tilt-stable MINOR axis instead
    // of the tilt-inflated major axis, and a strongly elongated contact is read as a tilted pen rather
    // than a finger (isFingerContact in whiteboard-core, fitted on the labelled ViewSonic capture).
    //
    // null while the contact is still deciding — the caller must DEFER, not guess. See
    // updateContactState for why the verdict waits for the settled size and is then frozen.
    const isFingerSizedContact = (event: PointerEvent): boolean | null => contactStateFor(event)?.routing ?? null;
    // The brush colour for a touch DRAW stroke under dual-tip: big head → secondary colour, everything
    // else (small head, finger) → the primary colour. Alpha-wrapped for the highlighter to match the
    // normal highlighter path. Only meaningful for pen/highlighter (never the eraser).
    const resolveDualTipBrushColor = (head: 'small' | 'big' | 'finger' | null): string => {
      // resolveHeadColourRole owns the mapping: only the SMALL band writes in the primary colour, and a
      // contact classified 'finger' that is nonetheless writing takes the big head's colour rather than
      // the small head's — see its doc.
      const base =
        resolveHeadColourRole(head) === 'secondary'
          ? strokeSettingsRef.current.secondaryColor
          : strokeSettingsRef.current.color;

      if (effectiveToolRef.current === 'highlighter') return withAlpha(base, HIGHLIGHTER_OPACITY);
      if (effectiveToolRef.current === 'marker') return withAlpha(base, SOFT_MARKER_OPACITY);

      return base;
    };
    // Dev input trace: record a touch event's decision so a teacher can export the exact timeline.
    const traceTouch = (event: PointerEvent, phase: 'cancel' | 'down' | 'move' | 'up', decision: string) => {
      if (!isInputTraceEnabled()) return;

      traceInput({
        kind: 'touch',
        phase,
        decision,
        pointerId: event.pointerId,
        pointerType: event.pointerType || 'touch',
        width: event.width,
        height: event.height,
        buttons: event.buttons,
        hasSeenRealPen: hasSeenRealPenRef.current,
        activePen: activePenPointersRef.current.size,
        activeTouch: activeTouchPointersRef.current.size,
      });
    };

    const getTouchCenter = (): TouchPoint | null => {
      const touchPoints = Array.from(activeTouchPointersRef.current.values());

      if (touchPoints.length < 2) {
        return null;
      }

      return {
        x: (touchPoints[0].x + touchPoints[1].x) / 2,
        y: (touchPoints[0].y + touchPoints[1].y) / 2,
      };
    };
    const getTouchDistance = () => {
      const touchPoints = Array.from(activeTouchPointersRef.current.values());

      if (touchPoints.length < 2) {
        return null;
      }

      return Math.hypot(touchPoints[0].x - touchPoints[1].x, touchPoints[0].y - touchPoints[1].y);
    };
    const stopTouchPan = () => {
      pendingSingleTouchPanRef.current = null;
      multiTouchGestureBaselineRef.current = null;

      // A pan/zoom gesture is ending — bake any previewed transform into Fabric now (crisp on release).
      commitZoomPreview(canvas);

      if (touchOverrideToolRef.current !== 'pan') return;

      touchOverrideToolRef.current = null;
      touchPanModeRef.current = null;
      lastTouchPanCenterRef.current = null;
      lastTouchDistanceRef.current = null;
      zoomGestureBaselineRef.current = null;
      zoomDistanceFilterRef.current = createZoomDistanceFilterState();
      cancelScheduledTouchViewportUpdate();
      syncEffectiveTool(canvas);
    };
    const ignoreTouchPointer = (event: PointerEvent, shouldEndFreehandStroke = false) => {
      ignoredTouchPointerIdsRef.current.add(event.pointerId);

      if (shouldEndFreehandStroke) {
        commitInterruptedFreehandStroke(canvas);
      }

      event.preventDefault();
      event.stopPropagation();
    };
    const startTouchPan = (mode: TouchPanMode) => {
      const isAlreadyActive = touchOverrideToolRef.current === 'pan' && touchPanModeRef.current === mode;

      if (!isAlreadyActive) {
        panVelocitySamplesRef.current = [];
        panAxisLockStateRef.current = createPanAxisLock();
      }

      // Mark every live contact as having navigated: what a training row needs is whether this contact
      // ENDED UP panning, which is a fact about the gesture rather than about the classifier's verdict.
      if (contactRecorderRef.current) {
        activeTouchPointersRef.current.forEach((_pointer, pointerId) => {
          contactRecorderRef.current?.mark(pointerId, 'panStarted');
        });
      }
      const center = mode === 'multi' ? getTouchCenter() : getPrimaryTouchPoint();
      const distance = mode === 'multi' ? getTouchDistance() : null;

      // TOUCH-ONLY-ROUTED device: a single finger tentatively inked through Fabric before this pan won
      // the gesture, so open the artifact-suppress window NOW (before we finalize the stroke below). The
      // interrupted tentative stroke committed by commitInterruptedFreehandStroke — or by a fast
      // touchend — then gets discarded in the path:created handler. No-op while routed as a pen device
      // (there a finger never tentatively inks — touchInputMode 'finger-draws' still routes as a pen
      // device and draws via its own identifier-tracked path in blockTouchFromFabricOnPenDevice, which
      // needs no artifact suppression since it isn't a "tentative, might-be-discarded" stroke).
      if (!isRoutedAsPenDevice()) {
        touchPanArtifactSuppressUntilRef.current = Date.now() + TOUCH_PAN_ARTIFACT_SUPPRESS_WINDOW_MS;
      }

      // Finalize any in-progress freehand stroke, then switch to pan MODE (isDrawingMode off via
      // syncEffectiveTool -> applyCanvasToolState) so no path is created while panning — the pan is a
      // non-drawing mode. On a touch-only device the finalized tentative stroke is suppressed via the
      // window opened above; on a pen device there is no stray artifact to suppress.
      commitInterruptedFreehandStroke(canvas);
      pendingSingleTouchPanRef.current = null;
      touchDrawingPointerIdRef.current = null;
      // A second finger landing mid finger-draw-stroke hands over to pan/zoom here: the stroke was just
      // closed above, so re-arm blockTouchFromFabricOnPenDevice's default (block) instead of leaving it
      // keyed to a contact that no longer draws.
      fingerDrawArmedRef.current = false;
      fingerDrawTouchIdentifierRef.current = null;
      touchPanModeRef.current = mode;
      touchOverrideToolRef.current = 'pan';
      lastTouchPanCenterRef.current = center;
      lastTouchDistanceRef.current = distance;
      zoomGestureBaselineRef.current = null;
      zoomDistanceFilterRef.current = createZoomDistanceFilterState();
      multiTouchGestureBaselineRef.current = mode === 'multi' ? { center, distance } : null;

      if (!isAlreadyActive) {
        syncEffectiveTool(canvas);
      }
    };
    // INVARIANT: a 'multi' pan may never outlive the SECOND contact. A multi-pan is the only mode that
    // needs two contacts to steer (its center/distance come from getTouchCenter/getTouchDistance, both
    // null below two points), so leaving the mode set with one contact left wedges the board: the move
    // handler then refuses to draw (touchOverride is 'pan'), skips the single-pan branch (mode is not
    // 'single') and drops out of the multi-pan branch (fewer than 2 contacts) — no ink, no pan, until
    // the user lifts. That is exactly what a stray second contact (a knuckle, the hand holding a phone)
    // used to cost: on a phone the palm guard can't swallow it, because it arms off an observed PEN
    // event and a phone never fires one.
    //
    // We DEMOTE to single-finger pan rather than hand the contact back to drawing, for three reasons:
    //   • it is what this file already says it does — releasePointer's own opening comment calls this a
    //     "pinch/pan ... transitioning (e.g. 2→1 finger)" and commits the preview "so a remaining finger
    //     that keeps panning sees the real viewport", and this branch already re-baselines the pan;
    //   • handing back to drawing is not reachable anyway: startTouchPan closed the brush path via
    //     commitInterruptedFreehandStroke, and Fabric only OPENS a path on a touchstart — so a contact
    //     that is already down could not ink again however we set our own refs;
    //   • it matches what every touch surface does when a two-finger pan drops to one finger.
    // The stray contact therefore costs at most the interrupted stroke, never a wedged board.
    const demoteMultiPanBelowTwoContacts = () => {
      if (touchPanModeRef.current !== 'multi' || activeTouchPointersRef.current.size >= 2) {
        return false;
      }

      touchPanModeRef.current = 'single';
      multiTouchGestureBaselineRef.current = null;
      // The pan is live, so nothing is left "pending" — clearing it keeps a stale armed candidacy from
      // re-activating a pan for a contact that is already driving one.
      pendingSingleTouchPanRef.current = null;
      // Re-baseline off the ONE remaining contact (getTouchCenter is null below two points), so the pan
      // continues from where the finger is now instead of jumping on its next move.
      lastTouchPanCenterRef.current = getPrimaryTouchPoint();
      lastTouchDistanceRef.current = null;

      return true;
    };
    // --- Whole-hand (palm) eraser -------------------------------------------------------------------
    // Rest a palm / ≥ contactCountThreshold fingers on the glass to erase a wide swath along the contacts'
    // centroid. Contacts are counted in the SEPARATE uncapped rawTouchContactsRef (the 2-contact pan/zoom
    // cap never sees them). A live pass drives the destination-out eraser brush MANUALLY at the centroid.
    const stopWholeHandEraser = () => {
      if (!wholeHandEraserSessionRef.current) {
        return;
      }

      // Drop any frame queued by the last finger move — the pass is ending; don't erase one more dab.
      cancelWholeHandEraserUpdate();
      // Commit the open destination-out erase path before tearing the session down.
      endWholeHandEraseStroke();
      hideWholeHandEraserCursor();

      wholeHandEraserSessionRef.current = null;
      setIsWholeHandEraserActive(false);

      if (touchOverrideToolRef.current === 'eraser') {
        touchOverrideToolRef.current = null;
        syncEffectiveTool(canvas);
      }
    };
    // Expose this local closure to the top-level self-heal reaper so it can end a LEAKED palm-eraser
    // session cleanly (commit the open destination-out path) instead of duplicating the teardown.
    stopWholeHandEraserRef.current = stopWholeHandEraser;
    const startWholeHandEraser = () => {
      // The palm takes over ALL touch for this pass. The 1–2 contacts that landed before the count
      // threshold was reached are still in activeTouchPointers/ignored; clear them so that when the pass
      // ends (releasePointer early-returns before the normal cleanup) nothing is left orphaned — otherwise
      // a leaked tracked contact makes the next single-finger touch read as a 2-finger pan.
      pendingSingleTouchPanRef.current = null;
      touchDrawingPointerIdRef.current = null;
      fingerDrawArmedRef.current = false;
      fingerDrawTouchIdentifierRef.current = null;
      activeTouchPointersRef.current.clear();
      ignoredTouchPointerIdsRef.current.clear();
      // TOUCH-ONLY-ROUTED device: a single finger tentatively inked through Fabric before the palm
      // landed. Open the artifact-suppress window + finalize that stroke so the interrupted tentative
      // ink is discarded in the path:created handler. No-op while routed as a pen device (a finger never
      // tentatively inks there — see the identical note in startTouchPan above).
      if (!isRoutedAsPenDevice()) {
        touchPanArtifactSuppressUntilRef.current = Date.now() + TOUCH_PAN_ARTIFACT_SUPPRESS_WINDOW_MS;
      }

      commitInterruptedFreehandStroke(canvas);
      // Capture the container rect once for cursor positioning (client → container-local).
      wholeHandCursorRectRef.current = containerRef.current?.getBoundingClientRect() ?? null;
      wholeHandEraserSessionRef.current = {
        size: tabletInputSettingsRef.current.wholeHandEraser.eraserSize,
        manual: true,
        strokeActive: false,
        segmentBaseScreenSize: 0,
      };
      setIsWholeHandEraserActive(true);
      touchOverrideToolRef.current = 'eraser';
      syncEffectiveTool(canvas);
      // Begin erasing from the moment the palm lands (don't wait for the first move).
      updateWholeHandEraser();
    };
    // The palm eraser is a CIRCLE covering ALL contacts: positioned at their centroid and sized to span
    // them (+ a finger pad), so spreading the fingers grows it and pinching shrinks it. Returns screen
    // (client) coords + the screen diameter, or null when there are no contacts.
    const getWholeHandEraserGeometry = (): { x: number; y: number; size: number } | null =>
      computeWholeHandEraserCircle(Array.from(rawTouchContactsRef.current.values()), {
        minSize: tabletInputSettingsRef.current.wholeHandEraser.eraserSize,
        // Live-tunable "space" around the hand (Settings → eraser → Palm eraser). Falls back to the
        // constant for any older settings blob the normalizer somehow missed.
        fingerPadding:
          tabletInputSettingsRef.current.wholeHandEraser.fingerPadding ?? WHOLE_HAND_ERASER_FINGER_PADDING_PX,
        maxSize: WHOLE_HAND_ERASER_MAX_SIZE_PX,
      });
    // Move/size the on-screen eraser circle so the teacher sees exactly what will be erased. Positioned
    // inside the container via the rect captured at pass start — no per-frame getBoundingClientRect.
    const showWholeHandEraserCursor = (clientX: number, clientY: number, size: number) => {
      const el = wholeHandEraserCursorRef?.current;

      if (!el) return;

      const rect = wholeHandCursorRectRef.current;
      const localX = clientX - (rect?.left ?? 0);
      const localY = clientY - (rect?.top ?? 0);

      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.transform = `translate3d(${localX - size / 2}px, ${localY - size / 2}px, 0)`;
      el.style.display = 'block';
    };
    const hideWholeHandEraserCursor = () => {
      const el = wholeHandEraserCursorRef?.current;

      if (el) el.style.display = 'none';
    };
    // Commit (or no-op) the open destination-out erase path and clear the preview anchor so the next
    // stroke can't bridge a streak from where this one stopped.
    const endWholeHandEraseStroke = () => {
      const session = wholeHandEraserSessionRef.current;
      const brush = eraserBrushRef.current as (LiveEraserBrush & { oldEnd?: unknown }) | null;

      if (session?.strokeActive && brush) {
        brush.onMouseUp({ e: new MouseEvent('mouseup') });
        brush.oldEnd = undefined;
      }

      if (session) session.strokeActive = false;
    };
    // Real-palm pass: PARTIALLY erase (destination-out brush, never object-delete) with a circle that
    // COVERS all contacts — driven CONTINUOUSLY at their centroid (the centroid glides as the hand moves,
    // so the eraser never jumps/flickers between individual fingers). Size tracks the finger spread.
    const updateWholeHandEraser = () => {
      const session = wholeHandEraserSessionRef.current;

      if (!session || !session.manual) return;

      const brush = eraserBrushRef.current as (LiveEraserBrush & { oldEnd?: unknown }) | null;

      if (!brush) return;

      const geometry = getWholeHandEraserGeometry();

      if (!geometry) return;

      session.size = geometry.size;
      // brush.width is in SCENE units; divide the screen diameter by the live zoom so the erased swath
      // matches the on-screen circle.
      const zoom = canvas.getZoom() || 1;
      const nextWidth = geometry.size / zoom;
      // Keep the brush's own screen-size record in step: its pen-down re-derives `width` from it.
      brush.screenDiameter = geometry.size;
      const eventData = { e: new MouseEvent('mousemove') };
      const scenePoint = canvas.getScenePoint(
        new MouseEvent('mousemove', { clientX: geometry.x, clientY: geometry.y }),
      );

      brush.color = '#000000';

      if (!session.strokeActive) {
        brush.width = nextWidth;
        brush.onMouseDown(scenePoint, eventData);
        session.strokeActive = true;
        session.segmentBaseScreenSize = geometry.size;
      } else if (Math.abs(geometry.size - session.segmentBaseScreenSize) > WHOLE_HAND_ERASER_RESEGMENT_EPS_PX) {
        // The finger spread changed enough to move the circle's on-screen diameter more than the epsilon
        // AWAY from where this segment began. A PencilBrush commits its WHOLE trail at the FINAL width (and
        // live-previews it at the CURRENT width), so without re-segmenting, growing the circle would
        // retroactively widen everything already erased in this pass — wiping nearby ink on release. Close
        // the current segment FIRST (brush.width still holds the previous, within-epsilon-of-base value),
        // extended to the current point so there's no gap, THEN begin a fresh segment at the new width from
        // that point. Comparing against the segment BASE (not the previous frame), in SCREEN px, means
        // jitter oscillating around a steady spread never churns out segments at any zoom, while a real
        // spread change still splits cleanly.
        brush.onMouseMove(scenePoint, eventData);
        brush.onMouseUp({ e: new MouseEvent('mouseup') });
        brush.oldEnd = undefined;
        // Bake the just-committed segment into the (hidden) lower canvas now, so the next segment's preview
        // frame copies a current bitmap — otherwise Fabric's rAF-deferred render leaves it invisible for a
        // frame (a trailing-edge shimmer during a fast spread).
        canvas.renderAll();
        brush.width = nextWidth;
        brush.onMouseDown(scenePoint, eventData);
        session.segmentBaseScreenSize = geometry.size;
      } else {
        // Within the epsilon of the segment base: keep one continuous segment. Track the width live so the
        // preview + cursor stay in sync (the committed width can only differ from the base by <= eps).
        brush.width = nextWidth;
        brush.onMouseMove(scenePoint, eventData);
      }

      showWholeHandEraserCursor(geometry.x, geometry.y, geometry.size);
    };
    // Coalesce per-finger moves into one erase update per animation frame (see wholeHandEraserFrameRef).
    const scheduleWholeHandEraserUpdate = () => {
      if (wholeHandEraserFrameRef.current !== null) return;

      wholeHandEraserFrameRef.current = window.requestAnimationFrame(() => {
        wholeHandEraserFrameRef.current = null;
        updateWholeHandEraser();
      });
    };
    const cancelWholeHandEraserUpdate = () => {
      if (wholeHandEraserFrameRef.current !== null) {
        window.cancelAnimationFrame(wholeHandEraserFrameRef.current);
        wholeHandEraserFrameRef.current = null;
      }
    };
    const wholeHandEraserThreshold = () => {
      const settings = tabletInputSettingsRef.current.wholeHandEraser;

      // In test/emulation mode a single mouse or finger drag stands in for the whole hand.
      if (settings.testEmulation) {
        return 1;
      }

      return Math.max(2, Math.round(settings.contactCountThreshold));
    };
    const maybeStartWholeHandEraser = () => {
      if (wholeHandEraserSessionRef.current) {
        return true;
      }

      const settings = tabletInputSettingsRef.current.wholeHandEraser;

      // Never fire while a real pen is active / recently active (isPalmRejectActive) — a resting palm mid-pen
      // stroke must NOT become an erase. handlePointerDown already returns early on palm-reject, so this is a
      // belt-and-suspenders guard for the `session || maybeStart` call.
      if (!settings.enabled || isPalmRejectActive()) {
        return false;
      }

      if (rawTouchContactsRef.current.size < wholeHandEraserThreshold()) {
        return false;
      }

      stopTouchPan();
      startWholeHandEraser();

      return true;
    };
    // DETERMINISTIC TOUCH MODEL (no heuristics — decided purely by device + contact count):
    //   • PALM GUARD (only palm rejection): a pen down OR pen active within PEN_PALM_REJECT_MS → ignore.
    //   • 2+ contacts → two-finger PAN + PINCH-ZOOM (both device types).
    //   • exactly 1 contact:
    //       - PEN DEVICE (hasSeenRealPen) → single-finger PAN, armed on down, activated once it drags
    //         past SINGLE_TOUCH_PAN_ACTIVATION_DISTANCE (Fabric is starved of touch on a pen device, so
    //         nothing inks). A palm that slipped the time window still won't pan until it deliberately moves.
    //       - TOUCH-ONLY DEVICE (never saw a 'pen' event, e.g. ViewSonic) → single finger DRAWS via Fabric.
    // Does a lone finger landing here (select tool) grab a PICTURE or the current selection: a handle of
    // the selection, inside its frame, or inside the box of a selectable, unpinned image? Raw ink does
    // not count — on a written page a one-finger pan almost always starts on ink, and must still pan.
    // Once the contact reaches Fabric, its own target find decides between the picture and ink over it.
    // The pointer whose grab is armed: an arm its touchstart never consumed is dropped on its release, so
    // it can never hand a LATER contact (a pan finger) to Fabric.
    let fingerGrabPointerId: number | null = null;
    const fingerGrabsObject = (event: PointerEvent): boolean => {
      if (effectiveToolRef.current !== 'select' || canvas.skipTargetFind) return false;

      const viewPoint = canvas.getViewportPoint(event as never);
      const scenePoint = canvas.getScenePoint(event as never);
      const active = canvas.getActiveObject();

      if (active) {
        if (active.findControl(viewPoint, true)) return true;
        if (active.containsPoint(scenePoint)) return true;
      }

      return canvas
        .getObjects()
        .some(
          (object) =>
            object instanceof FabricImage &&
            object.visible !== false &&
            object.selectable &&
            object.evented !== false &&
            !isLockedImage(object) &&
            object.containsPoint(scenePoint),
        );
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;

      // A finger landing ends any slide instantly, and the velocity window restarts for the next pan.
      cancelFling();
      panVelocitySamplesRef.current = [];

      // One layout read per contact, same reason as the pen's — see pointerGeometryRef.
      invalidatePointerGeometry();

      // Self-heal BEFORE tracking this contact: a prior gesture whose release the OS dropped can leave a
      // phantom in the pointer map + a stranded touchOverride/pan-mode. Reaping it now (removes only
      // pointers > STALE_POINTER_MS stale, so a live gesture is untouched) makes a rapid retry start
      // clean. Runs before noteInputActivity so this event's own timestamp doesn't mask it.
      reapStalePointersAndRecover(Date.now());
      noteInputActivity('touch down');

      // A new touch is starting — commit any still-previewed zoom/pan first so this interaction sees
      // Fabric's real, up-to-date viewport, and the next gesture's preview starts from a clean baseline.
      commitZoomPreview(canvas);

      // PALM GUARD (the ONLY palm rejection): pen down, or pen active within the time window (incl.
      // hover). Ignore the touch entirely — no draw, no pan.
      if (isPalmRejectActive()) {
        traceTouch(event, 'down', 'palm-reject');
        // Close an open stroke ONLY when no pen is down: with the pen off the glass an open path is
        // stranded and a palm must not be the thing that keeps it alive. With the pen DOWN the open path
        // is the pen's own live stroke — ending it here cut every letter the palm settled during (the
        // Samsung tablet lets palm points through whenever the tip lifts a little): the committed stub
        // was a DOT and the rest of the letter was dropped, since Fabric only reopens on a touchstart.
        // The palm itself never reaches Fabric (blockTouchFromFabricOnPenDevice), so nothing fuses.
        ignoreTouchPointer(event, activePenPointersRef.current.size === 0);

        return;
      }

      // Whole-hand eraser: track every RAW contact (uncapped — the panel reports a fixed size per touch, so
      // a palm is identified by COUNT) and activate once enough land. Tracked HERE — after the palm-reject
      // guard but BEFORE the 2-contact gesture cap below — so the palm's extra contacts accumulate past the
      // cap and can trigger it. Fires for both device types, gated to NOT-palm-reject-active so it never
      // fires mid-pen-stroke.
      rawTouchContactsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY, lastSeenAt: Date.now() });

      if (wholeHandEraserSessionRef.current || maybeStartWholeHandEraser()) {
        event.preventDefault();

        return;
      }

      // Hard cap: react to at most MAX_SIMULTANEOUS_TOUCHES contacts. A further contact (resting palm,
      // stray finger) is swallowed and never tracked.
      if (
        !activeTouchPointersRef.current.has(event.pointerId) &&
        activeTouchPointersRef.current.size >= MAX_SIMULTANEOUS_TOUCHES
      ) {
        ignoreTouchPointer(event);

        return;
      }

      const trackedPointer = trackTouchPointer(event);

      // 2+ contacts → two-finger PAN + PINCH-ZOOM (both device types).
      if (activeTouchPointersRef.current.size >= 2) {
        traceTouch(event, 'down', 'multi-pan');
        event.preventDefault();
        startTouchPan('multi');

        return;
      }

      // Exactly 1 contact.
      if (isRoutedAsPenDevice()) {
        // touchInputMode 'finger-draws': draw with a single finger exactly like the pen. Reached only
        // once isPalmRejectActive() above has already passed (no pen down / active within the
        // palm-reject window — real pen activity always outranks this) and there is exactly one live
        // contact (the 2+ branch above wins first for anything more). No preventDefault here, mirroring
        // the touch-only DRAW branch below: the native touchstart must reach
        // blockTouchFromFabricOnPenDevice's finger-drawing passthrough so Fabric's raw touch pipeline —
        // the SAME one a touch-only-routed device already draws through — opens the stroke.
        if (tabletInputSettingsRef.current.touchInputMode === 'finger-draws') {
          traceTouch(event, 'down', 'pen-device-finger-draw');
          // Self-heal any stale open brush path before this stroke starts, mirroring handlePenDown's
          // own down-time self-heal.
          commitInterruptedFreehandStroke(canvas);
          touchDrawingPointerIdRef.current = event.pointerId;
          fingerDrawArmedRef.current = true;
          applyPenVerticalDrawOffset(event);

          return;
        }

        // SELECT tool, finger landing on a picture or the current selection (see fingerGrabsObject): the
        // finger moves / scales / rotates it — Fabric gets this one contact through the
        // same arm→capture handshake as 'finger-draws' (with the select tool Fabric is not in drawing
        // mode, so the contact drags instead of inking). A finger on empty board still pans below.
        if (fingerGrabsObject(event)) {
          traceTouch(event, 'down', 'pen-device-finger-grab');
          fingerDrawArmedRef.current = true;
          fingerGrabPointerId = event.pointerId;

          return;
        }

        // PEN DEVICE (touchInputMode 'auto', default): single finger PANS (never draws). Arm a pending
        // pan; it activates once the finger drags past SINGLE_TOUCH_PAN_ACTIVATION_DISTANCE.
        // preventDefault keeps the finger's compat events off; the touch stream itself is starved from
        // Fabric on a pen device.
        traceTouch(event, 'down', 'pen-device-pan-arm');
        pendingSingleTouchPanRef.current = {
          pointerId: event.pointerId,
          startPoint: { x: trackedPointer.x, y: trackedPointer.y },
        };
        event.preventDefault();

        return;
      }

      // TOUCH-ONLY-ROUTED device (real touch-only hardware, e.g. ViewSonic — OR any hardware while
      // touchInputMode is 'capacitive-pen', which forces this branch regardless of hasSeenRealPenRef):
      // the dual-tip capacitive pen's heads AND a finger all report `pointerType === 'touch'`, so the
      // route is decided by contact SIZE (min/max of width/height).
      const fingerPanSettings = tabletInputSettingsRef.current.singleFingerPan;
      const isFingerAtDown = fingerPanSettings.enabled && isFingerSizedContact(event) === true;

      // Single-finger pan armed: when the feature is on, arm a pending pan for EVERY single touch-only
      // contact so handlePointerMove can resolve it once the live size is known — a finger-sized move
      // switches to pan (discarding the tentative ink via the suppress window), a pen-tip-sized move
      // cancels the candidacy and keeps drawing. A CLEAR finger already at down commits to that pan
      // candidacy immediately (never becomes the draw contact); the <=1 placeholder still draws tentatively.
      if (fingerPanSettings.enabled) {
        pendingSingleTouchPanRef.current = {
          pointerId: event.pointerId,
          startPoint: { x: trackedPointer.x, y: trackedPointer.y },
        };
      }

      if (isFingerAtDown) {
        // A finger-sized footprint at down → navigate, don't draw. Leave touchDrawingPointerIdRef unset so
        // this contact never becomes the draw pointer; the move handler activates the armed pan on travel.
        traceTouch(event, 'down', 'touch-only-finger-pan-arm');
        event.preventDefault();

        return;
      }

      // DRAW: a pen-tip-sized (or unknown <=1 placeholder) contact writes. Let Fabric's touch stream ink it
      // — track the pointer and lift the drawn point to the nib.
      traceTouch(event, 'down', 'touch-only-draw');
      touchDrawingPointerIdRef.current = event.pointerId;

      // Dual-tip stylus: pick the stroke colour from the contact head SIZE (small/finger → primary, big →
      // secondary). We run in capture phase BEFORE Fabric's own pointerdown, so setting freeDrawingBrush.color
      // here is what the committed stroke uses (Fabric commits a stroke at its FINAL brush.color). Only for
      // pen/highlighter (the eraser keeps its own colour), and only on this touch-only device.
      //
      // The colour is NOT settled here even when this frame reads cleanly. The touch-down frame is the one a
      // tilt corrupts most — the tip rolls onto the glass, briefly reporting a fatter patch than the head
      // really is — and committing to it is what wrote a big head in the small head's colour. The contact
      // keeps refining over the settle window in handlePointerMove and locks there; because the size is a
      // running MINIMUM it can only revise toward a smaller head, so it converges instead of oscillating.
      if (
        tabletInputSettingsRef.current.dualTipStylus.enabled &&
        isDualTipColouredTool(effectiveToolRef.current)
      ) {
        const brush = canvas.freeDrawingBrush;

        if (brush instanceof LowLatencyPencilBrush) {
          brush.setStrokeColor(resolveDualTipBrushColor(classifyDualTipHead(event)));
        } else if (brush) {
          brush.color = resolveDualTipBrushColor(classifyDualTipHead(event));
        }
      }

      applyPenVerticalDrawOffset(event);
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;

      noteInputActivity('touch move');

      // Before any of the pan/zoom machinery below, and before Fabric's own touchmove: hand the open
      // stroke the sub-frame samples. Self-guarded to the drawing contact, so a palm or a second finger
      // moving in the same frame contributes nothing.
      injectCoalescedSamples(canvas, event);

      // Whole-hand eraser: keep raw contact positions current; while a pass is live, erase along their
      // centroid (rAF-coalesced) and swallow the move. Palm contacts aren't in activeTouchPointers, so this
      // runs before the normal draw/pan machinery below.
      if (rawTouchContactsRef.current.has(event.pointerId)) {
        rawTouchContactsRef.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
          lastSeenAt: Date.now(),
        });
      }

      if (wholeHandEraserSessionRef.current) {
        scheduleWholeHandEraserUpdate();
        event.preventDefault();

        return;
      }

      if (ignoredTouchPointerIdsRef.current.has(event.pointerId)) {
        event.preventDefault();
        event.stopPropagation();

        return;
      }

      if (!activeTouchPointersRef.current.has(event.pointerId)) return;

      const trackedPointer = trackTouchPointer(event);

      // Touch-only device draw contact: keep the nib-landing offset on every move.
      if (event.pointerId === touchDrawingPointerIdRef.current) {
        applyPenVerticalDrawOffset(event);

        // Dual-tip: keep re-deciding the head colour over the contact's SETTLE WINDOW, then lock. Fabric
        // commits the stroke at its FINAL brush.color, so a revision during the window recolours the whole
        // stroke — which is exactly what we want while the size estimate is still improving. Two reasons
        // this window exists rather than locking on the first usable frame:
        //   - a panel may report only the <=1px placeholder at touch-down and the real footprint a frame or
        //     two later (the original reason);
        //   - the earliest real frames are the tilt-corrupted ones (the tip rolling onto the glass), and the
        //     running minimum needs a few frames to find the head's true width.
        // Past the window we lock, so the tail of a long stroke can never repaint what the teacher already
        // watched appear.
        if (
          tabletInputSettingsRef.current.dualTipStylus.enabled &&
          isDualTipColouredTool(effectiveToolRef.current) &&
          trackedPointer.contact.head !== null
        ) {
          const brush = canvas.freeDrawingBrush;

          // Through `setStrokeColor`: the stroke is live, and a bare write would drop its smart-contrast
          // adjustment for the rest of the stroke.
          if (brush instanceof LowLatencyPencilBrush) {
            brush.setStrokeColor(resolveDualTipBrushColor(trackedPointer.contact.head));
          } else if (brush) {
            brush.color = resolveDualTipBrushColor(trackedPointer.contact.head);
          }
        }
      }

      // Single-finger PAN activation. Routed as a PEN DEVICE, a lone finger always pans (size-agnostic)
      // — begin once it drags past the small activation distance (a palm that slipped the time window
      // still won't pan until it deliberately moves). Routed as TOUCH-ONLY the same 'touch' contact might
      // be a drawing pen tip, so gate on contact SIZE: a confirmed pen-tip reading cancels the pan
      // candidacy (keep drawing), a finger-sized reading pans (the tentative ink is discarded via the
      // suppress window).
      const fingerPan = tabletInputSettingsRef.current.singleFingerPan;
      const fingerVerdictMove = isFingerSizedContact(event);
      const isFingerSizedMove = fingerPan.enabled && fingerVerdictMove === true;

      if (
        !isRoutedAsPenDevice() &&
        fingerPan.enabled &&
        pendingSingleTouchPanRef.current?.pointerId === event.pointerId &&
        fingerVerdictMove === false
      ) {
        // Touch-only-routed device: a valid pen-head-sized reading — keep drawing, never pan this contact.
        // The verdict rides the running-minimum size, so once a contact has proven itself head-sized a
        // later tilted (inflated) frame cannot revoke that and yank the stroke out from under the teacher.
        pendingSingleTouchPanRef.current = null;
      }

      if (
        pendingSingleTouchPanRef.current?.pointerId === event.pointerId &&
        (isRoutedAsPenDevice() || isFingerSizedMove) &&
        trackedPointer.maxTravel >= SINGLE_TOUCH_PAN_ACTIVATION_DISTANCE &&
        touchOverrideToolRef.current !== 'pan'
      ) {
        startTouchPan('single');
      }

      if (touchOverrideToolRef.current !== 'pan') {
        return;
      }

      if (touchPanModeRef.current === 'single' && activeTouchPointersRef.current.size === 1) {
        const currentPoint = getPrimaryTouchPoint();
        const previousPoint = lastTouchPanCenterRef.current;

        if (currentPoint && previousPoint) {
          pendingTouchViewportUpdateRef.current.center = currentPoint;
          pendingTouchViewportUpdateRef.current.deltaX += currentPoint.x - previousPoint.x;
          pendingTouchViewportUpdateRef.current.deltaY += currentPoint.y - previousPoint.y;
          scheduleTouchViewportUpdate(canvas);
        }

        if (currentPoint) {
          recordPanSample(currentPoint.x, currentPoint.y, event.timeStamp);
        }

        lastTouchPanCenterRef.current = currentPoint;
        event.preventDefault();

        return;
      }

      if (activeTouchPointersRef.current.size < 2) {
        return;
      }

      const currentCenter = getTouchCenter();
      const currentDistance = getTouchDistance();
      const panZoomToleranceFactor = getTouchPanZoomToleranceFactor();
      const panActivationDistance = MULTI_TOUCH_PAN_ACTIVATION_DISTANCE * panZoomToleranceFactor;
      const zoomActivationDelta = MULTI_TOUCH_ZOOM_ACTIVATION_DELTA * panZoomToleranceFactor;
      const zoomRearmDelta = MULTI_TOUCH_ZOOM_REARM_DELTA * panZoomToleranceFactor;
      const panFrameDeadzone = MULTI_TOUCH_PAN_FRAME_DEADZONE * panZoomToleranceFactor;
      const baseline = multiTouchGestureBaselineRef.current;

      const enterZoomMode = (anchorCenter: TouchPoint | null) => {
        const baselineDistance = currentDistance ?? baseline?.distance ?? 0;

        multiTouchGestureLockRef.current = 'zoom';
        zoomGestureBaselineRef.current = {
          center: anchorCenter ?? baseline?.center ?? null,
          distance: baselineDistance,
          zoom: canvas.getZoom(),
        };
        // Seed the distance filter AT the baseline (not cold-start), so the first zoom-mode event
        // begins at targetScale ≈ 1 with no entry step from temporal-skew jitter between the commit
        // sample and the next pointermove, and the deadband measures drift from the true gap.
        zoomDistanceFilterRef.current =
          baselineDistance > 0
            ? { applied: baselineDistance, dxdt: 0, smoothed: baselineDistance, timestamp: event.timeStamp }
            : createZoomDistanceFilterState();
        cancelScheduledTouchViewportUpdate();
      };

      // Gesture intent: a two-finger gesture commits to EITHER pan OR zoom, never both at once.
      // A pan therefore emits zero zoom samples, which eliminates the zoom-while-panning
      // oscillation at the source instead of trying to filter it out.
      if (multiTouchGestureLockRef.current !== 'pan' && multiTouchGestureLockRef.current !== 'zoom') {
        const translation =
          currentCenter && baseline?.center
            ? Math.hypot(currentCenter.x - baseline.center.x, currentCenter.y - baseline.center.y)
            : 0;
        const scale =
          currentDistance && baseline?.distance && baseline.distance > 0 ? currentDistance / baseline.distance : 1;
        const scaleDelta = Math.abs(scale - 1);
        const panProgress = panActivationDistance > 0 ? translation / panActivationDistance : 0;
        const zoomProgress = zoomActivationDelta > 0 ? scaleDelta / zoomActivationDelta : 0;

        // Zoom locked: two fingers can ONLY pan (never zoom).
        if (zoomLockedRef.current) {
          if (panProgress < 1) {
            event.preventDefault();

            return;
          }

          multiTouchGestureLockRef.current = 'pan';
          lastTouchPanCenterRef.current = currentCenter;
          cancelScheduledTouchViewportUpdate();
          event.preventDefault();

          return;
        }

        // Wait until one intent clears its activation threshold.
        if (panProgress < 1 && zoomProgress < 1) {
          event.preventDefault();

          return;
        }

        // Commit to the stronger intent; ties go to pan (the gesture that must never zoom).
        if (zoomProgress >= 1 && zoomProgress > panProgress) {
          enterZoomMode(currentCenter);
        } else {
          multiTouchGestureLockRef.current = 'pan';
          lastTouchPanCenterRef.current = currentCenter;
          cancelScheduledTouchViewportUpdate();
        }

        event.preventDefault();

        return;
      }

      // Zoom mode: pinch only. Scale is ABSOLUTE relative to the fixed gesture baseline (never a
      // frame-to-frame ratio, so per-event distance noise cannot accumulate) and anchored at the
      // fixed pinch midpoint (so the view does not breathe).
      if (multiTouchGestureLockRef.current === 'zoom') {
        const zoomBaseline = zoomGestureBaselineRef.current;

        if (currentDistance && zoomBaseline && zoomBaseline.distance > 0 && zoomBaseline.center) {
          // De-noise the raw distance before mapping it to zoom. The 1€ filter smooths temporal-skew
          // jitter (heavy at low velocity, light during a deliberate pinch); the hysteresis deadband
          // then holds the applied distance until the smoothed signal clears the ~2-3px noise floor,
          // so a constant finger gap produces exactly zero zoom drift.
          const filterState = zoomDistanceFilterRef.current;
          const { dxdt, smoothed } = stepZoomDistanceFilter(currentDistance, event.timeStamp, filterState);
          const lastApplied = filterState.applied ?? smoothed;
          const drift = smoothed - lastApplied;
          const applied =
            Math.abs(drift) > ZOOM_DISTANCE_DEADBAND_PX
              ? smoothed - Math.sign(drift) * ZOOM_DISTANCE_DEADBAND_PX
              : lastApplied;

          filterState.smoothed = smoothed;
          filterState.timestamp = event.timeStamp;
          filterState.dxdt = dxdt;
          filterState.applied = applied;

          const targetScale = applied / zoomBaseline.distance;
          const targetZoom = clampZoomValue(zoomBaseline.zoom * targetScale);

          pendingTouchViewportUpdateRef.current.absoluteZoom = targetZoom;
          pendingTouchViewportUpdateRef.current.zoomAnchor = zoomBaseline.center;
          scheduleTouchViewportUpdate(canvas);
        }

        event.preventDefault();

        return;
      }

      // Pan mode: translation only — never samples zoom. A decisive pinch (spread changes well
      // past the noise floor versus the gesture-start span) re-arms zoom mode mid-gesture — unless
      // zoom is locked, in which case pan stays pan.
      if (!zoomLockedRef.current && currentDistance && baseline?.distance && baseline.distance > 0) {
        const scaleDeltaFromStart = Math.abs(currentDistance / baseline.distance - 1);

        if (scaleDeltaFromStart >= zoomRearmDelta) {
          enterZoomMode(currentCenter);
          event.preventDefault();

          return;
        }
      }

      const previousCenter = lastTouchPanCenterRef.current;

      if (currentCenter) {
        recordPanSample(currentCenter.x, currentCenter.y, event.timeStamp);
      }

      if (currentCenter && previousCenter) {
        const deltaX = currentCenter.x - previousCenter.x;
        const deltaY = currentCenter.y - previousCenter.y;
        const deltaDistance = Math.hypot(deltaX, deltaY);

        if (deltaDistance >= panFrameDeadzone) {
          pendingTouchViewportUpdateRef.current.center = currentCenter;
          pendingTouchViewportUpdateRef.current.deltaX += deltaX;
          pendingTouchViewportUpdateRef.current.deltaY += deltaY;
          lastTouchPanCenterRef.current = currentCenter;
          scheduleTouchViewportUpdate(canvas);
        }
      }

      event.preventDefault();
    };
    const releasePointer = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;

      // On a touch-only panel the capacitive pen arrives as 'touch' and takes the nib lift, so this is a
      // pen release as much as the real one above.
      clearPenPointerOffset();
      // Apply a canvas resize the observer reported mid-stroke and we postponed (see handleResize).
      flushDeferredResize();

      noteInputActivity(event.type === 'pointercancel' ? 'touch cancel' : 'touch up');

      if (fingerGrabPointerId === event.pointerId) {
        fingerGrabPointerId = null;
        fingerDrawArmedRef.current = false;
      }

      // A touch lifted — a pinch/pan is ending or transitioning (e.g. 2→1 finger). Commit any preview now
      // so the crisp result lands immediately and a remaining finger that keeps panning sees the real
      // viewport (no-op when no preview is active).
      commitZoomPreview(canvas);

      // Whole-hand eraser: a raw contact lifted (every touch is tracked at down, even later-ignored ones),
      // so always drop it; end the pass once too few contacts remain.
      rawTouchContactsRef.current.delete(event.pointerId);

      if (wholeHandEraserSessionRef.current) {
        if (rawTouchContactsRef.current.size < wholeHandEraserThreshold()) {
          stopWholeHandEraser();
        }

        event.preventDefault();

        return;
      }

      if (ignoredTouchPointerIdsRef.current.delete(event.pointerId)) {
        event.preventDefault();
        event.stopPropagation();

        return;
      }

      const panModeBeforeRelease = touchPanModeRef.current;

      if (panModeBeforeRelease !== null) {
        event.preventDefault();
        event.stopPropagation();
      }

      if (pendingSingleTouchPanRef.current?.pointerId === event.pointerId) {
        pendingSingleTouchPanRef.current = null;
      }

      // Read the contact's FINAL routing verdict before the record is dropped — see below.
      const resolvedRouting = contactStateFor(event)?.routing ?? null;

      emitCapturedContact(contactRecorderRef.current?.end(event.pointerId) ?? null);
      activeTouchPointersRef.current.delete(event.pointerId);

      if (touchDrawingPointerIdRef.current === event.pointerId) {
        // THE STRAY DOT. On this panel the routing verdict is deliberately DEFERRED: `routing` is null at
        // touch-down (the down frame is the least trustworthy reading — the tip rolls onto the glass), so
        // every contact, finger included, takes the DRAW branch and inks tentatively while the size
        // settles. That tentative ink is normally discarded when the contact resolves to a finger AND
        // travels far enough to activate a pan, which arms the artifact-suppression window.
        //
        // A finger that resolves but never travels that far — a tap, or a nudge that stops short of the
        // pan threshold — was falling through both halves of that: no pan, so no suppression window, and
        // the tentative stroke committed as a small mark. Arming the window here on the verdict alone
        // closes it, and the size test in the path:created handler still protects real ink.
        if (resolvedRouting === true) {
          touchPanArtifactSuppressUntilRef.current = Date.now() + TOUCH_PAN_ARTIFACT_SUPPRESS_WINDOW_MS;
        }

        touchDrawingPointerIdRef.current = null;
        fingerDrawArmedRef.current = false;

        if (event.type === 'pointercancel') {
          commitInterruptedFreehandStroke(canvas);
        }

        // STUCK-INK FAILSAFE (mirrors the pen's own PEN_STROKE_END_FAILSAFE_MS): normally Fabric's own
        // touchend/touchcancel — passed through by blockTouchFromFabricOnPenDevice's finger-drawing
        // branch for this exact contact — closes the brush a few ms after this pointerup. If the OS
        // drops that ending touch event (the same class of drop the pen failsafe exists for), give it
        // the same grace period, then force-commit any path still open so a later hover/touch can never
        // extend it into an endless line. commitInterruptedFreehandStroke no-ops when nothing is open, so
        // this is a harmless redundant close on the normal (non-dropped) path, and on a touch-only device
        // (where this ref is also used) it is likewise a no-op safety net.
        if (touchDrawStrokeEndFailsafeTimerRef.current !== null) {
          window.clearTimeout(touchDrawStrokeEndFailsafeTimerRef.current);
        }

        touchDrawStrokeEndFailsafeTimerRef.current = window.setTimeout(() => {
          touchDrawStrokeEndFailsafeTimerRef.current = null;

          if (touchDrawingPointerIdRef.current === null) {
            commitInterruptedFreehandStroke(canvas);
          }
        }, PEN_STROKE_END_FAILSAFE_MS);
      }

      if (panModeBeforeRelease === 'multi' && activeTouchPointersRef.current.size > 0) {
        // Dropped below two fingers mid-gesture: forget the pan/zoom commitment so a re-engaged
        // two-finger gesture re-runs intent detection from a fresh baseline. The velocity window
        // restarts too — the centre just jumped from between two fingers to the one that stayed.
        panVelocitySamplesRef.current = [];
        panAxisLockStateRef.current = createPanAxisLock();
        multiTouchGestureLockRef.current = null;
        zoomGestureBaselineRef.current = null;
        zoomDistanceFilterRef.current = createZoomDistanceFilterState();

        if (demoteMultiPanBelowTwoContacts()) {
          return;
        }

        lastTouchPanCenterRef.current = getTouchCenter();
        lastTouchDistanceRef.current = getTouchDistance();

        return;
      }

      if (touchPanModeRef.current === 'single' || activeTouchPointersRef.current.size < 2) {
        stopTouchPan();

        if (activeTouchPointersRef.current.size === 0) {
          multiTouchGestureLockRef.current = null;
        }

        // The pan that just ended keeps sliding with its release velocity (a pointercancel — the OS took
        // the gesture — is a stop, not a lift). A pinch coasts in translation only: stopTouchPan already
        // committed its zoom, and the fling only ever pushes pan deltas.
        if (panModeBeforeRelease !== null && event.type === 'pointerup') {
          startFling(canvas, event.timeStamp, 'touch');
        }

        return;
      }

      lastTouchPanCenterRef.current = getTouchCenter();
      lastTouchDistanceRef.current = getTouchDistance();
    };

    // Fabric v7 is created WITHOUT pointer-event mode (see `new Canvas(...)` above), so it binds its
    // freehand drawing to the raw TOUCH stream (touchstart/move/end on the upperCanvasEl) — a channel
    // ENTIRELY SEPARATE from the pointer events our handlers process. On a PEN DEVICE all drawing is the
    // pen's job (the pen inks via its compat MOUSE events); every touch is a palm/finger that must only
    // pan/zoom via our OWN pointer handlers. So intercept the touch stream at CAPTURE phase BEFORE
    // Fabric's own listener and starve it: stopPropagation keeps the touch out of Fabric entirely (a
    // resting palm can never open or extend a brush path), and preventDefault cancels its compat mouse
    // events. STRICT no-op on a touch-only-ROUTED device (real touch-only hardware like ViewSonic —
    // its capacitive pen reports as 'touch', never fires a 'pen' event, so hasSeenRealPen stays false —
    // OR any hardware while touchInputMode is 'capacitive-pen', which forces this routing) so its
    // capacitive pen keeps drawing through Fabric. Pan/zoom are driven by our own pointer handlers, so
    // this never disturbs navigation.
    // Raw-touch guard decisions in the exportable input trace (touch-probe page), per changed contact.
    const traceRawTouch = (event: TouchEvent, decision: string) => {
      if (!isInputTraceEnabled()) return;

      const touches = event.changedTouches;
      const phase =
        event.type === 'touchstart' ? 'down' : event.type === 'touchmove' ? 'move' : event.type === 'touchcancel' ? 'cancel' : 'up';

      for (let i = 0; i < touches.length; i += 1) {
        const touch = touches[i];

        traceInput({
          kind: 'touch',
          phase,
          decision: `raw:${decision}`,
          pointerId: touch.identifier,
          pointerType: (touch as Touch & { touchType?: string }).touchType ?? 'raw-touch',
          width: (touch.radiusX || 0) * 2,
          height: (touch.radiusY || 0) * 2,
          buttons: 0,
          hasSeenRealPen: hasSeenRealPenRef.current,
          activePen: activePenPointersRef.current.size,
          activeTouch: activeTouchPointersRef.current.size,
        });
      }
    };
    const blockTouchFromFabricOnPenDevice = (event: TouchEvent) => {
      // Count the raw touch stream as input activity too (belt-and-suspenders with the pointer path),
      // so the idle-recovery backstop never fires while a finger is genuinely on the glass.
      noteInputActivity('raw touch');

      const touches = event.changedTouches;

      // A contact the browser labels 'stylus' (Touch Events L2 touchType — WebKit only; Chromium never
      // reports it) is a real pen: latch the pen-device model from it exactly as a 'pen' pointer event
      // does, so a fresh install on such a device stops routing fingers as ink from the first pen touch.
      // A touch-only panel labels everything 'direct', so this can never latch there.
      for (let i = 0; i < touches.length; i += 1) {
        if ((touches[i] as Touch & { touchType?: string }).touchType === 'stylus') {
          markRealPenSeen();
          break;
        }
      }

      // Touch-only-ROUTED device: its capacitive pen (or plain finger) MUST reach Fabric to draw.
      if (!isRoutedAsPenDevice()) return;

      // POSITIVE TWIN IDENTIFICATION — decided ONCE per contact, at touchstart, and remembered by
      // Touch.identifier for the contact's whole life (identifiers are reused, so every touchstart
      // re-decides its own). A touchstart contact is the pen's twin iff a 'pen' pointerdown is still DOWN,
      // landed within PEN_TWIN_START_WINDOW_MS and within PEN_TWIN_START_DISTANCE_PX of it (Blink dispatches
      // the pointerdown before the matching touchstart, same task, same position — see handlePenDown,
      // which records both). EVERYTHING ELSE on a pen device is starved from Fabric: no radius, no
      // proximity-to-the-live-pen guess. The old heuristics passed any tip-sized radius as the pen, and
      // the Samsung tablet reports palm contacts that way — dots where the hand rests, and straight lines
      // when a palm touchstart RESET Fabric's open path to the palm (PencilBrush.onMouseDown starts the
      // path over) and the next pen move drew from there. Bias is now toward STARVING: on a Chromium
      // panel the twin's pointerdown always precedes its touchstart, so a starved twin can only mean the
      // pen produced no pointerdown at all — which a 'pen'-device routing excludes by construction.
      //
      // KNOWN RESIDUAL (documented, accepted): Fabric's drawing mode reads changedTouches[0] of whatever
      // event reaches it. When a stray finger MOVES in the very same touchmove event as the twin (finger
      // at index 0), the event passes (the twin qualified) but Fabric samples the FINGER for that frame —
      // a one-frame blip that self-recovers. Blocking such mixed events would drop the twin's own points
      // (dead pen frames), the worse trade. Separate-event interleavings are fully starved.
      const isEndingEvent = event.type === 'touchend' || event.type === 'touchcancel';

      if (event.type === 'touchstart') {
        const now = Date.now();
        const penPoint = lastPenClientPointRef.current;
        // ONE pen contact has ONE twin, and it is the first touchstart after the pen-down (same task). Once
        // it is known, no later contact can be the twin however close and fresh — a finger landing beside
        // the tip right after the pen-down is still a finger. handlePenDown empties the set per contact.
        const twinAlreadyKnown = penTwinTouchIdentifiersRef.current.size > 0;
        const penDown =
          !twinAlreadyKnown && activePenPointersRef.current.size > 0 && penPoint
            ? { x: penPoint.x, y: penPoint.y, at: penDownAtRef.current }
            : null;

        for (let i = 0; i < touches.length; i += 1) {
          const touch = touches[i];

          penTwinTouchIdentifiersRef.current.delete(touch.identifier);

          if (
            isPenTwinTouchStart(touch, penDown, now, {
              maxDistance: PEN_TWIN_START_DISTANCE_PX,
              maxWindowMs: PEN_TWIN_START_WINDOW_MS,
            })
          ) {
            penTwinTouchIdentifiersRef.current.add(touch.identifier);
          }
        }
      }

      let hasAllowedTouch = false;

      for (let i = 0; i < touches.length; i += 1) {
        const touch = touches[i];

        if (isFabricAllowedTouch(touch)) {
          hasAllowedTouch = true;
        }

        // The contact is over — forget its identity AFTER reading it (the identifier gets reused). A
        // 'finger-draws' session ends here too: its ending event must still reach Fabric (below) to close
        // the brush, so the session is cleared only after the decision was taken.
        if (isEndingEvent) {
          penTwinTouchIdentifiersRef.current.delete(touch.identifier);

          if (fingerDrawTouchIdentifierRef.current === touch.identifier) {
            fingerDrawTouchIdentifierRef.current = null;
          }
        }
      }

      if (hasAllowedTouch) {
        // A NEW contact must never extend — or, worse, RESET to its own position — a path still open from
        // a contact whose end was lost (PencilBrush.onMouseDown starts the path over; the next pen move
        // then draws a straight line from there). handlePenDown already closed it ahead of the pen's own
        // twin; this is the same guarantee for every contact Fabric is allowed to see.
        if (event.type === 'touchstart') {
          commitInterruptedFreehandStroke(canvas);
        }

        // The pen frame in flight is a tip-leaving 'skip' (see penFrameSkipRef): this twin touchmove is
        // the same lifted position Fabric must not append. Starve just this move; the stroke stays open.
        if (event.type === 'touchmove' && penFrameSkipRef.current) {
          event.stopPropagation();

          if (event.cancelable) {
            event.preventDefault();
          }

          traceRawTouch(event, 'twin-skip-frame');

          return;
        }

        traceRawTouch(event, 'allowed');

        return;
      }

      // touchInputMode 'finger-draws' passthrough. handlePointerDown (a POINTER event, which per the
      // comment on handlePenDown fires before its matching TouchEvent, and JS is single-threaded) has
      // already decided, synchronously, that a lone non-palm-rejected touch should draw — but
      // PointerEvent has no view into the Touch Events API's `identifier`, so it can only ARM the
      // decision (fingerDrawArmedRef); this is where it is CONSUMED and turned into an identifier-keyed
      // session, the same way the pen's twin is keyed by identifier above, by observation rather than
      // by (nonexistent) cross-API id equality. Reached only when isRoutedAsPenDevice() is
      // true (this function already returned above otherwise), so this can never fire in
      // 'capacitive-pen' mode.
      // Also the select tool's finger grab (handlePointerDown arms it the same way in any touch mode).
      if (tabletInputSettingsRef.current.touchInputMode === 'finger-draws' || fingerDrawArmedRef.current) {
        if (
          event.type === 'touchstart' &&
          fingerDrawArmedRef.current &&
          fingerDrawTouchIdentifierRef.current === null
        ) {
          const armedTouch = touches[0];

          if (armedTouch) {
            fingerDrawArmedRef.current = false;
            fingerDrawTouchIdentifierRef.current = armedTouch.identifier;

            return;
          }
        }

        // A live session's own contact never reaches this point: isFabricAllowedTouch passed it above
        // (and cleared the session on its ending event, after the decision).
      }

      traceRawTouch(event, 'starved');
      event.stopPropagation();

      if (event.cancelable) {
        event.preventDefault();
      }
    };
    // Direct fix for the dropped-release case: when the OS silently drops a pointer capture (routine on a
    // pen+touch panel during pen/palm interleaving), `lostpointercapture` still fires even though the
    // pointerup/pointercancel never reaches us. Drop that pointer from the maps and run the reaper, which
    // clears any TOUCH state it stranded (so the pen can ink again). Only touch pointers are considered;
    // a normal end also fires this, in which case the map is already emptying and the reaper is a no-op.
    const handleLostPointerCapture = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;

      const id = event.pointerId;
      const wasTracked =
        activeTouchPointersRef.current.has(id) ||
        rawTouchContactsRef.current.has(id) ||
        ignoredTouchPointerIdsRef.current.has(id);

      // A NORMAL touch lift ALSO fires lostpointercapture, but by then releasePointer has already removed
      // the pointer, so `wasTracked` is false and we do nothing. We act ONLY when the release was
      // genuinely LOST (the pointer is still tracked) — the exact dropped-release case this exists for.
      if (!wasTracked) return;

      emitCapturedContact(contactRecorderRef.current?.end(id) ?? null);
      activeTouchPointersRef.current.delete(id);
      rawTouchContactsRef.current.delete(id);
      ignoredTouchPointerIdsRef.current.delete(id);
      // The SAME door as releasePointer's 2→1 transition: recoverIfTouchMapsEmpty below only heals once
      // BOTH touch maps are EMPTY, so when the dropped release belonged to a stray SECOND contact it
      // leaves the first one still down with a 'multi' pan stranded on it — the wedge, reached without
      // any pointerup. Enforce the below-two invariant here too (no-op unless a multi-pan is live).
      demoteMultiPanBelowTwoContacts();
      recoverIfTouchMapsEmpty();
    };
    // Backstop for the no-retry case: if the dropped release leaves state stranded and the user simply
    // waits (no new pen/touch to trigger the on-down reap), this heals it within ~2s. The per-pointer
    // 900ms staleness check inside the reaper is what keeps it safe; the idle guard here is belt-and-
    // suspenders so it never runs mid-interaction.
    const recoveryIntervalId = window.setInterval(() => {
      const now = Date.now();

      if (now - lastInputActivityAtRef.current >= INPUT_IDLE_RECOVERY_MS) {
        reapStalePointersAndRecover(now);

        // Stuck-ink backstop (routed as a PEN DEVICE only): with no pen on the glass a brush path can
        // never be legitimately open, so a still-open one is stranded (its ending event was lost) —
        // commit it so hovering/the next touch can't keep extending it. Never runs on a touch-only-ROUTED
        // device (real touch-only hardware, or touchInputMode 'capacitive-pen'), where a finger
        // legitimately holds a stroke open while resting still.
        // A native-driven contact (stylus landed with its button held; the WebView reports nothing) is
        // a pen on the glass this map cannot see — its open erase stroke is live, not stranded.
        if (isRoutedAsPenDevice() && activePenPointersRef.current.size === 0 && !nativePenDragRef.current) {
          if ((canvas as Canvas & { _isCurrentlyDrawing?: boolean })._isCurrentlyDrawing) {
            recordPenNativeTrace('idle backstop', 'closed an open stroke with no pen on screen (no input for 1200 ms)'); // i18n-ignore: diagnostic trace
          }

          commitInterruptedFreehandStroke(canvas);
        }
      }
    }, 700);

    containerEl.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: false });
    containerEl.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
    containerEl.addEventListener('pointerup', releasePointer, { capture: true });
    containerEl.addEventListener('pointercancel', releasePointer, { capture: true });
    containerEl.addEventListener('lostpointercapture', handleLostPointerCapture, { capture: true });
    containerEl.addEventListener('touchstart', blockTouchFromFabricOnPenDevice, { capture: true, passive: false });
    containerEl.addEventListener('touchmove', blockTouchFromFabricOnPenDevice, { capture: true, passive: false });
    containerEl.addEventListener('touchend', blockTouchFromFabricOnPenDevice, { capture: true, passive: false });
    containerEl.addEventListener('touchcancel', blockTouchFromFabricOnPenDevice, { capture: true, passive: false });

    return () => {
      window.clearInterval(recoveryIntervalId);
      containerEl.removeEventListener('pointerdown', handlePointerDown, true);
      containerEl.removeEventListener('pointermove', handlePointerMove, true);
      containerEl.removeEventListener('pointerup', releasePointer, true);
      containerEl.removeEventListener('pointercancel', releasePointer, true);
      containerEl.removeEventListener('lostpointercapture', handleLostPointerCapture, true);
      containerEl.removeEventListener('touchstart', blockTouchFromFabricOnPenDevice, true);
      containerEl.removeEventListener('touchmove', blockTouchFromFabricOnPenDevice, true);
      containerEl.removeEventListener('touchend', blockTouchFromFabricOnPenDevice, true);
      containerEl.removeEventListener('touchcancel', blockTouchFromFabricOnPenDevice, true);
      activeTouchPointersRef.current.clear();
      ignoredTouchPointerIdsRef.current.clear();
      rawTouchContactsRef.current.clear();
      penTwinTouchIdentifiersRef.current.clear();
      touchDrawingPointerIdRef.current = null;
      fingerDrawArmedRef.current = false;
      fingerDrawTouchIdentifierRef.current = null;

      if (touchDrawStrokeEndFailsafeTimerRef.current !== null) {
        window.clearTimeout(touchDrawStrokeEndFailsafeTimerRef.current);
        touchDrawStrokeEndFailsafeTimerRef.current = null;
      }

      pendingSingleTouchPanRef.current = null;
      multiTouchGestureBaselineRef.current = null;
      multiTouchGestureLockRef.current = null;
      touchPanModeRef.current = null;
      lastTouchPanCenterRef.current = null;
      lastTouchDistanceRef.current = null;
      stopWholeHandEraser();
      stopTouchPan();
      cancelFling();
      // Drop the reaper's handle to this (now torn-down) closure so it can't call a stale one before the
      // effect re-runs and reassigns it for the next canvas.
      stopWholeHandEraserRef.current = null;
    };
  }, [
    applyPenVerticalDrawOffset,
    cancelFling,
    canvas,
    cancelScheduledTouchViewportUpdate,
    commitInterruptedFreehandStroke,
    clearPenPointerOffset,
    commitZoomPreview,
    containerRef,
    getTouchPanZoomToleranceFactor,
    injectCoalescedSamples,
    markRealPenSeen,
    noteInputActivity,
    reapStalePointersAndRecover,
    recordPanSample,
    recoverIfTouchMapsEmpty,
    scheduleTouchViewportUpdate,
    startFling,
    syncEffectiveTool,
    wholeHandEraserCursorRef,
  ]);

  // --- Hold-to-snap shapes: JSON persistence + finger-sized handles on every snapped shape ---
  useEffect(() => {
    if (!canvas) return;

    installShapeStylePaint();

    const uninstall = installSnappedShapeSupport(canvas);

    return () => {
      uninstall();
      shapeSnapRef.current?.cancel();
    };
  }, [canvas]);

  // --- Object modified callback ---
  useEffect(() => {
    if (!canvas) return;

    const handler = (event: { target?: FabricObject | null }) => {
      if (isTransientCanvasObject(event.target)) {
        return;
      }

      onObjectModifiedRef.current?.();
    };

    canvas.on('object:modified', handler);
    canvas.on('object:added', handler);
    canvas.on('object:removed', handler);

    return () => {
      canvas.off('object:modified', handler);
      canvas.off('object:added', handler);
      canvas.off('object:removed', handler);
    };
  }, [canvas]);

  // --- Zoom with Ctrl+scroll ---
  useEffect(() => {
    if (!canvas) return;

    const handleWheel = (opt: TPointerEventInfo<WheelEvent>) => {
      const e = opt.e;

      if (!e.ctrlKey && !e.metaKey) return;

      e.preventDefault();
      e.stopPropagation();
      cancelFling();

      const bounds = getCanvasBounds(canvas);

      if (!bounds) return;

      const anchorX = e.clientX - bounds.left;
      const anchorY = e.clientY - bounds.top;

      // Start (or restart, if the previous preview was a pan) a zoom preview anchored at the cursor.
      // The real Fabric zoom is deferred to commit (on settle); each wheel tick just grows/shrinks the
      // GPU-composited CSS scale, so the framerate is the compositor's, not the re-raster's.
      if (!zoomPreviewRef.current || zoomPreviewRef.current.mode !== 'zoom') {
        commitZoomPreview(canvas);
        zoomPreviewRef.current = {
          mode: 'zoom',
          anchorX,
          anchorY,
          baseZoom: canvas.getZoom(),
          scale: 1,
          panX: 0,
          panY: 0,
        };
      }

      const preview = zoomPreviewRef.current;
      const factor = 1 + -e.deltaY / 500;
      const zoomBounds = getZoomBounds();
      const minScale = zoomBounds.min / preview.baseZoom;
      const maxScale = zoomBounds.max / preview.baseZoom;

      preview.scale = Math.min(maxScale, Math.max(minScale, preview.scale * factor));

      scheduleZoomPreviewStyle();
      scheduleZoomCommit(canvas);
    };

    canvas.on('mouse:wheel', handleWheel);

    return () => {
      canvas.off('mouse:wheel', handleWheel);
    };
  }, [cancelFling, canvas, commitZoomPreview, getCanvasBounds, getZoomBounds, scheduleZoomCommit, scheduleZoomPreviewStyle]);

  // Pan/zoom perf: invalidate the cached canvas rect on the only things that move the element
  // (resize/scroll), and flush any pending throttled zoom-state sync on unmount.
  useEffect(() => {
    const invalidateViewportBounds = () => {
      viewportBoundsRef.current = null;
      // The DRAW path's geometry cache moves with exactly the same events — see pointerGeometryRef.
      pointerGeometryRef.current = null;
    };

    window.addEventListener('resize', invalidateViewportBounds);
    window.addEventListener('scroll', invalidateViewportBounds, true);

    // Phones: the visual viewport moves (URL bar, on-screen keyboard) without a window resize or a
    // document scroll, and it takes the canvas's client rect with it.
    const visualViewport = window.visualViewport ?? null;

    visualViewport?.addEventListener('resize', invalidateViewportBounds);
    visualViewport?.addEventListener('scroll', invalidateViewportBounds);

    return () => {
      window.removeEventListener('resize', invalidateViewportBounds);
      window.removeEventListener('scroll', invalidateViewportBounds, true);
      visualViewport?.removeEventListener('resize', invalidateViewportBounds);
      visualViewport?.removeEventListener('scroll', invalidateViewportBounds);

      if (zoomSyncTimerRef.current !== null) {
        window.clearTimeout(zoomSyncTimerRef.current);
        zoomSyncTimerRef.current = null;
      }

      // Drop any pending zoom-preview work so a torn-down board can't fire a stale commit / rAF.
      if (zoomCommitTimerRef.current !== null) {
        window.clearTimeout(zoomCommitTimerRef.current);
        zoomCommitTimerRef.current = null;
      }

      if (zoomPreviewFrameRef.current !== null) {
        window.cancelAnimationFrame(zoomPreviewFrameRef.current);
        zoomPreviewFrameRef.current = null;
      }

      zoomPreviewRef.current = null;
    };
  }, []);

  // --- Delete key handler ---
  useEffect(() => {
    if (!canvas) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Don't delete if user is typing in a textbox
        const active = canvas.getActiveObject();

        if (active instanceof Textbox && (active as Textbox).isEditing) return;

        // A pinned image is never selectable, but a selection made BEFORE the pin can still hold one.
        const selected = canvas.getActiveObjects().filter((obj) => !isLockedImage(obj));

        if (selected.length > 0) {
          canvas.discardActiveObject();
          canvas.remove(...selected);
          canvas.requestRenderAll();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [canvas]);

  // --- Shape drawing listeners ---
  function setupShapeDrawingListeners(c: Canvas) {
    const downHandler = (opt: DownEventInfo) => {
      const tool = effectiveToolRef.current;

      if (!['line', 'arrow', 'rect', 'circle', 'triangle'].includes(tool)) return;

      isDrawingShapeRef.current = true;

      const pointer = opt.scenePoint;

      shapeStartPointRef.current = pointer;

      const stroke = strokeSettingsRef.current;
      const fill = fillColorRef.current;
      const styled = shapeStyleRef.current;
      // With the shape panel: its outline, background, pattern, line style, sloppiness and edges.
      const styleFor = (closed: boolean) => (styled ? newShapeOptions(styled, closed) : null);

      let shape: FabricObject | null = null;

      switch (tool) {
        case 'line':
          shape = new Line([pointer.x, pointer.y, pointer.x, pointer.y], {
            stroke: stroke.color,
            strokeWidth: stroke.width,
            opacity: stroke.opacity,
            ...styleFor(false),
            selectable: false,
            evented: false,
          });
          break;

        case 'arrow':
          shape = new Line([pointer.x, pointer.y, pointer.x, pointer.y], {
            stroke: stroke.color,
            strokeWidth: stroke.width,
            opacity: stroke.opacity,
            ...styleFor(false),
            selectable: false,
            evented: false,
          });
          break;

        case 'rect':
          shape = new Rect({
            left: pointer.x,
            top: pointer.y,
            width: 0,
            height: 0,
            fill: fill === 'transparent' ? '' : fill,
            stroke: stroke.color,
            strokeWidth: stroke.width,
            opacity: stroke.opacity,
            ...styleFor(true),
            selectable: false,
            evented: false,
          });
          break;

        case 'circle':
          shape = new Ellipse({
            left: pointer.x,
            top: pointer.y,
            rx: 0,
            ry: 0,
            fill: fill === 'transparent' ? '' : fill,
            stroke: stroke.color,
            strokeWidth: stroke.width,
            opacity: stroke.opacity,
            ...styleFor(true),
            selectable: false,
            evented: false,
          });
          break;

        case 'triangle':
          shape = new Triangle({
            left: pointer.x,
            top: pointer.y,
            width: 0,
            height: 0,
            fill: fill === 'transparent' ? '' : fill,
            stroke: stroke.color,
            strokeWidth: stroke.width,
            opacity: stroke.opacity,
            ...styleFor(true),
            selectable: false,
            evented: false,
          });
          break;
      }

      if (shape) {
        c.add(shape);
        activeShapeRef.current = shape;
      }
    };

    const moveHandler = (opt: MoveEventInfo) => {
      if (!isDrawingShapeRef.current || !shapeStartPointRef.current || !activeShapeRef.current) {
        return;
      }

      const tool = effectiveToolRef.current;
      const pointer = opt.scenePoint;
      const start = shapeStartPointRef.current;
      const shape = activeShapeRef.current;

      switch (tool) {
        case 'line':
        case 'arrow': {
          const line = shape as Line;

          line.set({ x2: pointer.x, y2: pointer.y });
          break;
        }

        case 'rect': {
          const left = Math.min(start.x, pointer.x);
          const top = Math.min(start.y, pointer.y);
          const width = Math.abs(pointer.x - start.x);
          const height = Math.abs(pointer.y - start.y);

          (shape as Rect).set({ left, top, width, height });

          if ((shape as FabricObject & { wbEdges?: string }).wbEdges === 'round') {
            const r = roundCornerRadius(width, height);

            (shape as Rect).set({ rx: r, ry: r });
          }
          break;
        }

        case 'circle': {
          const rx = Math.abs(pointer.x - start.x) / 2;
          const ry = Math.abs(pointer.y - start.y) / 2;
          const left = Math.min(start.x, pointer.x);
          const top = Math.min(start.y, pointer.y);

          (shape as Ellipse).set({ left, top, rx, ry });
          break;
        }

        case 'triangle': {
          const left = Math.min(start.x, pointer.x);
          const top = Math.min(start.y, pointer.y);
          const width = Math.abs(pointer.x - start.x);
          const height = Math.abs(pointer.y - start.y);

          (shape as Triangle).set({ left, top, width, height });
          break;
        }
      }

      shape.setCoords();
      c.requestRenderAll();
    };

    const upHandler = (opt: UpEventInfo) => {
      if (!isDrawingShapeRef.current || !activeShapeRef.current || !shapeStartPointRef.current) {
        isDrawingShapeRef.current = false;

        return;
      }

      const tool = effectiveToolRef.current;
      const shape = activeShapeRef.current;

      // If the tool is 'arrow', replace the line with a group (line + arrowhead)
      if (tool === 'arrow') {
        const pointer = opt.scenePoint;
        const start = shapeStartPointRef.current;

        c.remove(shape);

        const styled = shapeStyleRef.current;
        const arrowGroup = createArrowGroup(
          start,
          pointer,
          styled ? { ...strokeSettingsRef.current, color: styled.stroke, width: styled.width, opacity: styled.opacity } : strokeSettingsRef.current,
        );

        c.add(arrowGroup);
      } else {
        // Make the completed shape selectable
        shape.set({ selectable: true, evented: true });
        shape.setCoords();
      }

      isDrawingShapeRef.current = false;
      shapeStartPointRef.current = null;
      activeShapeRef.current = null;
      c.requestRenderAll();
    };

    addCustomMouseDown(c, downHandler);
    addCustomMouseMove(c, moveHandler);
    addCustomMouseUp(c, upHandler);
  }

  // --- Text click listener ---
  function setupTextListeners(c: Canvas) {
    const handler = (opt: DownEventInfo) => {
      if (effectiveToolRef.current !== 'text') return;

      // Don't add a new textbox if we clicked on an existing object
      if (opt.target) return;

      const pointer = opt.scenePoint;
      const stroke = strokeSettingsRef.current;

      const textbox = new Textbox('', {
        left: pointer.x,
        top: pointer.y,
        width: 200,
        fontSize: Math.max(stroke.width * 4, 20),
        fill: stroke.color,
        fontFamily: 'sans-serif',
        editable: true,
        selectable: true,
        evented: true,
      });

      c.add(textbox);
      c.setActiveObject(textbox);
      textbox.enterEditing();
      c.requestRenderAll();
    };

    addCustomMouseDown(c, handler);
  }

  // --- Pan listeners ---
  function setupPanListeners(c: Canvas) {
    const downHandler = (opt: DownEventInfo) => {
      if (effectiveToolRef.current !== 'pan') return;

      cancelFling();
      panVelocitySamplesRef.current = [];
      isPanningRef.current = true;
      lastPanPointRef.current = opt.viewportPoint;
      c.defaultCursor = 'grabbing';
      c.requestRenderAll();
    };

    const moveHandler = (opt: MoveEventInfo) => {
      if (!isPanningRef.current || !lastPanPointRef.current) return;

      const currentPoint = opt.viewportPoint;
      const delta = new Point(currentPoint.x - lastPanPointRef.current.x, currentPoint.y - lastPanPointRef.current.y);

      c.relativePan(delta);
      constrainViewport(c);
      recordPanSample(currentPoint.x, currentPoint.y, opt.e.timeStamp);
      lastPanPointRef.current = currentPoint;
    };

    const upHandler = (opt: UpEventInfo) => {
      const wasPanning = isPanningRef.current;

      isPanningRef.current = false;
      lastPanPointRef.current = null;

      if (effectiveToolRef.current === 'pan') {
        c.defaultCursor = 'grab';
      }

      c.requestRenderAll();

      // The drag keeps sliding with its release velocity (the hand tool pans Fabric directly, so its
      // fling does too — see startFling).
      if (wasPanning) {
        startFling(c, opt.e.timeStamp, 'hand');
      }
    };

    addCustomMouseDown(c, downHandler);
    addCustomMouseMove(c, moveHandler);
    addCustomMouseUp(c, upHandler);
  }

  /**
   * Every erasable object whose DRAWN geometry the ring touches while it sweeps `capsules`, topmost first.
   *
   * This used to ask Fabric's target find — a bounding-box test — at five points near the centre, and
   * fell back to `containsPoint`, another box test. A pen stroke's box is the whole rectangle it spans,
   * so a long diagonal stroke was deleted when the ring crossed EMPTY space inside its box: ink the
   * teacher never touched, gone, which is data loss. Now the broad phase (the spatial index) only
   * narrows the candidates by box; the decision is `objectHitsEraser`, which tests the stroke's own
   * polyline, half a stroke width thick, against each capsule the ring swept.
   *
   * The broad phase is TRUSTED, empty answers included: the index follows every add/remove/modify and
   * rebuilds itself whenever the canvas's object count disagrees with what those events said. The old
   * "no candidate → test every object" fallback fired on every sample over blank paper.
   */
  function findErasableObjects(c: Canvas, capsules: ReturnType<typeof sweepCapsules>): FabricObject[] {
    objectHitIndex.sync(c.getObjects());

    // Padded by half the thickest stroke indexed, so a wide stroke whose box ends short of the ring but
    // whose paint reaches it is still a candidate.
    const pad = objectHitIndex.maxHalfStroke();
    const query = capsulesBBox(capsules, pad);

    if (!query || !Number.isFinite(query.minX) || !Number.isFinite(query.maxX)) return [];

    const candidates = objectHitIndex
      .query(query)
      .filter((object) => !isTransientCanvasObject(object) && object.visible);

    return collectSweepHits(candidates, capsules, objectHitsEraser);
  }

  /** Sweep the ring from the drag's last sample through `points` and remove what it touched, in one go. */
  function eraseObjectsAlongPoints(c: Canvas, points: readonly Point[]) {
    if (points.length === 0) return;

    // The ring is a SCREEN size; the scene it tests is zoomed. Same conversion as the partial brush.
    const r = eraserSceneRadius(eraserSizeRef.current, c.getZoom());
    const capsules = sweepCapsules(lastObjectErasePointRef.current, points, r);

    lastObjectErasePointRef.current = points[points.length - 1];

    const targets = findErasableObjects(c, capsules).filter(
      (target) => !isEraserMark(target) && !isTransientCanvasObject(target) && !isLockedImage(target),
    );

    if (targets.length === 0) return;

    c.discardActiveObject();
    c.remove(...targets);
    c.requestRenderAll();
  }

  function eraseObjectsAlong(c: Canvas, pointer: Point) {
    eraseObjectsAlongPoints(c, [pointer]);
  }

  /** Run the samples still queued for the next frame now (the drag is ending: its last stretch counts). */
  function flushScheduledObjectErase(c: Canvas) {
    const points = pendingObjectErasePointsRef.current;

    cancelScheduledObjectErase();
    eraseObjectsAlongPoints(c, points);
  }

  // Every sample of the frame is kept (not just the last), so the frame's pass sweeps the path the pen
  // actually took — and costs one broad-phase query however many samples arrived.
  function scheduleObjectErase(c: Canvas, pointer: Point) {
    pendingObjectErasePointsRef.current.push(pointer);

    if (objectEraseFrameRef.current !== null) {
      return;
    }

    objectEraseFrameRef.current = window.requestAnimationFrame(() => {
      objectEraseFrameRef.current = null;

      const points = pendingObjectErasePointsRef.current;

      pendingObjectErasePointsRef.current = [];
      eraseObjectsAlongPoints(c, points);
    });
  }

  // Fabric's `opt.target` is deliberately NOT consulted here. It is a bounding-box hit on the pointer
  // alone, so it named a stroke whenever the pointer entered the stroke's box — and the old handlers
  // deleted that target on the spot, ring or no ring. Every erase now goes through the swept-ring test.
  function setupObjectEraserListeners(c: Canvas) {
    const downHandler = (opt: DownEventInfo) => {
      if (!isObjectEraserToolActive(effectiveToolRef.current)) return;

      isObjectErasingRef.current = true;
      cancelScheduledObjectErase();
      // A new drag sweeps from where it lands, never from where the previous one ended.
      lastObjectErasePointRef.current = null;
      eraseObjectsAlong(c, opt.scenePoint);
    };

    const moveHandler = (opt: MoveEventInfo) => {
      if (!isObjectEraserToolActive(effectiveToolRef.current) || !isObjectErasingRef.current) {
        return;
      }

      scheduleObjectErase(c, opt.scenePoint);
    };

    const upHandler = () => {
      if (isObjectErasingRef.current) flushScheduledObjectErase(c);

      isObjectErasingRef.current = false;
      cancelScheduledObjectErase();
      lastObjectErasePointRef.current = null;
    };

    addCustomMouseDown(c, downHandler);
    addCustomMouseMove(c, moveHandler);
    addCustomMouseUp(c, upHandler);
  }

  // --- Laser pointer listeners ---
  function setupLaserListeners(c: Canvas) {
    const moveHandler = (opt: MoveEventInfo) => {
      if (effectiveToolRef.current !== 'laser') return;

      const pointer = opt.scenePoint;

      // Remove previous laser dot
      if (laserDotRef.current) {
        c.remove(laserDotRef.current);
        laserDotRef.current = null;
      }

      if (laserTimeoutRef.current) {
        clearTimeout(laserTimeoutRef.current);
        laserTimeoutRef.current = null;
      }

      const dot = new Circle({
        // Centred on the pen tip: Fabric 7 defaults to a centre origin, so `left - radius` sat 12px up-left.
        left: pointer.x,
        top: pointer.y,
        originX: 'center',
        originY: 'center',
        radius: 12,
        fill: 'rgba(239, 68, 68, 0.7)',
        stroke: 'rgba(239, 68, 68, 0.3)',
        strokeWidth: 8,
        selectable: false,
        evented: false,
        excludeFromExport: true,
      });

      c.add(dot);
      c.requestRenderAll();
      laserDotRef.current = dot;

      laserTimeoutRef.current = setTimeout(() => {
        if (laserDotRef.current === dot) {
          c.remove(dot);
          c.requestRenderAll();
          laserDotRef.current = null;
        }
      }, 300);
    };

    addCustomMouseMove(c, moveHandler);
  }

  // --- Sticky note listeners ---
  function setupStickyListeners(c: Canvas) {
    const handler = (opt: DownEventInfo) => {
      if (effectiveToolRef.current !== 'sticky') return;

      // Don't add a sticky if we clicked on an existing object
      if (opt.target) return;

      const pointer = opt.scenePoint;

      addStickyNoteAt(c, pointer.x, pointer.y);
    };

    addCustomMouseDown(c, handler);
  }

  // --- Add sticky note at position ---
  function addStickyNoteAt(c: Canvas, x: number, y: number, color?: string) {
    const stickyColor = color ?? STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)];

    const rect = new Rect({
      width: 140,
      height: 140,
      rx: 8,
      ry: 8,
      fill: stickyColor,
      shadow: new Shadow({ color: 'rgba(0,0,0,0.15)', blur: 6, offsetX: 2, offsetY: 2 }),
    });

    const textbox = new Textbox('', {
      width: 120,
      fontSize: 14,
      fontFamily: 'sans-serif',
      fill: '#1a1a1a',
      textAlign: 'center',
      left: 10,
      top: 10,
      editable: true,
      selectable: true,
      evented: true,
    });

    const group = new Group([rect, textbox], {
      left: x - 70,
      top: y - 70,
      selectable: true,
      evented: true,
      subTargetCheck: true,
    });

    // Allow double-click to edit the textbox inside the group
    group.on('mousedblclick', () => {
      // Ungroup, make textbox editable, then re-group when done
      const items = group.getObjects();
      const bgRect = items[0];
      const txt = items[1] as Textbox;

      if (!txt || !(txt instanceof Textbox)) return;

      const groupLeft = group.left ?? 0;
      const groupTop = group.top ?? 0;

      c.remove(group);

      bgRect.set({
        left: groupLeft,
        top: groupTop,
        selectable: false,
        evented: false,
      });

      txt.set({
        left: groupLeft + 10,
        top: groupTop + 10,
        selectable: true,
        evented: true,
        editable: true,
      });

      c.add(bgRect);
      c.add(txt);
      c.setActiveObject(txt);
      txt.enterEditing();
      c.requestRenderAll();

      const exitEditing = () => {
        txt.exitEditing();
        txt.off('editing:exited', exitEditing);

        c.remove(bgRect);
        c.remove(txt);

        // Reset positions relative to group
        bgRect.set({ left: 0, top: 0, selectable: true, evented: true });
        txt.set({ left: 10, top: 10 });

        const newGroup = new Group([bgRect, txt], {
          left: groupLeft,
          top: groupTop,
          selectable: true,
          evented: true,
          subTargetCheck: true,
        });

        // Re-attach the double-click listener to the new group
        newGroup.on('mousedblclick', () => {
          group.fire('mousedblclick');
        });

        c.add(newGroup);
        c.setActiveObject(newGroup);
        c.requestRenderAll();
      };

      txt.on('editing:exited', exitEditing);
    });

    c.add(group);
    c.setActiveObject(group);
    c.requestRenderAll();
  }

  // --- Arrow group helper ---
  function createArrowGroup(start: Point, end: Point, stroke: StrokeSettings): Group {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

    const line = new Line([start.x, start.y, end.x, end.y], {
      stroke: stroke.color,
      strokeWidth: stroke.width,
      opacity: stroke.opacity,
    });

    const headSize = Math.max(stroke.width * 3, 10);

    const arrowHead = new Triangle({
      left: end.x,
      top: end.y,
      width: headSize,
      height: headSize,
      fill: stroke.color,
      opacity: stroke.opacity,
      angle: angle + 90,
      originX: 'center',
      originY: 'center',
    });

    const group = new Group([line, arrowHead], {
      selectable: true,
      evented: true,
    });

    return group;
  }

  // --- Zoom controls ---
  // A discrete zoom change is authoritative: cancel any trailing-throttled gesture flush so it can't
  // later overwrite this value with a stale one.
  const cancelPendingZoomSync = useCallback(() => {
    if (zoomSyncTimerRef.current !== null) {
      window.clearTimeout(zoomSyncTimerRef.current);
      zoomSyncTimerRef.current = null;
    }

    pendingZoomSyncRef.current = null;
  }, []);

  const setZoom = useCallback(
    (newZoom: number) => {
      if (!canvas) return;

      // Bake any active gesture preview first so this discrete zoom builds on the real current viewport.
      commitZoomPreview(canvas);

      const clamped = clampZoomValue(newZoom);
      const center = canvas.getCenterPoint();

      canvas.zoomToPoint(new Point(center.x, center.y), clamped);
      constrainViewport(canvas);
      cancelPendingZoomSync();
      setZoomState(canvas.getZoom());
      canvas.requestRenderAll();
    },
    [canvas, cancelPendingZoomSync, clampZoomValue, commitZoomPreview, constrainViewport],
  );

  // Base the step off the LIVE canvas zoom, not the React `zoom` state — the state is
  // trailing-throttled during gestures and may lag the real zoom by up to ~140ms.
  const zoomIn = useCallback(() => {
    if (!canvas) return;

    setZoom(canvas.getZoom() + ZOOM_STEP);
  }, [canvas, setZoom]);

  const zoomOut = useCallback(() => {
    if (!canvas) return;

    setZoom(canvas.getZoom() - ZOOM_STEP);
  }, [canvas, setZoom]);

  const resetZoom = useCallback(() => {
    if (!canvas) return;

    // Drop any in-flight gesture preview (clears its CSS transform + cancels the trailing commit timer)
    // so this reset isn't reverted by a stale commit firing ~90ms later.
    commitZoomPreview(canvas);

    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    // Under constraints identity may be out of bounds (a page wider than the window): land on the
    // nearest legal viewport instead.
    constrainViewport(canvas);
    cancelPendingZoomSync();
    setZoomState(canvas.getZoom());
    canvas.requestRenderAll();
  }, [canvas, cancelPendingZoomSync, commitZoomPreview, constrainViewport]);

  // --- Delete selected ---
  const deleteSelected = useCallback(() => {
    if (!canvas) return;

    // A pinned image is never selectable, but a selection made BEFORE the pin can still hold one.
    const selected = canvas.getActiveObjects().filter((obj) => !isLockedImage(obj));

    if (selected.length > 0) {
      canvas.discardActiveObject();
      canvas.remove(...selected);
      canvas.requestRenderAll();
    }
  }, [canvas]);

  // --- Clear canvas ---
  const clearCanvas = useCallback(() => {
    if (!canvas) return;

    // Clearing wipes the teacher's ink, not the pinned image they are annotating over — so this
    // removes everything else by hand instead of canvas.clear().
    const lockedImages = getLockedImages(canvas);
    const removable = canvas.getObjects().filter((obj) => !isLockedImage(obj));

    canvas.discardActiveObject();
    canvas.remove(...removable);

    for (const image of lockedImages) {
      applyImageLockState(image, true);
    }

    // The rest of what canvas.clear() dropped.
    canvas.backgroundImage = undefined;
    canvas.overlayImage = undefined;
    canvas.backgroundColor = 'transparent';
    inkBakeRef.current?.invalidate();
    canvas.requestRenderAll();
    notifyLockedImagesChanged(canvas);
  }, [canvas]);

  // --- Serialization ---
  const getCanvasJSON = useCallback(() => {
    if (!canvas) return '{}';

    return serializeCanvasJson(canvas);
  }, [canvas]);

  const loadCanvasJSON = useCallback(
    async (json: string) => {
      if (!canvas) return;

      let parsed: Record<string, unknown>;

      try {
        parsed = JSON.parse(json) as Record<string, unknown>;
      } catch {
        console.error('[useWhiteboardCanvas] Failed to parse canvas JSON');

        return;
      }

      // Belt and braces ahead of `loadFromJSON`'s clear()+add(): the bake's identity check would catch
      // the replaced object set on its own, one frame later.
      inkBakeRef.current?.invalidate();

      await canvas.loadFromJSON(parsed);

      inkBakeRef.current?.invalidate();

      // A fresh page replaces the whole object set, so the object-erase spatial
      // index must be rebuilt before the next erase query.
      objectHitIndexRef.current?.markDirty();

      // Keep restored freehand strokes crisp: like newly drawn strokes, render them directly
      // instead of from Fabric's size-capped object cache, which blurs large committed paths.
      restoreRenderInvariants(canvas);

      // Force the next tool sync to re-run its interaction sweep over this page's fresh object set.
      objectInteractionModeRef.current = null;

      // Restored images come back with their pin flag but plain interaction state, so the pin has to
      // be re-asserted; the notify hands the background painter its repaint even when none survived
      // (a page whose last pinned image was unpinned still has to clear the previous page's paint).
      enforceLockedImageInvariants(canvas);

      canvas.requestRenderAll();
      notifyLockedImagesChanged(canvas);
    },
    [canvas],
  );

  // --- Thumbnail ---
  const getThumbnail = useCallback(() => {
    if (!canvas) return '';

    return canvas.toDataURL({ multiplier: 0.2 });
  }, [canvas]);

  // --- Add image to canvas ---
  const addImageToCanvas = useCallback(
    async (url: string) => {
      if (!canvas) return;

      const img = await FabricImage.fromURL(url, { crossOrigin: 'anonymous' });

      // Scale image to fit within canvas viewport
      const maxWidth = canvas.getWidth() * 0.8;
      const maxHeight = canvas.getHeight() * 0.8;
      const scaleX = maxWidth / (img.width ?? maxWidth);
      const scaleY = maxHeight / (img.height ?? maxHeight);
      const scale = Math.min(scaleX, scaleY, 1);

      img.set({
        scaleX: scale,
        scaleY: scale,
        left: (canvas.getWidth() - (img.width ?? 0) * scale) / 2,
        top: (canvas.getHeight() - (img.height ?? 0) * scale) / 2,
        selectable: true,
        evented: true,
      });

      canvas.add(img);
      canvas.setActiveObject(img);
      canvas.requestRenderAll();
    },
    [canvas],
  );

  // --- Pin / unpin an image (public API) ---
  const setImageLockState = useCallback(
    (target: FabricObject, locked: boolean) => {
      if (!canvas) return;

      applyImageLockState(target, locked);

      // A selection group goes on rendering and transforming its members regardless of their own
      // visible/selectable flags, so an image pinned while selected has to leave the selection.
      if (canvas.getActiveObjects().includes(target)) {
        canvas.discardActiveObject();
      }

      // Pinning moves the image out of the object eraser's index (unpinning moves it back in).
      objectHitIndexRef.current?.markDirty();

      canvas.requestRenderAll();
      notifyLockedImagesChanged(canvas);
    },
    [canvas],
  );

  // --- Set background image ---
  const setBackgroundImage = useCallback(
    async (url: string) => {
      if (!canvas) return;

      const img = await FabricImage.fromURL(url, { crossOrigin: 'anonymous' });
      const canvasWidth = canvas.getWidth();
      const canvasHeight = canvas.getHeight();
      const imgW = img.width ?? canvasWidth;
      const imgH = img.height ?? canvasHeight;
      const scale = Math.min(canvasWidth / imgW, canvasHeight / imgH);

      img.set({
        scaleX: scale,
        scaleY: scale,
        left: (canvasWidth - imgW * scale) / 2,
        top: (canvasHeight - imgH * scale) / 2,
        originX: 'left',
        originY: 'top',
      });

      canvas.backgroundImage = img;
      canvas.requestRenderAll();
    },
    [canvas],
  );

  // --- Trigger image upload via file input ---
  const triggerImageUpload = useCallback(() => {
    if (!canvas) return;

    const input = document.createElement('input');

    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';

    input.addEventListener('change', () => {
      const file = input.files?.[0];

      if (!file) return;

      const reader = new FileReader();

      reader.onload = () => {
        const dataUrl = reader.result as string;

        addImageToCanvas(dataUrl);
      };

      reader.readAsDataURL(file);

      // Cleanup
      document.body.removeChild(input);
    });

    document.body.appendChild(input);
    input.click();
  }, [canvas, addImageToCanvas]);

  // --- Add sticky note at position (public API) ---
  const addStickyNote = useCallback(
    (x: number, y: number, color?: string) => {
      if (!canvas) return;

      addStickyNoteAt(canvas, x, y, color);
    },
    [canvas],
  );

  return {
    canvas,
    effectiveTool,
    isWholeHandEraserActive,
    zoom,
    setZoom,
    zoomIn,
    zoomOut,
    resetZoom,
    deleteSelected,
    clearCanvas,
    getCanvasJSON,
    loadCanvasJSON,
    getThumbnail,
    addImageToCanvas,
    setImageLockState,
    setBackgroundImage,
    triggerImageUpload,
    addStickyNote,
  };
}
