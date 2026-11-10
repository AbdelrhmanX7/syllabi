import type { DualTipClassifier } from './dual-tip-contact';
import type { WhiteboardTeacherType } from './remote/types';

export type WhiteboardTool =
  | 'select'
  | 'pen'
  // Speed-tapered ink brush, soft felt-tip marker and tapered gel/fountain "script" ink. All share the
  // pen's colour and width settings (including the dual-tip head colours) — see the brushes/ directory
  // in whiteboard-react.
  | 'brush'
  | 'marker'
  | 'script'
  | 'highlighter'
  | 'eraser'
  | 'line'
  | 'arrow'
  | 'rect'
  | 'circle'
  | 'triangle'
  | 'text'
  | 'laser'
  | 'sticky'
  | 'image'
  | 'pan';

/**
 * The nibs that share the pen's colour, width and opacity settings, and that the teacher picks from
 * INSIDE the pen button's own popover.
 *
 * Lives here, next to the union, because "is this the pen family?" is a question four different files
 * were each answering with their own hardcoded `=== 'pen'`. Every one of those was a bug the day the
 * brush and marker were added: the popover slammed shut on selecting a nib, the quick colour/width
 * buttons kicked you back to the plain pen, the focus dock lit nothing, and the cursor dot switched to
 * a fully-opaque disc. Add a nib to this array, not to another comparison.
 */
export const PEN_FAMILY_TOOLS: WhiteboardTool[] = ['pen', 'brush', 'marker', 'script'];

export const isPenFamilyTool = (tool: WhiteboardTool): boolean => PEN_FAMILY_TOOLS.includes(tool);

export type EraserMode = 'partial' | 'object';

export type BackgroundType = 'blank' | 'grid' | 'lined' | 'dotted';

export type ToolbarDock = 'top' | 'bottom' | 'left' | 'right';

export type GeometryStencilKind = 'compass' | 'protractor' | 'set-square';

/**
 * Whole-hand (palm) eraser: rest your whole hand (or ≥ `contactCountThreshold` fingers) on the surface
 * and drag to erase a wide swath — the natural board-eraser gesture. Off by default. The panel reports a
 * FIXED pixel size per touch, so a palm can't be told apart by contact SIZE — instead it's detected by the
 * NUMBER of simultaneous contacts (a whole hand lands as many points at once). It counts RAW contacts in a
 * separate uncapped map, independent of the 2-contact pan/zoom cap. Tunable, and emulatable for desktop
 * testing. Fires on BOTH device types, but only while a real pen isn't active (never mid-pen-stroke).
 */
export interface WholeHandEraserSettings {
  enabled: boolean;
  /**
   * How many simultaneous touch contacts count as a whole hand (rather than 1–2 fingers panning).
   * Lower = more sensitive. Detected by count because the panel reports a fixed size per touch.
   */
  contactCountThreshold: number;
  /** Diameter (CSS px) of the erase swath driven by a whole-hand contact — the FLOOR (size when the
   *  fingers are close together). */
  eraserSize: number;
  /** Extra radius (CSS px) added beyond the outermost fingertip on each side — i.e. how far the erase
   *  circle extends past the hand. 0 = the circle's edge sits right at the fingertips. */
  fingerPadding: number;
  /**
   * Testing / manual mode: when on, the activation threshold drops to a single contact so a lone
   * mouse/finger drag stands in for the whole hand — so it can be exercised on desktop without a real
   * palm. Independent of the contact-count auto-detection.
   */
  testEmulation: boolean;
}

/**
 * Dual-tip (two-headed) capacitive stylus. Some capacitive pens have two ends with DIFFERENT contact
 * footprints (e.g. a fine ~6px head and a thick ~10px head), distinct from a finger (~12–15px). On a
 * TOUCH-ONLY panel (e.g. ViewSonic) both pen heads and a finger all report `pointerType === 'touch'`,
 * so they can only be told apart by contact SIZE. When enabled, a single touch contact is classified by
 * its reported size and draws with a matching colour: small head → the primary stroke colour, big head →
 * the secondary stroke colour. A finger-sized contact is left to the normal behaviour. Thresholds are
 * device/pen-specific (measure them on the calibration page) so they're tunable here. Only ever consulted
 * on a touch-only device — on a real pen device the pen/finger split is deterministic and this is inert.
 */
export interface DualTipStylusSettings {
  enabled: boolean;
  /** Contact MINOR-axis size (CSS px, min of width/height) at or below which a touch is the SMALL head →
   *  primary colour. Minor axis is used because tilting the pen inflates only the major axis. */
  smallHeadMaxWidth: number;
  /** Above smallHeadMaxWidth and at or below this (minor axis) → the BIG head → secondary colour. Larger = a finger. */
  bigHeadMaxWidth: number;
  /**
   * Which rulebook reads the contact. `height-aware` (default) is the settled-minor-axis fit with the
   * elongation guard; `legacy` is the single-frame minor axis for colour and the major axis for
   * write-vs-navigate, exactly as it shipped through v0.1.141.
   */
  classifier: DualTipClassifier;
  /**
   * The bands `legacy` reads, kept SEPARATE from the fields above rather than shared.
   *
   * The two rulebooks measure different things: a single frame's major axis runs several px larger than
   * a size settled to its running minimum, so the same physical head lands in a different band under
   * each. One shared set of thresholds would mean switching rulebooks silently mis-tunes whichever one
   * the numbers were not fitted for — and would overwrite a calibration the teacher captured by hand.
   * Each rulebook keeps its own, and the sliders edit whichever is active.
   */
  legacyBands: DualTipLegacyBands;
}

/** The `legacy` rulebook's calibration — its own copy of the three thresholds. */
export interface DualTipLegacyBands {
  smallHeadMaxWidth: number;
  bigHeadMaxWidth: number;
  /** «Finger size» for the legacy rulebook, measured against the MAJOR axis. */
  fingerMinWidth: number;
}

/**
 * Single-finger pan (touch-only devices): a SINGLE touch whose contact footprint is at least `minWidth`
 * (a finger, which is fatter than a pen tip) PANS the canvas instead of drawing — so the finger navigates
 * and the (smaller) capacitive pen heads write. The threshold is finger-size-specific per teacher, so it's
 * a tunable slider. When off, a single finger keeps its current touch-only behaviour (draws). Only
 * consulted on a touch-only device (never saw a real 'pen' event); on a pen device a finger already pans.
 */
export interface SingleFingerPanSettings {
  enabled: boolean;
  /** Contact size (CSS px, max of width/height) at or above which a single touch is treated as a finger → pan. */
  minWidth: number;
}

/**
 * See the `touchInputMode` doc on {@link TabletInputSettings} for what each value does.
 */
export type TouchInputMode = 'auto' | 'finger-draws' | 'capacitive-pen';

/**
 * Tablet/pen input settings for the whiteboard. The input model is now DETERMINISTIC per device +
 * contact-count (a pen device single-finger PANS, a touch-only device single-finger DRAWS, two fingers
 * pan/zoom, a pen down suppresses touch as a palm guard), so the old heuristic tuning knobs (finger
 * drawing toggle, dual-tip, whole-hand eraser, pressure, stylus-only, palm-rejection window, tap
 * shortcuts) are gone. What remains: freehand jitter/tilt correction, the two-finger pan/zoom
 * tolerance, the pen barrel-button gestures, the diagnostic/zoom-lock toggles, and `touchInputMode`
 * (which reintroduces a device-model OVERRIDE — see its doc — deliberately kept minimal and layered
 * behind the same palm guard rather than reviving the old heuristic machinery wholesale).
 */
export interface TabletInputSettings {
  /** Freehand brush `decimate` (screen px): points closer than this are dropped when a stroke is
   *  finalized, filtering small hover/contact jitter. */
  penJitterFilter: number;
  /** Constant nib-landing correction (CSS px) applied along the pen tilt direction so ink lands at the
   *  nib rather than below/beside it. */
  penTiltOffset: number;
  /** Sensitivity multiplier (%) for the two-finger pan/zoom activation thresholds. Lower = snappier. */
  touchPanZoomTolerance: number;
  /**
   * Whole-hand (palm) eraser: rest ≥ `contactCountThreshold` fingers / a palm on the glass to erase a wide
   * swath along their centroid. Counts RAW contacts in a separate uncapped map (independent of the 2-contact
   * pan/zoom cap), so a full palm always registers. Fires on both device types, never while a pen is active.
   */
  wholeHandEraser: WholeHandEraserSettings;
  /**
   * Dual-tip capacitive stylus: colour a single touch DRAW stroke by contact head-size. ONLY consulted on
   * a touch-only device (ViewSonic), where pen heads and a finger all report `pointerType === 'touch'`.
   */
  dualTipStylus: DualTipStylusSettings;
  /**
   * Single-finger pan: a finger-sized single touch pans instead of draws. ONLY consulted on a touch-only
   * device (on a real pen device a single finger already pans, so this is inert there).
   */
  singleFingerPan: SingleFingerPanSettings;
  /**
   * Master switch for the pen barrel buttons (Lenovo ThinkPad two-button pen).
   * When false the barrel-button gestures (pen↔eraser toggle / COLOR-toggle) are inert.
   * Defaults OFF: the button→bit mapping is unverified on real hardware and a
   * mis-read can silently turn every stroke into an eraser. Opt in from Settings.
   */
  penButtonsEnabled: boolean;
  /**
   * Swaps which physical barrel bit drives which gesture. The buttons surface via
   * the W3C PointerEvent `buttons` bitmask while `pointerType === 'pen'`: BARREL
   * bit = 2, ERASER-mapped bit = 32. When false: bit 2 => pen↔eraser toggle, bit 32 =>
   * COLOR-toggle. When true the mapping is reversed (the physical ThinkPad mapping
   * can't be confirmed without the device, so it's user-swappable).
   */
  penButtonsSwap: boolean;
  /**
   * Diagnostic-only: show a live on-screen readout of RAW pointer contacts (count + each contact's
   * reported size). Default OFF.
   */
  touchDebugOverlay: boolean;
  /**
   * Show the on-canvas zoom-lock button (right edge). Default ON. Turn OFF on devices where you pan/zoom
   * freely by hand and draw with a pen (e.g. a ThinkPad), so the lock toggle doesn't take up space.
   */
  showZoomLockButton: boolean;
  /**
   * Touch input model. Deliberately INDEPENDENT of the screen-recording `deviceMode`
   * (ViewSonic/ThinkPad, see recording-settings.ts) — a device can run ThinkPad-style native recording
   * while still needing the ViewSonic touch model (e.g. a new touchscreen laptop with a capacitive
   * stylus but no real pen digitizer), so the two must never be coupled.
   *   - 'auto' (default): today's deterministic model. A device that has ever reported a real
   *     `pointerType === 'pen'` event (hasSeenRealPen) locks a single finger to PAN (the pen draws); a
   *     device that never has (e.g. ViewSonic, whose capacitive pen reports as 'touch') lets a single
   *     finger DRAW, disambiguated from a real finger by contact size via singleFingerPan/dualTipStylus.
   *   - 'finger-draws': on a device that HAS a real pen, override the single-finger-PANS lock so a lone
   *     finger also draws with the active tool (same brush pipeline the pen uses; no contact-size
   *     classification — every lone touch draws). REAL pen activity still wins: the existing palm-reject
   *     window (any touch while a pen is down or was active within ~400ms) is consulted first, so a
   *     resting palm can never draw even with this on. A no-op on a device that never saw a pen (already
   *     draws there). This mirrors a finger-drawing toggle the deterministic-model refactor removed for
   *     being a source of stray-palm-ink bugs — layered strictly behind the same palm guard for that
   *     reason.
   *   - 'capacitive-pen': force the FULL touch-only (ViewSonic) contact-size model REGARDLESS of whether
   *     a real 'pen' event was ever observed — for a device with a purely capacitive stylus (reports as
   *     'touch', never 'pen') that must still be told apart from a finger by SIZE. Reuses
   *     singleFingerPan/dualTipStylus verbatim; only the ROUTING decision (which branch of the touch
   *     model applies) is forced, not the classification thresholds themselves.
   */
  touchInputMode: TouchInputMode;
  /**
   * Record every touch contact (its frames plus what the classifier decided) and upload it as
   * training data for a learned replacement of the size thresholds.
   *
   * OFF by default and opt-in per board: the frames carry x/y, which is the teacher's handwriting
   * geometry, so this must never start collecting because a release shipped.
   */
  penCaptureEnabled: boolean;
  /**
   * Hold-to-snap shapes (Apple Notes / Samsung Notes): draw a rough line / triangle / rectangle /
   * ellipse and keep the pen down and still at the end — the stroke becomes the perfect shape, and
   * keeps resizing/rotating with the pen until it lifts. Default ON. Optional only so a settings
   * object saved before the feature still type-checks; absent reads as ON.
   */
  shapeSnapOnHold?: boolean;
  /**
   * Smart ink contrast: a stroke whose colour would barely show against what is under it (light
   * yellow on white paper, dark blue on a dark PDF region) is drawn in a darker — or lighter — shade
   * of the same hue, until it reads at WCAG 3:1. The palette selection itself never changes; only
   * the committed stroke and its live preview do. Pen, brush and marker; never the highlighter.
   * Default ON. Optional for the same reason as `shapeSnapOnHold`; absent reads as ON.
   */
  smartInkContrast?: boolean;
}

export const DEFAULT_TABLET_INPUT_SETTINGS: TabletInputSettings = {
  penJitterFilter: 0.4,
  penTiltOffset: 0,
  touchPanZoomTolerance: 100,
  wholeHandEraser: {
    enabled: false,
    contactCountThreshold: 5,
    eraserSize: 80,
    fingerPadding: 8,
    testEmulation: false,
  },
  dualTipStylus: {
    enabled: false,
    // Fitted by replaying labelled ViewSonic captures through the live decision code
    // (`tools/replay-dualtip.mjs --sweep`). Sizes are the SETTLED minor axis, which reads smaller than
    // any single frame, so they sit below the old single-frame values (7/11). Refit from a fresh
    // capture rather than by intuition — these track the physical pen, and the teacher's replacement
    // pen (2026-08-16, 104 labelled strokes) has smaller heads than the one they started with.
    smallHeadMaxWidth: 5,
    // Inert by construction and kept only for the settings UI: a contact that writes takes the primary
    // colour only in the SMALL band, and write-vs-navigate is decided by the finger size below — so
    // nothing reads this threshold on its own. Sweeping it 7..12 changes no outcome in either capture.
    bigHeadMaxWidth: 10,
    classifier: 'height-aware',
    // The values that shipped with the legacy rulebook itself (v0.1.141: 7 / 11, finger 14). They are
    // its own fit on single-frame readings — do not "sync" them to the settled-size numbers above.
    legacyBands: {
      smallHeadMaxWidth: 7,
      bigHeadMaxWidth: 11,
      fingerMinWidth: 14,
    },
  },
  singleFingerPan: {
    enabled: false,
    // Same fit: the new pen's heads settle at 1-9, the teacher's fingers at 11-17. 11 is the measured
    // optimum — 1 pen stroke of 104 pans, no finger writes; 12 costs 2 fingers, 10 costs another stroke.
    minWidth: 11,
  },
  penButtonsEnabled: false,
  penButtonsSwap: false,
  touchDebugOverlay: false,
  showZoomLockButton: true,
  touchInputMode: 'auto',
  penCaptureEnabled: false,
  shapeSnapOnHold: true,
  smartInkContrast: false,
};

export interface WhiteboardPage {
  id: string;
  canvasJSON: string;
  thumbnail: string;
  pdfAssetId?: string;
  pdfFingerprint?: string;
  pdfPageIndex?: number;
  /**
   * Original 1-based page number in the SOURCE file the page was imported from. Decoupled from
   * `pdfPageIndex` because, when only a subset of a PDF is imported+uploaded, `pdfPageIndex` is the
   * index INTO the uploaded subset asset (0..N-1), not the original page. Used for incremental-import
   * dedup ("already imported page 7"). Absent on legacy whole-file pages (where pdfPageIndex+1 = it).
   */
  pdfSourcePageNumber?: number;
  pdfImageUrl?: string;
  pdfSourceName?: string;
  /**
   * Rotation of the PDF/image BACKGROUND raster in degrees CLOCKWISE (screen sense), any angle —
   * the fix for sideways/tilted scans. Ink is deliberately NOT rotated (the teacher straightens the
   * page before writing); the background is painted rotated about the center of its rotated
   * bounding box, and that bbox becomes the page's fit/placement frame. Absent = 0.
   */
  pdfRotation?: number;
  /**
   * Canvas-px frame at capture; used by the server-side ink renderer. Width in CSS px of the page
   * frame the ink in `canvasJSON` is stored in: Fabric's SCENE space, i.e. the canvas's CSS-pixel
   * coordinate system with the viewport at identity (zoom 1, no pan). `viewportOffsetX/Y` and
   * `viewportZoom` never enter into it, and neither does devicePixelRatio (Fabric `getWidth()` is the
   * CSS width; the retina backing store is separate). For a PDF page this is the frozen fit width
   * the renderer pins the background to — a window resize is compensated with viewport zoom rather
   * than by moving the ink. It is recorded from the canvas the FIRST time the page is captured and,
   * from then on, the page is re-frozen to THIS value on every later open (whatever window it opens
   * in), so the record is stable and always describes the frame the ink was written in. For a page
   * without a PDF it is the live canvas width at capture. Never a guess: absent when nothing was
   * measured.
   */
  canvasWidthPx?: number;
  /**
   * Canvas-px frame at capture; used by the server-side ink renderer. Where the PDF/image background
   * sits in the SAME frame as `canvasWidthPx` (CSS px, top-left origin) — the output of the renderer's
   * own fit (`getScreenFitPlacement`: fill the width, centre vertically), so `x` is 0, `width` equals
   * `canvasWidthPx`, and `y` is NEGATIVE whenever the page is taller than the canvas it opened in.
   * With a `pdfRotation` this is the BOUNDING BOX of the rotated page (the frame the ink was drawn
   * over) and the source page is turned by `pdfRotation` about the box's centre. Present only on
   * pages with a PDF/image background whose placement was known at capture; never zeros.
   */
  pdfPlacement?: PdfPlacementRect;
  /**
   * Set ONLY on a blank writing sheet inserted among a PDF's pages (`WhiteboardEditor.allowInsertBlankPages`):
   * the sheet's height ÷ width, copied from the PDF page it was inserted after so it stacks in the
   * continuous layout as a page of the same size. Its ink is stored like any page without a PDF (frame
   * `canvasWidthPx` wide, page rect from the top). Never present on a page with a PDF/image background;
   * absent on every page written before the feature, which therefore load and render unchanged.
   */
  sheetAspect?: number;
  /**
   * A sheet of a free-writing notebook (no PDF) split into pages (see notebook-sheets.ts): its paper is
   * ruled like a plain board page — `paperSpacingMm` on the board-px scale, measured in the page's own
   * frame (`canvasWidthPx`) from its top-left corner — instead of the per-page-width ruling of a sheet
   * inserted among PDF pages. So a page written before the split keeps its lines exactly under its
   * writing. Only ever `true` on a page that also has `sheetAspect`; absent everywhere else.
   */
  boardRuled?: boolean;
  /**
   * The student bookmarked this page. `label` is an optional short name they typed; `at` is when it
   * was set (ms since epoch). Absent = not bookmarked. Removing a bookmark just drops the field.
   */
  bookmark?: PageBookmark;
  backgroundType: BackgroundType;
  /**
   * Spacing of the page's paper (the ruled lines of 'lined', the cells of 'grid' and 'dotted') in
   * millimetres. Absent = the spacing every page had before this field existed, so old pages keep
   * exactly what they show. The mm → board-unit scale is fixed (see whiteboard-react
   * utils/paperSpacing): an inserted sheet is an A4-wide page; any other page is CSS px at 96 dpi,
   * the scale the PDF export already prints the board at.
   */
  paperSpacingMm?: number;
  /**
   * Saved pan/zoom. For a PDF page that carries `canvasWidthPx` these are FRAME-relative — the
   * viewport as it would read on a canvas exactly `canvasWidthPx` wide — and the editor scales them
   * onto the live window on open (identical on the device the page was written on). For every other
   * page they are the live screen values.
   */
  viewportOffsetX?: number;
  viewportOffsetY?: number;
  viewportZoom?: number;
}

export interface PageBookmark {
  label?: string;
  at: number;
}

/**
 * Axis-aligned rect in a page's canvas frame (CSS px, top-left origin, viewport at identity).
 * See {@link WhiteboardPage.pdfPlacement} for the coordinate-frame contract.
 */
export interface PdfPlacementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WhiteboardDocument {
  id: string;
  title: string;
  pages: WhiteboardPage[];
  currentPageIndex: number;
  createdAt: number;
  updatedAt: number;
  thumbnail: string;
  sharedBackgroundImageUrl?: string;
  sharedBackgroundImageOpacity?: number;
  viewportZoom?: number;
  schemaVersion?: number;
  /**
   * The teacher this locally-stored board is tagged for. Lets the home library SCOPE local boards to
   * the selected teacher (hide another teacher's boards) instead of showing every device-local board.
   * OPTIONAL on purpose: boards created before tagging existed have none, and the migrate-on-read path
   * carries these three through untouched (they ride the finalize/normalize spread) — so an absent tag
   * means "belongs to everyone / never assigned" and such boards must ALWAYS stay visible.
   */
  teacherId?: string;
  /** The tagged teacher's type (mirrors the server's owner axis). Only meaningful with `teacherId`. */
  teacherType?: WhiteboardTeacherType;
  /**
   * Display-only label for the tagged teacher (e.g. 'Jane Smith'), used to name/label the board in the
   * library. NOT carried on the server document, so it is best-effort: present on locally-created and
   * freshly-claimed boards, absent on boards re-fetched from the cloud in a later session.
   */
  teacherName?: string;
}

/**
 * The list-row projection of a {@link WhiteboardDocument}: every scalar the home library renders
 * and NOTHING else. A real board carries 100–286 pages, each with a full Fabric `canvasJSON` and a
 * base64 thumbnail, so loading whole documents just to paint a list costs tens-to-hundreds of MB of
 * main-thread structured-clone work. Summaries are persisted in their own object store alongside the
 * documents (see `listWhiteboardSummaries`) so the list never touches page content.
 *
 * Adding a field here is only correct if the LIST actually shows it — anything page-shaped defeats
 * the point of the store.
 */
export interface WhiteboardSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** The DOCUMENT-level cover thumbnail (not a per-page one). */
  thumbnail: string;
  /** `pages.length` of the document this summarizes — the list shows the count, never the pages. */
  pageCount: number;
  /** Mirrors {@link WhiteboardDocument.teacherId}; absent means "untagged / belongs to everyone". */
  teacherId?: string;
  teacherType?: WhiteboardTeacherType;
  teacherName?: string;
}

export interface WhiteboardPdfAsset {
  id: string;
  blob: Blob;
  createdAt: number;
  fileName: string;
  fingerprint: string;
  mimeType: string;
  pageCount: number;
  size: number;
}

export interface StrokeSettings {
  /** Primary / active drawing color. */
  color: string;
  /**
   * Secondary drawing color slot. The pen COLOR barrel button toggles
   * `color` <-> `secondaryColor`. Default: '#2563EB' (blue).
   */
  secondaryColor: string;
  width: number;
  opacity: number;
  /**
   * Straight-line mode of the pen family. `free` (default / absent) = freehand; `hold` = a pause of
   * ~0.5 s snaps the stroke to a line start→pen that then follows the pen; `always` = every stroke is
   * a line start→end.
   */
  lineShape?: LineShape;
  /** Pen-family strokes are drawn dashed (the dash is scaled to the stroke width and saved with it). */
  dashed?: boolean;
}

export type LineShape = 'free' | 'hold' | 'always';

export interface WhiteboardState {
  pages: WhiteboardPage[];
  currentPageIndex: number;
  activeTool: WhiteboardTool;
  strokeSettings: StrokeSettings;
  fillColor: string;
  zoom: number;
}

export interface HistoryEntry {
  pageId: string;
  canvasJSON: string;
}

export interface WhiteboardStorage {
  ready: () => Promise<void>;
  close: () => void;
  /**
   * Persist a whole document. Page CONTENT is stored per page, so the cost of a save is the number
   * of pages actually written, not the size of the board.
   *
   * `changedPageIds` is how a caller says which pages it touched: every page NOT in the list is
   * taken to be already on disk unchanged, and is not rewritten. That is a promise the caller
   * makes — on a 109-page board it is the difference between a ~1.5 s main-thread stall and a few
   * milliseconds — but it is a promise the store double-checks: a page with no row on disk is
   * written even when it was not listed, so a missed id costs speed, never a page. Omit the option
   * (or pass nothing) to rewrite every page, which is always correct.
   *
   * An id in `changedPageIds` that is not in `doc.pages` is ignored, and a page that has been
   * removed from `doc.pages` has its row deleted, so a save is always a complete description of
   * the board.
   */
  saveWhiteboard: (doc: WhiteboardDocument, options?: { changedPageIds?: string[] }) => Promise<void>;
  /**
   * Persist ONE page without touching the document record — the write-behind path the editor's
   * autosave takes while the teacher writes. A real 109-page board is ~54 MB of page content, so a
   * full save for the single page a stroke touched used to cost a 54 MB structured clone every
   * couple of seconds and froze the pen; this writes one small row in its own tiny transaction,
   * which never takes the document store's write lock.
   *
   * A page save for a document that does not exist is dropped (there is nothing to attach it to).
   * The page is written whether or not the document's page ORDER knows about it yet, so a page
   * created mid-stroke is never lost; the next full {@link saveWhiteboard} records the order.
   */
  savePageSnapshot: (documentId: string, page: WhiteboardPage, updatedAt: number) => Promise<void>;
  loadWhiteboard: (id: string) => Promise<WhiteboardDocument | null>;
  listWhiteboards: () => Promise<WhiteboardDocument[]>;
  /**
   * The library list read: {@link WhiteboardSummary} rows straight out of the summaries store, with
   * NO page content deserialized. Prefer this over {@link listWhiteboards} anywhere only the list
   * fields are needed. Self-heals drift (rows written by a build that predates the store, documents
   * deleted behind its back) before returning, so it is always consistent with the document store.
   */
  listWhiteboardSummaries: () => Promise<WhiteboardSummary[]>;
  deleteWhiteboard: (id: string) => Promise<void>;
  /**
   * Tier-2 re-key: atomically move a board record from `oldId` (local UUID) to `newId` (server
   * `_id`) after a successful claim — migrating the document row plus its sync-cursor + outbox
   * entries, WITHOUT touching shared pdfAssets (asset-id keyed) or outbox payloads (entry-id keyed).
   * No-op if `oldId` is absent; if `newId` already exists it just drops the stale `oldId` row.
   */
  rekeyWhiteboard: (oldId: string, newId: string) => Promise<void>;
  savePdfAsset: (asset: WhiteboardPdfAsset) => Promise<void>;
  loadPdfAsset: (id: string) => Promise<WhiteboardPdfAsset | null>;
  deletePdfAsset: (id: string) => Promise<void>;
}

export const WHITEBOARD_SCHEMA_VERSION = 2;

export const DEFAULT_COLORS = [
  '#000000',
  '#FFFFFF',
  '#EF4444',
  '#F97316',
  '#EAB308',
  '#22C55E',
  '#3B82F6',
  '#8B5CF6',
  '#EC4899',
  '#6B7280',
] as const;

export const STROKE_WIDTHS = [2, 4, 6, 8, 12, 16] as const;
export const MIN_STROKE_WIDTH = 1;
export const MAX_STROKE_WIDTH = 64;

export const STICKY_COLORS = ['#FEF3C7', '#DBEAFE', '#D1FAE5', '#FCE7F3', '#EDE9FE', '#FED7AA'] as const;

export const HIGHLIGHTER_COLORS = [
  'rgba(255, 235, 59, 0.4)',
  'rgba(76, 175, 80, 0.4)',
  'rgba(33, 150, 243, 0.4)',
  'rgba(244, 67, 54, 0.4)',
  'rgba(255, 152, 0, 0.4)',
] as const;
