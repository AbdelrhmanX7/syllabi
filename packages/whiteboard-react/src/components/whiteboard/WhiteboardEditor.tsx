import React, { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import type { Canvas, FabricObject } from 'fabric';
import { DARK_BOARD_BASE_COLOR, LIGHT_BOARD_BASE_COLOR } from './utils/darkBoard';
import { FabricImage, Group, Point } from 'fabric';
import { Button, Slider, Tooltip } from '@repo/ui';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Pin,
  Plus,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import {
  appendWhiteboardPages,
  createBlankWhiteboardPage,
  createWhiteboardId,
  decodeImagePageBackground,
  DEFAULT_TABLET_INPUT_SETTINGS,
  formatPdfPageRange,
  imageMimeTypeForFileName,
  createInsertedSheet,
  insertWhiteboardPageAt,
  isInsertedSheet,
  isLikelyMongoObjectId,
  normalizePaperSpacingMm,
  pageHasInk,
  resolvePageLabels,
  resolveSheetInsertIndex,
  MAX_STROKE_WIDTH,
  MIN_STROKE_WIDTH,
  reorderWhiteboardPages,
  routeImportSelection,
  suggestNextPdfPageRange,
  WHITEBOARD_SCHEMA_VERSION,
} from '@repo/whiteboard-core';

import { WbLocaleProvider, useWbStrings } from '../../i18n/context';
import { wbT, type WbLocale, type WbStringKey } from '../../i18n/strings';
import { WhiteboardCanvas } from './WhiteboardCanvas';
import { BoardAiLayer } from './ai/BoardAiLayer';
import { InkAutoColorLayer } from './autoColor/InkAutoColorLayer';
import { ImageCropOverlay } from './ImageCropOverlay';
import { PasteChip, SelectionActionBar } from './SelectionActionBar';
import { installModernSelectionChrome, SELECTION_MARQUEE } from './utils/selectionChrome';
import { rasterizeSelection, selectionSceneBounds } from './utils/selectionActions';
import { boardRuleGrid, sheetRuleGrid } from './utils/straightenInk';
import { selectedInkStrokes, straightenSelection } from './utils/straightenInkCanvas';
import { createSnappedShapeObject } from './brushes/shapeSnap';
import { defaultRadicalParams } from './utils/radicalSign';
import { radicalShape } from './utils/shapeRecognition';
import { excludeTransientPages } from './ai/remakeDraft';
import { WhiteboardErrorBoundary } from './WhiteboardErrorBoundary';
import FocusModeDock from './FocusModeDock';
import BlankPageMenu from './BlankPageMenu';
import PageManager from './PageManager';
import ToolbarPageGroup, { PAGE_GROUP_BUTTON_CLASS } from './ToolbarPageGroup';
import { TOOLBAR_SURFACE } from './toolbarSurfaces';
import PdfUploadModal from './PdfUploadModal';
import QuickGestureMenu, { QUICK_GESTURE_COLORS } from './QuickGestureMenu';
import QuickPenTrigger from './QuickPenTrigger';
import { useQuickPenAnchor } from './hooks/useQuickPenAnchor';
import { useChromeInset } from './utils/chromeInsets';
import { chromeHideStyle } from './ai/generatingState';
import { insertHandConceptMap, readPageBackdrop } from './ai/handConceptMapInsert';
import { HandMapControls } from './ai/HandMapControls';
import Toolbar from './Toolbar';
import { usePageIntroPlayback } from './hooks/usePageIntroPlayback';
import { usePdfPageImage } from './hooks/usePdfPageImage';
import { usePendingPdfImport } from './hooks/usePendingPdfImport';
import { useSelectionActions } from './hooks/useSelectionActions';
import { DOCUMENT_HISTORY_SCOPE, useWhiteboardHistory } from './hooks/useWhiteboardHistory';
import { useWhiteboardStorage } from './hooks/useWhiteboardStorage';
import { startAutoSaveScheduler } from './utils/autoSaveScheduler';
import {
  BOARD_PEN_SAVE_DEBOUNCE_MS,
  isBoardPenTool,
  nextBoardPenMemory,
  readBoardPenRaw,
  resolveInitialBoardPen,
  writeBoardPenMemory,
  type BoardPenTool,
} from './utils/boardPenMemory';
import {
  dedupeColors,
  pushRecentColor,
  readRecentColors,
  RECENT_COLOR_RECORD_DEBOUNCE_MS,
  writeRecentColors,
} from './utils/recentColors';
import {
  drawBackgroundPattern,
  drawOverlayImage,
  drawScreenFitImage,
  getRotatedScreenFitPlacement,
  getScreenFitPlacement,
  normalizeRotationDeg,
} from './utils/backgroundLayers';
import { scheduleQuietIdleWork, type QuietIdleHandle } from './utils/idleWork';
import { cropResult, isSameCrop } from './utils/imageCrop';
import { invalidateInkBake } from './utils/inkBake';
import { perfMark, perfSpan } from './utils/perfSpan';
import { serializeCanvasJson } from './utils/canvasJson';
import { PdfScrollSession } from './utils/pdfScrollSession';
import {
  clampViewportTransform,
  constraintsForPageRect,
  isSameViewportTransform,
  refitViewportToConstraints,
  relaxConstraints,
  type SceneRect,
  type ViewportConstraints,
  type ViewportTransform6,
} from './utils/viewportConstraints';
import {
  fitNotebookViewport,
  captureNotebookView,
  notebookViewBottom,
  notebookViewStorageKey,
  parseNotebookView,
  refitNotebookViewport,
  resolveNotebookFrameWidth,
  resolveNotebookLayout,
  restoreNotebookViewport,
  shouldGrowNotebookPage,
  type NotebookView,
  unionInkBounds,
} from './utils/notebookPage';
import { isPointerDown, millisecondsSinceLastInput, waitForInputIdle } from './utils/inputActivity';
import { pageInkKey, renderPageImage, renderPageThumbnail } from './utils/pageThumbnail';
import { publishBoardTelemetryContext, setBoardObjectCounter, trackBoardGestures } from './utils/boardTelemetry';
import {
  applyImageLockState,
  drawLockedImages,
  enforceLockedImageInvariants,
  getLockedImages,
  isLockedImage,
  notifyLockedImagesChanged,
  onLockedImagesChanged,
} from './utils/lockedImages';
import { buildMergeManifestEntry, paintOverlayPattern, type PageOverlaySnapshot } from './utils/pageRender';
import {
  getRenderDeviceMemoryGb,
  forgetCachedPdfAsset,
  loadCachedPdfAsset,
  prefetchPdfAssetPageImage,
  renderPdfAssetPageImageUrl,
  warmPdfRuntime,
} from './utils/pdfAssetRenderer';
import { loadPdfPageImage } from './utils/pdfPageImageLoader';
import PerfOverlay from './PerfOverlay';
import { TouchDebugOverlay } from './TouchDebugOverlay';
import { buildPdfFromJpegPages } from './utils/pdfExport';
import { recordPerf } from './utils/perfHud';
import { resolvePdfExportRenderEdge, resolvePdfLiveRenderEdge } from './utils/pdfRenderSizing';
import {
  captureSnapshotState,
  getPageFrameScale,
  resolvePageExportFrame,
  resolveResetViewport,
  resolveSnapshotGeometry,
  toScreenViewport,
  type PdfBackgroundFrame,
} from './utils/snapshotGeometry';

import type {
  CapturedContact,
  BackgroundType,
  EraserMode,
  GeometryStencilKind,
  MergePageManifestEntry,
  LineShape,
  StrokeSettings,
  TabletInputSettings,
  ToolbarDock,
  WhiteboardDocument,
  WhiteboardPage,
  WhiteboardTool,
} from './types';
import { DEFAULT_COLORS, isPenFamilyTool, normalizeCanvasWidthPx } from './types';
import type { EditorViewport, RulerEdgesRef } from './brushes/rulerSnap';
import type { PageTransitionHandle } from './WhiteboardCanvas';
import { boardPatternSpacingPx, resolveDefaultPaperSpacingMm } from './utils/paperSpacing';
import { findPdfScrollPageAt, pdfScrollRegionPaintArgs, resolvePdfPageAspect } from './utils/pdfScrollLayout';
import type { PageListEntry } from './utils/boardHistory';
import { applyItemOpsToCanvasJson, applyItemOpsToState } from './utils/itemIds';
import type { RemoteItemOps } from './utils/itemIds';
import type { PdfScrollPainter } from './utils/pdfScrollLayout';
import type { PdfImportNativeRescue, PdfImportResult, ResolveRemotePdfAsset } from './utils/pdfAssetRenderer';
import type { PeekPageIntro, ResolvePageIntro } from './utils/pageIntroPolicy';
import type { UsePdfPageImageNativeCapability } from './hooks/usePdfPageImage';
import type { BoardAiEditorBridge, BoardAiRenderRequest } from './ai/BoardAiLayer';
import type { WhiteboardSelectionAction } from './SelectionActionBar';
import type { SelectionChrome } from './utils/selectionChrome';
import type { RemakeGeneratingInfo } from './ai/generatingState';
import type { BoardAiCommand } from './ai/commands';
import type { BoardAiService, ConceptMap } from './ai/types';
import type { AutoColorConfig } from './autoColor/model';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Optional host-provided native (Rust/PDFium) PDF rendering capability. When
 * supplied and available in the current runtime, PDF pages are rendered natively
 * (inside the Tauri desktop shell) with an automatic fallback to the bundled
 * pdf.js renderer on any failure. The package never imports the implementation;
 * the host app provides it.
 */
export type WhiteboardNativePdfCapability = UsePdfPageImageNativeCapability;

/**
 * Optional host-provided bridge for saving exports to the real local filesystem (e.g. a native
 * "Save As" dialog inside the Tauri desktop shell). When absent, the editor falls back to a plain
 * browser anchor download. Implementations live in the host app; the package never imports them.
 */
export interface WhiteboardFileBridge {
  /** Persist binary data (an exported PDF). Returns when the save resolves or is cancelled. */
  saveBinary(opts: {
    suggestedName: string;
    data: Uint8Array;
    mimeType?: string;
    description?: string;
  }): Promise<unknown>;
  /** Persist text data (an exported .kawb.json document). */
  saveText(opts: { suggestedName: string; text: string; mimeType?: string; description?: string }): Promise<unknown>;
}

/**
 * A converted source file left the import flow WITHOUT being imported — the teacher cancelled,
 * picked another file, or the import UI went away. Converting a PowerPoint writes a whole PDF to
 * disk, so this is the host's cue to delete that staged copy. A plain PDF pick is the teacher's own
 * file and is never reported. Fires exactly once per staged file.
 */
export interface WhiteboardPdfImportDiscardedEvent {
  /** The file the teacher picked, whose conversion is the copy the host should discard. */
  sourceFile: File;
}

/** What an import created, reported to the host once the pages are on the board. */
export interface WhiteboardPdfImportedEvent {
  /** The pages the import created, in board (slide) order. */
  pageIds: string[];
  /** Total pages in the SOURCE document — larger than `pageIds.length` for a page-range import. */
  pdfPageCount: number;
  /** The file the teacher picked: the `.pptx` when one was converted, else the PDF itself. */
  sourceFile: File;
}

/** See {@link WhiteboardEditorProps.liveBoardRef}. */
export interface WhiteboardLiveHandle {
  /** The board as it is right now (the page being written on serialized). */
  getDocument: () => WhiteboardDocument;
  /** Put someone else's item changes in, per page. Resolves false when it could not (reload instead). */
  applyRemoteItems: (ops: RemoteItemOps[]) => Promise<boolean>;
}

export interface WhiteboardEditorProps {
  /**
   * Kept for host compatibility; the board chrome is English-only, so every value renders the same.
   */
  locale?: WbLocale;
  /** Sink for finished touch contacts (training capture). Absent = nothing is recorded, which is the
   *  default everywhere except the app's board page. */
  onContactCaptured?: (contact: CapturedContact) => void;
  /**
   * An undo just took effect (from any of the three ways to reach it — keyboard, toolbar, focus dock).
   *
   * Fires only when something was actually undone. Paired with {@link onContactCaptured}: the capture
   * uses it to retro-mark the contacts the teacher was rejecting, which is the one wrong-label signal
   * that cannot be collected while the stroke is still happening.
   */
  onUndoPerformed?: () => void;
  /**
   * The «Record pen strokes for training» switch settled on a value.
   *
   * Fires once on mount with the stored value, then on every flip. The editor owns the switch but
   * not the queue behind it: the host's uploader has to be armed the moment a teacher turns capture
   * on MID-LESSON, and nothing else tells it that happened — the setting is written to local storage
   * from inside this component, which fires no storage event in its own window.
   */
  onPenCaptureEnabledChange?: (enabled: boolean) => void;
  /**
   * Capture is not the teacher's to switch off on this device.
   *
   * Set by the app when the board is running under a TEACHER account (owner ask 2026-09-20): the
   * «Record pen strokes for training» row is not rendered at all, and every settings value that reaches
   * state — the first read from storage and every later change from the popover — carries
   * `penCaptureEnabled: true`. Forcing it through STATE rather than at the sink is what makes the
   * lock hold end to end: the editor persists the settings blob, so the stored value agrees, and
   * {@link WhiteboardEditorProps.onPenCaptureEnabledChange} fires `true` and arms the host's
   * uploader exactly as a real flip would.
   */
  penCaptureLocked?: boolean;
  /**
   * Convert a picked PowerPoint file into a PDF `File` (native desktop shell only; the app
   * side drives PowerPoint COM / LibreOffice through Rust). Enables .pptx/.ppt in the PDF
   * upload modal — when absent, the modal stays PDF-only.
   */
  convertOfficeFile?: (file: File) => Promise<File | null>;
  isPublishingVersion?: boolean;
  onDocumentTitleChange?: (title: string) => void;
  onPersistPdfAsset?: (
    input: WhiteboardPersistPdfAssetInput,
  ) => Promise<WhiteboardPersistPdfAssetResult> | WhiteboardPersistPdfAssetResult;
  /**
   * Re-upload a source PDF whose bytes are cached locally but whose background upload never reached
   * the server (the teacher imported then closed the app, or was offline). Called by the board-open
   * self-heal for each page still pointing at a LOCAL (non-ObjectId) asset id. Returns the server
   * asset id (the editor then re-keys the pages to it), or null if it could not upload.
   */
  onReuploadPdfAsset?: (input: WhiteboardReuploadPdfAssetInput) => Promise<string | null>;
  /**
   * A PDF the HOST wants imported into the board currently open — e.g. a file that arrived over the
   * LAN and the teacher chose to add here rather than open as a new board.
   *
   * Opens the normal import modal preloaded with the file, so the pages are APPENDED to this board
   * exactly like a hand-picked import (`appendWhiteboardPages`), page-range picker included.
   * Clearing it is the host's job — see {@link onPendingPdfImportHandled}.
   */
  pendingPdfImport?: File | null;
  /** Fired once the pending import has been opened, so the host can drop its reference and not
   *  re-open the modal on every subsequent render. */
  onPendingPdfImportHandled?: () => void;
  /**
   * An IMAGE the HOST wants placed on the board currently open — e.g. a photo that arrived over the
   * LAN and the teacher chose to add here rather than open as a new board.
   *
   * Inserted on the current page as a normal selectable object, identical to the toolbar's «Insert
   * image», so the teacher can move, scale and pin it. Clearing it is the host's job — see
   * {@link onPendingImageImportHandled}.
   */
  pendingImageImport?: File | null;
  /** Fired after any picture FILE lands on the board (toolbar picker or host-supplied), with that file. */
  onImagePlaced?: (file: File) => void;
  /** Fired once the pending image has been inserted, so the host can drop its reference. */
  onPendingImageImportHandled?: () => void;
  /**
   * A ready CONCEPT MAP the host wants DRAWN on the current page (e.g. Study's AI reference map) — in
   * hand-drawn ink, not typed: node text written by the handwriting pipeline in the owner's hand,
   * hand ellipses, bowed arrows, linking phrases (ai/handConceptMap). Waits for the page to finish
   * loading, lands below what is already there, one undo step, objects tagged `wbAi`. Pass the
   * backend graph through `parseConceptMap`. Clearing it is the host's job — see
   * {@link onPendingConceptMapHandled}.
   */
  pendingConceptMap?: ConceptMap | null;
  /** Fired once the pending map was drawn (`true`) or could not be (`false`); the host drops its reference. */
  onPendingConceptMapHandled?: (drawn: boolean) => void;
  /**
   * IMAGES the HOST wants added to the board currently open as PAGES — one page per photo, in the
   * given order, the image as each page's background.
   *
   * The image twin of {@link pendingPdfImport}: pages are APPENDED (`appendWhiteboardPages`) and the
   * first new page becomes current, exactly as a PDF import does, so a photographed worksheet
   * behaves like a scanned one. Distinct from {@link pendingImageImport}, which places ONE photo on
   * the current page as a movable object — that is «Add to current board», a different intent.
   * Clearing it is the host's job — see {@link onPendingImagePagesImportHandled}.
   */
  pendingImagePagesImport?: File[] | null;
  /** Fired once the pending images have been taken, so the host can drop its reference. */
  onPendingImagePagesImportHandled?: () => void;
  onPublishVersion?: (payload: WhiteboardPublishPayload) => Promise<void> | void;
  whiteboardId?: string;
  onBack?: () => Promise<unknown> | void;
  /**
   * When true, collapse the on-canvas window-style chrome (back / fullscreen / refresh title bar) to
   * a distraction-free writing surface — e.g. while the teacher is recording. The drawing Toolbar and
   * page navigation are NEVER hidden by this. Default (undefined/false) = current behavior.
   */
  hideChrome?: boolean;
  /**
   * View-only: the board pans and zooms (the PDF still scrolls) but nothing can be drawn — the canvas
   * runs the pan tool and the drawing toolbar and board AI are not rendered. The host flips it to let
   * the teacher annotate. Default false.
   */
  readOnly?: boolean;
  /**
   * The board is a pane inside a host screen (e.g. notes beside a concept map), not the whole window:
   * the right-edge zoom lock, the draggable quick-pen trigger and the page-manager panel are left out
   * (they stack on top of each other in a narrow pane), and with `readOnly` the page pager too.
   */
  embedded?: boolean;
  /**
   * The board AI is making a «Similar copy» draft page on screen: every piece of board chrome steps aside
   * (the editor's own already does). A host hides its own overlay chrome (record/bell/QR cluster) while
   * this is true; it comes back the moment generation ends or the teacher leaves the page.
   */
  onAiGeneratingChromeChange?: (hidden: boolean) => void;
  /**
   * An import finished and its pages are on the board.
   *
   * Reported rather than inferred: only the editor knows which pages an import created and in what
   * order. `sourceFile` is what the TEACHER picked — a `.pptx` when the desktop shell converted one,
   * which matters because the deck's animations exist only in that original file. `pdfPageCount` is
   * the SOURCE document's total page count, so a host can tell a whole-file import from a page-range
   * one (`pageIds.length < pdfPageCount`) without re-deriving anything.
   */
  onPdfImported?: (event: WhiteboardPdfImportedEvent) => void;
  /**
   * A converted deck is being thrown away unimported — see {@link WhiteboardPdfImportDiscardedEvent}.
   * Without this the conversion's output (a 73 MB PDF for a large deck) sits on disk until the
   * shell's next restart-plus-a-day cleanup.
   */
  onPdfImportDiscarded?: (event: WhiteboardPdfImportDiscardedEvent) => void;
  /**
   * Slide intros. Resolves the short clip rendered from a page's source slide (its PowerPoint
   * entrance animation / Morph transition), or null when that page has none.
   *
   * Called on every page ENTER. A non-null result plays ONCE, in the page-background layer under the
   * ink, and then the static page raster takes over. Purely presentational: nothing about an intro
   * enters the document model, the snapshot, or sync.
   */
  resolvePageIntro?: ResolvePageIntro;
  /**
   * SYNCHRONOUS companion to {@link resolvePageIntro}: does this page have a clip or a transition?
   *
   * Entering a page that has a transition means holding the page being left on screen while the new
   * one loads, and that has to be decided BEFORE the load starts — the resolver could not answer in
   * time. Without this lookup every forward step on every board would pay for that hold, including
   * a plain PDF board that has no intros at all. Absent = no page is ever held.
   */
  peekPageIntro?: PeekPageIntro;
  /**
   * Bump when the set of available intros changed — typically when the native renderer finishes a
   * clip for a page that is ALREADY open (an import lands on page 1 while page 1's clip is still
   * rendering). Re-resolves for the current page and plays it if this visit has not played one yet.
   */
  pageIntroVersion?: number;
  pdfWorkerSrc?: string;
  /**
   * How an imported PDF is shown. `'paged'` (the default) is the existing one-page-at-a-time board,
   * byte-for-byte unchanged. `'scroll'` stacks every page of the document in ONE vertical scrollable
   * column (pages near the viewport are hydrated, the rest live as JSON). Ignored for a board with no
   * PDF pages. See utils/pdfScrollSession.
   */
  pdfLayout?: 'paged' | 'scroll';
  /** A toolbar button to flip {@link pdfLayout} appears only when this is true. */
  allowPdfLayoutToggle?: boolean;
  /** Notified whenever the effective layout changes (initial, toggle, persisted preference restored). */
  onPdfLayoutChange?: (layout: 'paged' | 'scroll') => void;
  /**
   * The PDF always fills the viewport width: zoom cannot drop below fit-width and panning is clamped
   * to the page edges (in scroll mode, to the stacked column). The blurred overscan backdrop never
   * shows. Default false = the free board. Implied by `pdfLayout = 'scroll'`.
   */
  lockZoomToPage?: boolean;
  /**
   * A page with no PDF behind it becomes a fixed-width notebook sheet that scrolls down (utils/
   * notebookPage): as wide as the pane at zoom 1 (capped, centred with margins on a very wide pane),
   * frozen per page so a second device shows the same sheet scaled, zoom-out capped at fit-width,
   * horizontal pan clamped to the sheet. Finger pans everywhere (PDF scroll layout included) lock to
   * the axis they start along. Pen input is never affected. Default false = the free board.
   */
  verticalNotebook?: boolean;
  /** Notebook sheet at its fit zoom spans the whole pane width (no 1150 px cap / side margins). Default false. */
  notebookFillScreen?: boolean;
  /**
   * Free zoom: every viewport cage (notebook sheet, PDF scroll, paged zoom-lock) drops its zoom floor
   * to FREE_ZOOM_MIN and its pan limits, so a long board can be crossed fast. Turning it off glides the
   * view back inside the cage. Default false.
   */
  freeZoom?: boolean;
  /** The page's paper (grid / lines / dots) also shows over PDF pages. Default false. */
  paperOverPdf?: boolean;
  /**
   * 'dark' = a dark board: dark paper, ink painted on the light side of its hue. A view setting only —
   * stored colours and every export stay as on paper (utils/darkBoard). Default 'light'.
   */
  boardTheme?: 'light' | 'dark';
  /** The select arrow sits in the toolbar's collapsed row (see Toolbar `compactSelectTool`). Default false. */
  compactSelectTool?: boolean;
  /**
   * What a drag from empty canvas with the select tool draws: a freehand `lasso` (default) or a
   * dashed `box` that selects every object whose ink it touches (partial strokes included).
   */
  selectionShape?: 'lasso' | 'box';
  /**
   * How a selection looks: `classic` (default — Fabric's frame and the icon-row bar) or `modern`
   * (accent frame with round 44px-target handles, corners only, accent marquee, and the labeled
   * selection bar placed clear of the frame). See utils/selectionChrome.
   */
  selectionChrome?: SelectionChrome;
  /** Undo / Redo sit in the toolbar's collapsed row (see Toolbar `compactUndoRedo`). Default false. */
  compactUndoRedo?: boolean;
  /**
   * `'full-scroll'`: a top/bottom-docked toolbar becomes one row across the board's full width — on
   * the top dock its own row under the title bar and host chrome instead of squeezed into the gap
   * between them — holding every tool and scrolling sideways when they do not fit (see Toolbar
   * `layout`). Default `'wrap'`: the centred, wrapping pill.
   *
   * The page controls (prev / page / next / add / page list) move INTO the row as one group pinned at
   * its end, replacing the floating pager, add-page button and page-list toggle. Docked at the bottom,
   * the row is a flat bar flush with the screen edge, laid out under the canvas (not over it).
   */
  toolbarLayout?: 'wrap' | 'full-scroll';
  /** The dock a board opens with until the user picks one (the pick is remembered). Default `'top'`. */
  defaultToolbarDock?: ToolbarDock;
  /**
   * Open every board on this nib, whatever nib it was last left on. The board's remembered colours
   * and width still apply. Default unset: reopen on the board's last pen (see utils/boardPenMemory).
   */
  initialPenTool?: BoardPenTool;
  /** The eraser mode a board opens with: `'partial'` rubs out part of a stroke, `'object'` deletes whole objects. Default `'partial'`. */
  defaultEraserMode?: EraserMode;
  /** Hide the floating pen-shortcuts button. The S Pen side button still opens the menu. Default false. */
  hideQuickPenTrigger?: boolean;
  /**
   * Focus mode (only the canvas + the small focus dock) controlled by the host, e.g. a host button that
   * also hides the host's own overlays. Unset: the editor keeps it to itself (toolbar «Focus mode»).
   */
  focusMode?: boolean;
  /** Focus mode was entered or left from inside the editor (toolbar button / the dock's exit). */
  onFocusModeChange?: (focused: boolean) => void;
  /**
   * The pager's add button becomes a «blank page» menu while the continuous PDF layout is on: insert
   * an empty writing sheet (sized like the PDF page in view, on {@link blankPagePaper}) after the page
   * in view or at the end, and delete an inserted sheet. PDF pages keep their own numbers; sheets are
   * labelled «3a». A sheet is a plain page in the document (see core inserted-sheets). Default false:
   * the pager is unchanged.
   */
  allowInsertBlankPages?: boolean;
  /** Paper of an inserted sheet. Default 'lined'. */
  blankPagePaper?: BackgroundType;
  /**
   * Offer a paper SPACING control (lined/grid/dotted presets + a mm slider) in the background
   * popover. Stored per page as `paperSpacingMm` (board-wide, like the paper type); a page without it
   * keeps the original spacing, so boards never touched by this control draw exactly as before.
   * Default false: the whiteboard app is unchanged.
   */
  allowPaperSpacing?: boolean;
  /**
   * Spacing (mm) a NEW page or inserted sheet starts with, per paper type (the host's note setting;
   * 'dotted' falls back to 'grid'). A type without an entry = the original spacing.
   */
  defaultPaperSpacingMm?: Partial<Record<BackgroundType, number>>;
  resolveRemotePdfAsset?: ResolveRemotePdfAsset;
  fileBridge?: WhiteboardFileBridge;
  nativePdf?: WhiteboardNativePdfCapability;
  /**
   * Native (PDFium) renderer for IMPORT time — the tier-2 fallback for a page pdf.js cannot
   * rasterize, so a malformed page still lands on the board as a real page instead of a placeholder.
   * Separate from {@link nativePdf} on purpose: that one serves the live board from an asset already
   * saved, this one renders out of the file being imported. Desktop-shell only; omitted on web.
   */
  nativePdfRescue?: PdfImportNativeRescue;
  /**
   * Board AI transport (lasso → ask, generate, page check, concept maps). Host-supplied like
   * `fileBridge`; absent = no AI buttons at all. See `ai/types.ts` for the contract.
   */
  boardAi?: BoardAiService;
  /**
   * «Map my terms» on the selection bar (opt-in): the selected handwritten terms become a concept map
   * drawn in the owner's own ink. Needs a `boardAi` with `mapTerms`; absent/false = no button.
   */
  termsMap?: boolean;
  /**
   * «Straighten» on the selection bar (opt-in): the selected handwriting is levelled and set on the
   * paper's rule, Samsung-Notes style (`utils/straightenInk`). Offered for a selection of two or more
   * ink strokes; one undo step. Default false: the whiteboard app is unchanged.
   */
  straightenInk?: boolean;
  /**
   * «Auto colour» (opt-in): fresh handwriting in the default ink is recoloured by what it says (heading,
   * term, formula, example, key point) — `autoColor/`. The host supplies the recognizer (ML Kit on
   * Android) and the palette; absent/null = off.
   */
  autoColor?: AutoColorConfig | null;
  /**
   * Host buttons on the selection bar (after colour / copy / cut / duplicate / delete / Ask AI). Each
   * gets the selection rendered on white the moment it is pressed. Absent = the built-in bar only.
   */
  extraSelectionActions?: readonly WhiteboardSelectionAction[];
  /**
   * Populated by the editor with an AWAITABLE flush of the current document (the
   * same path autosave/back use, with a thumbnail). The host wires this into the
   * desktop shell's flush-before-close handshake so the latest edits reach disk
   * before the window is destroyed (a plain `beforeunload` can't await on Tauri).
   */
  flushBeforeCloseRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  /**
   * Live co-editing (a notebook page several people edit at once): populated by the editor with the
   * board as it is right now and a way to put someone else's item changes onto it without a reload.
   */
  liveBoardRef?: React.MutableRefObject<WhiteboardLiveHandle | null>;
  /** The user changed the board (a stroke, erase, move, undo …) — fires at the end of the gesture. */
  onBoardChange?: () => void;
  /**
   * Populated by the editor with a full-page renderer: a page's paper + ink over its PDF/image
   * background, as a webp whose LONG edge is `longEdge` px (`utils/pageThumbnail`). Offscreen — the
   * live canvas is never touched — and it keeps working after the editor unmounts (it reads only the
   * page and storage), so a host may finish uploading page images after the board closed.
   */
  /**
   * The host's on-screen ruler: it fills this with a function returning the ruler's long edges in client
   * px. A pen stroke drawn along one of them commits as a straight line on it (`brushes/rulerSnap.ts`).
   */
  rulerEdgesRef?: RulerEdgesRef;
  /** Fires with the canvas viewport zoom on mount and after every change (gesture settle, toolbar, fit). */
  onViewportZoomChange?: (zoom: number) => void;
  /**
   * The host reads the live viewport transform through this getter (zoom + pan, the canvas origin on screen,
   * the page shown); `onViewportChange` pings whenever any of them moves.
   */
  viewportRef?: React.MutableRefObject<(() => EditorViewport | null) | null>;
  onViewportChange?: () => void;
  renderPageImageRef?: React.MutableRefObject<((page: WhiteboardPage, longEdge: number) => Promise<Blob>) | null>;
  /**
   * Populated by the editor with a guarded ALL-PAGES sweep that produces the server-merge inputs:
   * for every page in order, a transparent overlay PNG (everything EXCEPT the source PDF) + the
   * per-page geometry manifest entry (MINUS `overlayKey`, filled in by the host after upload). The
   * host (board page) wires this into its "generate merged PDF" flow: upload each overlay, attach
   * the `overlayKey`, then call the backend `generateVersion`. Resolves `null` if the editor canvas
   * is not ready or a page-switch superseded the sweep (page-bleed invariant).
   */
  buildMergeOverlaysRef?: React.MutableRefObject<(() => Promise<MergeOverlaysResult | null>) | null>;
}

/**
 * Output of the editor's server-merge overlay sweep (see `buildMergeOverlaysRef`). One element per
 * whiteboard page, in document order. `overlayDataUrl` is the transparent overlay PNG data URL;
 * `entry` is the merge manifest entry MINUS `overlayKey` (the host fills `overlayKey` after it PUTs
 * the PNG to its presigned destination).
 */
export interface MergeOverlaysResult {
  pages: Array<{
    overlayDataUrl: string;
    entry: Omit<MergePageManifestEntry, 'overlayKey'>;
  }>;
}

export interface WhiteboardPublishPayload {
  document: WhiteboardDocument;
  pageCount: number;
  pdfBlob: Blob;
  pdfFileSize: number;
  thumbnailDataUrl?: string;
}

export interface WhiteboardPersistPdfAssetInput {
  existingAssetId?: string | null;
  result: PdfImportResult;
}

export interface WhiteboardPersistPdfAssetResult {
  assetId: string;
}

export interface WhiteboardReuploadPdfAssetInput {
  /** The LOCAL asset id the page still references (its bytes are cached under this id). */
  assetId: string;
  blob: Blob;
  fileName: string;
  mimeType: string;
  pageCount: number;
}

interface GeometryOverlayState {
  label: string;
  left: number;
  subtitle: string;
  top: number;
}

/** Floating «Pin image» button for the currently selected (not yet pinned) image. */
interface PinImageActionState {
  image: FabricObject;
  left: number;
  top: number;
}

/** One «Pinned» chip riding on a pinned image's top-left corner. */
interface LockedImageChipState {
  chipKey: string;
  image: FabricObject;
  left: number;
  top: number;
}

/**
 * Value-equality for the three selection overlays, so a re-computation that produced the SAME chip
 * is not a state change.
 *
 * These three setters run off fabric's `after:render`, i.e. once per rendered FRAME while anything
 * is selected — and `describeGeometryObject` / `describePinImageAction` / `describeLockedImageChip`
 * each allocate a fresh object, so `Object.is` always said "changed" and React re-rendered this
 * 4,600-line component (plus every HeroUI Tooltip and the whole toolbar) 60 times a second to move
 * a decorative chip that had not moved. Comparing by value collapses that to the frames where the
 * chip genuinely moved. `image` is compared by identity on purpose: it IS the fabric object.
 */
function isSameGeometryOverlay(a: GeometryOverlayState | null, b: GeometryOverlayState | null): boolean {
  if (a === b) {
    return true;
  }

  return !!a && !!b && a.label === b.label && a.subtitle === b.subtitle && a.left === b.left && a.top === b.top;
}

function isSamePinImageAction(a: PinImageActionState | null, b: PinImageActionState | null): boolean {
  if (a === b) {
    return true;
  }

  return !!a && !!b && a.image === b.image && a.left === b.left && a.top === b.top;
}

function isSameLockedImageChips(a: LockedImageChipState[], b: LockedImageChipState[]): boolean {
  if (a === b) {
    return true;
  }

  if (a.length !== b.length) {
    return false;
  }

  return a.every((chip, index) => {
    const other = b[index];

    return (
      !!other &&
      chip.chipKey === other.chipKey &&
      chip.image === other.image &&
      chip.left === other.left &&
      chip.top === other.top
    );
  });
}

interface ExistingPdfImportSummary {
  fileName: string;
  fingerprint: string;
  pageNumbers: number[];
}

interface LastPdfImportHint {
  fileName: string;
  fingerprint: string;
  importedRange: string;
  suggestedRange: string;
}

const IDENTITY_VIEWPORT: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
const TOOLBAR_DOCK_STORAGE_KEY = 'whiteboard-toolbar-dock';
/** Per-document sticky PDF layout preference (see `pdfLayout`). */
const PDF_LAYOUT_STORAGE_PREFIX = 'whiteboard-pdf-layout:';
const TABLET_INPUT_SETTINGS_STORAGE_KEY = 'whiteboard-tablet-input-settings';
const STROKE_SETTINGS_STORAGE_KEY = 'whiteboard-stroke-settings';
const DEFAULT_VIEWPORT_ZOOM = 1;
const PAGE_MANAGER_THUMBNAIL_HEIGHT = 80;
const PAGE_MANAGER_THUMBNAIL_WIDTH = 140;
const THUMBNAIL_IDLE_DELAY_MS = 700;
/**
 * The nib a quick colour/width pick lands on. Mid-eraser (or pan), it returns to the nib the teacher
 * last drew with — brush, marker or highlighter — not the plain default pen.
 */
function resolveQuickPenTool(currentTool: WhiteboardTool, lastPrimaryTool: WhiteboardTool): WhiteboardTool {
  if (isPenFamilyTool(currentTool)) return currentTool;

  return isPenFamilyTool(lastPrimaryTool) ? lastPrimaryTool : 'pen';
}

/** Page-manager thumbnails kept per editor; oldest evicted first. */
const PAGE_MANAGER_THUMBNAIL_CACHE_LIMIT = 120;
/** Longest edge the native renderer rasterizes for a strip thumbnail (2× the 140×80 tile, crisp on 2× DPR). */
const PAGE_MANAGER_THUMBNAIL_NATIVE_EDGE = 280;
/** Input must be quiet this long before a pdf.js (main-thread) thumbnail render may start. */
const PAGE_MANAGER_THUMBNAIL_QUIET_MS = 700;
const IDLE_SNAPSHOT_TIMEOUT_MS = 2000;
/** A writer who never pauses still gets a checkpoint at the next pen lift after this long. */
// Was 6 s: a teacher writing continuously hit the ceiling mid-word and the serialize of a 3.5 MB page
// landed under the pen. Twenty seconds bounds the unsaved-undo window without touching the ink;
// durability is the autosave scheduler's job, not this snapshot's.
const IDLE_SNAPSHOT_MAX_DEFER_MS = 20_000;
/** A full document write at least this often, so the summary row and currentPageIndex never lag far. */
const FULL_SAVE_EVERY_MS = 45_000;
const FIXED_HIGHLIGHTER_OPACITY = 0.22;
const GEOMETRY_SNAP_GRID_SIZE = 16;
const GEOMETRY_SNAP_CENTER_THRESHOLD = 12;
const GEOMETRY_ROTATION_SNAP_DEGREES = 15;
// Pin overlays reposition once the viewport comes to REST. A pinch fires after:render every frame and
// only commits the real viewportTransform on settle (the gesture itself is a CSS transform preview),
// so re-rendering the editor per frame would cost strokes to move a decorative chip.
const LOCKED_IMAGE_OVERLAY_SETTLE_MS = 160;
/** Shared empty array so the (overwhelmingly common) "nothing pinned" refresh allocates nothing. */
/** Title-bar chips: the host app's clay edge + lip (falls back to its light values outside Study). */
const CHROME_CHIP =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border-2 border-[rgb(var(--st-clay-edge,205_209_224))] bg-[rgb(var(--st-surface,255_255_255))] text-ink shadow-[0_4px_0_rgb(var(--st-clay-edge,205_209_224))] transition-[transform,box-shadow] duration-100 hover:bg-[rgb(var(--st-raised,241_238_228))] active:translate-y-[3px] active:shadow-none';

const EMPTY_LOCKED_IMAGE_CHIPS: LockedImageChipState[] = [];

function normalizeTabletInputSettings(value: Partial<TabletInputSettings> | null | undefined): TabletInputSettings {
  const penTiltOffset = value?.penTiltOffset;
  const penJitterFilter = value?.penJitterFilter;
  const touchPanZoomTolerance = value?.touchPanZoomTolerance;

  return {
    penTiltOffset:
      typeof penTiltOffset === 'number' && Number.isFinite(penTiltOffset)
        ? Math.min(8, Math.max(-8, penTiltOffset))
        : DEFAULT_TABLET_INPUT_SETTINGS.penTiltOffset,
    penJitterFilter:
      typeof penJitterFilter === 'number' && Number.isFinite(penJitterFilter)
        ? Math.min(15, Math.max(0, penJitterFilter))
        : DEFAULT_TABLET_INPUT_SETTINGS.penJitterFilter,
    touchPanZoomTolerance:
      typeof touchPanZoomTolerance === 'number' && Number.isFinite(touchPanZoomTolerance)
        ? Math.min(260, Math.max(40, touchPanZoomTolerance))
        : DEFAULT_TABLET_INPUT_SETTINGS.touchPanZoomTolerance,
    // Re-read + clamp the whole-hand (palm) eraser calibration so the teacher's persisted settings load
    // back. Clamp ceilings match the EraserSettings sliders (count 2–10, size 16–200, padding 0–60).
    wholeHandEraser: {
      enabled:
        typeof value?.wholeHandEraser?.enabled === 'boolean'
          ? value.wholeHandEraser.enabled
          : DEFAULT_TABLET_INPUT_SETTINGS.wholeHandEraser.enabled,
      contactCountThreshold:
        typeof value?.wholeHandEraser?.contactCountThreshold === 'number' &&
        Number.isFinite(value.wholeHandEraser.contactCountThreshold)
          ? Math.min(10, Math.max(2, Math.round(value.wholeHandEraser.contactCountThreshold)))
          : DEFAULT_TABLET_INPUT_SETTINGS.wholeHandEraser.contactCountThreshold,
      eraserSize:
        typeof value?.wholeHandEraser?.eraserSize === 'number' && Number.isFinite(value.wholeHandEraser.eraserSize)
          ? Math.min(200, Math.max(16, value.wholeHandEraser.eraserSize))
          : DEFAULT_TABLET_INPUT_SETTINGS.wholeHandEraser.eraserSize,
      fingerPadding:
        typeof value?.wholeHandEraser?.fingerPadding === 'number' &&
        Number.isFinite(value.wholeHandEraser.fingerPadding)
          ? Math.min(60, Math.max(0, value.wholeHandEraser.fingerPadding))
          : DEFAULT_TABLET_INPUT_SETTINGS.wholeHandEraser.fingerPadding,
      testEmulation:
        typeof value?.wholeHandEraser?.testEmulation === 'boolean'
          ? value.wholeHandEraser.testEmulation
          : DEFAULT_TABLET_INPUT_SETTINGS.wholeHandEraser.testEmulation,
    },
    dualTipStylus: (() => {
      // Clamp ceilings match the settings sliders (small ≤20, big ≤30) so a persisted value can always
      // be represented + lowered by the slider thumb. Reading these fields again is what restores the
      // teacher's calibration on a touch-only device (their thresholds were never wiped from localStorage).
      const small =
        typeof value?.dualTipStylus?.smallHeadMaxWidth === 'number' &&
        Number.isFinite(value.dualTipStylus.smallHeadMaxWidth)
          ? Math.min(20, Math.max(2, value.dualTipStylus.smallHeadMaxWidth))
          : DEFAULT_TABLET_INPUT_SETTINGS.dualTipStylus.smallHeadMaxWidth;
      const bigRaw =
        typeof value?.dualTipStylus?.bigHeadMaxWidth === 'number' &&
        Number.isFinite(value.dualTipStylus.bigHeadMaxWidth)
          ? Math.min(30, Math.max(3, value.dualTipStylus.bigHeadMaxWidth))
          : DEFAULT_TABLET_INPUT_SETTINGS.dualTipStylus.bigHeadMaxWidth;

      // The legacy rulebook's own bands, clamped by the same slider ranges. A blob written before the
      // rulebook switch existed simply has none, and falls back to the values legacy shipped with.
      const legacyDefaults = DEFAULT_TABLET_INPUT_SETTINGS.dualTipStylus.legacyBands;
      const legacyStored = value?.dualTipStylus?.legacyBands;
      const legacySmall =
        typeof legacyStored?.smallHeadMaxWidth === 'number' && Number.isFinite(legacyStored.smallHeadMaxWidth)
          ? Math.min(20, Math.max(2, legacyStored.smallHeadMaxWidth))
          : legacyDefaults.smallHeadMaxWidth;
      const legacyBigRaw =
        typeof legacyStored?.bigHeadMaxWidth === 'number' && Number.isFinite(legacyStored.bigHeadMaxWidth)
          ? Math.min(30, Math.max(3, legacyStored.bigHeadMaxWidth))
          : legacyDefaults.bigHeadMaxWidth;

      return {
        enabled:
          typeof value?.dualTipStylus?.enabled === 'boolean'
            ? value.dualTipStylus.enabled
            : DEFAULT_TABLET_INPUT_SETTINGS.dualTipStylus.enabled,
        smallHeadMaxWidth: small,
        // Keep the big-head ceiling strictly above the small-head one, else the big band vanishes.
        bigHeadMaxWidth: Math.max(small + 1, bigRaw),
        // Anything unrecognised means the height-aware rulebook: it is the fitted one, and a blob that
        // never mentioned a rulebook was written when it was the only one.
        classifier: value?.dualTipStylus?.classifier === 'legacy' ? 'legacy' : 'height-aware',
        legacyBands: {
          smallHeadMaxWidth: legacySmall,
          bigHeadMaxWidth: Math.max(legacySmall + 1, legacyBigRaw),
          fingerMinWidth:
            typeof legacyStored?.fingerMinWidth === 'number' && Number.isFinite(legacyStored.fingerMinWidth)
              ? Math.min(40, Math.max(4, legacyStored.fingerMinWidth))
              : legacyDefaults.fingerMinWidth,
        },
      };
    })(),
    singleFingerPan: {
      enabled:
        typeof value?.singleFingerPan?.enabled === 'boolean'
          ? value.singleFingerPan.enabled
          : DEFAULT_TABLET_INPUT_SETTINGS.singleFingerPan.enabled,
      minWidth:
        typeof value?.singleFingerPan?.minWidth === 'number' && Number.isFinite(value.singleFingerPan.minWidth)
          ? Math.min(40, Math.max(4, value.singleFingerPan.minWidth))
          : DEFAULT_TABLET_INPUT_SETTINGS.singleFingerPan.minWidth,
    },
    penCaptureEnabled:
      typeof value?.penCaptureEnabled === 'boolean'
        ? value.penCaptureEnabled
        : DEFAULT_TABLET_INPUT_SETTINGS.penCaptureEnabled,
    penButtonsEnabled:
      typeof value?.penButtonsEnabled === 'boolean'
        ? value.penButtonsEnabled
        : DEFAULT_TABLET_INPUT_SETTINGS.penButtonsEnabled,
    penButtonsSwap:
      typeof value?.penButtonsSwap === 'boolean' ? value.penButtonsSwap : DEFAULT_TABLET_INPUT_SETTINGS.penButtonsSwap,
    touchDebugOverlay:
      typeof value?.touchDebugOverlay === 'boolean'
        ? value.touchDebugOverlay
        : DEFAULT_TABLET_INPUT_SETTINGS.touchDebugOverlay,
    showZoomLockButton:
      typeof value?.showZoomLockButton === 'boolean'
        ? value.showZoomLockButton
        : DEFAULT_TABLET_INPUT_SETTINGS.showZoomLockButton,
    touchInputMode:
      value?.touchInputMode === 'finger-draws' || value?.touchInputMode === 'capacitive-pen'
        ? value.touchInputMode
        : DEFAULT_TABLET_INPUT_SETTINGS.touchInputMode,
    shapeSnapOnHold:
      typeof value?.shapeSnapOnHold === 'boolean'
        ? value.shapeSnapOnHold
        : DEFAULT_TABLET_INPUT_SETTINGS.shapeSnapOnHold,
    smartInkContrast:
      typeof value?.smartInkContrast === 'boolean'
        ? value.smartInkContrast
        : DEFAULT_TABLET_INPUT_SETTINGS.smartInkContrast,
  };
}

/**
 * Force capture on when the host has locked it (see `penCaptureLocked`). Returns the same object
 * when there is nothing to change, so a locked board does not re-render on every settings read.
 */
function applyPenCaptureLock(settings: TabletInputSettings, locked: boolean): TabletInputSettings {
  if (!locked || settings.penCaptureEnabled) {
    return settings;
  }

  return { ...settings, penCaptureEnabled: true };
}

// One-time forced reset. The pen-buttons feature shipped defaulting ON in v0.1.20–0.1.22 and a
// mis-read of the pen's button bits silently turns every stroke into an eraser (draws/saves/exports
// nothing). Those builds PERSISTED penButtonsEnabled:true to localStorage, so simply flipping the
// default to false does not help an already-affected device. Force the persisted value to false ONCE
// (guarded by a flag so the user can still re-enable it afterward). Touches only the setting, never data.
const PEN_BUTTONS_RESET_FLAG = 'whiteboard-pen-buttons-reset-v1';
// The dual-tip classifier switched from MAX-axis to MINOR-axis contact size (tilt-robust). Old stored
// thresholds were tuned for the max metric, so reset them ONCE to the new minor-axis defaults; the user
// can still re-tune afterward. Touches only the setting, never data. Guarded by a flag — the teacher's
// device already passed this migration (flag present), so restoring it now is a no-op that preserves their
// calibration; it only ever fires on a device that has never seen the minor-axis defaults.
const DUALTIP_MINAXIS_RESET_FLAG = 'whiteboard-dualtip-minaxis-reset-v1';
// The classifier now measures the SETTLED contact size (a running minimum over the first frames of a
// contact) rather than one frame's reading, and a settled size reads smaller than any single frame — so
// thresholds tuned against single frames sit too high and swallow the next band up. On the teacher's
// board the stored small-head limit of 8 was exactly where the big head settles, so the big head wrote
// in the small head's colour. Reset all three ONCE to the values fitted by replaying a labelled capture
// through this very code (`whiteboard-core/tools/replay-dualtip.mjs --sweep`); the sliders stay live and
// re-tunable afterwards. Touches only the setting, never data.
const DUALTIP_SETTLED_SIZE_RESET_FLAG = 'whiteboard-dualtip-settled-size-reset-v1';

function readTabletInputSettings(): TabletInputSettings {
  if (typeof window === 'undefined') {
    return DEFAULT_TABLET_INPUT_SETTINGS;
  }

  try {
    const rawValue = window.localStorage.getItem(TABLET_INPUT_SETTINGS_STORAGE_KEY);
    const settings = rawValue
      ? normalizeTabletInputSettings(JSON.parse(rawValue) as Partial<TabletInputSettings>)
      : { ...DEFAULT_TABLET_INPUT_SETTINGS };
    let mutated = false;

    if (!window.localStorage.getItem(PEN_BUTTONS_RESET_FLAG)) {
      settings.penButtonsEnabled = false;
      window.localStorage.setItem(PEN_BUTTONS_RESET_FLAG, '1');
      mutated = true;
    }

    if (!window.localStorage.getItem(DUALTIP_MINAXIS_RESET_FLAG)) {
      settings.dualTipStylus = {
        ...settings.dualTipStylus,
        smallHeadMaxWidth: DEFAULT_TABLET_INPUT_SETTINGS.dualTipStylus.smallHeadMaxWidth,
        bigHeadMaxWidth: DEFAULT_TABLET_INPUT_SETTINGS.dualTipStylus.bigHeadMaxWidth,
      };
      window.localStorage.setItem(DUALTIP_MINAXIS_RESET_FLAG, '1');
      mutated = true;
    }

    if (!window.localStorage.getItem(DUALTIP_SETTLED_SIZE_RESET_FLAG)) {
      settings.dualTipStylus = {
        ...settings.dualTipStylus,
        smallHeadMaxWidth: DEFAULT_TABLET_INPUT_SETTINGS.dualTipStylus.smallHeadMaxWidth,
        bigHeadMaxWidth: DEFAULT_TABLET_INPUT_SETTINGS.dualTipStylus.bigHeadMaxWidth,
      };
      settings.singleFingerPan = {
        ...settings.singleFingerPan,
        minWidth: DEFAULT_TABLET_INPUT_SETTINGS.singleFingerPan.minWidth,
      };
      window.localStorage.setItem(DUALTIP_SETTLED_SIZE_RESET_FLAG, '1');
      mutated = true;
    }

    if (mutated) {
      window.localStorage.setItem(TABLET_INPUT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    }

    return settings;
  } catch {
    return DEFAULT_TABLET_INPUT_SETTINGS;
  }
}

const DEFAULT_STROKE_SETTINGS: StrokeSettings = {
  color: '#000000',
  secondaryColor: '#2563EB',
  width: 4,
  opacity: 1,
};

function readStrokeSettings(): StrokeSettings {
  if (typeof window === 'undefined') {
    return DEFAULT_STROKE_SETTINGS;
  }

  try {
    const rawValue = window.localStorage.getItem(STROKE_SETTINGS_STORAGE_KEY);

    if (!rawValue) {
      return DEFAULT_STROKE_SETTINGS;
    }

    const parsed = JSON.parse(rawValue) as Partial<StrokeSettings>;
    const color = typeof parsed.color === 'string' && parsed.color ? parsed.color : DEFAULT_STROKE_SETTINGS.color;
    const secondaryColor =
      typeof parsed.secondaryColor === 'string' && parsed.secondaryColor
        ? parsed.secondaryColor
        : DEFAULT_STROKE_SETTINGS.secondaryColor;
    const width =
      typeof parsed.width === 'number' && Number.isFinite(parsed.width)
        ? Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, parsed.width))
        : DEFAULT_STROKE_SETTINGS.width;
    const opacity =
      typeof parsed.opacity === 'number' && Number.isFinite(parsed.opacity)
        ? Math.min(1, Math.max(0, parsed.opacity))
        : DEFAULT_STROKE_SETTINGS.opacity;

    const lineShape: LineShape = parsed.lineShape === 'hold' || parsed.lineShape === 'always' ? parsed.lineShape : 'free';

    return { color, secondaryColor, width, opacity, lineShape, dashed: parsed.dashed === true };
  } catch {
    return DEFAULT_STROKE_SETTINGS;
  }
}

function compactPdfPreviewPage(page: WhiteboardPage): WhiteboardPage {
  if (!page.pdfAssetId || !page.pdfImageUrl) {
    return page;
  }

  return {
    ...page,
    pdfImageUrl: undefined,
  };
}

function compactPdfPreviewPages(pages: WhiteboardPage[]): WhiteboardPage[] {
  let hasChanges = false;
  const nextPages = pages.map((page) => {
    const nextPage = compactPdfPreviewPage(page);

    if (nextPage !== page) {
      hasChanges = true;
    }

    return nextPage;
  });

  return hasChanges ? nextPages : pages;
}

function resolveFullscreenPortalHost(node: HTMLDivElement | null): Element | undefined {
  if (!node) {
    return undefined;
  }

  const ownerDocument = node.ownerDocument;
  const overlayAncestor = node.closest('[data-overlay-container]');
  const portalHost = overlayAncestor?.parentElement ?? ownerDocument.getElementById('__next');

  return portalHost ?? undefined;
}

function sanitizeFilename(value: string): string {
  const sanitized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '-');

  return sanitized || 'whiteboard';
}

/**
 * Storage keeps a page's background rotation NORMALIZED to [0, 360); the rotate panel talks in signed
 * degrees (-180..180) so «90° left» reads as -90 instead of 270. Display/slider side only — every
 * write back to a page goes through `normalizeRotationDeg` first.
 */
function toSignedRotationDeg(rotationDeg: number): number {
  const normalized = normalizeRotationDeg(rotationDeg);

  return normalized > 180 ? normalized - 360 : normalized;
}

// Separator the create flow uses to tag a board's default title with the teacher name
// ('<default> — <teacher>'). Kept as a constant so the default-detection and teacher-recovery paths
// stay in sync.
const BOARD_TITLE_TEACHER_SEPARATOR = ' — ';

// A board still carries a DEFAULT title when it was never renamed by the teacher: exactly 'Board',
// the create flows' fixed defaults ('New board', 'Imported board'), or the date-stamped default
// ('Board 4 July' — always 'Board' + a DIGIT), optionally suffixed with the teacher name as
// '<default> — <teacher>'. Empty/whitespace also counts. Deliberately NARROW: a teacher-chosen name
// like 'Board for algebra' also starts with the word 'Board' but is NOT a default and must never be
// overwritten by the PDF-import auto-rename (a broad /^Board/ match silently renamed such boards —
// adversarial-review catch).
function isDefaultBoardTitle(title: string): boolean {
  const trimmed = title.trim();

  if (trimmed === '') {
    return true;
  }

  // Inspect the base before any ' — <teacher>' suffix so a teacher-tagged default is still default.
  const base = trimmed.split(BOARD_TITLE_TEACHER_SEPARATOR)[0]?.trim() ?? trimmed;

  return /^(New|Imported) board$|^Board$|^Board \d/.test(base);
}

// Off-input-path scheduler for the heavy serialization (toJSON + undo snapshot). requestIdleCallback
// alone fired in the first spare frame — which for a fast writer is BETWEEN two samples of the next
// stroke, so a 100–300 ms toJSON landed under the pen and the stroke came out as a jagged polyline
// on the studio's Intel HD 530 (2026-09-13). scheduleQuietIdleWork keeps rIC but refuses to run while
// a contact is down or input has been quiet for less than `delayMs`, with a ceiling so a writer who
// never pauses still gets an autosave/undo checkpoint at the next lift. Returns an opaque handle that
// cancelIdleSnapshot understands.
type IdleSnapshotHandle = QuietIdleHandle;

function scheduleIdleSnapshot(callback: () => void, delayMs: number): IdleSnapshotHandle {
  return scheduleQuietIdleWork(callback, {
    fallbackDelayMs: delayMs,
    idleTimeoutMs: IDLE_SNAPSHOT_TIMEOUT_MS,
    isBusy: isPointerDown,
    maxDeferMs: IDLE_SNAPSHOT_MAX_DEFER_MS,
    msSinceInput: millisecondsSinceLastInput,
    quietMs: delayMs,
  });
}

function cancelIdleSnapshot(handle: IdleSnapshotHandle): void {
  handle.cancel();
}

function getGeometryStencilMarkup(kind: GeometryStencilKind) {
  switch (kind) {
    case 'compass':
      return `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">
          <g fill="none" stroke="#0f172a" stroke-linecap="round" stroke-linejoin="round">
            <path d="M142 52 88 254" stroke-width="14"/>
            <path d="M178 52 234 254" stroke-width="14"/>
            <path d="M150 66h20" stroke-width="12"/>
            <path d="M120 176c24 12 56 12 80 0" stroke-width="10" opacity=".6"/>
            <circle cx="160" cy="44" r="20" stroke-width="12"/>
            <path d="M88 254 72 292" stroke-width="12"/>
            <path d="M234 254 250 292" stroke-width="12"/>
            <circle cx="250" cy="292" r="6" fill="#0f172a" stroke="none"/>
          </g>
        </svg>
      `;
    case 'set-square':
      return `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 320">
          <g fill="rgba(59,130,246,0.08)" stroke="#0f172a" stroke-width="12" stroke-linejoin="round">
            <path d="M42 274 282 274 42 38Z"/>
            <path d="M112 204h90v-88Z" fill="white"/>
          </g>
        </svg>
      `;
    case 'protractor':
    default:
      return `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 240">
          <path d="M30 210a180 180 0 0 1 360 0" fill="rgba(245,158,11,0.10)" stroke="#0f172a" stroke-width="10"/>
          <path d="M70 210a140 140 0 0 1 280 0" fill="white" stroke="#0f172a" stroke-width="8"/>
          <path d="M30 210h360" stroke="#0f172a" stroke-width="10"/>
          ${Array.from({ length: 19 }, (_, index) => {
            const angle = Math.PI - (index * Math.PI) / 18;
            const outerRadius = 176;
            const innerRadius = index % 3 === 0 ? 132 : 148;
            const x1 = 210 + Math.cos(angle) * outerRadius;
            const y1 = 210 - Math.sin(angle) * outerRadius;
            const x2 = 210 + Math.cos(angle) * innerRadius;
            const y2 = 210 - Math.sin(angle) * innerRadius;

            return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#0f172a" stroke-width="${index % 3 === 0 ? 7 : 4}" stroke-linecap="round"/>`;
          }).join('')}
        </svg>
      `;
  }
}

function getGeometryStencilDataUrl(kind: GeometryStencilKind) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(getGeometryStencilMarkup(kind))}`;
}

function getGeometryStencilLabel(kind: GeometryStencilKind): WbStringKey {
  switch (kind) {
    case 'compass':
      return 'editor.geo.compass';
    case 'set-square':
      return 'editor.geo.setSquare';
    case 'protractor':
    default:
      return 'editor.geo.protractor';
  }
}

function getObjectData<T extends object>(object: FabricObject | null | undefined): T | undefined {
  return (object as (FabricObject & { data?: T }) | null | undefined)?.data;
}

function isArrowGroup(object: FabricObject): object is Group {
  if (!(object instanceof Group)) {
    return false;
  }

  const children = object.getObjects();

  return (
    children.length === 2 &&
    children.some((child) => child.type === 'line') &&
    children.some((child) => child.type === 'triangle')
  );
}

function isGeometryInspectableObject(object: FabricObject | null | undefined): object is FabricObject {
  if (!object) {
    return false;
  }

  const objectType = object.type;
  const stencilData = getObjectData<{ geometryStencilKind?: GeometryStencilKind; isGeometryStencil?: boolean }>(object);

  return (
    stencilData?.isGeometryStencil === true ||
    objectType === 'line' ||
    objectType === 'rect' ||
    objectType === 'ellipse' ||
    objectType === 'triangle' ||
    isArrowGroup(object)
  );
}

/** How long a notebook zoom/scroll must sit still before it is remembered. */
const NOTEBOOK_VIEW_SAVE_DELAY_MS = 400;

function readNotebookView(boardId: string, pageId: string): NotebookView | null {
  try {
    return parseNotebookView(window.localStorage.getItem(notebookViewStorageKey(boardId, pageId)));
  } catch {
    return null;
  }
}

function writeNotebookView(boardId: string, pageId: string, view: NotebookView): void {
  try {
    window.localStorage.setItem(notebookViewStorageKey(boardId, pageId), JSON.stringify(view));
  } catch {
    // Storage full or blocked: the page just reopens at its fit width.
  }
}

function transformCanvasPoint(point: Point, viewportTransform: number[] | undefined) {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = viewportTransform ?? IDENTITY_VIEWPORT;

  return {
    x: point.x * a + point.y * c + e,
    y: point.x * b + point.y * d + f,
  };
}

function formatGeometryMeasurement(value: number) {
  return `${Math.round(value)} px`;
}

function describeGeometryObject(object: FabricObject, canvas: Canvas, locale: WbLocale): GeometryOverlayState | null {
  if (!isGeometryInspectableObject(object)) {
    return null;
  }

  const viewportTransform = canvas.viewportTransform;
  const centerPoint = transformCanvasPoint(object.getCenterPoint(), viewportTransform);
  const bounds = object.getBoundingRect();
  const roundedAngle = Math.round(((object.angle ?? 0) + 360) % 360);
  const stencilData = getObjectData<{ geometryStencilKind?: GeometryStencilKind; isGeometryStencil?: boolean }>(object);
  let labelKey: WbStringKey = 'editor.geo.element';
  let subtitle = `${formatGeometryMeasurement(bounds.width)} × ${formatGeometryMeasurement(bounds.height)}`;

  if (stencilData?.isGeometryStencil && stencilData.geometryStencilKind) {
    labelKey = getGeometryStencilLabel(stencilData.geometryStencilKind);
    subtitle = `${subtitle} • ${roundedAngle}°`;
  } else if (object.type === 'line') {
    const line = object as FabricObject & { x1?: number; x2?: number; y1?: number; y2?: number };
    const length = Math.hypot((line.x2 ?? 0) - (line.x1 ?? 0), (line.y2 ?? 0) - (line.y1 ?? 0));

    labelKey = 'editor.geo.line';
    subtitle = `${formatGeometryMeasurement(length)} • ${roundedAngle}°`;
  } else if (isArrowGroup(object)) {
    labelKey = 'editor.geo.arrow';
    subtitle = `${formatGeometryMeasurement(bounds.width)} • ${roundedAngle}°`;
  } else if (object.type === 'rect') {
    labelKey = 'editor.geo.rect';
  } else if (object.type === 'ellipse') {
    labelKey = 'editor.geo.ellipse';
  } else if (object.type === 'triangle') {
    labelKey = 'editor.geo.triangle';
  }

  return {
    label: wbT(locale, labelKey),
    left: centerPoint.x,
    subtitle,
    top: centerPoint.y - bounds.height / 2 - 22,
  };
}

/**
 * Object bounds in SCREEN px — the plane the absolutely-positioned canvas-stage overlays live in.
 * `getCoords()` returns the four corners in the SCENE plane, so they need the same viewport transform
 * the geometry HUD applies to the center point; taking min/max keeps a rotated image honest.
 */
function getObjectScreenBounds(object: FabricObject, canvas: Canvas) {
  const corners = object.getCoords().map((corner) => transformCanvasPoint(corner, canvas.viewportTransform));
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);

  return {
    bottom: Math.max(...ys),
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
  };
}

// Chips need a React key that survives a reposition. Fabric objects carry no id, and an index key
// would re-mount every chip the moment one image is pinned or unpinned.
const lockedImageChipKeys = new WeakMap<FabricObject, string>();
let lockedImageChipKeySeed = 0;

function getLockedImageChipKey(object: FabricObject) {
  const existingKey = lockedImageChipKeys.get(object);

  if (existingKey) {
    return existingKey;
  }

  lockedImageChipKeySeed += 1;
  const chipKey = `pinned-image-${lockedImageChipKeySeed}`;

  lockedImageChipKeys.set(object, chipKey);

  return chipKey;
}

function describePinImageAction(object: FabricObject | null | undefined, canvas: Canvas): PinImageActionState | null {
  // Exactly ONE image: a multi-selection has no single thing to pin, and pinning it piecemeal would
  // silently drop the rest of the selection out of the group.
  if (!(object instanceof FabricImage) || isLockedImage(object) || canvas.getActiveObjects().length > 1) {
    return null;
  }

  const bounds = getObjectScreenBounds(object, canvas);

  return {
    image: object,
    left: (bounds.left + bounds.right) / 2,
    // Below the image — fabric's rotate handle owns the space above the top edge.
    top: bounds.bottom + 12,
  };
}

function describeLockedImageChip(object: FabricObject, canvas: Canvas): LockedImageChipState {
  const bounds = getObjectScreenBounds(object, canvas);

  return {
    chipKey: getLockedImageChipKey(object),
    image: object,
    // Just INSIDE the top-left corner, so a pinned image flush against the canvas edge keeps its chip.
    left: bounds.left + 8,
    top: bounds.top + 8,
  };
}

function snapGeometryObjectPosition(object: FabricObject, canvas: Canvas) {
  if (!isGeometryInspectableObject(object)) {
    return;
  }

  const bounds = object.getBoundingRect();
  const canvasCenterX = canvas.getWidth() / 2;
  const canvasCenterY = canvas.getHeight() / 2;
  const objectCenterX = bounds.left + bounds.width / 2;
  const objectCenterY = bounds.top + bounds.height / 2;
  const snappedLeft = Math.round((object.left ?? 0) / GEOMETRY_SNAP_GRID_SIZE) * GEOMETRY_SNAP_GRID_SIZE;
  const snappedTop = Math.round((object.top ?? 0) / GEOMETRY_SNAP_GRID_SIZE) * GEOMETRY_SNAP_GRID_SIZE;

  object.set({
    left: snappedLeft,
    top: snappedTop,
  });

  if (Math.abs(objectCenterX - canvasCenterX) <= GEOMETRY_SNAP_CENTER_THRESHOLD) {
    object.set({ left: (object.left ?? 0) + (canvasCenterX - objectCenterX) });
  }

  if (Math.abs(objectCenterY - canvasCenterY) <= GEOMETRY_SNAP_CENTER_THRESHOLD) {
    object.set({ top: (object.top ?? 0) + (canvasCenterY - objectCenterY) });
  }

  object.setCoords();
}

function snapGeometryObjectRotation(object: FabricObject) {
  if (!isGeometryInspectableObject(object)) {
    return;
  }

  const nextAngle = Math.round((object.angle ?? 0) / GEOMETRY_ROTATION_SNAP_DEGREES) * GEOMETRY_ROTATION_SNAP_DEGREES;

  object.set({ angle: nextAngle });
  object.setCoords();
}

// ---------------------------------------------------------------------------
// WhiteboardEditor
// ---------------------------------------------------------------------------

type WhiteboardEditorInnerProps = WhiteboardEditorProps & {
  // Populated by the inner editor with its best-effort flush-on-crash handler so the editor-level
  // boundary (which sits outside this component's scope) can flush in-flight ink before showing the
  // catastrophic fallback — without duplicating the serialization path.
  flushOnCrashRef?: React.MutableRefObject<(() => void) | null>;
};

/**
 * Names a drop is willing to hand to the import router at all.
 *
 * The router (`routeImportSelection`) decides what a selection MEANS; this only keeps a dropped
 * video or folder from opening a modal that would just say no. Kept deliberately wide — HEIC is in
 * here so the teacher is TOLD their iPhone photo cannot be decoded, rather than watching the drop do
 * nothing at all.
 */
const IMPORT_ROUTABLE_PATTERN = /\.(pdf|pptx?|png|jpe?g|webp|gif|bmp|heic|heif)$/i;

/**
 * A drag carrying real FILES, as opposed to the PageManager's own HTML5 thumbnail-reorder drags —
 * those carry no file payload, and hijacking them would break page reordering.
 */
const carriesFiles = (dataTransfer: DataTransfer | null): boolean =>
  Array.from(dataTransfer?.types ?? []).includes('Files');

const WhiteboardEditorInner: React.FC<WhiteboardEditorInnerProps> = ({
  convertOfficeFile,
  onContactCaptured,
  onPenCaptureEnabledChange,
  penCaptureLocked = false,
  onUndoPerformed,
  isPublishingVersion = false,
  onDocumentTitleChange,
  onPersistPdfAsset,
  onReuploadPdfAsset,
  pendingPdfImport,
  onPendingPdfImportHandled,
  pendingImageImport,
  onImagePlaced,
  onPendingImageImportHandled,
  pendingConceptMap = null,
  onPendingConceptMapHandled,
  pendingImagePagesImport,
  onPendingImagePagesImportHandled,
  onPublishVersion,
  whiteboardId,
  onBack,
  hideChrome = false,
  readOnly = false,
  embedded = false,
  onAiGeneratingChromeChange,
  onPdfImported,
  onPdfImportDiscarded,
  resolvePageIntro,
  peekPageIntro,
  pageIntroVersion,
  pdfWorkerSrc,
  pdfLayout: pdfLayoutProp = 'paged',
  allowPdfLayoutToggle = false,
  onPdfLayoutChange,
  lockZoomToPage = false,
  verticalNotebook = false,
  notebookFillScreen = false,
  freeZoom = false,
  paperOverPdf = false,
  boardTheme = 'light',
  compactSelectTool = false,
  selectionShape = 'lasso',
  selectionChrome = 'classic',
  compactUndoRedo = false,
  toolbarLayout = 'wrap',
  defaultToolbarDock = 'top',
  initialPenTool,
  defaultEraserMode = 'partial',
  hideQuickPenTrigger = false,
  focusMode,
  onFocusModeChange,
  allowInsertBlankPages = false,
  blankPagePaper = 'lined',
  allowPaperSpacing = false,
  defaultPaperSpacingMm,
  resolveRemotePdfAsset,
  fileBridge,
  nativePdf,
  nativePdfRescue,
  boardAi,
  termsMap = false,
  straightenInk = false,
  autoColor = null,
  extraSelectionActions,
  flushOnCrashRef,
  flushBeforeCloseRef,
  liveBoardRef,
  onBoardChange,
  renderPageImageRef,
  rulerEdgesRef,
  onViewportZoomChange,
  viewportRef,
  onViewportChange,
  buildMergeOverlaysRef,
}) => {
  const storage = useWhiteboardStorage();

  const { t, locale, dir } = useWbStrings();

  // --- Canvas ref for synchronous access + state to trigger re-renders ---
  const editorRootRef = useRef<HTMLDivElement>(null);
  const [overlayPortalContainer, setOverlayPortalContainer] = useState<Element | undefined>(undefined);
  const fabricCanvasRef = useRef<Canvas | null>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const backgroundOverlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [fabricCanvas, setFabricCanvas] = useState<Canvas | null>(null);

  // --- Persistence state ---
  const [whiteboardDocId] = useState<string>(() => whiteboardId ?? createWhiteboardId());
  const [documentTitle, setDocumentTitle] = useState(() => wbT(locale, 'editor.newBoard'));
  const [sharedBackgroundImageUrl, setSharedBackgroundImageUrl] = useState('');
  const [sharedBackgroundImageOpacity, setSharedBackgroundImageOpacity] = useState(1);
  const existingCreatedAtRef = useRef<number | null>(null);
  // The board's teacher tag (id/type/display name), captured at load. buildDocumentSnapshot rebuilds
  // the WhiteboardDocument from scratch on every autosave; without carrying these through, each save
  // would DROP the tag — invisible for platform teachers (the remote refresh re-stamps ownership from
  // the server) but permanent for a LOCAL teacher (no server to re-stamp), which orphaned every local
  // board into the "unassigned" section the moment it was opened + auto-saved.
  const existingTeacherTagRef = useRef<Partial<Pick<WhiteboardDocument, 'teacherId' | 'teacherType' | 'teacherName'>>>(
    {},
  );
  const hasLoadedRef = useRef(false);
  // Blocks persistence until the stored document has been read: a save firing before/while the
  // initial load resolves would overwrite the stored multi-page doc with the initial blank state.
  const initialLoadSettledRef = useRef(false);
  const pendingInitialPageRef = useRef<{ page: WhiteboardPage; viewportZoom: number } | null>(null);

  // --- Core state ---
  const [pages, setPages] = useState<WhiteboardPage[]>(() => [createBlankWhiteboardPage()]);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  // This board's last pen (nib + its colours/width) on this device; the device-wide stroke settings for
  // a board never opened here. Read in the initialisers so the toolbar never flashes the global pen.
  const [initialBoardPen] = useState(() => {
    const remembered = resolveInitialBoardPen(readBoardPenRaw(whiteboardDocId), readStrokeSettings());

    return initialPenTool ? { ...remembered, tool: initialPenTool } : remembered;
  });
  const [activeTool, setActiveTool] = useState<WhiteboardTool>(initialBoardPen.tool);
  const [eraserMode, setEraserMode] = useState<EraserMode>(defaultEraserMode);
  const [eraserSize, setEraserSize] = useState(24);
  const [tabletInputSettings, setStoredTabletInputSettings] = useState<TabletInputSettings>(() =>
    applyPenCaptureLock(readTabletInputSettings(), penCaptureLocked),
  );
  // Every write to the tablet settings goes through the lock, not just the first read: the popover
  // rebuilds the whole blob from its own typed object on any change, so a locked board would lose
  // the forced value the first time the teacher touched an unrelated slider.
  const setTabletInputSettings = useCallback<React.Dispatch<React.SetStateAction<TabletInputSettings>>>(
    (action) =>
      setStoredTabletInputSettings((previous) =>
        applyPenCaptureLock(typeof action === 'function' ? action(previous) : action, penCaptureLocked),
      ),
    [penCaptureLocked],
  );
  const [strokeSettings, setStrokeSettings] = useState<StrokeSettings>(initialBoardPen.strokeSettings);
  const [fillColor, setFillColor] = useState('transparent');
  const [backgroundType, setBackgroundType] = useState<BackgroundType>('blank');
  const [toolbarDock, setToolbarDock] = useState<ToolbarDock>(defaultToolbarDock);
  // The page list's open state, lifted so the full-scroll toolbar's page group can open it.
  const [isPageListOpen, setIsPageListOpen] = useState(false);
  const { pdfModalOpen, setPdfModalOpen, pendingImportFiles, startImportWithFiles } = usePendingPdfImport(
    pendingPdfImport,
    onPendingPdfImportHandled,
  );
  // Drag-and-drop import: true only while a real FILE drag is over the board. Page-thumbnail drags in
  // the PageManager are HTML5 drags too, so every handler below is gated on the 'Files' payload.
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [zoom, setZoom] = useState(1);
  const onViewportZoomChangeRef = useRef(onViewportZoomChange);

  onViewportZoomChangeRef.current = onViewportZoomChange;
  useEffect(() => {
    onViewportZoomChangeRef.current?.(zoom);
  }, [zoom]);
  const onViewportChangeRef = useRef(onViewportChange);

  onViewportChangeRef.current = onViewportChange;
  useEffect(() => {
    if (!viewportRef || !fabricCanvas) return undefined;

    viewportRef.current = () => {
      const [a = 1, , , , e = 0, f = 0] = fabricCanvas.viewportTransform ?? IDENTITY_VIEWPORT;
      const rect = fabricCanvas.upperCanvasEl?.getBoundingClientRect();

      return { zoom: a, offsetX: e, offsetY: f, originX: rect?.left ?? 0, originY: rect?.top ?? 0, pageIndex: currentPageIndex };
    };

    const last = [NaN, NaN, NaN];
    const ping = () => {
      const [a = 1, , , , e = 0, f = 0] = fabricCanvas.viewportTransform ?? IDENTITY_VIEWPORT;

      if (last[0] === a && last[1] === e && last[2] === f) return;

      last[0] = a;
      last[1] = e;
      last[2] = f;
      onViewportChangeRef.current?.();
    };

    fabricCanvas.on('after:render', ping as never);
    onViewportChangeRef.current?.();

    return () => {
      fabricCanvas.off('after:render', ping as never);
      viewportRef.current = null;
    };
  }, [viewportRef, fabricCanvas, currentPageIndex]);
  const [isLocked, setIsLocked] = useState(false);
  // Zoom lock: when on, two-finger gestures pan only (no pinch-zoom), and two-finger pan works even
  // in pen mode. Lets a teacher rest/scroll with two fingers without the canvas zooming.
  const [isZoomLocked, setIsZoomLocked] = useState(false);
  const [smoothingEnabled, setSmoothingEnabled] = useState(true);
  const [ownFocusMode, setOwnFocusMode] = useState(false);
  const isFocusMode = focusMode ?? ownFocusMode;
  const setIsFocusMode = useCallback(
    (focused: boolean) => {
      setOwnFocusMode(focused);
      onFocusModeChange?.(focused);
    },
    [onFocusModeChange],
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  // True while the exit/close flush is writing the latest snapshot to disk — drives the "saving…"
  // overlay so the user knows their work is being persisted before the board closes.
  const [isExitSaving, setIsExitSaving] = useState(false);
  const exitingRef = useRef(false);
  const [geometryOverlay, setGeometryOverlay] = useState<GeometryOverlayState | null>(null);
  const [pinImageAction, setPinImageAction] = useState<PinImageActionState | null>(null);
  const [lockedImageChips, setLockedImageChips] = useState<LockedImageChipState[]>([]);
  const [isQuickGestureMenuOpen, setIsQuickGestureMenuOpen] = useState(false);
  const isQuickGestureMenuOpenRef = useRef(false);

  isQuickGestureMenuOpenRef.current = isQuickGestureMenuOpen;
  // Where a pen-button press opened the quick menu (viewport fraction); null = the trigger's anchor.
  const [penButtonMenuAnchor, setPenButtonMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  // One position for the «Pen shortcuts» button and the menu it opens, saved per board.
  const { anchor: quickPenAnchor, setAnchor: setQuickPenAnchor } = useQuickPenAnchor(whiteboardDocId);
  const [openToolSettings, setOpenToolSettings] = useState<'pen' | 'eraser' | 'highlighter' | null>(null);
  const [isRotatePanelOpen, setIsRotatePanelOpen] = useState(false);
  // Un-committed page-background angle while the rotate panel is open, SIGNED (-180..180) to match the
  // slider and the readout. null = show the page's own saved rotation. The canvas previews this value
  // live; only a quick action / slider release / panel close writes it onto the page.
  const [rotationDraftDeg, setRotationDraftDeg] = useState<number | null>(null);
  const [lastPdfImportHint, setLastPdfImportHint] = useState<LastPdfImportHint | null>(null);
  const isSyncingCanvasRef = useRef(false);
  const isRestoringHistoryRef = useRef(false);
  // Generation counter + abort handle for page loads: only the latest load may touch the canvas,
  // commit shared guard flags, or let fabric's deferred clear()+add() run (see loadPage).
  const loadGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  // Slide transitions: the canvas's controls, and whether the load about to run is a FORWARD step
  // (page i entered from i-1). Only a forward step plays a transition, so the flag is set by the
  // navigation that knows the direction and read once by the load it belongs to.
  const pageTransitionRef = useRef<PageTransitionHandle | null>(null);
  const nextEnterIsForwardRef = useRef(false);
  // Slide intros: the hidden video + the "play once per page ENTER" policy. `enterPage` is stable and
  // is called from loadPage's success path; the canvas blits the video into the page-background layer.
  const {
    enterPage: enterPageIntro,
    isPlaying: isPageIntroPlaying,
    status: pageIntroStatus,
    statusPageId: pageIntroStatusPageId,
    stopPlayback: stopPageIntro,
    videoRef: pageIntroVideoRef,
  } = usePageIntroPlayback({ pageIntroVersion, resolvePageIntro, transitionHandleRef: pageTransitionRef });
  // True while a multi-page render loop (PDF publish) cycles foreign pages through the canvas —
  // snapshots must not attribute that transient content to the current page index.
  const isBatchRenderingRef = useRef(false);
  const lastPrimaryToolRef = useRef<WhiteboardTool>(initialBoardPen.tool);
  const pagesRef = useRef(pages);
  const currentPageIndexRef = useRef(currentPageIndex);
  const idleThumbnailTimerRef = useRef<IdleSnapshotHandle | null>(null);
  const idleThumbnailPageIndexRef = useRef<number | null>(null);
  // Set on every canvas mutation, cleared whenever we serialize the page (in-memory). Lets page
  // navigation skip the expensive canvas.toJSON()+stringify of the OUTGOING page when nothing changed
  // since the last serialize (the common "flip through pages" case) — that was the dominant per-switch
  // cost. NOTE: this means "canvas changed since last SERIALIZE", NOT "since last DURABLE save".
  const isPageDirtyRef = useRef(false);
  // Set on every canvas mutation, cleared ONLY by persistSnapshotNow after a successful IndexedDB
  // write. This is what the 2s autosave gates on. It must be separate from isPageDirtyRef: the idle
  // thumbnail snapshot clears isPageDirtyRef after an in-memory-only save (~700ms), so gating autosave
  // on isPageDirtyRef let the idle clear win the race and autosave NEVER persisted (the reported
  // "nothing saves / last-save frozen at mount"). needsPersistRef survives the in-memory snapshot.
  const needsPersistRef = useRef(false);
  // Pages that exist only in memory (the board AI's draft page while «Similar copy» is made and
  // reviewed): never saved, synced, published or exported until the teacher keeps them.
  const transientPageIdsRef = useRef<Set<string>>(new Set());
  // Wall-clock of the last durable IndexedDB write from ANY path (autosave, back button, visibility
  // flush, the shell's close hook). The autosave scheduler measures its deferral ceiling from this,
  // so a flush that just happened for another reason resets the ceiling instead of leaving it
  // counting from a save that is already on disk. 0 = nothing written yet this mount.
  const lastDurableSaveAtRef = useRef(0);
  // Page-level persistence baseline: the pages array as of the last FULL document write, plus the
  // document-level fields a page-only write cannot carry. See persistSnapshotNow.
  const lastFullSavedPagesRef = useRef<WhiteboardPage[] | null>(null);
  const lastFullSavedMetaRef = useRef<{
    sharedBackgroundImageOpacity?: number;
    sharedBackgroundImageUrl?: string;
    title: string;
    viewportZoom?: number;
  }>({ title: '' });
  // The two document fields the no-op autosave skip must also see unchanged (a page-only write never
  // carries them). null until this mount's first full write, so that first tick always writes.
  const lastFullSavedViewRef = useRef<{ currentPageIndex: number; thumbnail: string } | null>(null);
  const lastFullSaveAtRef = useRef(0);
  // The most recent library thumbnail (a small JPEG of the last-active page), regenerated on the
  // exit/close flush. Kept in a ref so routine 2s autosaves preserve it instead of blanking the
  // document thumbnail; seeded from the loaded doc so it survives until the first exit.
  const lastThumbnailRef = useRef('');
  // Guards the prefetch effect so it only re-runs when the page actually changes (not on every
  // stroke, which also mutates `pages`).
  const lastPrefetchKeyRef = useRef('');

  // pagesRef is write-through: every setPages call site assigns pagesRef.current first. Do NOT
  // re-add a render-body mirror — saveCurrentPage's deferred path commits the ref then defers
  // setPages in a transition, and a higher-priority render in between would rewind the ref to
  // the pre-stroke array (transition updates are excluded from non-transition render passes).
  currentPageIndexRef.current = currentPageIndex;
  const deferredPages = useDeferredValue(pages);
  const currentPage = pages[currentPageIndex] ?? null;
  const currentPageIdForCapture = currentPage?.id ?? '';

  /** Stamp the page onto each captured contact — without it the strokes of a lesson cannot be sorted
   *  back into pages, and a reviewer cannot see the word a contact belongs to. */
  const handleContactCaptured = useCallback(
    (contact: CapturedContact) => {
      onContactCaptured?.({
        ...contact,
        context: { ...contact.context, pageId: currentPageIdForCapture },
      });
    },
    [currentPageIdForCapture, onContactCaptured],
  );
  const hasPdfPageBackground = Boolean(currentPage?.pdfAssetId || currentPage?.pdfImageUrl);
  const hasAnyPdfBackground = useMemo(() => pages.some((page) => page.pdfAssetId || page.pdfImageUrl), [pages]);

  // --- Continuous PDF layout + zoom-lock (opt-in, see props) ---
  // `pdfLayout` is sticky per document; the prop is the initial value, the toolbar toggle (when
  // allowed) and a stored preference override it.
  const [pdfLayout, setPdfLayoutState] = useState<'paged' | 'scroll'>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = window.localStorage.getItem(`${PDF_LAYOUT_STORAGE_PREFIX}${whiteboardDocId}`);

        if (stored === 'paged' || stored === 'scroll') return stored;
      } catch {
        // storage blocked — fall back to the prop
      }
    }

    return pdfLayoutProp;
  });
  // Scroll is only meaningful for a board that has PDF pages; it owns the canvas (one scene of stacked
  // pages) while active. An export/publish sweep steps every page through the canvas paged, so the
  // session is torn down for its duration and rebuilt after (writing back any unsaved ink first).
  const isScrollActive = pdfLayout === 'scroll' && hasAnyPdfBackground;
  // The PDF-covers-view cage applies in scroll mode always, and in paged mode when `lockZoomToPage`.
  const isZoomLockedToPage = isScrollActive || (lockZoomToPage && hasPdfPageBackground);
  const scrollSessionRef = useRef<PdfScrollSession | null>(null);
  // The viewport cage handed to the canvas hook; updated in place as the page/layout/size change.
  const viewportConstraintsRef = useRef<ViewportConstraints | null>(null);
  // Free zoom (see the prop). The canvas and the zoom buttons read the cage through
  // `effectiveConstraintsRef`, which hands back a relaxed copy while it is on; every writer keeps
  // assigning the real cage to `viewportConstraintsRef`.
  const freeZoomRef = useRef(freeZoom);
  const effectiveConstraintsRef = useMemo<React.RefObject<ViewportConstraints | null>>(() => {
    let source: ViewportConstraints | null = null;
    let relaxed: ViewportConstraints | null = null;

    return {
      get current() {
        const real = viewportConstraintsRef.current;

        if (!real || !freeZoomRef.current) return real;

        if (real !== source) {
          source = real;
          relaxed = relaxConstraints(real);
        }

        return relaxed;
      },
    } as React.RefObject<ViewportConstraints | null>;
  }, []);
  // Vertical notebook (see the prop): the current sheet as the background painter reads it, its frozen
  // frame width, and the scene box of its ink. Null whenever the sheet is not in force.
  const notebookPageRef = useRef<{ pageId: string; frameWidth: number; pageLeft: number; pageRight: number } | null>(
    null,
  );
  const notebookFrameRef = useRef<{ pageId: string; width: number } | null>(null);
  const notebookInkRef = useRef<{ pageId: string; rect: SceneRect | null } | null>(null);
  // The furthest scene y the view's bottom edge has reached on the sheet: the endless paper keeps
  // room below it, so scrolling down always finds more page (see utils/notebookPage HEIGHT).
  const notebookViewedRef = useRef<{ pageId: string; bottom: number } | null>(null);
  // The cage the notebook installed (so leaving the sheet never clears a PDF/scroll cage), and the
  // updater loadPage calls once a page's ink is on the canvas (assigned below).
  const notebookConstraintsRef = useRef<ViewportConstraints | null>(null);
  const notebookUpdateRef = useRef<((mode: 'open' | 'refit' | 'grow', loaded?: WhiteboardPage) => void) | null>(null);
  // Scroll mode applies touch pans to Fabric per frame (so pages scrolling in are painted as they
  // arrive) instead of the CSS-preview-then-commit the free board uses.
  const directTouchPanRef = useRef(false);
  // The stacked-page painter + "repaint the background now" hook the session drives the canvas with.
  const pdfScrollPainterRef = useRef<PdfScrollPainter | null>(null);
  const backgroundRepaintRef = useRef<(() => void) | null>(null);
  // Refresh the paged zoom-lock cage (assigned once updatePagedLockConstraints exists). Called when a
  // PDF frame lands, which happens without a React re-render.
  const pagedLockRefreshRef = useRef<(() => void) | null>(null);
  // The last index the session reported from free SCROLLING — the enter-effect must not scroll back
  // to a page's top when the index merely followed the finger.
  const scrollDrivenIndexRef = useRef(-1);

  directTouchPanRef.current = isScrollActive;

  useEffect(() => {
    onPdfLayoutChange?.(pdfLayout);

    if (typeof window === 'undefined') return;

    try {
      window.localStorage.setItem(`${PDF_LAYOUT_STORAGE_PREFIX}${whiteboardDocId}`, pdfLayout);
    } catch {
      // storage blocked — the prop still drives the next open
    }
  }, [onPdfLayoutChange, pdfLayout, whiteboardDocId]);

  const setPdfLayout = useCallback((layout: 'paged' | 'scroll') => {
    setPdfLayoutState(layout);
  }, []);

  // What the CANVAS shows: the open panel's draft while the teacher is still choosing, otherwise the
  // page's saved rotation. Exports always read the page itself, never the draft.
  const previewPageRotationDeg = rotationDraftDeg ?? normalizeRotationDeg(currentPage?.pdfRotation);
  const rotationSliderValue = toSignedRotationDeg(previewPageRotationDeg);
  const existingPdfImports = useMemo<ExistingPdfImportSummary[]>(() => {
    const importsByFingerprint = new Map<string, ExistingPdfImportSummary>();

    for (const page of pages) {
      if (!page.pdfFingerprint || page.pdfPageIndex === undefined) {
        continue;
      }

      const existingImport = importsByFingerprint.get(page.pdfFingerprint);

      if (existingImport) {
        existingImport.pageNumbers.push(page.pdfPageIndex + 1);
        if (!existingImport.fileName && page.pdfSourceName) {
          existingImport.fileName = page.pdfSourceName;
        }
        continue;
      }

      importsByFingerprint.set(page.pdfFingerprint, {
        fileName: page.pdfSourceName ?? '',
        fingerprint: page.pdfFingerprint,
        pageNumbers: [page.pdfPageIndex + 1],
      });
    }

    return Array.from(importsByFingerprint.values()).map((pdfImport) => ({
      ...pdfImport,
      pageNumbers: Array.from(new Set(pdfImport.pageNumbers)).sort((left, right) => left - right),
    }));
  }, [pages]);
  // The LIVE canvas/container size, pushed from WhiteboardCanvas's ResizeObserver. The Fabric canvas is
  // resized IMPERATIVELY (setDimensions, no setState), so `fabricCanvas.getWidth()` alone stays frozen at
  // the small pre-layout width captured on the last React render — which sized the PDF raster too small,
  // and drawScreenFitImage then upscaled it to fill the real width (the persistent soft-PDF bug). We take
  // the MAX of the reported size and the live getWidth() so the raster always matches the real display,
  // and never fall back to 1 (a width of 1 slips past usePdfPageImage's containerWidth<=0 guard).
  const [canvasDisplaySize, setCanvasDisplaySize] = useState({ width: 0, height: 0 });
  // Only re-render (and thus re-size the PDF raster) when the size actually changes — the ResizeObserver
  // reports on every fire, including no-op ones.
  const handleCanvasResize = useCallback((size: { width: number; height: number }) => {
    setCanvasDisplaySize((prev) => (prev.width === size.width && prev.height === size.height ? prev : size));
  }, []);
  // The current page's PDF frame as the background painter sees it (frozen fit size + raster size),
  // published by WhiteboardCanvas once the raster lands and cleared on every page switch. Read by
  // snapshotPageFromCanvas to record `canvasWidthPx` / `pdfPlacement` for the server-side ink
  // renderer. A ref, not state: snapshots run off refs and a frame change must never re-render.
  const pdfBackgroundFrameRef = useRef<PdfBackgroundFrame | null>(null);
  const handlePdfBackgroundFrameChange = useCallback((frame: PdfBackgroundFrame | null) => {
    pdfBackgroundFrameRef.current = frame;
    // A frame only now known tightens the paged zoom-lock cage from the fit size to the real page rect.
    pagedLockRefreshRef.current?.();
  }, []);
  // A board pulled from the cloud references a PDF whose bytes may never have reached this device
  // (the load-time download timed out, the board was opened offline, the asset list did not name
  // it). The live page then renders through pdf.js ON THE MAIN THREAD — 6.5 s per page on the
  // studio PC, with the pen frozen for the duration (2026-09-13, the ViewSonic's PDF-board lag).
  // The first time the native renderer reports «no local bytes», fetch the PDF once in the
  // background, store it like an imported one, hand it to the native cache and bump the revision so
  // the page re-resolves natively without a page turn.
  const [pdfAssetRevision, setPdfAssetRevision] = useState(0);
  const pdfAssetDownloadsRef = useRef<Set<string>>(new Set());
  const ensureLocalPdfAssetInBackground = useCallback(
    (assetId: string) => {
      if (!resolveRemotePdfAsset || pdfAssetDownloadsRef.current.has(assetId)) {
        return;
      }

      pdfAssetDownloadsRef.current.add(assetId);

      void (async () => {
        try {
          const access = await resolveRemotePdfAsset(assetId);

          if (!access?.readUrl) {
            return;
          }

          const startedAt = performance.now();
          const response = await fetch(access.readUrl, { headers: access.headers });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const blob = await response.blob();
          const referencingPage = pagesRef.current.find((page) => page.pdfAssetId === assetId);

          await storage.savePdfAsset({
            blob,
            createdAt: Date.now(),
            fileName: access.fileName || referencingPage?.pdfSourceName || 'document.pdf',
            fingerprint: referencingPage?.pdfFingerprint ?? '',
            id: assetId,
            mimeType: 'application/pdf',
            pageCount: access.pageCount ?? 0,
            size: blob.size,
          });
          forgetCachedPdfAsset(assetId);

          if (nativePdf?.isAvailable()) {
            await nativePdf.ensureCached(assetId, blob);
          }

          perfMark('pdf-asset-cached', performance.now() - startedAt, `${Math.round(blob.size / 1024)}kb`);
          setPdfAssetRevision((revision) => revision + 1);
        } catch {
          // Let a later page turn retry (offline right now, a 401, a stalled uplink).
          pdfAssetDownloadsRef.current.delete(assetId);
        }
      })();
    },
    [nativePdf, resolveRemotePdfAsset, storage],
  );

  const { imageUrl: currentPdfPageImageUrl, isLoading: isCurrentPdfPageLoading } = usePdfPageImage({
    assetRevision: pdfAssetRevision,
    containerHeight: Math.max(canvasDisplaySize.height, fabricCanvas?.getHeight() ?? 0),
    containerWidth: Math.max(canvasDisplaySize.width, fabricCanvas?.getWidth() ?? 0),
    loadPdfAsset: storage.loadPdfAsset,
    nativePdf,
    onLocalBlobMissing: ensureLocalPdfAssetInBackground,
    page: currentPage
      ? {
          id: currentPage.id,
          pdfAssetId: currentPage.pdfAssetId,
          pdfImageUrl: currentPage.pdfImageUrl,
          pdfPageIndex: currentPage.pdfPageIndex,
        }
      : null,
    resolveRemotePdfAsset,
    workerSrc: pdfWorkerSrc,
    zoom,
  });

  // Joins undo/redo restores into the page-load abort/generation scheme: starting a restore
  // aborts any in-flight page load and vice versa, so exactly one canvas writer wins.
  const createHistoryRestoreContext = useCallback(() => {
    loadAbortRef.current?.abort();
    const abortController = new AbortController();

    loadAbortRef.current = abortController;
    const generation = ++loadGenerationRef.current;

    // A load this restore just superseded will skip releasing the shared guard in its finally
    // (it is no longer current) — release it here; the restore itself is covered by
    // isRestoringHistoryRef, which handleUndo/handleRedo hold for the whole await.
    isSyncingCanvasRef.current = false;

    return {
      signal: abortController.signal,
      isCurrent: () => generation === loadGenerationRef.current,
    };
  }, []);

  // --- History (undo/redo) — pass state (not ref) so hook re-runs when canvas is set ---
  // Undo/redo of a sheet insert/delete — wired once the page operations exist (below).
  const onBoardChangeRef = useRef(onBoardChange);

  onBoardChangeRef.current = onBoardChange;
  const applyHistoryPageListChangeRef = useRef<
    ((action: 'insert' | 'remove', entry: PageListEntry<WhiteboardPage>) => Promise<boolean>) | null
  >(null);
  const history = useWhiteboardHistory({
    canvas: fabricCanvas,
    createRestoreContext: createHistoryRestoreContext,
    // Scroll layout: one stack for the whole document (entries carry their page). Paged: per page.
    currentPageId: isScrollActive ? DOCUMENT_HISTORY_SCOPE : (pages[currentPageIndex]?.id ?? ''),
    getScrollSession: () => scrollSessionRef.current,
    applyPageListChange: (action, entry) => applyHistoryPageListChangeRef.current?.(action, entry) ?? false,
    onUserChange: () => onBoardChangeRef.current?.(),
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const storedDock = window.localStorage.getItem(TOOLBAR_DOCK_STORAGE_KEY);

    if (storedDock === 'top' || storedDock === 'bottom' || storedDock === 'left' || storedDock === 'right') {
      setToolbarDock(storedDock);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.localStorage.setItem(TOOLBAR_DOCK_STORAGE_KEY, toolbarDock);
  }, [toolbarDock]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.localStorage.setItem(TABLET_INPUT_SETTINGS_STORAGE_KEY, JSON.stringify(tabletInputSettings));
  }, [tabletInputSettings]);

  // Tell the host which side the training-capture switch is on. Declared AFTER the persist effect so
  // the stored settings already carry the new value by the time the host reacts, and keyed on the one
  // field — an unrelated tablet setting must not look like the teacher touched this switch. Held in a
  // ref so an inline callback prop cannot turn every render into a fresh "it changed".
  // The lock arrives LATE. The host resolves the teacher session after ITS mount, so this editor's
  // first render sees `false` and its first settings read can be a stale opt-out; re-apply the lock
  // when the answer lands. A no-op once locked (the setter above already forces every later write).
  useEffect(() => {
    if (!penCaptureLocked) return;

    setStoredTabletInputSettings((previous) => applyPenCaptureLock(previous, true));
  }, [penCaptureLocked]);

  const penCaptureEnabled = tabletInputSettings.penCaptureEnabled;
  const onPenCaptureEnabledChangeRef = useRef(onPenCaptureEnabledChange);

  onPenCaptureEnabledChangeRef.current = onPenCaptureEnabledChange;

  useEffect(() => {
    onPenCaptureEnabledChangeRef.current?.(penCaptureEnabled);
  }, [penCaptureEnabled]);

  // Persist pen color/size/opacity per-device so they survive a refresh / reopen.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.localStorage.setItem(STROKE_SETTINGS_STORAGE_KEY, JSON.stringify(strokeSettings));
  }, [strokeSettings]);

  // Recent colours (global across boards) for the quick menu's ring. Recorded from the active colour
  // itself, so every source counts — toolbar picker, quick menu, barrel COLOR toggle — and debounced so a
  // custom-picker drag records only the colour it settles on. The colour a board merely opened with isn't one.
  const [recentColors, setRecentColors] = useState<string[]>(() => readRecentColors());
  const recentColorSeenRef = useRef(strokeSettings.color);
  useEffect(() => {
    const color = strokeSettings.color;
    if (color === recentColorSeenRef.current) return;
    const timer = window.setTimeout(() => {
      recentColorSeenRef.current = color;
      setRecentColors((current) => {
        const next = pushRecentColor(current, color);
        writeRecentColors(next);

        return next;
      });
    }, RECENT_COLOR_RECORD_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [strokeSettings.color]);

  // Remember this board's pen (debounced). Off a pen (eraser/hand/select…) the saved nib stays the last
  // pen, so the board reopens ready to write. A pending write is flushed on unmount / page hide.
  const lastBoardPenToolRef = useRef<BoardPenTool>(initialBoardPen.tool);
  const pendingBoardPenRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (isBoardPenTool(activeTool)) lastBoardPenToolRef.current = activeTool;
    const memory = nextBoardPenMemory(lastBoardPenToolRef.current, activeTool, strokeSettings);
    const write = () => {
      pendingBoardPenRef.current = null;
      writeBoardPenMemory(whiteboardDocId, memory);
    };
    pendingBoardPenRef.current = write;
    const timer = window.setTimeout(write, BOARD_PEN_SAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [activeTool, strokeSettings, whiteboardDocId]);
  useEffect(() => {
    const flush = () => pendingBoardPenRef.current?.();
    window.addEventListener('pagehide', flush);

    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  const handleEditorRootRef = useCallback((node: HTMLDivElement | null) => {
    editorRootRef.current = node;
    setOverlayPortalContainer(resolveFullscreenPortalHost(node));
  }, []);

  // Board telemetry (utils/boardTelemetry): a host's perf collector reads the context at a gesture's
  // end and counts frames between gesture edges. Pushed only when these values change (they already
  // re-render the editor); the object count is a lazy getter. Free while no host subscribes.
  const telemetryLayout = isScrollActive ? 'continuous' : verticalNotebook && !hasPdfPageBackground ? 'notebook' : 'paged';

  useEffect(() => {
    publishBoardTelemetryContext({
      tool: activeTool,
      pages: pages.length,
      page: currentPageIndex,
      zoom: Math.round(zoom * 100) / 100,
      layout: telemetryLayout,
    });
  }, [activeTool, currentPageIndex, pages.length, telemetryLayout, zoom]);

  useEffect(() => {
    const root = editorRootRef.current;

    setBoardObjectCounter(fabricCanvas ? () => fabricCanvas.getObjects().length : null);
    const stopTracking = root && fabricCanvas ? trackBoardGestures(root) : null;

    return () => {
      stopTracking?.();
      setBoardObjectCounter(null);
    };
  }, [fabricCanvas]);

  useEffect(() => () => publishBoardTelemetryContext(null), []);

  const exitFullscreenIfActive = useCallback(async () => {
    if (typeof document === 'undefined') {
      return;
    }

    const fullscreenDocument = document as Document & {
      webkitExitFullscreen?: () => Promise<void> | void;
      webkitFullscreenElement?: Element | null;
    };
    const activeFullscreenElement = document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement ?? null;

    if (!activeFullscreenElement) {
      return;
    }

    if (document.exitFullscreen) {
      await document.exitFullscreen();
    } else {
      await fullscreenDocument.webkitExitFullscreen?.();
    }
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const syncFullscreenState = () => {
      const fullscreenElement =
        document.fullscreenElement ??
        (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ??
        null;

      setIsFullscreen(Boolean(fullscreenElement));
    };

    syncFullscreenState();
    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncFullscreenState as EventListener);

    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState as EventListener);
    };
  }, []);

  const loadSharedBackgroundImage = useCallback(async () => {
    if (!sharedBackgroundImageUrl) {
      return null;
    }

    return await new Promise<HTMLImageElement | null>((resolve) => {
      const image = new Image();

      image.crossOrigin = 'anonymous';
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = sharedBackgroundImageUrl;
    });
  }, [sharedBackgroundImageUrl]);

  // Shared loader, not a private `new Image()`: `resolveNativePdfPageImageUrl` has ALREADY loaded
  // this exact URL to verify it composites without tainting the export canvas, so a second private
  // load meant a second trip through the pdfpage:// protocol (WebView2 does not HTTP-cache it —
  // WebView2Feedback#4687) and a second main-thread decode of a multi-MB raster, per exported page.
  const loadCanvasImage = useCallback(async (imageUrl?: string) => await loadPdfPageImage(imageUrl), []);

  const resolvePdfRenderableAsset = useCallback(
    async (page: Pick<WhiteboardPage, 'pdfAssetId'>) => {
      if (!page.pdfAssetId) {
        return null;
      }

      const localAsset = await loadCachedPdfAsset(page.pdfAssetId, storage.loadPdfAsset);

      if (localAsset) {
        return localAsset;
      }

      if (!resolveRemotePdfAsset) {
        return null;
      }

      return await resolveRemotePdfAsset(page.pdfAssetId);
    },
    [resolveRemotePdfAsset, storage.loadPdfAsset],
  );

  // Render the PDF page through the host's native (Rust/PDFium) renderer, mirroring the live path in
  // usePdfPageImage. The export pipeline previously rendered ONLY via pdf.js + the IndexedDB asset, so
  // on the desktop shell — where the live page is drawn natively (its bytes pushed to the Rust cache,
  // and the local blob may not be loadable by pdf.js) — exports silently dropped the PDF background
  // while the live view showed it. Returns a URL only when the native image actually loads and is
  // canvas-exportable (loaded with the SAME crossOrigin the compositor uses); otherwise null so the
  // caller falls back to the unchanged pdf.js path. No-ops on web (native unavailable).
  const resolveNativePdfPageImageUrl = useCallback(
    async (page: WhiteboardPage, mode: 'export' | 'live'): Promise<string | null> => {
      const pdfAssetId = page.pdfAssetId;
      const pdfPageIndex = page.pdfPageIndex;

      if (!nativePdf?.isAvailable() || !pdfAssetId || pdfPageIndex === undefined || nativePdf.hasFailed?.(pdfAssetId)) {
        return null;
      }

      try {
        let cached = nativePdf.isCached(pdfAssetId);
        const asset = cached ? null : await loadCachedPdfAsset(pdfAssetId, storage.loadPdfAsset);

        if (!cached) {
          if (!asset?.blob) {
            return null;
          }

          cached = await nativePdf.ensureCached(pdfAssetId, asset.blob);
        }

        if (!cached) {
          return null;
        }

        const containerHeight = fabricCanvasRef.current?.getHeight() ?? 1080;
        const containerWidth = fabricCanvasRef.current?.getWidth() ?? 1920;
        const sizedAsset = asset ?? (await loadCachedPdfAsset(pdfAssetId, storage.loadPdfAsset));
        const targetEdge =
          mode === 'export'
            ? resolvePdfExportRenderEdge({
                deviceMemoryGb: getRenderDeviceMemoryGb(),
                fileSize: sizedAsset?.size ?? 0,
                totalPages: sizedAsset?.pageCount ?? 1,
              })
            : resolvePdfLiveRenderEdge({
                containerHeight,
                containerWidth,
                deviceMemoryGb: getRenderDeviceMemoryGb(),
                fileSize: sizedAsset?.size ?? 0,
                totalPages: sizedAsset?.pageCount ?? 1,
                zoom,
              });
        const url = nativePdf.pageUrl(pdfAssetId, pdfPageIndex, targetEdge);
        // Verify the native image loads with the SAME crossOrigin the export compositor uses, so a
        // native URL that would taint the export canvas (and break toDataURL) is rejected here and we
        // fall back to pdf.js instead of producing a corrupt/blank export. Going through the shared
        // loader means the compositor's own `loadCanvasImage(url)` right after this is a cache hit on
        // the very element verified here — one fetch + one decode for the page, not two.
        const loaded = await loadPdfPageImage(url);

        return loaded ? url : null;
      } catch {
        return null;
      }
    },
    [nativePdf, storage.loadPdfAsset, zoom],
  );

  const resolvePdfPageImageUrl = useCallback(
    async (page: WhiteboardPage, mode: 'export' | 'live' = 'live') => {
      if (!page.pdfAssetId || page.pdfPageIndex === undefined) {
        return page.pdfImageUrl;
      }

      // Native-first (matches the live renderer): keeps the export in sync with what the desktop shell
      // draws on screen. Falls through to pdf.js on web or any native failure.
      const nativeUrl = await resolveNativePdfPageImageUrl(page, mode);

      if (nativeUrl) {
        return nativeUrl;
      }

      const asset = await resolvePdfRenderableAsset(page);

      if (!asset) {
        return page.pdfImageUrl;
      }

      try {
        return await renderPdfAssetPageImageUrl({
          asset,
          containerHeight: fabricCanvasRef.current?.getHeight() ?? 1080,
          containerWidth: fabricCanvasRef.current?.getWidth() ?? 1920,
          mode,
          pageIndex: page.pdfPageIndex,
          workerSrc: pdfWorkerSrc,
          zoom: mode === 'export' ? 1 : zoom,
        });
      } catch {
        // Match the live renderer (usePdfPageImage): a transient pdf.js failure must not abort the
        // whole export — fall back to any inline preview so the page still composites.
        return page.pdfImageUrl;
      }
    },
    [pdfWorkerSrc, resolveNativePdfPageImageUrl, resolvePdfRenderableAsset, zoom],
  );

  // Page-manager thumbnails, cached per (asset, page, rotation) for the life of this editor. A
  // thumbnail is a full PDF page render; without the cache every idle snapshot's page-object
  // replacement re-rendered it (see PageThumbnail's effect deps). Failures are not cached so a
  // transient asset miss retries on the next look.
  const pageManagerThumbnailCacheRef = useRef<Map<string, Promise<string | undefined>>>(new Map());

  const resolvePageManagerPdfThumbnail = useCallback(
    async (page: WhiteboardPage) => {
      if (page.thumbnail) {
        return page.thumbnail;
      }

      if (!page.pdfAssetId || page.pdfPageIndex === undefined) {
        return page.pdfImageUrl;
      }

      const pdfPageIndex = page.pdfPageIndex;
      const cacheKey = `${page.pdfAssetId}:${pdfPageIndex}:${page.pdfRotation ?? 0}`;
      const cache = pageManagerThumbnailCacheRef.current;
      const cached = cache.get(cacheKey);

      if (cached) {
        return cached;
      }

      const pending = (async () => {
        const assetId = page.pdfAssetId as string;

        // Native first: the Rust renderer already holds this PDF (the live page uses it), and a
        // thumbnail-sized render there costs the main thread nothing but an <img> load.
        if (nativePdf?.isAvailable() && nativePdf.isCached(assetId) && !nativePdf.hasFailed?.(assetId)) {
          return nativePdf.pageUrl(assetId, pdfPageIndex, PAGE_MANAGER_THUMBNAIL_NATIVE_EDGE);
        }

        const asset = await resolvePdfRenderableAsset(page);

        if (!asset) {
          return page.pdfImageUrl;
        }

        // pdf.js rasterizes on the main thread: a strip of thumbnails rendering while the teacher
        // writes is exactly the hitch under study. Wait for the pen to lift and input to go quiet.
        await waitForInputIdle(PAGE_MANAGER_THUMBNAIL_QUIET_MS, () => false);

        const startedAt = performance.now();
        const url = await renderPdfAssetPageImageUrl({
          asset,
          containerHeight: PAGE_MANAGER_THUMBNAIL_HEIGHT,
          containerWidth: PAGE_MANAGER_THUMBNAIL_WIDTH,
          pageIndex: pdfPageIndex,
          workerSrc: pdfWorkerSrc,
          zoom: 1,
        });

        perfMark('pdf-thumb', performance.now() - startedAt, `page=${pdfPageIndex}`);

        return url;
      })();

      cache.set(cacheKey, pending);

      // Bound the map: a 300-page textbook would otherwise pin 300 data URLs for the session.
      if (cache.size > PAGE_MANAGER_THUMBNAIL_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;

        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }

      pending.catch(() => {
        if (cache.get(cacheKey) === pending) {
          cache.delete(cacheKey);
        }
      });

      return pending;
    },
    [nativePdf, pdfWorkerSrc, resolvePdfRenderableAsset],
  );

  // The page list's picture of each page: its saved ink + paper over the PDF thumbnail above
  // (`utils/pageThumbnail`). One render at a time, each after the pen has gone quiet, cached per page
  // until its ink changes — opening the list never competes with writing.
  const pageInkThumbnailCacheRef = useRef<Map<string, Promise<string | undefined>>>(new Map());
  const pageInkThumbnailQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const resolvePageManagerThumbnail = useCallback(
    (page: WhiteboardPage): Promise<string | undefined> => {
      const background = page.pdfAssetId || page.pdfImageUrl ? resolvePageManagerPdfThumbnail({ ...page, thumbnail: '' }) : Promise.resolve(undefined);
      const cacheKey = `${page.id}|${pageInkKey(page.canvasJSON)}|${page.backgroundType}|${page.pdfAssetId ?? ''}:${page.pdfPageIndex ?? ''}:${page.pdfRotation ?? 0}|${page.canvasWidthPx ?? ''}`;
      const cache = pageInkThumbnailCacheRef.current;
      const cached = cache.get(cacheKey);

      if (cached) return cached;

      const pending = pageInkThumbnailQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const backgroundUrl = await background.catch(() => undefined);

          await waitForInputIdle(PAGE_MANAGER_THUMBNAIL_QUIET_MS, () => false);

          try {
            return await renderPageThumbnail(page, {
              backgroundUrl,
              width: PAGE_MANAGER_THUMBNAIL_NATIVE_EDGE,
              checkpoint: () => waitForInputIdle(PAGE_MANAGER_THUMBNAIL_QUIET_MS, () => false),
            });
          } catch {
            // A page that will not render keeps whatever picture it can: the PDF page, an old thumbnail.
            return backgroundUrl ?? (page.thumbnail || undefined);
          }
        });

      pageInkThumbnailQueueRef.current = pending;
      // An older render of the same page is superseded: drop it (and its object URL) from the cache.
      for (const key of Array.from(cache.keys())) {
        if (key.startsWith(`${page.id}|`)) {
          const stale = cache.get(key);

          cache.delete(key);
          void stale?.then((url) => url?.startsWith('blob:') && window.setTimeout(() => URL.revokeObjectURL(url), 5_000));
        }
      }
      cache.set(cacheKey, pending);

      return pending;
    },
    [resolvePageManagerPdfThumbnail],
  );

  useEffect(() => {
    if (!renderPageImageRef) return;

    renderPageImageRef.current = async (page, longEdge) => {
      const pdfAssetId = page.pdfAssetId;
      const pdfPageIndex = page.pdfPageIndex;
      let backgroundUrl = page.pdfImageUrl;
      let ownedUrl: string | null = null;

      if (pdfAssetId && pdfPageIndex !== undefined) {
        if (nativePdf?.isAvailable() && nativePdf.isCached(pdfAssetId) && !nativePdf.hasFailed?.(pdfAssetId)) {
          backgroundUrl = nativePdf.pageUrl(pdfAssetId, pdfPageIndex, longEdge);
        } else {
          const asset = await resolvePdfRenderableAsset(page).catch(() => null);

          if (asset) {
            ownedUrl = await renderPdfAssetPageImageUrl({
              asset,
              containerHeight: longEdge,
              containerWidth: longEdge,
              mode: 'export',
              onRenderError: 'reject',
              pageIndex: pdfPageIndex,
              workerSrc: pdfWorkerSrc,
              zoom: 1,
            }).catch(() => null);
            backgroundUrl = ownedUrl ?? backgroundUrl;
          }
        }
      }

      try {
        return await renderPageImage(page, { backgroundUrl, quality: 0.85, view: 'page', width: longEdge });
      } finally {
        if (ownedUrl?.startsWith('blob:')) URL.revokeObjectURL(ownedUrl);
      }
    };
  }, [nativePdf, pdfWorkerSrc, renderPageImageRef, resolvePdfRenderableAsset]);

  const getPageExportBounds = useCallback((page: WhiteboardPage, pdfPageImage: HTMLImageElement | null, { backgroundOnly = false }: { backgroundOnly?: boolean } = {}) => {
    const canvas = fabricCanvasRef.current;

    if (!canvas) {
      return null;
    }

    const exportableObjects = canvas
      .getObjects()
      .filter((object) => !(object as FabricObject & { excludeFromExport?: boolean }).excludeFromExport)
      // The background frame alone (AI remake snapshot): only pinned pictures belong to it.
      .filter((object) => !backgroundOnly || isLockedImage(object));
    const canvasWidth = canvas.getWidth();
    const canvasHeight = canvas.getHeight();
    // The PDF is fitted against the page's FROZEN frame — the size the live painter laid it out in,
    // which is the frame the ink coordinates live in — never the live canvas. A window taller than
    // the frame the page was written in would otherwise centre the page lower and leave the ink
    // floating above it in every export and in the merged download.
    const pdfFrame = pdfPageImage
      ? resolvePageExportFrame({
          live: { height: canvasHeight, width: canvasWidth },
          page,
          pinned: pdfBackgroundFrameRef.current,
        })
      : null;

    // A rotated background fits by its BOUNDING BOX, so the exported page grows to hold the turned
    // scan. At rotation 0 this is byte-for-byte `getScreenFitPlacement` — unrotated boards export
    // exactly the size they always did.
    const pdfPlacement =
      pdfPageImage && pdfFrame
        ? getRotatedScreenFitPlacement(
            pdfFrame.width,
            pdfFrame.height,
            pdfPageImage.naturalWidth || pdfPageImage.width || pdfFrame.width,
            pdfPageImage.naturalHeight || pdfPageImage.height || pdfFrame.height,
            normalizeRotationDeg(page.pdfRotation),
          )
        : null;

    let minX = pdfPlacement?.left ?? 0;
    let minY = pdfPlacement?.top ?? 0;
    let maxX = pdfPlacement ? pdfPlacement.left + pdfPlacement.width : canvasWidth;
    let maxY = pdfPlacement ? pdfPlacement.top + pdfPlacement.height : canvasHeight;

    if (!pdfPlacement && exportableObjects.length === 0) {
      return {
        height: canvasHeight,
        left: 0,
        top: 0,
        width: canvasWidth,
      };
    }

    for (const object of exportableObjects) {
      const rect = object.getBoundingRect();

      minX = Math.min(minX, rect.left);
      minY = Math.min(minY, rect.top);
      maxX = Math.max(maxX, rect.left + rect.width);
      maxY = Math.max(maxY, rect.top + rect.height);
    }

    return {
      height: Math.max(1, Math.ceil(maxY - minY)),
      left: Math.floor(minX),
      top: Math.floor(minY),
      width: Math.max(1, Math.ceil(maxX - minX)),
    };
  }, []);

  const createPageExportSnapshot = useCallback(
    async (
      page: WhiteboardPage,
      overlayImage: HTMLImageElement | null,
      {
        format = 'png',
        multiplier = 2,
        quality = 1,
        maxDimension,
      }: { format?: 'jpeg' | 'png'; multiplier?: number; quality?: number; maxDimension?: number } = {},
    ) => {
      const canvas = fabricCanvasRef.current;
      const exportGeneration = loadGenerationRef.current;
      const pdfPageImage = await loadCanvasImage(await resolvePdfPageImageUrl(page, 'export'));
      const exportBounds = getPageExportBounds(page, pdfPageImage);

      if (!canvas || !exportBounds) {
        return null;
      }

      // A page load/restore landed while the PDF image loaded — the canvas no longer holds
      // `page`, so a snapshot now would export another page's pixels under this page's name.
      if (exportGeneration !== loadGenerationRef.current) {
        return null;
      }

      // Cap the multiplier so the longest edge fits `maxDimension` (thumbnail path) — keeps the
      // export cheap (one toDataURL on exit, not per stroke) and the stored data URL small.
      let effectiveMultiplier = multiplier;

      if (maxDimension) {
        const longestEdge = Math.max(exportBounds.width, exportBounds.height);

        if (longestEdge > 0) {
          effectiveMultiplier = Math.min(multiplier, maxDimension / longestEdge);
        }
      }

      const exportWidth = exportBounds.width * effectiveMultiplier;
      const exportHeight = exportBounds.height * effectiveMultiplier;
      const patternCanvas = document.createElement('canvas');
      const overlayCanvas = document.createElement('canvas');
      const mergedCanvas = document.createElement('canvas');
      const mergedContext = mergedCanvas.getContext('2d');

      if (!mergedContext) {
        return null;
      }

      const originalViewport = [...(canvas.viewportTransform ?? IDENTITY_VIEWPORT)] as typeof IDENTITY_VIEWPORT;

      canvas.setViewportTransform([...IDENTITY_VIEWPORT]);

      try {
        const fabricSnapshot = canvas.toCanvasElement(effectiveMultiplier, {
          filter: (object) => !(object as FabricObject & { excludeFromExport?: boolean }).excludeFromExport,
          height: exportBounds.height,
          left: exportBounds.left,
          top: exportBounds.top,
          width: exportBounds.width,
        });

        drawBackgroundPattern(patternCanvas, page.backgroundType, exportWidth, exportHeight, { spacing: boardPatternSpacingPx(page) });
        const patternContext = patternCanvas.getContext('2d');

        if (patternContext && pdfPageImage) {
          // The same frozen frame `getPageExportBounds` placed the page with (see the note there).
          const pdfFrame = resolvePageExportFrame({
            live: { height: canvas.getHeight(), width: canvas.getWidth() },
            page,
            pinned: pdfBackgroundFrameRef.current,
          });

          // The live board's own draw, reused rather than re-derived: the export's scene->bounds
          // mapping IS a viewport transform ([m,0,0,m,-left*m,-top*m] — the same matrix
          // `toCanvasElement` runs under and `drawLockedImages` reconstructs), so passing it with
          // pixelRatio 1 lands the page exactly where the plain drawImage used to, and the rotation
          // math lives in ONE place instead of two that can drift.
          drawScreenFitImage(
            patternContext,
            pdfFrame.width,
            pdfFrame.height,
            pdfPageImage,
            pdfPageImage.naturalWidth || pdfPageImage.width || pdfFrame.width,
            pdfPageImage.naturalHeight || pdfPageImage.height || pdfFrame.height,
            1,
            [
              effectiveMultiplier,
              0,
              0,
              effectiveMultiplier,
              -exportBounds.left * effectiveMultiplier,
              -exportBounds.top * effectiveMultiplier,
            ],
            'high',
            1,
            normalizeRotationDeg(page.pdfRotation),
          );
        }
        drawOverlayImage(overlayCanvas, exportWidth, exportHeight, overlayImage, sharedBackgroundImageOpacity);

        mergedCanvas.width = exportWidth;
        mergedCanvas.height = exportHeight;
        mergedContext.drawImage(patternCanvas, 0, 0, exportWidth, exportHeight);
        // Pinned images are teacher CONTENT that fabric never renders (visible:false), so `fabricSnapshot`
        // omits them and the export has to paint them itself — above the pattern/PDF, below the ink.
        // Coordinates match `toCanvasElement` exactly: it runs with the viewport already forced to
        // identity, so its internal transform is [m,0,0,m,-left*m,-top*m] — i.e. a pure scene→bounds
        // translation scaled by the multiplier, which is what drawLockedImages' (transform, ratio) pair
        // reconstructs (it scales all six matrix entries by the ratio).
        drawLockedImages(
          mergedContext,
          getLockedImages(canvas),
          [1, 0, 0, 1, -exportBounds.left, -exportBounds.top],
          effectiveMultiplier,
        );
        mergedContext.drawImage(fabricSnapshot, 0, 0, exportWidth, exportHeight);
        mergedContext.drawImage(overlayCanvas, 0, 0, exportWidth, exportHeight);

        return {
          dataUrl: mergedCanvas.toDataURL(`image/${format}`, quality),
          height: exportBounds.height,
          pixelHeight: exportHeight,
          pixelWidth: exportWidth,
          width: exportBounds.width,
        };
      } finally {
        canvas.setViewportTransform(originalViewport);
        canvas.requestRenderAll();
      }
    },
    [getPageExportBounds, loadCanvasImage, resolvePdfPageImageUrl, sharedBackgroundImageOpacity],
  );

  /**
   * Render ONE page's server-merge OVERLAY: a full-page TRANSPARENT PNG of EVERYTHING EXCEPT the
   * source PDF (background pattern + ink + shared bg-image overlay), plus the geometry the merge
   * manifest needs. Mirrors {@link createPageExportSnapshot} EXCEPT it (a) NEVER draws the source PDF
   * page image, (b) keeps the merged canvas transparent — no white fill: `paintOverlayPattern`
   * instead of `drawBackgroundPattern` — so the backend can composite it onto the vector PDF, and
   * (c) always exports `image/png`. It also returns the export-bounds CSS dims + the PDF placement
   * (CSS px, relative to the bounds, top-left origin) so {@link buildMergeManifestEntry} can convert
   * to PDF points.
   *
   * Like the publish/export sweeps this briefly flips the viewport to identity; the CALLER must hold
   * `isBatchRenderingRef` (Phase 2's `requestServerMerge`) so the autosave/idle/visibility writers
   * cannot race a snapshot. It also re-checks `loadGenerationRef` after the async PDF-image load so a
   * page switch mid-render can never export the wrong page's pixels under this page's name.
   */
  const createPageOverlaySnapshot = useCallback(
    async (
      page: WhiteboardPage,
      overlayImage: HTMLImageElement | null,
      { maxDimension, multiplier = 2 }: { maxDimension?: number; multiplier?: number } = {},
    ): Promise<PageOverlaySnapshot | null> => {
      const canvas = fabricCanvasRef.current;
      const exportGeneration = loadGenerationRef.current;
      const pdfPageImage = await loadCanvasImage(await resolvePdfPageImageUrl(page, 'export'));
      const exportBounds = getPageExportBounds(page, pdfPageImage);

      if (!canvas || !exportBounds) {
        return null;
      }

      // A page load/restore landed while the PDF image loaded — the canvas no longer holds `page`,
      // so a snapshot now would export another page's pixels under this page's name.
      if (exportGeneration !== loadGenerationRef.current) {
        return null;
      }

      let effectiveMultiplier = multiplier;

      if (maxDimension) {
        const longestEdge = Math.max(exportBounds.width, exportBounds.height);

        if (longestEdge > 0) {
          effectiveMultiplier = Math.min(multiplier, maxDimension / longestEdge);
        }
      }

      const exportWidth = exportBounds.width * effectiveMultiplier;
      const exportHeight = exportBounds.height * effectiveMultiplier;
      const patternCanvas = document.createElement('canvas');
      const overlayCanvas = document.createElement('canvas');
      const mergedCanvas = document.createElement('canvas');
      const mergedContext = mergedCanvas.getContext('2d');

      if (!mergedContext) {
        return null;
      }

      // PDF placement WITHIN the export bounds (CSS px, top-left origin). Recomputed exactly as
      // getPageExportBounds / createPageExportSnapshot do, then made relative to the bounds so it
      // matches where the PDF sits in the overlay PNG. Absent on blank pages (overlay carries only
      // the pattern + ink).
      let pdfPlacementCss: PageOverlaySnapshot['pdfPlacementCss'];
      // Degrees CLOCKWISE on screen; the backend turns the source page by this about the rect below.
      const pdfRotationDeg = normalizeRotationDeg(page.pdfRotation);

      if (pdfPageImage) {
        // The same frozen frame `getPageExportBounds` placed the page with (see the note there).
        const pdfFrame = resolvePageExportFrame({
          live: { height: canvas.getHeight(), width: canvas.getWidth() },
          page,
          pinned: pdfBackgroundFrameRef.current,
        });

        // With a rotation the rect handed to the manifest is the rotated page's BOUNDING BOX — the
        // same frame the ink was drawn over. Identical to `getScreenFitPlacement` at rotation 0.
        const pdfPlacement = getRotatedScreenFitPlacement(
          pdfFrame.width,
          pdfFrame.height,
          pdfPageImage.naturalWidth || pdfPageImage.width || pdfFrame.width,
          pdfPageImage.naturalHeight || pdfPageImage.height || pdfFrame.height,
          pdfRotationDeg,
        );

        pdfPlacementCss = {
          height: pdfPlacement.height,
          left: pdfPlacement.left - exportBounds.left,
          top: pdfPlacement.top - exportBounds.top,
          width: pdfPlacement.width,
        };
      }

      const originalViewport = [...(canvas.viewportTransform ?? IDENTITY_VIEWPORT)] as typeof IDENTITY_VIEWPORT;

      canvas.setViewportTransform([...IDENTITY_VIEWPORT]);

      try {
        const fabricSnapshot = canvas.toCanvasElement(effectiveMultiplier, {
          filter: (object) => !(object as FabricObject & { excludeFromExport?: boolean }).excludeFromExport,
          height: exportBounds.height,
          left: exportBounds.left,
          top: exportBounds.top,
          width: exportBounds.width,
        });

        // Transparent pattern (no white fill) + ink + shared overlay — DELIBERATELY no PDF image, so
        // the overlay is transparent wherever the source PDF should show through on the backend.
        paintOverlayPattern(patternCanvas, page.backgroundType, exportWidth, exportHeight, boardPatternSpacingPx(page));
        drawOverlayImage(overlayCanvas, exportWidth, exportHeight, overlayImage, sharedBackgroundImageOpacity);

        mergedCanvas.width = exportWidth;
        mergedCanvas.height = exportHeight;
        mergedContext.drawImage(patternCanvas, 0, 0, exportWidth, exportHeight);
        // Pinned images belong to the OVERLAY, not the source PDF: the teacher inserted them, so the
        // backend has nothing to composite them from. Same mapping as the full export; the merged
        // canvas stays transparent everywhere they don't cover.
        drawLockedImages(
          mergedContext,
          getLockedImages(canvas),
          [1, 0, 0, 1, -exportBounds.left, -exportBounds.top],
          effectiveMultiplier,
        );
        mergedContext.drawImage(fabricSnapshot, 0, 0, exportWidth, exportHeight);
        mergedContext.drawImage(overlayCanvas, 0, 0, exportWidth, exportHeight);

        const snapshot: PageOverlaySnapshot = {
          contentHeightCss: exportBounds.height,
          contentWidthCss: exportBounds.width,
          dataUrl: mergedCanvas.toDataURL('image/png'),
          pdfPlacementCss,
          pixelHeight: exportHeight,
          pixelWidth: exportWidth,
        };

        // Set only when it means something, so an unrotated board's snapshot — and the merge manifest
        // built from it — stays byte-identical to the pre-rotation payload.
        if (pdfRotationDeg !== 0) {
          snapshot.pdfRotationDeg = pdfRotationDeg;
        }

        return snapshot;
      } finally {
        canvas.setViewportTransform(originalViewport);
        canvas.requestRenderAll();
      }
    },
    [getPageExportBounds, loadCanvasImage, resolvePdfPageImageUrl, sharedBackgroundImageOpacity],
  );

  const snapshotPageFromCanvas = useCallback(
    (
      sourcePages: WhiteboardPage[] = pagesRef.current,
      pageIndex: number = currentPageIndexRef.current,
      options?: { includeThumbnail?: boolean; precomputedCanvasJSON?: string },
    ) => {
      // Scroll layout: the live canvas holds MANY pages' objects in scene coordinates — serializing it
      // onto one page would corrupt them. The session writes each dirty page back in its own frame.
      const scrollSession = scrollSessionRef.current;

      if (scrollSession) {
        const next = scrollSession.flush(sourcePages);

        // flush() hands the dirty pages over and forgets them, so the owner must keep what it returns:
        // an autosave that persisted `next` and dropped it left the live page list without that ink,
        // and the next relayout (a page insert, a page scrolling back in) rehydrated the stale copy and
        // saved it over the ink.
        if (next !== sourcePages && sourcePages === pagesRef.current) {
          pagesRef.current = next;
          startTransition(() => setPages(next));
        }

        return next;
      }

      const canvas = fabricCanvasRef.current;
      const activePage = sourcePages[pageIndex];

      if (
        !canvas ||
        !activePage ||
        isSyncingCanvasRef.current ||
        isRestoringHistoryRef.current ||
        isBatchRenderingRef.current
      ) {
        return sourcePages;
      }

      // Capture geometry for the server-side ink renderer (canvasWidthPx / pdfPlacement): the frame
      // the ink in canvasJSON lives in — the page's frozen fit for a PDF page, the live canvas CSS
      // width otherwise (see utils/snapshotGeometry for the frame contract). Recorded on clean pages
      // too, so a board written before these fields existed heals as its pages are visited. An
      // unknown frame leaves whatever the page already carries untouched — never a guessed 0. The
      // viewport comes back in the units the record is persisted in (frame-relative for a PDF page
      // pinned to a recorded frame, live screen values otherwise).
      const {
        page: geometryPatchedPage,
        viewportOffsetX,
        viewportOffsetY,
        viewportZoom,
      } = captureSnapshotState({
        // A notebook sheet records its frozen frame, not the pane: that is the frame its ink is in.
        canvasWidth:
          notebookPageRef.current?.pageId === activePage.id ? notebookPageRef.current.frameWidth : canvas.getWidth(),
        defaultZoom: DEFAULT_VIEWPORT_ZOOM,
        page: activePage,
        pdfFrame: pdfBackgroundFrameRef.current,
        viewportTransform: canvas.viewportTransform,
      });

      // Keep the page's stored ink untouched and only reconcile the (cheap) viewport, so pan/zoom is
      // never lost while a blank/unchanged canvas can never overwrite saved handwriting.
      const reconcileViewportOnly = (): WhiteboardPage[] => {
        if (
          geometryPatchedPage === activePage &&
          activePage.viewportOffsetX === viewportOffsetX &&
          activePage.viewportOffsetY === viewportOffsetY &&
          activePage.viewportZoom === viewportZoom
        ) {
          return sourcePages;
        }

        return sourcePages.map((page, index) =>
          index === pageIndex ? { ...geometryPatchedPage, viewportOffsetX, viewportOffsetY, viewportZoom } : page,
        );
      };

      // DATA-LOSS GUARD #1: only re-serialize the canvas when the page is actually dirty (a real
      // mutation since the last serialize) or the caller already computed the JSON. A *clean* page
      // must never be re-serialized from the live canvas — if a load/remount left the canvas
      // momentarily blank, serializing it would overwrite the good stored canvasJSON with an empty
      // one (the reported "all handwriting disappeared after reopen"). Trust the stored content.
      if (!options?.precomputedCanvasJSON && !isPageDirtyRef.current) {
        return reconcileViewportOnly();
      }

      // Reuse a precomputed serialization when the caller already ran toJSON (deferred/flush path),
      // so a single JSON.stringify(canvas.toJSON()) feeds both autosave and undo history.
      const canvasJSON = options?.precomputedCanvasJSON ?? serializeCanvasJson(canvas);

      // Thumbnail generation is dropped for now: toDataURL of the whole canvas after every stroke
      // was a main-thread freeze on long drawings. canvasJSON autosave still runs; previews reuse
      // whatever thumbnail already existed. (`options.includeThumbnail` is intentionally ignored.)
      const thumbnail = activePage.thumbnail;

      if (
        geometryPatchedPage === activePage &&
        activePage.canvasJSON === canvasJSON &&
        activePage.thumbnail === thumbnail &&
        activePage.viewportOffsetX === viewportOffsetX &&
        activePage.viewportOffsetY === viewportOffsetY &&
        activePage.viewportZoom === viewportZoom
      ) {
        return sourcePages;
      }

      return sourcePages.map((page, index) =>
        index === pageIndex
          ? {
              ...geometryPatchedPage,
              canvasJSON,
              thumbnail,
              viewportOffsetX,
              viewportOffsetY,
              viewportZoom,
            }
          : page,
      );
    },
    // Reads only refs now; no longer depends on getCompositeCanvasDataUrl (thumbnail dropped).
    [],
  );

  const buildDocumentSnapshot = useCallback((): WhiteboardDocument => {
    const persisted = excludeTransientPages(
      snapshotPageFromCanvas(pagesRef.current, currentPageIndexRef.current, {
        includeThumbnail: false,
      }),
      currentPageIndexRef.current,
      transientPageIdsRef.current,
    );
    const snapshotPages = persisted.pages;

    return {
      id: whiteboardDocId,
      title: documentTitle,
      pages: snapshotPages,
      currentPageIndex: persisted.currentIndex,
      createdAt: existingCreatedAtRef.current ?? Date.now(),
      updatedAt: Date.now(),
      // Library thumbnail = the last-active page's preview (regenerated on exit). Falls back to the
      // first page's thumbnail; routine autosaves keep the last one rather than blanking it.
      thumbnail: lastThumbnailRef.current || snapshotPages[0]?.thumbnail || '',
      sharedBackgroundImageUrl: sharedBackgroundImageUrl || undefined,
      sharedBackgroundImageOpacity,
      viewportZoom: fabricCanvasRef.current?.getZoom() ?? zoom,
      schemaVersion: WHITEBOARD_SCHEMA_VERSION,
      // Preserve the board's teacher tag across autosaves (captured at load).
      ...existingTeacherTagRef.current,
    };
  }, [
    documentTitle,
    zoom,
    sharedBackgroundImageOpacity,
    sharedBackgroundImageUrl,
    snapshotPageFromCanvas,
    whiteboardDocId,
  ]);

  const buildSnapshotDocument = useCallback(
    (allPages: WhiteboardPage[]): WhiteboardDocument => {
      const persisted = excludeTransientPages(allPages, currentPageIndexRef.current, transientPageIdsRef.current);
      const snapshotPages = persisted.pages;

      return {
        id: whiteboardDocId,
        title: documentTitle,
        pages: snapshotPages,
        currentPageIndex: persisted.currentIndex,
        createdAt: existingCreatedAtRef.current ?? Date.now(),
        updatedAt: Date.now(),
        thumbnail: lastThumbnailRef.current || snapshotPages[0]?.thumbnail || '',
        sharedBackgroundImageUrl: sharedBackgroundImageUrl || undefined,
        sharedBackgroundImageOpacity,
        viewportZoom: fabricCanvasRef.current?.getZoom() ?? zoom,
        schemaVersion: WHITEBOARD_SCHEMA_VERSION,
        // Preserve the board's teacher tag across autosaves (captured at load).
        ...existingTeacherTagRef.current,
      };
    },
    [documentTitle, sharedBackgroundImageOpacity, sharedBackgroundImageUrl, whiteboardDocId, zoom],
  );

  const clearScheduledIdleThumbnailSnapshot = useCallback(() => {
    if (idleThumbnailTimerRef.current !== null) {
      cancelIdleSnapshot(idleThumbnailTimerRef.current);
      idleThumbnailTimerRef.current = null;
    }

    idleThumbnailPageIndexRef.current = null;
  }, []);

  // Render a small JPEG preview of the CURRENT (last-active) page for the library card. Reuses the
  // export compositor (ink + background pattern + PDF + overlay) capped to ~360px, run ONCE on the
  // exit/close flush — never per stroke (that toDataURL-per-stroke was the old main-thread freeze).
  const captureCurrentPageThumbnail = useCallback(async (): Promise<string | undefined> => {
    const canvas = fabricCanvasRef.current;
    const page = pagesRef.current[currentPageIndexRef.current];

    if (!canvas || !page) {
      return undefined;
    }

    // createPageExportSnapshot briefly flips the viewport to identity; block concurrent snapshot
    // writers (the 2s autosave / idle / visibility flush all check isBatchRenderingRef) so none
    // captures the transient viewport. Reset in finally before the exit flush builds its own snapshot.
    isBatchRenderingRef.current = true;

    try {
      const overlayImage = await loadSharedBackgroundImage();
      const snapshot = await createPageExportSnapshot(page, overlayImage, {
        format: 'jpeg',
        maxDimension: 360,
        multiplier: 1,
        quality: 0.6,
      });

      if (snapshot?.dataUrl) {
        lastThumbnailRef.current = snapshot.dataUrl;
      }

      return snapshot?.dataUrl;
    } catch {
      // A thumbnail failure must never block the actual save — keep the previous thumbnail.
      return undefined;
    } finally {
      isBatchRenderingRef.current = false;
    }
  }, [createPageExportSnapshot, loadSharedBackgroundImage]);

  const persistSnapshotNow = useCallback(
    async (options?: { includeThumbnail?: boolean }) => {
      if (!storage.isReady) {
        return;
      }

      // Never persist before the stored document has been read (existing boards only) —
      // a 2s autosave racing a slow initial load would overwrite the doc with blank state.
      if (whiteboardId && !initialLoadSettledRef.current) {
        return;
      }

      if (options?.includeThumbnail) {
        clearScheduledIdleThumbnailSnapshot();
        // Regenerate the library thumbnail of the last-active page (updates lastThumbnailRef, which
        // buildDocumentSnapshot reads). Awaited before the save so the fresh preview is persisted.
        await captureCurrentPageThumbnail();
      }

      // Clear the persist-needed flag BEFORE serializing: the snapshot below captures the canvas as it
      // is right now, so any mutation that lands during the async write re-sets the flag and is caught
      // by the next 2s tick (rather than being silently dropped by a post-await clear).
      needsPersistRef.current = false;

      try {
        const snapshot = buildDocumentSnapshot();
        // Write only the page that changed when that is all that changed. `buildDocumentSnapshot`
        // re-serializes just the active page, so every other page keeps its object identity — a
        // reference diff against the last FULL save names the one dirty page for free. The studio's
        // 109-page exam board is a 54 MB document; cloning and writing all of it every 2 s while the
        // teacher wrote was the stroke-by-stroke stall (2026-09-13). Structure or metadata changes
        // (page count, title, zoom, the exit flush with a thumbnail) and a periodic ceiling still go
        // through the full write, which also folds the journal back into the document.
        const base = lastFullSavedPagesRef.current;
        const fullSaveDue = Date.now() - lastFullSaveAtRef.current >= FULL_SAVE_EVERY_MS;
        let changedIndex = -1;
        let changedCount = 0;

        if (base && base.length === snapshot.pages.length) {
          for (let index = 0; index < snapshot.pages.length; index += 1) {
            if (snapshot.pages[index] !== base[index]) {
              changedCount += 1;
              changedIndex = index;
            }
          }
        }

        const metaUnchanged =
          snapshot.title === lastFullSavedMetaRef.current.title &&
          snapshot.viewportZoom === lastFullSavedMetaRef.current.viewportZoom &&
          snapshot.sharedBackgroundImageUrl === lastFullSavedMetaRef.current.sharedBackgroundImageUrl &&
          snapshot.sharedBackgroundImageOpacity === lastFullSavedMetaRef.current.sharedBackgroundImageOpacity;

        // Nothing to write: the flag was raised but every page is still the one on disk (a scroll-layout
        // flush with no dirty page hands back the same objects) and no document field moved. Writing
        // anyway cost a 20-45 ms meta put + its IDB completion every tick on a dense board (device log
        // 2026-10-12). The periodic full save still runs when due, to fold the page journal.
        if (
          !options?.includeThumbnail &&
          !fullSaveDue &&
          base !== null &&
          base.length === snapshot.pages.length &&
          changedCount === 0 &&
          metaUnchanged &&
          snapshot.currentPageIndex === lastFullSavedViewRef.current?.currentPageIndex &&
          snapshot.thumbnail === lastFullSavedViewRef.current.thumbnail
        ) {
          return;
        }

        const pageOnly =
          Boolean(storage.savePageSnapshot) &&
          !options?.includeThumbnail &&
          !fullSaveDue &&
          base !== null &&
          changedCount === 1 &&
          snapshot.pages[changedIndex].id === base![changedIndex].id &&
          metaUnchanged;

        const writeStartedAt = performance.now();

        if (pageOnly) {
          const page = snapshot.pages[changedIndex];

          await storage.savePageSnapshot!(snapshot.id, page, {
            pageCount: snapshot.pages.length,
            title: snapshot.title,
            updatedAt: snapshot.updatedAt,
          });
          // The baseline now matches what is on disk for that page.
          base![changedIndex] = page;
          perfMark('autosave:page', performance.now() - writeStartedAt, `page=${changedIndex + 1}`);
        } else {
          // A full save still writes only the pages that differ from the last one (by reference —
          // an untouched page keeps its identity across saves). The store writes the meta record
          // plus those pages, so adding a page to a 109-page board costs one page, not 109.
          const baseById = new Map((base ?? []).map((page) => [page.id, page] as const));
          const changedPageIds = base
            ? snapshot.pages.filter((page) => baseById.get(page.id) !== page).map((page) => page.id)
            : undefined;

          await storage.saveWhiteboard(snapshot, changedPageIds ? { changedPageIds } : undefined);
          perfMark(
            'autosave:full',
            performance.now() - writeStartedAt,
            `pages=${snapshot.pages.length} changed=${changedPageIds?.length ?? snapshot.pages.length}`,
          );
          lastFullSavedPagesRef.current = snapshot.pages.slice();
          lastFullSavedMetaRef.current = {
            sharedBackgroundImageOpacity: snapshot.sharedBackgroundImageOpacity,
            sharedBackgroundImageUrl: snapshot.sharedBackgroundImageUrl,
            title: snapshot.title,
            viewportZoom: snapshot.viewportZoom,
          };
          lastFullSavedViewRef.current = { currentPageIndex: snapshot.currentPageIndex, thumbnail: snapshot.thumbnail ?? '' };
          lastFullSaveAtRef.current = Date.now();
        }

        // Stamp the write AFTER it lands, not when it was issued: the autosave scheduler's ceiling
        // is a promise about how much ink an abrupt quit can cost, and ink is only safe once the
        // put has committed.
        lastDurableSaveAtRef.current = Date.now();
      } catch (error) {
        // The write failed — re-arm so the autosave interval retries instead of silently losing the
        // page. Don't rethrow: callers use `void persistSnapshotNow()` and an await-then-navigate path.
        needsPersistRef.current = true;
        console.error('whiteboard: failed to persist snapshot', error);
      }
    },
    [
      buildDocumentSnapshot,
      captureCurrentPageThumbnail,
      clearScheduledIdleThumbnailSnapshot,
      storage,
      storage.isReady,
      whiteboardId,
    ],
  );

  useEffect(() => {
    onDocumentTitleChange?.(documentTitle);
  }, [documentTitle, onDocumentTitleChange]);

  // --- Auto-save: 2s cadence, but the write waits for a gap between strokes ---
  // Still mutation-agnostic and self-re-arming, and still gated on needsPersistRef — NOT
  // isPageDirtyRef: the idle thumbnail snapshot clears isPageDirtyRef after an in-memory-only save
  // (~700ms), which always beat the 2s tick, so gating on isPageDirtyRef meant the timer saw "clean"
  // and never persisted. needsPersistRef is cleared only by a successful IndexedDB write.
  //
  // What changed: a profile of the PRODUCTION build found this save to be the dominant stall while
  // drawing — the IndexedDB `put` + `onsuccess` + the syncer's follow-up `get` cost 50-65ms at 7 ink
  // objects and 77-93ms at 707 (6x CPU throttle; ~8-15ms at 1x on a fast desktop, and the teacher's
  // panel is much slower than the box that measured it) — and a plain interval lands that ON the
  // stroke. utils/autoSaveScheduler keeps the same cadence but spends the write in the pen-up gap the
  // teacher is already taking, with a hard ceiling so an unbroken stroke still gets saved. Read that
  // file for the full measurement + the unsaved-work bound this buys.
  useEffect(() => {
    if (!storage.isReady) return;

    const scheduler = startAutoSaveScheduler({
      lastDurableSaveAt: () => lastDurableSaveAtRef.current,
      millisecondsSinceLastInput,
      needsPersist: () => needsPersistRef.current,
      persist: () => persistSnapshotNow(),
    });

    return () => scheduler.stop();
  }, [persistSnapshotNow, storage, storage.isReady]);

  useEffect(() => {
    if (!storage.isReady) return;

    const flushSnapshot = () => {
      if (document.visibilityState !== 'hidden') return;

      void persistSnapshotNow();
    };

    const flushOnUnload = () => {
      void persistSnapshotNow();
    };

    document.addEventListener('visibilitychange', flushSnapshot);
    window.addEventListener('beforeunload', flushOnUnload);

    return () => {
      document.removeEventListener('visibilitychange', flushSnapshot);
      window.removeEventListener('beforeunload', flushOnUnload);
    };
  }, [persistSnapshotNow, storage, storage.isReady]);

  useEffect(
    () => () => {
      void exitFullscreenIfActive();
    },
    [exitFullscreenIfActive],
  );

  const handleBackPress = useCallback(async () => {
    // Show the "saving…" overlay while the exit flush (snapshot + fresh thumbnail) reaches disk, so
    // the user sees their work is persisted before the board closes.
    // It stays up through onBack too: the app may still be sending the page before it leaves.
    if (exitingRef.current) return;
    exitingRef.current = true;
    setIsExitSaving(true);

    try {
      await persistSnapshotNow({ includeThumbnail: true });
      await exitFullscreenIfActive();
      await onBack?.();
    } finally {
      exitingRef.current = false;
      setIsExitSaving(false);
    }
  }, [exitFullscreenIfActive, onBack, persistSnapshotNow]);

  const handleRefresh = useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }

    setIsExitSaving(true);

    try {
      await persistSnapshotNow({ includeThumbnail: true });
      await exitFullscreenIfActive();
    } finally {
      setIsExitSaving(false);
    }

    window.location.reload();
  }, [exitFullscreenIfActive, persistSnapshotNow]);

  // --- Load a page onto the canvas ---
  // Returns false when this load was superseded by a newer one before completing. Fabric applies
  // loadFromJSON's clear()+add() inside the promise continuation AFTER async image enlivening, so
  // without aborting, a superseded heavy load resolves seconds late and paints its page's content
  // over whatever page the user navigated to meanwhile (the page-bleed bug).
  const loadPage = useCallback(
    async (page: WhiteboardPage, options?: { viewportZoom?: number }) => {
      // Read and cleared FIRST, before every early return: the flag belongs to the navigation that
      // set it, and a load that never ran must not hand a forward step to whatever loads next,
      // which may well be a jump or a publish sweep's restore.
      const isForwardEnter = nextEnterIsForwardRef.current;

      nextEnterIsForwardRef.current = false;

      // In the continuous PDF layout the scroll session owns the canvas (one scene of stacked pages);
      // a single-page load would wipe it. Navigation there scrolls instead (see navigateToPage). An
      // export/publish sweep SUSPENDS the session first, which hands the canvas back for paged loads.
      if (scrollSessionRef.current && !scrollSessionRef.current.suspended) return false;

      const canvas = fabricCanvasRef.current;

      if (!canvas) return false;

      loadAbortRef.current?.abort();
      const abortController = new AbortController();

      loadAbortRef.current = abortController;
      const generation = ++loadGenerationRef.current;
      const isCurrentLoad = () => generation === loadGenerationRef.current;

      isSyncingCanvasRef.current = true;
      history.pause();

      let loadedObjectSources: string[] | undefined;
      // A page switch replaces the entire object set; drop the render bake now rather than let the
      // next frame's identity check discover it (see `utils/inkBake.ts`).
      invalidateInkBake(canvas);

      try {
        if (page.canvasJSON) {
          try {
            const __tJson = performance.now();

            const parsedPage = JSON.parse(page.canvasJSON) as { objects?: unknown[] };

            // The undo history's strings for the loaded objects, straight from the stored page.
            loadedObjectSources = Array.isArray(parsedPage.objects) ? parsedPage.objects.map((object) => JSON.stringify(object)) : undefined;
            await canvas.loadFromJSON(parsedPage, undefined, {
              signal: abortController.signal,
            });
            recordPerf('loadFromJSON', performance.now() - __tJson, `objs=${canvas.getObjects().length}`);
            invalidateInkBake(canvas);
            if (!isCurrentLoad()) return false;
            canvas.backgroundImage = undefined;

            // SELF-HEAL (also fixes boards imported before the olf-import fix): on a page with a
            // PDF/slide backdrop, an opaque Fabric `background` restored from canvasJSON paints ABOVE
            // the backdrop layer and hides it completely — the "preview shows the PDF but the page
            // renders blank" bug (pre-fix OLF import stamped background:'#ffffff' on every page).
            if (page.pdfImageUrl || page.pdfAssetId) {
              canvas.backgroundColor = 'transparent';
            }
          } catch {
            // An aborted load must leave the canvas alone — the winning load owns it now.
            if (!isCurrentLoad() || abortController.signal.aborted) return false;
            canvas.clear();
            canvas.backgroundColor = 'transparent';
            canvas.backgroundImage = undefined;
            invalidateInkBake(canvas);
          }
        } else {
          canvas.clear();
          canvas.backgroundColor = 'transparent';
          canvas.backgroundImage = undefined;
          invalidateInkBake(canvas);
        }

        if (!isCurrentLoad()) return false;

        // A pinned image comes back from JSON as an ordinary object; re-assert the pin invariants
        // (hidden from fabric, not selectable) and tell the background painter + chips the set
        // changed, so the page opens with its pinned images already on screen.
        enforceLockedImageInvariants(canvas);
        notifyLockedImagesChanged(canvas);

        const currentViewport = canvas.viewportTransform ?? IDENTITY_VIEWPORT;
        const hasPdfBackground = Boolean(page.pdfAssetId || page.pdfImageUrl);
        // Restore the page's OWN saved zoom/pan so returning to a page keeps where you left it
        // (the PDF/image background follows the viewport transform, so this stays in sync). Only when
        // a page has never been zoomed (no saved zoom) do we fall back: PDF pages open fit-and-centered
        // at identity, blank pages inherit the live viewport.
        const savedZoom = page.viewportZoom ?? options?.viewportZoom;
        const hasSavedZoom = typeof savedZoom === 'number' && Number.isFinite(savedZoom);
        const nextZoom = hasSavedZoom
          ? savedZoom
          : hasPdfBackground
            ? DEFAULT_VIEWPORT_ZOOM
            : (currentViewport[0] ?? DEFAULT_VIEWPORT_ZOOM);
        const nextOffsetX = hasSavedZoom
          ? (page.viewportOffsetX ?? 0)
          : hasPdfBackground
            ? 0
            : (page.viewportOffsetX ?? currentViewport[4] ?? 0);
        const nextOffsetY = hasSavedZoom
          ? (page.viewportOffsetY ?? 0)
          : hasPdfBackground
            ? 0
            : (page.viewportOffsetY ?? 0);

        // A PDF page carrying a recorded frame is pinned to that frame by WhiteboardCanvas (see
        // utils/snapshotGeometry) and its saved viewport is frame-relative — scale it onto THIS
        // window, so a page written at 3436 px opens filling a 1096 px window with its ink aligned.
        // Exactly 1 on the device the page was written on and for every other kind of page. `zoom`
        // state keeps the frame-relative value: it sizes the raster to the visible width.
        const frameScale = getPageFrameScale({
          canvasHeight: canvas.getHeight(),
          canvasWidth: canvas.getWidth(),
          page,
        });
        const screenViewport = toScreenViewport(
          { offsetX: nextOffsetX, offsetY: nextOffsetY, zoom: nextZoom },
          frameScale,
        );

        canvas.setViewportTransform([
          screenViewport.zoom,
          0,
          0,
          screenViewport.zoom,
          screenViewport.offsetX,
          screenViewport.offsetY,
        ]);
        setZoom(nextZoom);
        // A notebook sheet opens at its fit width, at the row the saved viewport was reading.
        notebookUpdateRef.current?.('open', page);
        canvas.requestRenderAll();

        // Seed this page's undo baseline from the content that actually loaded. Same content as the
        // page's history was recorded against → its stack stays; different (reloaded from elsewhere)
        // → the stack is cleared rather than undone onto content it does not describe.
        history.seedLoadedPage(page.id, loadedObjectSources);
        // The canvas now exactly mirrors the loaded page's stored canvasJSON — mark it clean so the
        // next navigation can skip re-serializing an unchanged page.
        isPageDirtyRef.current = false;
        // Page ENTER: ask the host for this page's slide intro and play it once. Everything about it
        // is asynchronous and cancellable — a resolution that lands after the next page was entered
        // is dropped by the hook's own visit token, the same way this load drops itself above.
        // NOT during a publish/export sweep: that cycles every page through this canvas for a render,
        // which is not a teacher entering a page, and an intro there would paint over the capture.
        if (!isBatchRenderingRef.current) {
          enterPageIntro(page.id, { isForward: isForwardEnter });
        }

        return true;
      } finally {
        // Only the latest load may release the shared guards — a superseded load finishing
        // (or aborting) early must not re-enable snapshots/history while the winner still runs.
        if (isCurrentLoad()) {
          history.resume();
          isSyncingCanvasRef.current = false;
        }
      }
    },
    [enterPageIntro, history],
  );

  // --- Canvas ready callback ---
  // Stable so the Fabric 'mouse:down' listener registered once in handleCanvasReady stays valid.
  const closeToolSettingsOnCanvasAction = useCallback(() => {
    setOpenToolSettings((current) => (current ? null : current));
  }, []);

  const handleCanvasReady = useCallback(
    (canvas: Canvas) => {
      fabricCanvasRef.current = canvas;

      // Auto-close the pen/eraser settings popover the instant a canvas action starts. We listen on
      // Fabric's NORMALIZED 'mouse:down' (not the DOM/window 'mousedown' the popover relies on) because
      // pen/touch drawing calls preventDefault on the pointer event, which suppresses the synthesized
      // DOM mousedown — so the popover's own outside-press handler never fires for a stylus. Fabric's
      // event fires for mouse/pen/touch alike and does NOT swallow the stroke (it's an additive
      // listener; the draw proceeds normally). setState is a no-op when nothing is open.
      canvas.off('mouse:down', closeToolSettingsOnCanvasAction);
      canvas.on('mouse:down', closeToolSettingsOnCanvasAction);

      const pendingPage = pendingInitialPageRef.current;

      if (pendingPage) {
        pendingInitialPageRef.current = null;

        void loadPage(pendingPage.page, { viewportZoom: pendingPage.viewportZoom }).finally(() => {
          setFabricCanvas(canvas);
        });

        return;
      }

      setFabricCanvas(canvas);
    },
    [closeToolSettingsOnCanvasAction, loadPage],
  );

  // Warm the pdf.js runtime as soon as the board contains any PDF page, so opening the first PDF page
  // doesn't pay the module download + worker spin-up inline (part of the "couple seconds" cost).
  const hasAnyPdfPage = useMemo(() => pages.some((page) => Boolean(page.pdfAssetId)), [pages]);

  useEffect(() => {
    if (hasAnyPdfPage) {
      warmPdfRuntime(undefined, pdfWorkerSrc);
    }
  }, [hasAnyPdfPage, pdfWorkerSrc]);

  // pdf.js (web build) PREFETCH ONLY — warming the NATIVE disk render cache is `usePdfPageImage`'s
  // job, and it must be exactly one job.
  //
  // This effect used to ALSO warm 3 ahead + 2 behind natively, duplicating the hook's window for no
  // gain and competing with it for the single PDFium worker thread. It duplicated it badly, too: its
  // dep array includes `pages`, which the editor mutates ~700 ms after every stroke, so on a board
  // being written to every stroke ran this effect's cleanup (`isActive = false`) and killed the chain
  // mid-flight — while `lastPrefetchKeyRef` then refused to restart it for the same page. The native
  // half warmed close to nothing during an actual lesson and cost a render or two of contention each
  // time. Deleted; the hook's chain (dedupe-first, idle-gated, abortable) is the only warmer now.
  useEffect(() => {
    if (!fabricCanvas || !currentPage?.pdfAssetId || currentPage.pdfPageIndex === undefined) {
      return;
    }

    // Desktop shell: usePdfPageImage owns warming. Nothing to do here.
    if (nativePdf?.isAvailable()) {
      return;
    }

    // Only re-run when the page actually changes (the effect also depends on `pages`, which mutates
    // on every stroke).
    const prefetchKey = `${currentPageIndex}:${currentPage.id}`;

    if (lastPrefetchKeyRef.current === prefetchKey) {
      return;
    }

    lastPrefetchKeyRef.current = prefetchKey;

    let isActive = true;
    // pdf.js rasterizes on the MAIN thread, so prefetch the single immediate next page only —
    // prefetching a heavy page here would freeze the UI.
    const prefetchPage = pages[currentPageIndex + 1];

    void (async () => {
      if (!prefetchPage?.pdfAssetId || prefetchPage.pdfPageIndex === undefined) {
        return;
      }

      const asset = await resolvePdfRenderableAsset(prefetchPage);

      if (!asset || !isActive) {
        return;
      }

      await prefetchPdfAssetPageImage({
        asset,
        containerHeight: fabricCanvas.getHeight(),
        containerWidth: fabricCanvas.getWidth(),
        pageIndex: prefetchPage.pdfPageIndex,
        workerSrc: pdfWorkerSrc,
        zoom,
      });
    })();

    return () => {
      isActive = false;
    };
  }, [currentPage, currentPageIndex, fabricCanvas, nativePdf, pages, pdfWorkerSrc, resolvePdfRenderableAsset, zoom]);

  useEffect(() => {
    if (!fabricCanvas) {
      setGeometryOverlay(null);
      setPinImageAction(null);

      return;
    }

    // The pin button follows the selection on exactly the machinery the geometry HUD already runs on
    // (selection + move/scale/modify), so it never drifts off the image it belongs to.
    const updateSelectionOverlays = (target?: FabricObject | null) => {
      const activeObject = target ?? fabricCanvas.getActiveObject() ?? null;
      const nextGeometry = activeObject ? describeGeometryObject(activeObject, fabricCanvas, locale) : null;
      const nextPinAction = describePinImageAction(activeObject, fabricCanvas);

      // Updater form + value equality: this runs once per rendered frame from `after:render` below,
      // and both describe* helpers allocate, so without the diff every frame with a selection on it
      // re-rendered the whole editor. Keeping `current` when nothing moved makes those frames free.
      setGeometryOverlay((current) => (isSameGeometryOverlay(current, nextGeometry) ? current : nextGeometry));
      setPinImageAction((current) => (isSamePinImageAction(current, nextPinAction) ? current : nextPinAction));
    };

    const handleSelectionChange = (event: { selected?: FabricObject[]; target?: FabricObject | null }) => {
      updateSelectionOverlays(event.selected?.[0] ?? event.target ?? null);
    };

    const handleSelectionClear = () => {
      setGeometryOverlay(null);
      setPinImageAction(null);
    };

    const handleObjectMoving = (event: { target?: FabricObject | null }) => {
      const target = event.target;

      if (!target) {
        return;
      }

      snapGeometryObjectPosition(target, fabricCanvas);
      updateSelectionOverlays(target);
    };

    const handleObjectRotating = (event: { target?: FabricObject | null }) => {
      const target = event.target;

      if (!target) {
        return;
      }

      snapGeometryObjectRotation(target);
      updateSelectionOverlays(target);
    };

    const handleObjectTransform = (event: { target?: FabricObject | null }) => {
      updateSelectionOverlays(event.target ?? null);
    };

    const handleAfterRender = () => {
      const activeObject = fabricCanvas.getActiveObject();

      if (!activeObject || !isGeometryInspectableObject(activeObject)) {
        return;
      }

      updateSelectionOverlays(activeObject);
    };

    fabricCanvas.on('selection:created', handleSelectionChange as never);
    fabricCanvas.on('selection:updated', handleSelectionChange as never);
    fabricCanvas.on('selection:cleared', handleSelectionClear as never);
    fabricCanvas.on('object:moving', handleObjectMoving as never);
    fabricCanvas.on('object:rotating', handleObjectRotating as never);
    fabricCanvas.on('object:scaling', handleObjectTransform as never);
    fabricCanvas.on('object:modified', handleObjectTransform as never);
    fabricCanvas.on('after:render', handleAfterRender as never);

    updateSelectionOverlays();

    return () => {
      fabricCanvas.off('selection:created', handleSelectionChange as never);
      fabricCanvas.off('selection:updated', handleSelectionChange as never);
      fabricCanvas.off('selection:cleared', handleSelectionClear as never);
      fabricCanvas.off('object:moving', handleObjectMoving as never);
      fabricCanvas.off('object:rotating', handleObjectRotating as never);
      fabricCanvas.off('object:scaling', handleObjectTransform as never);
      fabricCanvas.off('object:modified', handleObjectTransform as never);
      fabricCanvas.off('after:render', handleAfterRender as never);
    };
  }, [fabricCanvas, locale]);

  // --- Unpin chips: one «Pinned» badge per pinned image, only while the select tool is active ---
  // A pinned image is invisible to fabric, so it has no selection box and no controls of its own —
  // this chip is the ONLY way back out of the pinned state, which is why it also stands in for undo.
  useEffect(() => {
    if (!fabricCanvas) {
      setLockedImageChips([]);

      return;
    }

    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    // The last viewport we reacted to, copied out element-by-element rather than kept by reference:
    // fabric's pan path mutates `viewportTransform` in place, so holding the array would compare it
    // against itself and the chips would never reposition after a pan.
    const lastViewport: number[] = [...(fabricCanvas.viewportTransform ?? IDENTITY_VIEWPORT)];

    const refreshPinOverlays = () => {
      const nextChips =
        activeTool === 'select'
          ? getLockedImages(fabricCanvas).map((image) => describeLockedImageChip(image, fabricCanvas))
          : EMPTY_LOCKED_IMAGE_CHIPS;
      const nextPinAction = describePinImageAction(fabricCanvas.getActiveObject(), fabricCanvas);

      setLockedImageChips((current) => (isSameLockedImageChips(current, nextChips) ? current : nextChips));
      setPinImageAction((current) => (isSamePinImageAction(current, nextPinAction) ? current : nextPinAction));
    };

    const scheduleRefresh = () => {
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
      }

      settleTimer = setTimeout(() => {
        settleTimer = null;
        refreshPinOverlays();
      }, LOCKED_IMAGE_OVERLAY_SETTLE_MS);
    };

    // Runs on EVERY fabric render — i.e. every frame of every stroke, not just of a pan. The old
    // `.join(',')` allocated a string 60 times a second to answer a six-number comparison; compare
    // the numbers in place instead so a frame in which nothing panned costs nothing.
    const handleAfterRender = () => {
      const viewport = fabricCanvas.viewportTransform ?? IDENTITY_VIEWPORT;
      let moved = viewport.length !== lastViewport.length;

      for (let index = 0; index < viewport.length; index += 1) {
        if (lastViewport[index] !== viewport[index]) {
          moved = true;
          lastViewport[index] = viewport[index] as number;
        }
      }

      lastViewport.length = viewport.length;

      if (!moved) {
        return;
      }

      scheduleRefresh();
    };

    const unsubscribeFromLockChanges = onLockedImagesChanged(fabricCanvas, refreshPinOverlays);

    fabricCanvas.on('after:render', handleAfterRender as never);
    fabricCanvas.on('selection:created', refreshPinOverlays as never);
    fabricCanvas.on('selection:updated', refreshPinOverlays as never);
    fabricCanvas.on('selection:cleared', refreshPinOverlays as never);

    refreshPinOverlays();

    return () => {
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
      }

      unsubscribeFromLockChanges();
      fabricCanvas.off('after:render', handleAfterRender as never);
      fabricCanvas.off('selection:created', refreshPinOverlays as never);
      fabricCanvas.off('selection:updated', refreshPinOverlays as never);
      fabricCanvas.off('selection:cleared', refreshPinOverlays as never);
    };
  }, [activeTool, fabricCanvas]);

  // --- Load whiteboard from storage on mount ---
  useEffect(() => {
    if (!storage.isReady || !whiteboardId || hasLoadedRef.current) return;

    hasLoadedRef.current = true;

    storage
      .loadWhiteboard(whiteboardId)
      .then((doc) => {
        if (!doc) return;

        const compactedPages = compactPdfPreviewPages(doc.pages);

        setDocumentTitle(doc.title);
        setSharedBackgroundImageUrl(doc.sharedBackgroundImageUrl ?? '');
        setSharedBackgroundImageOpacity(doc.sharedBackgroundImageOpacity ?? 1);
        existingCreatedAtRef.current = doc.createdAt;
        // Carry the teacher tag through every autosave (see existingTeacherTagRef). Only keep fields
        // that are actually present so a save never writes an explicit `teacherId: undefined`.
        existingTeacherTagRef.current = {
          ...(doc.teacherId ? { teacherId: doc.teacherId } : {}),
          ...(doc.teacherType ? { teacherType: doc.teacherType } : {}),
          ...(doc.teacherName ? { teacherName: doc.teacherName } : {}),
        };
        // Seed the library thumbnail so routine autosaves don't blank it before the first exit.
        lastThumbnailRef.current = doc.thumbnail ?? '';

        if (compactedPages.length > 0) {
          const safePageIndex = Math.min(Math.max(doc.currentPageIndex, 0), compactedPages.length - 1);
          const pageToLoad = compactedPages[safePageIndex];
          const viewportZoom = doc.viewportZoom ?? DEFAULT_VIEWPORT_ZOOM;

          // Same write-through pattern as switchToPage: refs must not lag the canvas, or a
          // visibility/unload flush in the gap would persist the doc keyed off stale refs.
          pagesRef.current = compactedPages;
          currentPageIndexRef.current = safePageIndex;
          setPages(compactedPages);
          setCurrentPageIndex(safePageIndex);
          setBackgroundType(pageToLoad?.backgroundType ?? 'blank');
          // What is on disk right now IS this page list: seed the save baseline from it so the first
          // autosave diffs against it instead of rewriting every page of a 109-page board.
          lastFullSavedPagesRef.current = compactedPages.slice();
          lastFullSavedMetaRef.current = {
            sharedBackgroundImageOpacity: doc.sharedBackgroundImageOpacity ?? 1,
            sharedBackgroundImageUrl: doc.sharedBackgroundImageUrl || undefined,
            title: doc.title,
            viewportZoom,
          };
          lastFullSaveAtRef.current = Date.now();

          if (pageToLoad) {
            if (fabricCanvasRef.current) {
              void loadPage(pageToLoad, { viewportZoom });
            } else {
              pendingInitialPageRef.current = { page: pageToLoad, viewportZoom };
            }
          }
        }
      })
      .finally(() => {
        initialLoadSettledRef.current = true;
      });
  }, [loadPage, storage, storage.isReady, whiteboardId]);

  // --- Save current page state to the pages array ---
  const saveCurrentPage = useCallback(
    (
      sourcePages: WhiteboardPage[] = pagesRef.current,
      pageIndex: number = currentPageIndexRef.current,
      options?: { deferred?: boolean; includeThumbnail?: boolean; precomputedCanvasJSON?: string },
    ) => {
      const snapshotPages = snapshotPageFromCanvas(sourcePages, pageIndex, {
        includeThumbnail: options?.includeThumbnail,
        precomputedCanvasJSON: options?.precomputedCanvasJSON,
      });

      if (snapshotPages === sourcePages) {
        return snapshotPages;
      }

      pagesRef.current = snapshotPages;

      if (options?.deferred) {
        startTransition(() => {
          setPages(snapshotPages);
        });
      } else {
        setPages(snapshotPages);
      }

      return snapshotPages;
    },
    [snapshotPageFromCanvas],
  );

  // Deferred persist path. Coalesces rapid strokes (one idle fire per ~700ms quiet window) and runs
  // the heavy work OFF the input path via requestIdleCallback (setTimeout fallback). On fire we
  // serialize the canvas EXACTLY ONCE and feed that single JSON to both autosave (pages[i].canvasJSON)
  // and undo history — so canvas.toJSON()+stringify runs once per change instead of twice.
  const scheduleIdleThumbnailSnapshot = useCallback(
    (pageIndex: number = currentPageIndexRef.current) => {
      idleThumbnailPageIndexRef.current = pageIndex;

      const runSnapshot = (): void => {
        idleThumbnailTimerRef.current = null;

        if (idleThumbnailPageIndexRef.current !== currentPageIndexRef.current) {
          idleThumbnailPageIndexRef.current = null;

          return;
        }

        idleThumbnailPageIndexRef.current = null;

        const canvas = fabricCanvasRef.current;

        if (!canvas || isSyncingCanvasRef.current || isRestoringHistoryRef.current || isBatchRenderingRef.current) {
          return;
        }

        const scrollSession = scrollSessionRef.current;

        if (scrollSession) {
          perfSpan(
            'idle-snapshot',
            () => {
              const next = scrollSession.flush(pagesRef.current);

              if (next !== pagesRef.current) {
                pagesRef.current = next;
                startTransition(() => setPages(next));
              }

              isPageDirtyRef.current = false;
            },
            `scroll objects=${canvas.getObjects().length}`,
          );

          return;
        }

        perfSpan(
          'idle-snapshot',
          () => {
            const canvasJSON = serializeCanvasJson(canvas);

            saveCurrentPage(pagesRef.current, pageIndex, {
              deferred: true,
              includeThumbnail: true,
              precomputedCanvasJSON: canvasJSON,
            });
            isPageDirtyRef.current = false;
          },
          `objects=${canvas.getObjects().length}`,
        );
      };

      // Re-arm in place while a run is still owed: the quiet-idle ceiling is measured from the FIRST
      // stroke of the burst, so a stroke every half second cannot postpone the checkpoint forever.
      const pending = idleThumbnailTimerRef.current;

      if (pending && pending.isPending()) {
        pending.reschedule(runSnapshot);

        return;
      }

      idleThumbnailTimerRef.current = scheduleIdleSnapshot(runSnapshot, THUMBNAIL_IDLE_DELAY_MS);
    },
    [history, saveCurrentPage],
  );

  // Synchronous flush (page switch / save / blur). Serializes once, pushes the same JSON to history so
  // undo stays correct, and cancels any pending idle task to avoid a duplicate serialization.
  const flushCurrentPageSnapshot = useCallback(
    (sourcePages: WhiteboardPage[] = pagesRef.current, pageIndex: number = currentPageIndexRef.current) => {
      clearScheduledIdleThumbnailSnapshot();
      // The gesture just finished becomes its undo step before the page is written or left.
      history.commitNow();

      const scrollSession = scrollSessionRef.current;

      if (scrollSession) {
        const next = scrollSession.flush(sourcePages);

        if (next !== sourcePages) {
          pagesRef.current = next;
          setPages(next);
        }

        isPageDirtyRef.current = false;

        return next;
      }

      const canvas = fabricCanvasRef.current;

      if (!canvas || isSyncingCanvasRef.current || isRestoringHistoryRef.current || isBatchRenderingRef.current) {
        return saveCurrentPage(sourcePages, pageIndex, { includeThumbnail: true });
      }

      // Fast path: nothing was drawn/edited since the last serialization (the idle autosave already
      // captured this page), so its stored canvasJSON is current. Skip the expensive toJSON()+stringify
      // — that was the dominant per-page-switch cost. Pan/zoom does not fire object mutations, so we
      // still capture the (cheap) viewport here; otherwise returning to this page would lose its scroll.
      if (!isPageDirtyRef.current) {
        const activePage = sourcePages[pageIndex];

        if (!activePage) {
          return sourcePages;
        }

        // Same capture as snapshotPageFromCanvas (geometry record + frame-relative viewport), so a
        // clean page still picks up canvasWidthPx / pdfPlacement when the teacher merely flips
        // through an older board.
        const {
          page: geometryPatchedPage,
          viewportOffsetX: offsetX,
          viewportOffsetY: offsetY,
          viewportZoom,
        } = captureSnapshotState({
          canvasWidth:
            notebookPageRef.current?.pageId === activePage.id ? notebookPageRef.current.frameWidth : canvas.getWidth(),
          defaultZoom: DEFAULT_VIEWPORT_ZOOM,
          page: activePage,
          pdfFrame: pdfBackgroundFrameRef.current,
          viewportTransform: canvas.viewportTransform ?? IDENTITY_VIEWPORT,
        });

        if (
          geometryPatchedPage !== activePage ||
          activePage.viewportOffsetX !== offsetX ||
          activePage.viewportOffsetY !== offsetY ||
          activePage.viewportZoom !== viewportZoom
        ) {
          const nextPages = sourcePages.map((page, index) =>
            index === pageIndex
              ? { ...geometryPatchedPage, viewportOffsetX: offsetX, viewportOffsetY: offsetY, viewportZoom }
              : page,
          );

          pagesRef.current = nextPages;

          // Newly recorded geometry is worth a durable save on its own (the backend reads it), unlike
          // a viewport-only change; this is what lets an old board self-heal without a stroke.
          if (geometryPatchedPage !== activePage) {
            needsPersistRef.current = true;
          }

          return nextPages;
        }

        return sourcePages;
      }

      const canvasJSON = serializeCanvasJson(canvas);
      const snapshotPages = saveCurrentPage(sourcePages, pageIndex, {
        includeThumbnail: true,
        precomputedCanvasJSON: canvasJSON,
      });

      isPageDirtyRef.current = false;

      return snapshotPages;
    },
    [clearScheduledIdleThumbnailSnapshot, history, saveCurrentPage],
  );

  const handleCanvasMutation = useCallback(() => {
    if (isSyncingCanvasRef.current || isRestoringHistoryRef.current || isBatchRenderingRef.current) return;

    isPageDirtyRef.current = true;
    // Mark the page as needing a durable save. Unlike isPageDirtyRef (which the idle in-memory
    // snapshot clears ~700ms later), this stays set until persistSnapshotNow writes to IndexedDB.
    needsPersistRef.current = true;
    // One undo step per gesture: the history checkpoints when the contact lifts (cheap — only the
    // objects that changed are serialized); the heavy page snapshot below stays deferred to idle.
    history.noteMutation();
    scheduleIdleThumbnailSnapshot(currentPageIndexRef.current);
  }, [history, scheduleIdleThumbnailSnapshot]);

  // Pinning flips flags on an object rather than adding/removing one, so fabric reports NO modification
  // and the page would look unchanged to autosave — the pin would be lost on the next open. Route the
  // lock-change notification into the SAME debounced snapshot every stroke uses, so a pin/unpin from any
  // source (chip, button, history restore) persists. handleCanvasMutation self-guards while a page load
  // or history restore is in flight, so re-asserted invariants never mark a page falsely dirty.
  useEffect(() => {
    if (!fabricCanvas) {
      return;
    }

    return onLockedImagesChanged(fabricCanvas, handleCanvasMutation);
  }, [fabricCanvas, handleCanvasMutation]);

  // Error-boundary crash handler. A corrupt page's canvasJSON or a broken PDF asset throwing during
  // render must not lose the in-flight ink: best-effort flush the current page's snapshot through the
  // EXISTING flush path (which persists to storage via the autosave document), then swallow any error
  // so the fallback still renders. Reused by both the editor-level and per-page boundaries.
  const handleEditorBoundaryError = useCallback(() => {
    try {
      flushCurrentPageSnapshot();
      void persistSnapshotNow({ includeThumbnail: true });
    } catch {
      // A crash mid-serialization must not re-throw out of the boundary — drop the flush and recover.
    }
  }, [flushCurrentPageSnapshot, persistSnapshotNow]);

  // Expose the flush-on-crash handler to the editor-level boundary (which lives outside this
  // component, so it cannot reach the flush path directly). Reuses the same path — no new serializer.
  useEffect(() => {
    if (!flushOnCrashRef) {
      return;
    }

    flushOnCrashRef.current = handleEditorBoundaryError;

    return () => {
      flushOnCrashRef.current = null;
    };
  }, [flushOnCrashRef, handleEditorBoundaryError]);

  // Expose an AWAITABLE flush so the desktop shell can save the latest edits to
  // disk before the window closes (the `beforeunload` handler above can only
  // fire-and-forget — on Tauri the process dies before that async save commits).
  // Reuses the same snapshot path as autosave/back; includes a thumbnail.
  useEffect(() => {
    if (!flushBeforeCloseRef) {
      return;
    }

    // The Rust shell intercepts the window close and waits for this to resolve, so the window stays
    // open long enough to show the "saving…" overlay while the final snapshot reaches disk.
    flushBeforeCloseRef.current = async () => {
      setIsExitSaving(true);

      try {
        await persistSnapshotNow({ includeThumbnail: true });
      } finally {
        setIsExitSaving(false);
      }
    };

    return () => {
      flushBeforeCloseRef.current = null;
    };
  }, [flushBeforeCloseRef, persistSnapshotNow]);

  useEffect(() => clearScheduledIdleThumbnailSnapshot, [clearScheduledIdleThumbnailSnapshot]);

  useEffect(() => {
    setIsQuickGestureMenuOpen(false);
    setOpenToolSettings(null);
  }, [currentPageIndex]);

  // --- Switch page ---
  const switchToPage = useCallback(
    async (index: number) => {
      // A publish/export sweep owns the canvas; navigating would corrupt the exported pages.
      if (isBatchRenderingRef.current) return;
      if (index === currentPageIndexRef.current) return;
      if (index < 0 || index >= pagesRef.current.length) return;

      const __t0 = performance.now();
      const previousIndex = currentPageIndexRef.current;
      const syncedPages = flushCurrentPageSnapshot();
      const __tFlush = performance.now();
      const targetPage = syncedPages[index];

      if (!targetPage) return;

      // Stepping to the NEXT page is the only navigation PowerPoint animates. Snapshot the page
      // being left BEFORE the load replaces it, and keep it on screen until the transition (or the
      // lack of one) is decided — see WhiteboardCanvas's capturePrevious.
      //
      // Only for a page that actually HAS something: the hold costs the length of the page load,
      // with the ink hidden, so a page with neither a clip nor a transition must never pay it. The
      // answer has to be synchronous, which is what `peekPageIntro` is for; without it, nothing is
      // ever captured and navigation behaves exactly as it did before slide intros existed.
      const isForwardStep = index === previousIndex + 1;

      nextEnterIsForwardRef.current = isForwardStep;

      if (isForwardStep) {
        const waiting = peekPageIntro?.(targetPage.id);

        if (waiting?.hasClip || waiting?.hasTransition) {
          pageTransitionRef.current?.capturePrevious();
        }
      }

      // Commit the page pointer synchronously BEFORE the async load. loadPage raises
      // isSyncingCanvasRef in this same tick, so no snapshot writer (rapid second click,
      // debounced autosave, visibility flush) can ever pair the canvas content with a stale
      // index — that pairing is what used to file one page's content under another's slot.
      pagesRef.current = syncedPages;
      currentPageIndexRef.current = index;
      setPages(syncedPages);
      setCurrentPageIndex(index);
      setBackgroundType(targetPage.backgroundType);

      await loadPage(targetPage);
      recordPerf(
        `switch → ${index}`,
        performance.now() - __t0,
        `flush=${(__tFlush - __t0).toFixed(0)} load=${(performance.now() - __tFlush).toFixed(0)}${targetPage.pdfAssetId ? ' pdf' : ''} ink=${Math.round((targetPage.canvasJSON?.length ?? 0) / 1024)}kb`,
      );
    },
    [flushCurrentPageSnapshot, loadPage, peekPageIntro],
  );

  // Navigate to a page: scroll to it in the continuous layout, switch to it in the paged layout.
  const navigateToPage = useCallback(
    (index: number) => {
      const session = scrollSessionRef.current;

      if (session) {
        scrollDrivenIndexRef.current = -1;
        session.syncPages(pagesRef.current);
        viewportConstraintsRef.current = session.getConstraints();
        void session.enter(index);

        return;
      }

      void switchToPage(index);
    },
    [switchToPage],
  );


  const handleOpenToolSettings = useCallback((tool: 'pen' | 'eraser' | 'highlighter' | null) => {
    setOpenToolSettings(tool);
  }, []);

  // The highlighter keeps its OWN colour: entering it parks the pen colour and swaps the highlighter's
  // in; leaving it remembers the highlighter colour (per device) and gives the pen its colour back.
  const previousToolRef = useRef<WhiteboardTool>(activeTool);
  const parkedPenColorRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousToolRef.current;
    previousToolRef.current = activeTool;
    if (previous === activeTool) return;
    if (activeTool === 'highlighter') {
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem('whiteboard-highlighter-color');
      } catch {
        stored = null;
      }
      setStrokeSettings((current) => {
        parkedPenColorRef.current = current.color;
        return { ...current, color: stored || '#ffd60a' };
      });
    } else if (previous === 'highlighter' && (isPenFamilyTool(activeTool) || parkedPenColorRef.current)) {
      setStrokeSettings((current) => {
        try {
          window.localStorage.setItem('whiteboard-highlighter-color', current.color);
        } catch {
          /* private mode: the colour just is not remembered */
        }
        const pen = parkedPenColorRef.current;
        parkedPenColorRef.current = null;
        return pen ? { ...current, color: pen } : current;
      });
    }
  }, [activeTool]);

  const handleToolChange = useCallback((nextTool: WhiteboardTool) => {
    setIsQuickGestureMenuOpen(false);
    setOpenToolSettings((current) => {
      if (!current) return current;

      // The brush and marker are picked from INSIDE the pen popover, so selecting one must not close the
      // popover they were selected from — the teacher could never then reach that nib's colour or width.
      if (current === 'pen' && isPenFamilyTool(nextTool)) return current;

      return current !== nextTool ? null : current;
    });
    setActiveTool((currentTool) => {
      if ((nextTool === 'pan' || nextTool === 'eraser') && currentTool === nextTool) {
        return lastPrimaryToolRef.current;
      }

      if (nextTool !== 'pan' && nextTool !== 'eraser') {
        lastPrimaryToolRef.current = nextTool;
      }

      return nextTool;
    });
  }, []);

  const handleQuickGestureMenuOpen = useCallback(() => {
    // The trigger opens the menu at the trigger, never at an earlier pen-button spot.
    setPenButtonMenuAnchor(null);
    startTransition(() => {
      setIsQuickGestureMenuOpen(true);
    });
  }, []);

  const handleQuickGestureMenuClose = useCallback(() => {
    setIsQuickGestureMenuOpen(false);
    setPenButtonMenuAnchor(null);
  }, []);

  // Dragging the hub is an explicit move: it leaves the pen-button spot and moves the saved anchor.
  const handleQuickMenuAnchorChange = useCallback(
    (anchor: { x: number; y: number }, commit: boolean) => {
      setPenButtonMenuAnchor(null);
      setQuickPenAnchor(anchor, commit);
    },
    [setQuickPenAnchor],
  );

  // The S Pen button pressed while hovering: open the menu AT the pen (a transient spot — the saved
  // trigger anchor never moves), or close it when it is already showing.
  const handlePenButtonQuickMenu = useCallback((anchor?: { x: number; y: number }) => {
    // The ref is re-read from state on render, but the open below is a transition that may not have
    // rendered yet when the next edge arrives: record the intent now so two quick toggles alternate.
    if (isQuickGestureMenuOpenRef.current) {
      isQuickGestureMenuOpenRef.current = false;
      setIsQuickGestureMenuOpen(false);
      setPenButtonMenuAnchor(null);

      return;
    }

    isQuickGestureMenuOpenRef.current = true;
    setPenButtonMenuAnchor(anchor ?? null);
    startTransition(() => {
      setIsQuickGestureMenuOpen(true);
    });
  }, []);

  const handleQuickToolToggle = useCallback(() => {
    startTransition(() => {
      setIsQuickGestureMenuOpen(false);
      setActiveTool((currentTool) => {
        if (currentTool === 'eraser') {
          const fallbackTool = lastPrimaryToolRef.current === 'eraser' ? 'pen' : lastPrimaryToolRef.current;

          return fallbackTool === 'pan' ? 'pen' : fallbackTool;
        }

        return 'eraser';
      });
    });
  }, []);

  const handleQuickStrokeColorChange = useCallback((color: string) => {
    // Keep whichever nib is active. Hard-selecting 'pen' here dropped a teacher who was mid-brush back
    // to the plain pen the moment they changed colour or width — and wiped lastPrimaryToolRef with it, so
    // the barrel-button erase/restore could not bring the brush back either.
    setActiveTool((currentTool) => {
      const nextTool = resolveQuickPenTool(currentTool, lastPrimaryToolRef.current);

      lastPrimaryToolRef.current = nextTool;

      return nextTool;
    });
    setStrokeSettings((currentSettings) => ({
      ...currentSettings,
      color,
    }));
  }, []);

  const handleQuickStrokeWidthChange = useCallback((width: number) => {
    // Keep whichever nib is active. Hard-selecting 'pen' here dropped a teacher who was mid-brush back
    // to the plain pen the moment they changed colour or width — and wiped lastPrimaryToolRef with it, so
    // the barrel-button erase/restore could not bring the brush back either.
    setActiveTool((currentTool) => {
      const nextTool = resolveQuickPenTool(currentTool, lastPrimaryToolRef.current);

      lastPrimaryToolRef.current = nextTool;

      return nextTool;
    });
    setStrokeSettings((currentSettings) => ({
      ...currentSettings,
      width,
    }));
  }, []);

  const handleQuickStrokeColorCycle = useCallback(() => {
    setActiveTool((currentTool) => {
      const nextTool = resolveQuickPenTool(currentTool, lastPrimaryToolRef.current);

      lastPrimaryToolRef.current = nextTool;

      return nextTool;
    });
    setStrokeSettings((currentSettings) => {
      const currentIndex = QUICK_GESTURE_COLORS.findIndex(
        (color) => color.toLowerCase() === currentSettings.color.toLowerCase(),
      );
      const nextColor = QUICK_GESTURE_COLORS[(currentIndex + 1) % QUICK_GESTURE_COLORS.length];

      return {
        ...currentSettings,
        color: nextColor ?? currentSettings.color,
      };
    });
  }, []);

  // Binary swap of the active (primary) color with the secondary slot — driven by the pen COLOR
  // barrel button (edge-triggered upstream in useWhiteboardCanvas, so this fires once per press).
  // Distinct from handleQuickStrokeColorCycle (the 6-color mouse-gesture cycle): this is a latching
  // primary<->secondary flip and does NOT force the active tool to pen, so a COLOR press mid-erase
  // (or while another tool is active) just swaps the slots without changing what you're doing.
  const handleQuickStrokeColorToggle = useCallback(() => {
    setStrokeSettings((currentSettings) => ({
      ...currentSettings,
      color: currentSettings.secondaryColor,
      secondaryColor: currentSettings.color,
    }));
  }, []);

  const handleStrokeSettingsChange = useCallback(
    (nextSettings: StrokeSettings) => {
      setStrokeSettings((currentSettings) => ({
        ...currentSettings,
        color: nextSettings.color,
        secondaryColor: nextSettings.secondaryColor,
        width: nextSettings.width,
        opacity: activeTool === 'highlighter' ? currentSettings.opacity : nextSettings.opacity,
        lineShape: nextSettings.lineShape,
        dashed: nextSettings.dashed,
      }));
    },
    [activeTool],
  );

  // A new page starts on the host's default paper spacing (only where spacing is offered at all).
  const withDefaultPaperSpacing = useCallback(
    (page: WhiteboardPage): WhiteboardPage => {
      const mm = allowPaperSpacing ? resolveDefaultPaperSpacingMm(defaultPaperSpacingMm, page.backgroundType) : undefined;

      return mm === undefined ? page : { ...page, paperSpacingMm: mm };
    },
    [allowPaperSpacing, defaultPaperSpacingMm],
  );

  const insertPageAt = useCallback(
    async (insertAt: number) => {
      if (isBatchRenderingRef.current) return;

      const syncedPages = flushCurrentPageSnapshot();
      const newPage = withDefaultPaperSpacing(createBlankWhiteboardPage(backgroundType));
      const { insertedIndex, pages: nextPages } = insertWhiteboardPageAt(syncedPages, newPage, insertAt);

      pagesRef.current = nextPages;
      currentPageIndexRef.current = insertedIndex;
      setPages(nextPages);
      setCurrentPageIndex(insertedIndex);
      setBackgroundType(newPage.backgroundType);
      await loadPage(newPage);
    },
    [backgroundType, flushCurrentPageSnapshot, loadPage, withDefaultPaperSpacing],
  );

  // --- Add new blank page ---
  const addPage = useCallback(async () => {
    await insertPageAt(currentPageIndexRef.current + 1);
  }, [insertPageAt]);

  // --- Blank writing sheets among PDF pages (allowInsertBlankPages) ---
  // A sheet is just a page: its ink is page-local like every page's, so inserting one only restacks
  // the pages after it. Sized like the page in view (the session's live aspect, raster-corrected).
  const insertBlankSheet = useCallback(
    async (where: 'after' | 'end') => {
      if (isBatchRenderingRef.current) return;

      const syncedPages = flushCurrentPageSnapshot();
      const anchorIndex = where === 'end' ? syncedPages.length - 1 : currentPageIndexRef.current;
      const anchor = syncedPages[anchorIndex];

      if (!anchor) return;

      const liveAspect = scrollSessionRef.current?.layout.entries[anchorIndex]?.aspect;
      const aspect = liveAspect ?? resolvePdfPageAspect(anchor);
      const newPage = createInsertedSheet(
        aspect,
        blankPagePaper,
        allowPaperSpacing ? resolveDefaultPaperSpacingMm(defaultPaperSpacingMm, blankPagePaper) : undefined,
      );
      const insertAt = where === 'end' ? syncedPages.length : resolveSheetInsertIndex(syncedPages, anchorIndex);
      const { insertedIndex, pages: nextPages } = insertWhiteboardPageAt(syncedPages, newPage, insertAt);

      // The continuous layout's document-wide history: «undo» takes the sheet back out.
      if (scrollSessionRef.current) history.recordPageInsert(newPage, insertedIndex);

      pagesRef.current = nextPages;
      currentPageIndexRef.current = insertedIndex;
      needsPersistRef.current = true;
      setPages(nextPages);
      setCurrentPageIndex(insertedIndex);
      setBackgroundType(newPage.backgroundType);
      await loadPage(newPage);
    },
    [allowPaperSpacing, blankPagePaper, defaultPaperSpacingMm, flushCurrentPageSnapshot, history, loadPage],
  );

  // --- Board AI -------------------------------------------------------------------------------------
  // The layer owns the lasso, panel and insertion; the editor only lends it rendering and pages.
  const [aiCommand, setAiCommand] = useState<{ command: BoardAiCommand; nonce: number } | null>(null);
  const [isAiLassoActive, setIsAiLassoActive] = useState(false);
  // «Similar copy» generating on screen → the board chrome steps aside (ai/generatingState).
  const [remakeInfo, setRemakeInfo] = useState<RemakeGeneratingInfo | null>(null);
  const aiChromeHidden = remakeInfo?.chromeHidden ?? false;
  const remakeBusyPage = useMemo(() => (remakeInfo?.generating ? { pageId: remakeInfo.pageId, orb: remakeInfo.orb } : null), [remakeInfo]);
  const aiChromeReportRef = useRef(onAiGeneratingChromeChange);

  aiChromeReportRef.current = onAiGeneratingChromeChange;

  useEffect(() => {
    aiChromeReportRef.current?.(aiChromeHidden);
  }, [aiChromeHidden]);

  useEffect(() => () => aiChromeReportRef.current?.(false), []);
  const sendAiCommand = useCallback((command: BoardAiCommand) => {
    setAiCommand((current) => ({ command, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  // --- Selection action bar: colour, copy/cut/duplicate/delete, paste ---
  const selectionActions = useSelectionActions({
    activeTool,
    canvas: fabricCanvas,
    enabled: !readOnly,
    sceneTransformAt: (sceneY) => scrollSessionRef.current?.sceneTransformAt(sceneY) ?? { scale: 1, dx: 0, dy: 0 },
    onSelectTool: () => handleToolChange('select'),
    selectionShape,
    marquee: SELECTION_MARQUEE[selectionChrome],
  });

  // «Straighten»: the paper's rules come from the page under the selection — the current page's
  // pattern (rules at multiples of its spacing) or, in the continuous layout, the sheet the selection's
  // centre is on; strokes on other pages are left out, since history is document-scoped there.
  const handleStraightenSelection = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    const bounds = canvas ? selectionSceneBounds(canvas) : null;

    if (!canvas || !bounds) return;

    const session = scrollSessionRef.current && !scrollSessionRef.current.suspended ? scrollSessionRef.current : null;

    if (!session) {
      straightenSelection(canvas, { rules: boardRuleGrid(pagesRef.current[currentPageIndexRef.current]) });

      return;
    }

    const entry = session.layout.entries[findPdfScrollPageAt(session.layout, bounds.top + bounds.height / 2)];
    const page = entry ? pagesRef.current.find((candidate) => candidate.id === entry.pageId) : undefined;

    if (!entry || !page) return;

    straightenSelection(canvas, {
      rules: isInsertedSheet(page) ? sheetRuleGrid(entry, session.layout.width, page) : null,
      within: { top: entry.top, bottom: entry.top + entry.height },
    });
  }, []);
  const canStraighten = straightenInk && !readOnly && !!fabricCanvas && !!selectionActions.selectionBox && selectedInkStrokes(fabricCanvas).length >= 2;

  // --- Crop a picture -------------------------------------------------------------------------------
  // Non-destructive: the picture keeps its whole source; crop mode only picks the part it draws
  // (`cropX`/`cropY`/`width`/`height`), so a later crop can widen it back out. Nothing changes until
  // «Done», which is one `object:modified` — one undo step, saved like any other edit.
  const [cropTarget, setCropTarget] = useState<FabricImage | null>(null);
  const croppableImage = (() => {
    if (readOnly || !fabricCanvas || !selectionActions.selectionBox) return null;

    const active = fabricCanvas.getActiveObject();
    const stencil = (active as (FabricObject & { data?: { isGeometryStencil?: boolean } }) | undefined)?.data?.isGeometryStencil;

    return active instanceof FabricImage && !isLockedImage(active) && !stencil && fabricCanvas.getActiveObjects().length === 1 ? active : null;
  })();

  // One picture (not a stencil) is the whole selection: host actions scoped to `picture` show, `other` ones hide.
  const selectedPicture = (() => {
    if (readOnly || !fabricCanvas || !selectionActions.selectionBox) return false;

    const active = fabricCanvas.getActiveObject();
    const stencil = (active as (FabricObject & { data?: { isGeometryStencil?: boolean } }) | undefined)?.data?.isGeometryStencil;

    return active instanceof FabricImage && !stencil && fabricCanvas.getActiveObjects().length === 1;
  })();

  const handleStartCrop = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    const image = canvas?.getActiveObject();

    if (!canvas || !(image instanceof FabricImage)) return;

    // The selection frame, its bar and the pin chip all hang off the active object: drop it while cropping.
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    setCropTarget(image);
  }, []);

  const finishCrop = useCallback((rect: { x: number; y: number; width: number; height: number } | null) => {
    const canvas = fabricCanvasRef.current;
    const image = cropTarget;

    setCropTarget(null);

    if (!canvas || !image || !canvas.getObjects().includes(image)) return;

    if (rect && !isSameCrop(image, rect)) {
      const result = cropResult(image.calcTransformMatrix(), image, rect);

      image.set({ cropX: result.cropX, cropY: result.cropY, width: result.width, height: result.height });
      image.setPositionByOrigin(new Point(result.center.x, result.center.y), 'center', 'center');
      image.setCoords();
      image.set('dirty', true);
      canvas.fire('object:modified', { target: image } as never);
      invalidateInkBake(canvas);
    }

    canvas.setActiveObject(image);
    canvas.requestRenderAll();
  }, [cropTarget]);

  // The picture left the board under the overlay (undo, a page switch, a reload): crop mode ends.
  useEffect(() => {
    if (!fabricCanvas || !cropTarget) return undefined;

    const check = () => {
      if (!fabricCanvas.getObjects().includes(cropTarget)) setCropTarget(null);
    };

    fabricCanvas.on('after:render', check);
    fabricCanvas.on('object:removed', check);

    return () => {
      fabricCanvas.off('after:render', check);
      fabricCanvas.off('object:removed', check);
    };
  }, [cropTarget, fabricCanvas]);

  useEffect(() => {
    if (!fabricCanvas || selectionChrome !== 'modern') return undefined;

    return installModernSelectionChrome(fabricCanvas);
  }, [fabricCanvas, selectionChrome]);
  const selectionPalette = useMemo(
    () => dedupeColors([...DEFAULT_COLORS, ...recentColors, strokeSettings.color]),
    [recentColors, strokeSettings.color],
  );

  /**
   * One scene rectangle of the CURRENT page → canvas, composited exactly like an export: board
   * colour + pattern, the PDF/image page, pinned images, then ink. With `objects`, just those
   * objects on white (the selection chip). Same identity-viewport trick as
   * `createPageExportSnapshot`, synchronous around `toCanvasElement`, so nothing flickers.
   */
  const renderAiRegion = useCallback(
    async ({ region, scale, objects, layers = 'all' }: BoardAiRenderRequest): Promise<HTMLCanvasElement | null> => {
      const canvas = fabricCanvasRef.current;
      const page = pagesRef.current[currentPageIndexRef.current];

      if (!canvas || !page) return null;

      const generation = loadGenerationRef.current;
      // Continuous layout: the scene is the whole stack of pages, not the current page at the origin —
      // the region's background is painted by the session (every page it crosses, at its own place).
      const scrollSession = scrollSessionRef.current && !scrollSessionRef.current.suspended ? scrollSessionRef.current : null;
      const pdfPageImage = objects || scrollSession ? null : await loadCanvasImage(await resolvePdfPageImageUrl(page, 'export'));

      if (generation !== loadGenerationRef.current || fabricCanvasRef.current !== canvas) return null;

      const width = Math.max(1, Math.round(region.width * scale));
      const height = Math.max(1, Math.round(region.height * scale));
      const output = document.createElement('canvas');

      output.width = width;
      output.height = height;

      const context = output.getContext('2d');

      if (!context) return null;

      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);

      const regionTransform: [number, number, number, number, number, number] = [
        scale,
        0,
        0,
        scale,
        -region.left * scale,
        -region.top * scale,
      ];

      if (!objects && scrollSession) {
        // Gaps, sheets and every crossed page's raster, through the same scene→pixel map as the ink.
        scrollSession.paint(context, pdfScrollRegionPaintArgs(region, scale));
        drawLockedImages(context, getLockedImages(canvas), [1, 0, 0, 1, -region.left, -region.top], scale);
      } else if (!objects) {
        const patternCanvas = document.createElement('canvas');

        drawBackgroundPattern(
          patternCanvas,
          page.backgroundType,
          region.width,
          region.height,
          { spacing: boardPatternSpacingPx(page), viewportTransform: [1, 0, 0, 1, -region.left, -region.top] },
          scale,
        );
        context.drawImage(patternCanvas, 0, 0, width, height);

        if (pdfPageImage) {
          const pdfFrame = resolvePageExportFrame({
            live: { height: canvas.getHeight(), width: canvas.getWidth() },
            page,
            pinned: pdfBackgroundFrameRef.current,
          });

          drawScreenFitImage(
            context,
            pdfFrame.width,
            pdfFrame.height,
            pdfPageImage,
            pdfPageImage.naturalWidth || pdfPageImage.width || pdfFrame.width,
            pdfPageImage.naturalHeight || pdfPageImage.height || pdfFrame.height,
            1,
            regionTransform,
            'high',
            1,
            normalizeRotationDeg(page.pdfRotation),
          );
        }

        drawLockedImages(context, getLockedImages(canvas), [1, 0, 0, 1, -region.left, -region.top], scale);
      }

      // Background only (the remake snapshot): no ink, shapes, AI objects — pinned pictures were drawn above.
      if (layers === 'background' && !objects) return output;

      const only = objects ? new Set<unknown>(objects) : null;
      const originalViewport = [...(canvas.viewportTransform ?? IDENTITY_VIEWPORT)] as typeof IDENTITY_VIEWPORT;

      canvas.setViewportTransform([...IDENTITY_VIEWPORT]);

      try {
        const ink = canvas.toCanvasElement(scale, {
          filter: (object) =>
            only
              ? only.has(object)
              : !(object as FabricObject & { excludeFromExport?: boolean }).excludeFromExport,
          height: region.height,
          left: region.left,
          top: region.top,
          width: region.width,
        });

        context.drawImage(ink, 0, 0, width, height);
      } finally {
        canvas.setViewportTransform(originalViewport);
        canvas.requestRenderAll();
      }

      return output;
    },
    [loadCanvasImage, resolvePdfPageImageUrl],
  );


  const insertPageRelative = useCallback(
    async (index: number, position: 'after' | 'before') => {
      await insertPageAt(position === 'before' ? index : index + 1);
    },
    [insertPageAt],
  );

  // --- Delete page ---
  const deletePage = useCallback(
    async (index: number) => {
      if (isBatchRenderingRef.current) return;

      const syncedPages = flushCurrentPageSnapshot();

      if (syncedPages.length <= 1) return;

      const newPages = syncedPages.filter((_, i) => i !== index);
      const activeIndex = currentPageIndexRef.current;
      let newIndex = activeIndex;

      if (index <= activeIndex) {
        newIndex = Math.max(0, activeIndex - 1);
      }

      newIndex = Math.min(newIndex, newPages.length - 1);
      const nextPage = newPages[newIndex];

      if (!nextPage) return;

      pagesRef.current = newPages;
      currentPageIndexRef.current = newIndex;
      setPages(newPages);
      setCurrentPageIndex(newIndex);
      setBackgroundType(nextPage.backgroundType);

      await loadPage(nextPage);
    },
    [flushCurrentPageSnapshot, loadPage],
  );

  // Only an inserted sheet can be deleted from the blank-page menu, never a PDF page.
  const deleteBlankSheet = useCallback(async () => {
    const index = currentPageIndexRef.current;

    if (!isInsertedSheet(pagesRef.current[index])) return;

    // Recorded with its ink as of now, so «undo» puts the sheet back exactly as it was.
    const sheet = flushCurrentPageSnapshot()[index];

    if (sheet && scrollSessionRef.current) history.recordPageDelete(sheet, index);

    // A page leaving the list is a document change the autosave must write (and upload) even though
    // no ink changed; deletePage alone leaves the save gate closed.
    await deletePage(index);
    needsPersistRef.current = true;
  }, [deletePage, flushCurrentPageSnapshot, history]);

  // Undo/redo of a sheet insert/delete (see useWhiteboardHistory's applyPageListChange).
  applyHistoryPageListChangeRef.current = async (action, entry) => {
    if (isBatchRenderingRef.current) return false;

    if (action === 'remove') {
      const index = pagesRef.current.findIndex((page) => page.id === entry.pageId);

      if (index < 0 || pagesRef.current.length <= 1) return false;

      await deletePage(index);
      needsPersistRef.current = true;

      return !pagesRef.current.some((page) => page.id === entry.pageId);
    }

    if (pagesRef.current.some((page) => page.id === entry.pageId)) return false;

    const syncedPages = flushCurrentPageSnapshot();
    const { insertedIndex, pages: nextPages } = insertWhiteboardPageAt(
      syncedPages,
      entry.page,
      Math.min(entry.index, syncedPages.length),
    );

    pagesRef.current = nextPages;
    currentPageIndexRef.current = insertedIndex;
    needsPersistRef.current = true;
    setPages(nextPages);
    setCurrentPageIndex(insertedIndex);
    setBackgroundType(entry.page.backgroundType);
    await loadPage(entry.page);

    return true;
  };

  const currentSheetHasInk = useCallback(() => {
    const synced = flushCurrentPageSnapshot();
    const page = synced[currentPageIndexRef.current];

    return Boolean(page && pageHasInk(page));
  }, [flushCurrentPageSnapshot]);

  // PDF pages keep their own numbers; sheets read «3a». Identical to index + 1 without sheets.
  const pageLabels = useMemo(() => (allowInsertBlankPages ? resolvePageLabels(pages) : null), [allowInsertBlankPages, pages]);
  const currentPageLabel = pageLabels?.[currentPageIndex] ?? String(currentPageIndex + 1);

  // --- Duplicate page ---
  const duplicatePage = useCallback(
    async (index: number) => {
      if (isBatchRenderingRef.current) return;

      const syncedPages = flushCurrentPageSnapshot();
      const sourcePage = syncedPages[index];

      if (!sourcePage) return;

      const clonedPage: WhiteboardPage = {
        id: createWhiteboardId(),
        canvasJSON: sourcePage.canvasJSON,
        thumbnail: sourcePage.thumbnail,
        backgroundType: sourcePage.backgroundType,
        // Same paper, same size: a duplicated sheet stays a sheet, its ruling stays its ruling.
        ...(sourcePage.paperSpacingMm !== undefined ? { paperSpacingMm: sourcePage.paperSpacingMm } : {}),
        ...(sourcePage.sheetAspect !== undefined ? { sheetAspect: sourcePage.sheetAspect } : {}),
        pdfAssetId: sourcePage.pdfAssetId,
        pdfFingerprint: sourcePage.pdfFingerprint,
        pdfPageIndex: sourcePage.pdfPageIndex,
        pdfSourcePageNumber: sourcePage.pdfSourcePageNumber,
        pdfImageUrl: sourcePage.pdfAssetId ? undefined : sourcePage.pdfImageUrl,
        pdfSourceName: sourcePage.pdfSourceName,
        // Same ink, same background → same frame. Copied so the clone is renderable server-side
        // before it is ever opened (the next snapshot of the clone re-records them anyway).
        canvasWidthPx: sourcePage.canvasWidthPx,
        pdfPlacement: sourcePage.pdfPlacement,
        viewportOffsetX: 0,
        viewportOffsetY: 0,
      };

      const insertAt = index + 1;
      const newPages = [...syncedPages.slice(0, insertAt), clonedPage, ...syncedPages.slice(insertAt)];

      pagesRef.current = newPages;
      currentPageIndexRef.current = insertAt;
      setPages(newPages);
      setCurrentPageIndex(insertAt);
      setBackgroundType(clonedPage.backgroundType);

      await loadPage(clonedPage);
    },
    [flushCurrentPageSnapshot, loadPage],
  );

  // --- Reorder pages ---
  const reorderPages = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (isBatchRenderingRef.current) return;
      if (fromIndex === toIndex) return;

      const syncedPages = flushCurrentPageSnapshot();
      const updated = reorderWhiteboardPages(syncedPages, fromIndex, toIndex);

      if (updated === syncedPages) {
        return;
      }
      pagesRef.current = updated;
      setPages(updated);

      const activeIndex = currentPageIndexRef.current;
      let nextActiveIndex = activeIndex;

      if (activeIndex === fromIndex) {
        nextActiveIndex = toIndex;
      } else if (fromIndex < activeIndex && toIndex >= activeIndex) {
        nextActiveIndex = activeIndex - 1;
      } else if (fromIndex > activeIndex && toIndex <= activeIndex) {
        nextActiveIndex = activeIndex + 1;
      }

      if (nextActiveIndex !== activeIndex) {
        currentPageIndexRef.current = nextActiveIndex;
        setCurrentPageIndex(nextActiveIndex);
      }
    },
    [flushCurrentPageSnapshot],
  );

  // --- PageManager actions (identity-based) ---
  // The panel renders the DEFERRED pages list, so a thumbnail's array index can point at a different
  // LIVE page after an insert/delete/reorder (the deferral lags one+ frames, longer on heavy PDFs).
  // Resolve the clicked page's id against the live `pagesRef.current` here so every action lands on the
  // exact page the user clicked — this is what fixes "insert a blank mid-PDF and neighbors show the
  // wrong content / clicking a page opens its neighbor".
  const resolveLivePageIndex = useCallback(
    (pageId: string) => pagesRef.current.findIndex((page) => page.id === pageId),
    [],
  );

  const handlePageManagerSelect = useCallback(
    (pageId: string) => {
      const index = resolveLivePageIndex(pageId);

      if (index >= 0) navigateToPage(index);
    },
    [navigateToPage, resolveLivePageIndex],
  );

  const handlePageManagerDelete = useCallback(
    (pageId: string) => {
      const index = resolveLivePageIndex(pageId);

      if (index >= 0) void deletePage(index);
    },
    [deletePage, resolveLivePageIndex],
  );

  const handlePageManagerDuplicate = useCallback(
    (pageId: string) => {
      const index = resolveLivePageIndex(pageId);

      if (index >= 0) void duplicatePage(index);
    },
    [duplicatePage, resolveLivePageIndex],
  );

  const handlePageManagerInsert = useCallback(
    (pageId: string, position: 'after' | 'before') => {
      const index = resolveLivePageIndex(pageId);

      if (index >= 0) void insertPageRelative(index, position);
    },
    [insertPageRelative, resolveLivePageIndex],
  );

  const handlePageManagerReorder = useCallback(
    (fromPageId: string, toPageId: string) => {
      const fromIndex = resolveLivePageIndex(fromPageId);
      const toIndex = resolveLivePageIndex(toPageId);

      if (fromIndex >= 0 && toIndex >= 0) reorderPages(fromIndex, toIndex);
    },
    [reorderPages, resolveLivePageIndex],
  );

  // --- Continuous PDF layout session -----------------------------------------------------------
  // Resolve a page's live raster for the scroll painter (native-first, pdf.js fallback), decoded to
  // an element the painter can drawImage.
  const resolveScrollPageImage = useCallback(
    async (page: WhiteboardPage) => {
      const url = await resolvePdfPageImageUrl(page, 'live');

      if (!url) return null;

      return loadPdfPageImage(url);
    },
    [resolvePdfPageImageUrl],
  );

  // The session lives as long as the layout is 'scroll'; it must NOT follow these callbacks'
  // identities. `loadPage` / `flushCurrentPageSnapshot` are rebuilt on every history push (every
  // flush of ink), and re-running the effect for that tore the session down mid-pan: the cleanup's
  // paged `loadPage` and the next session's hydration then BOTH put the page's ink on the canvas and
  // the following flush wrote the doubled set back — 2 → 4 → … → 55k objects, then a stack overflow.
  const flushCurrentPageSnapshotRef = useRef(flushCurrentPageSnapshot);
  const historyRef = useRef(history);
  const loadPageRef = useRef(loadPage);
  const resolveScrollPageImageRef = useRef(resolveScrollPageImage);
  const isScrollActiveRef = useRef(isScrollActive);
  const paperOverPdfRef = useRef(paperOverPdf);

  flushCurrentPageSnapshotRef.current = flushCurrentPageSnapshot;
  historyRef.current = history;
  loadPageRef.current = loadPage;
  resolveScrollPageImageRef.current = resolveScrollPageImage;
  isScrollActiveRef.current = isScrollActive;
  paperOverPdfRef.current = paperOverPdf;

  // Create / tear down the scroll session as the layout toggles (or an export sweep borrows the
  // canvas). Creating it clears the single-page canvas and hydrates the window; tearing it down
  // writes every dirty page back and reloads the current page in the paged layout.
  useEffect(() => {
    const canvas = fabricCanvasRef.current;

    if (!canvas || !fabricCanvas || !isScrollActive) return;

    // Hand the current paged page back before the session takes the canvas.
    flushCurrentPageSnapshotRef.current();

    isSyncingCanvasRef.current = true;

    try {
      canvas.discardActiveObject();
      canvas.clear();
      canvas.backgroundColor = 'transparent';
      canvas.backgroundImage = undefined;
      invalidateInkBake(canvas);
      canvas.requestRenderAll();
    } finally {
      isSyncingCanvasRef.current = false;
    }

    const session = new PdfScrollSession({
      canvas,
      width: Math.max(canvas.getWidth(), canvasDisplaySize.width, 1),
      maxZoom: 4,
      resolveImage: (page) => resolveScrollPageImageRef.current(page),
      onCurrentPageChange: (index) => {
        scrollDrivenIndexRef.current = index;
        currentPageIndexRef.current = index;
        setCurrentPageIndex(index);
      },
      onWindowChange: () => undefined,
      onPageHydrated: (pageId, objects, sources) => historyRef.current.seedHydratedPage(pageId, objects, sources),
      beforeDehydrate: () => historyRef.current.commitNow(),
      objectCache: history.objectCache,
      onPagesPatched: (patch, options) => {
        const next = patch(pagesRef.current);

        if (next !== pagesRef.current) {
          pagesRef.current = next;
          setPages(next);

          if (options.persist) needsPersistRef.current = true;
        }
      },
      setExternalWrite: (active) => {
        isSyncingCanvasRef.current = active;
      },
      isWriteBlocked: () =>
        isSyncingCanvasRef.current || isRestoringHistoryRef.current || isBatchRenderingRef.current,
      requestRepaint: () => backgroundRepaintRef.current?.(),
      paperOverPdf: () => paperOverPdfRef.current,
    });

    scrollSessionRef.current = session;
    pdfScrollPainterRef.current = (ctx, args) => session.paint(ctx, args);
    viewportConstraintsRef.current = session.getConstraints();
    session.syncPages(pagesRef.current);
    void session.enter(currentPageIndexRef.current);
    backgroundRepaintRef.current?.();

    return () => {
      scrollSessionRef.current = null;
      pdfScrollPainterRef.current = null;
      viewportConstraintsRef.current = null;
      scrollDrivenIndexRef.current = -1;

      const patched = session.dispose();

      if (patched && patched !== pagesRef.current) {
        pagesRef.current = patched;
        setPages(patched);
        needsPersistRef.current = true;
      }

      backgroundRepaintRef.current?.();

      const page = pagesRef.current[currentPageIndexRef.current];

      // Back to the paged layout only: a session replaced by another (a remount of the canvas)
      // must not race the paged load against the new session's hydration.
      if (page && fabricCanvasRef.current && !isScrollActiveRef.current) {
        void loadPageRef.current(page);
      }
    };
    // canvasDisplaySize.width is read once at creation; a live resize is handled by the canvas hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fabricCanvas, isScrollActive]);

  // Keep the session's layout in step with the owner's page list (insert / delete / reorder / import /
  // a raster correcting a page's aspect) and refresh the viewport cage the new layout implies.
  useEffect(() => {
    const session = scrollSessionRef.current;

    if (!session) return;

    session.syncPages(pages);
    viewportConstraintsRef.current = session.getConstraints();
  }, [pages]);

  // The scroll layout's cage follows the canvas size: its fit zoom is canvas width ÷ the frozen scene
  // width, so a narrower window (split screen, rotation) needs a lower floor. Taken once at creation
  // and on page edits only, the cage went stale on a resize — the old floor held the zoom at the old
  // fit and the page ran off the right edge. A view at fit follows to the new fit; a zoomed-in one
  // keeps its zoom (see refitViewportToConstraints).
  useEffect(() => {
    const session = scrollSessionRef.current;
    const canvas = fabricCanvasRef.current;

    if (!session || !canvas || !isScrollActive) return;

    const previous = viewportConstraintsRef.current;
    const next = session.getConstraints();

    viewportConstraintsRef.current = next;

    const transform = freeZoomRef.current
      ? canvas.viewportTransform
      : refitViewportToConstraints(canvas.viewportTransform, previous, next, canvas.getWidth(), canvas.getHeight());

    if (!isSameViewportTransform(canvas.viewportTransform, transform)) {
      canvas.setViewportTransform(transform);
      setZoom(canvas.getZoom());
      canvas.requestRenderAll();
      backgroundRepaintRef.current?.();
    }
  }, [canvasDisplaySize, isScrollActive]);

  // Scroll to the current page when the index changed for a reason OTHER than free scrolling (a page
  // insert / delete, a page-manager tap, a chevron) — a scroll-driven index change must not snap.
  useEffect(() => {
    const session = scrollSessionRef.current;

    if (!session || currentPageIndex === scrollDrivenIndexRef.current) return;

    session.syncPages(pagesRef.current);
    viewportConstraintsRef.current = session.getConstraints();
    void session.enter(currentPageIndex);
  }, [currentPageIndex]);

  // Paged zoom-lock (lockZoomToPage, no scroll session): cage the viewport to the current PDF page's
  // rect so it always fills the width and never reveals the board around it. Recomputed when the page,
  // its frame, the canvas size or the mode changes; cleared when no lock is in force.
  const updatePagedLockConstraints = useCallback(() => {
    // The notebook sheet owns the cage on a page without a PDF (see updateNotebookPage).
    if (isScrollActive || (verticalNotebook && !hasPdfPageBackground)) return;

    const canvas = fabricCanvasRef.current;

    if (!lockZoomToPage || !canvas || !hasPdfPageBackground) {
      viewportConstraintsRef.current = null;

      return;
    }

    const page = pagesRef.current[currentPageIndexRef.current];
    const frame = pdfBackgroundFrameRef.current;

    if (!page) {
      viewportConstraintsRef.current = null;

      return;
    }

    const rotation = normalizeRotationDeg(page.pdfRotation);
    let rect: { x: number; y: number; width: number; height: number } | null = null;

    if (frame && frame.pageId === page.id && frame.fitWidth > 0 && frame.fitHeight > 0) {
      const placement = frame.image
        ? getRotatedScreenFitPlacement(frame.fitWidth, frame.fitHeight, frame.image.width, frame.image.height, rotation)
        : { height: frame.fitHeight, left: 0, top: 0, width: frame.fitWidth };

      rect = { height: placement.height, width: placement.width, x: placement.left, y: placement.top };
    } else {
      const geometry = resolveSnapshotGeometry({ canvasWidth: canvas.getWidth(), page, pdfFrame: null });

      if (geometry && typeof geometry.pdfPlacement === 'object') {
        rect = geometry.pdfPlacement;
      }
    }

    viewportConstraintsRef.current = constraintsForPageRect({ canvasWidth: canvas.getWidth(), maxZoom: 4, rect });
  }, [hasPdfPageBackground, isScrollActive, lockZoomToPage, verticalNotebook]);

  pagedLockRefreshRef.current = updatePagedLockConstraints;

  // Free zoom on/off. Off: glide the view back inside the real cage (the fit zoom, about the centre).
  useEffect(() => {
    const wasFree = freeZoomRef.current;

    freeZoomRef.current = freeZoom;

    const canvas = fabricCanvasRef.current;
    const cage = viewportConstraintsRef.current;

    if (!wasFree || freeZoom || !canvas || !cage) return;

    const from = [...canvas.viewportTransform] as number[];
    const to = clampViewportTransform(from, cage, canvas.getWidth(), canvas.getHeight());

    if (isSameViewportTransform(from, to)) return;

    const startedAt = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / 220);
      const eased = 1 - (1 - t) ** 3;

      if (freeZoomRef.current) return;

      canvas.setViewportTransform(from.map((v, i) => v + ((to[i] ?? v) - v) * eased) as ViewportTransform6);
      setZoom(canvas.getZoom());
      canvas.requestRenderAll();
      backgroundRepaintRef.current?.();

      if (t < 1) frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);

    return () => cancelAnimationFrame(frame);
  }, [freeZoom]);

  useEffect(() => {
    updatePagedLockConstraints();
  }, [canvasDisplaySize, currentPageIndex, updatePagedLockConstraints]);

  const notebookFillScreenRef = useRef(notebookFillScreen);

  notebookFillScreenRef.current = notebookFillScreen;

  // --- Vertical notebook sheet (verticalNotebook; see utils/notebookPage) ---
  // 'open': the page's ink just loaded — measure it and show the sheet at its fit width. 'refit': the
  // pane changed size — a view at fit width stays at fit width. 'grow': ink landed — the sheet only
  // gets longer. Off the sheet (a PDF page, the scroll layout, the prop off) the painter's page and
  // the cage the sheet installed are dropped.
  const updateNotebookPage = useCallback(
    (mode: 'open' | 'refit' | 'grow', loaded?: WhiteboardPage) => {
      const canvas = fabricCanvasRef.current;
      // 'open' is handed the page loadPage just put on the canvas: the page list may not hold it yet.
      const page = loaded ?? pagesRef.current[currentPageIndexRef.current];

      if (!canvas || !page) return;

      const isSheet = verticalNotebook && !(page.pdfAssetId || page.pdfImageUrl) && !isScrollActiveRef.current;

      if (!isSheet) {
        if (notebookPageRef.current) {
          notebookPageRef.current = null;
          backgroundRepaintRef.current?.();
        }

        if (viewportConstraintsRef.current && viewportConstraintsRef.current === notebookConstraintsRef.current) {
          viewportConstraintsRef.current = null;
        }

        notebookConstraintsRef.current = null;
        notebookInkRef.current = null;
        notebookViewedRef.current = null;

        return;
      }

      let entering = false;

      if (mode === 'open' || (notebookInkRef.current?.pageId !== page.id && !isSyncingCanvasRef.current)) {
        entering = true;
        // Measured on 'open', and the first time a page is seen without one (a board that opens blank
        // never goes through loadPage).
        notebookInkRef.current = {
          pageId: page.id,
          rect: unionInkBounds(canvas.getObjects().map((object) => object.getBoundingRect())),
        };
        // A reopened page starts from its ink again; the view re-earns its own high-water mark.
        if (mode === 'open') notebookViewedRef.current = null;
      } else if (notebookInkRef.current?.pageId !== page.id) {
        // This page's ink is still loading: wait for 'open'.
        return;
      }

      const ink = notebookInkRef.current?.rect ?? null;
      let frameWidth = notebookFrameRef.current?.pageId === page.id ? notebookFrameRef.current.width : null;

      if (frameWidth === null) {
        const recorded = normalizeCanvasWidthPx(page.canvasWidthPx);

        frameWidth = resolveNotebookFrameWidth(recorded, canvas.getWidth());

        if (frameWidth === null) return;

        // A recorded frame, or ink written against this one, fixes the width for good; an empty
        // unrecorded page keeps following the pane until then.
        if (recorded !== undefined || ink) {
          notebookFrameRef.current = { pageId: page.id, width: frameWidth };
        }
      }

      const width = canvas.getWidth();
      const height = canvas.getHeight();
      const layoutFor = () =>
        resolveNotebookLayout({
          canvasHeight: height,
          canvasWidth: width,
          frameWidth,
          ink,
          maxZoom: 4,
          viewedBottom: notebookViewedRef.current?.pageId === page.id ? notebookViewedRef.current.bottom : null,
          fillWidth: notebookFillScreenRef.current,
        });
      let layout = layoutFor();

      if (!layout) return;

      // Entering a page: come back to where this device last left it (zoom + scroll), if anywhere.
      let restored: ViewportTransform6 | null = null;

      if (entering) {
        const view = readNotebookView(whiteboardDocId, page.id);

        if (view) {
          // The endless page must reach at least as far down as the remembered view.
          notebookViewedRef.current = { bottom: view.top + height / layout.constraints.minZoom, pageId: page.id };
          layout = layoutFor() ?? layout;
          restored = restoreNotebookViewport(view, layout.constraints, width, height);
        }
      }

      const previous =
        viewportConstraintsRef.current === notebookConstraintsRef.current ? notebookConstraintsRef.current : null;

      notebookPageRef.current = {
        frameWidth,
        pageId: page.id,
        pageLeft: layout.pageLeft,
        pageRight: layout.pageRight,
      };
      notebookConstraintsRef.current = layout.constraints;
      viewportConstraintsRef.current = layout.constraints;

      const next = restored
        ? restored
        : freeZoomRef.current && mode !== 'open'
          ? canvas.viewportTransform
          : mode === 'open'
            ? fitNotebookViewport(canvas.viewportTransform, layout.constraints, width, height)
            : mode === 'refit'
              ? refitNotebookViewport(canvas.viewportTransform, previous, layout.constraints, width, height)
              : clampViewportTransform(canvas.viewportTransform, layout.constraints, width, height);

      if (!isSameViewportTransform(canvas.viewportTransform, next)) {
        canvas.setViewportTransform(next);
        setZoom(canvas.getZoom());
        canvas.requestRenderAll();
      }

      backgroundRepaintRef.current?.();
    },
    [verticalNotebook, whiteboardDocId],
  );

  notebookUpdateRef.current = updateNotebookPage;

  useEffect(() => {
    updateNotebookPage('refit');
  }, [canvasDisplaySize, currentPageIndex, fabricCanvas, hasPdfPageBackground, isScrollActive, notebookFillScreen, updateNotebookPage]);

  // Ink landing on the sheet makes it longer (never wider: a width change would rescale the page under
  // the pen — the next open covers it). One update per frame however many objects arrive.
  useEffect(() => {
    if (!verticalNotebook || !fabricCanvas) return;

    let frame: number | null = null;
    const handleAdded = (event: { target?: { getBoundingRect: () => { left: number; top: number; width: number; height: number } } }) => {
      const sheet = notebookPageRef.current;
      const ink = notebookInkRef.current;

      if (!sheet || !ink || ink.pageId !== sheet.pageId || isSyncingCanvasRef.current || !event.target) return;

      const box = event.target.getBoundingRect();

      if (![box.top, box.height].every(Number.isFinite)) return;

      ink.rect = ink.rect
        ? { ...ink.rect, bottom: Math.max(ink.rect.bottom, box.top + box.height), top: Math.min(ink.rect.top, box.top) }
        : { bottom: box.top + box.height, left: 0, right: 0, top: box.top };

      if (notebookFrameRef.current?.pageId !== sheet.pageId) {
        notebookFrameRef.current = { pageId: sheet.pageId, width: sheet.frameWidth };
      }

      if (frame === null) {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          notebookUpdateRef.current?.('grow');
        });
      }
    };

    // View memory: once a zoom/scroll settles, remember it for this page on this device.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const lastViewport: number[] = [];
    const saveView = () => {
      saveTimer = null;
      const sheet = notebookPageRef.current;
      const constraints = notebookConstraintsRef.current;

      if (!sheet || !constraints || viewportConstraintsRef.current !== constraints) return;
      // Mid page switch the canvas may already show another page: never file its view under this one.
      if (pagesRef.current[currentPageIndexRef.current]?.id !== sheet.pageId) return;

      const view = captureNotebookView(fabricCanvas.viewportTransform, constraints);

      if (view) writeNotebookView(whiteboardDocId, sheet.pageId, view);
    };

    // Endless paper: every render (a pan, a wheel, a fling frame) records how far down the view has
    // reached; nearing the page bottom grows the page so the scroll never meets a wall.
    const handleAfterRender = () => {
      const sheet = notebookPageRef.current;
      const constraints = notebookConstraintsRef.current;

      if (!sheet || !constraints || viewportConstraintsRef.current !== constraints) return;

      const viewport = fabricCanvas.viewportTransform ?? IDENTITY_VIEWPORT;
      let moved = viewport.length !== lastViewport.length;

      for (let index = 0; index < viewport.length; index += 1) {
        if (lastViewport[index] !== viewport[index]) {
          moved = true;
          lastViewport[index] = viewport[index] as number;
        }
      }

      lastViewport.length = viewport.length;

      if (moved) {
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = setTimeout(saveView, NOTEBOOK_VIEW_SAVE_DELAY_MS);
      }

      const height = fabricCanvas.getHeight();
      const viewBottom = notebookViewBottom(fabricCanvas.viewportTransform, height);

      if (!Number.isFinite(viewBottom)) return;

      const viewed = notebookViewedRef.current;

      if (viewed?.pageId === sheet.pageId && viewed.bottom >= viewBottom) return;

      notebookViewedRef.current = { bottom: viewBottom, pageId: sheet.pageId };

      if (frame === null && shouldGrowNotebookPage(constraints, viewBottom, height)) {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          notebookUpdateRef.current?.('grow');
        });
      }
    };

    fabricCanvas.on('object:added', handleAdded);
    fabricCanvas.on('after:render', handleAfterRender as never);

    return () => {
      fabricCanvas.off('object:added', handleAdded);
      fabricCanvas.off('after:render', handleAfterRender as never);

      if (frame !== null) window.cancelAnimationFrame(frame);
      // Flush a pending save: leaving the board right after a zoom still remembers it.
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveView();
      }
    };
  }, [fabricCanvas, verticalNotebook, whiteboardDocId]);

  // --- PDF import ---
  // Re-key every page that references a just-imported LOCAL pdf asset id to the SERVER id the
  // background upload returned, copy the cached blob under the server id (keep the local copy so the
  // renderer never gaps mid-swap), then persist so the corrected references reach the cloud on the
  // next snapshot sync. Operates on the LIVE page state, so drawing/adding pages during the upload is
  // safe — only pages still pointing at the local id are touched.
  const rekeyPdfAsset = useCallback(
    async (localAssetId: string, serverAssetId: string) => {
      try {
        const local = await storage.loadPdfAsset(localAssetId);

        if (local?.blob) {
          await storage.savePdfAsset({ ...local, id: serverAssetId });
        }
      } catch {
        // Best-effort: even if the blob copy fails the renderer can re-download by the server id.
      }

      const nextPages = pagesRef.current.map((page) =>
        page.pdfAssetId === localAssetId ? { ...page, pdfAssetId: serverAssetId } : page,
      );

      pagesRef.current = nextPages;
      setPages(nextPages);
      await persistSnapshotNow();
    },
    [persistSnapshotNow, storage],
  );

  const handlePdfSourceDiscarded = useCallback(
    (sourceFile: File) => {
      onPdfImportDiscarded?.({ sourceFile });
    },
    [onPdfImportDiscarded],
  );

  const handlePdfProcessed = useCallback(
    async (result: PdfImportResult, sourceFile: File | null) => {
      if (result.pages.length === 0) return;

      const syncedPages = flushCurrentPageSnapshot();
      // Prior imports from the SAME source file (matched by fingerprint). Use the page's recorded
      // original page number; fall back to pdfPageIndex+1 for legacy whole-file pages predating it.
      const priorImportedPageNumbers = syncedPages
        .filter((page) => page.pdfFingerprint === result.asset.fingerprint)
        .map(
          (page) => page.pdfSourcePageNumber ?? (page.pdfPageIndex !== undefined ? page.pdfPageIndex + 1 : undefined),
        )
        .filter((pageNumber): pageNumber is number => pageNumber !== undefined);
      const priorImportedPageSet = new Set(priorImportedPageNumbers);
      const pagesToAppend = result.pages.filter((pagePreview) => !priorImportedPageSet.has(pagePreview.pageNumber));

      if (pagesToAppend.length === 0) {
        setPdfModalOpen(false);
        return;
      }

      // Every import — subset OR whole file — is its own asset addressed by a fresh LOCAL id. The
      // source PDF uploads in the BACKGROUND (below) and the pages re-key local→server on completion,
      // so the teacher draws/writes right away instead of waiting on the slow upload. We deliberately
      // do NOT reuse a prior asset id across imports: a subset and a whole-file import of the same
      // source share a pdf.js fingerprint but hold DIFFERENT bytes/page-sets, so reusing one id would
      // clobber the other asset's blob and skip its upload → silent wrong-page corruption. Re-importing
      // identical bytes is cheap anyway — uploadSourcePdfAsset dedups by checksum server-side and the
      // re-key just points the new pages at the existing server asset.
      const pdfAssetId = result.asset.id;

      await storage.savePdfAsset({
        ...result.asset,
        id: pdfAssetId,
      });

      // Each import owns its own asset, so prior pages (which belong to their own assets) are untouched.
      const nextSyncedPages = syncedPages;

      // Open each new PDF page scrolled to its TOP. The width-fill placement is vertically centered
      // (its frame anchors the ink, so we must NOT move it); instead we offset the page's INITIAL
      // viewport so the page's top edge sits at the top of the view. A portrait page then starts at the
      // top (write from the top) instead of mid-page. Computed from the current canvas size + the
      // page's aspect ratio; viewportZoom:1 makes loadPage honor the saved offset.
      const importCanvas = fabricCanvasRef.current;
      const importCanvasWidth = importCanvas?.getWidth() ?? 0;
      const importCanvasHeight = importCanvas?.getHeight() ?? 0;

      const newPages: WhiteboardPage[] = pagesToAppend.map((pagePreview) => {
        let viewportOffsetY = 0;

        if (importCanvasWidth > 0 && importCanvasHeight > 0 && pagePreview.width > 0 && pagePreview.height > 0) {
          const placement = getScreenFitPlacement(
            importCanvasWidth,
            importCanvasHeight,
            pagePreview.width,
            pagePreview.height,
          );

          viewportOffsetY = -placement.top;
        }

        return {
          id: createWhiteboardId(),
          canvasJSON: '',
          // No import preview in the page record: 108 JPEG previews made a PDF board a 4.7 MB
          // document that every autosave AND every sync enqueue re-serialized (2026-09-13). The page
          // strip renders PDF thumbnails from the asset on demand (resolvePageManagerPdfThumbnail).
          thumbnail: '',
          backgroundType,
          pdfAssetId,
          pdfFingerprint: result.asset.fingerprint,
          pdfPageIndex: pagePreview.pageIndex,
          pdfSourcePageNumber: pagePreview.pageNumber,
          pdfImageUrl: undefined,
          pdfSourceName: result.asset.fileName,
          viewportOffsetX: 0,
          viewportOffsetY,
          viewportZoom: 1,
        };
      });
      const importedPageNumbers = pagesToAppend.map((pagePreview) => pagePreview.pageNumber);
      const { firstInsertedIndex, pages: nextPages } = appendWhiteboardPages(nextSyncedPages, newPages);
      const firstNewIndex = firstInsertedIndex;
      const firstPdfPage = nextPages[firstNewIndex];

      if (!firstPdfPage) return;

      pagesRef.current = nextPages;
      currentPageIndexRef.current = firstNewIndex;
      setPages(nextPages);
      setCurrentPageIndex(firstNewIndex);
      setBackgroundType(firstPdfPage.backgroundType);
      await loadPage(firstPdfPage);
      saveCurrentPage(nextPages, firstNewIndex, { includeThumbnail: true });
      // New pages are a document change even when nothing was drawn: without this the autosave has
      // nothing to pick up and a reload loses the import (seen 2026-09-13 on a custom-titled board).
      needsPersistRef.current = true;
      // Tell the host what this import produced, now that the pages are committed and on screen.
      // Nothing here is awaited: what a host does with it (rendering a deck's slide intros, say) is
      // minutes of work, and the board is usable the moment its pages are drawn.
      if (sourceFile) {
        onPdfImported?.({
          pageIds: newPages.map((page) => page.id),
          pdfPageCount: result.summary.totalPages,
          sourceFile,
        });
      }

      setLastPdfImportHint({
        fileName: result.asset.fileName,
        fingerprint: result.asset.fingerprint,
        importedRange: formatPdfPageRange(importedPageNumbers),
        suggestedRange: suggestNextPdfPageRange(
          [...priorImportedPageNumbers, ...importedPageNumbers],
          result.summary.totalPages,
        ),
      });

      // Name a still-default board after the imported PDF (minus the .pdf), preserving any teacher tag
      // the create flow embedded as '<default> — <teacher>'. Only fires while the title is default, so
      // it never overwrites a name the teacher chose; and since the PDF's name is non-default, a later
      // import into the same board won't rename again (first import wins). setDocumentTitle is the
      // editor's title state path — it flows into buildDocumentSnapshot, so the rename persists via the
      // normal autosave/exit flush, not a parallel storage write.
      if (isDefaultBoardTitle(documentTitle)) {
        const pdfBaseName = result.asset.fileName.replace(/\.pdf$/i, '').trim();

        if (pdfBaseName) {
          // Recover the teacher name the create flow tagged onto the default title ('… — <teacher>') so
          // the renamed board keeps it. The whiteboard document's own optional `teacherName` field is
          // not in this handler's scope (only loaded into the `.then` on mount), so the current title
          // is the reliable in-scope source for it.
          const titleParts = documentTitle.trim().split(BOARD_TITLE_TEACHER_SEPARATOR);
          const teacherName =
            titleParts.length > 1 ? titleParts.slice(1).join(BOARD_TITLE_TEACHER_SEPARATOR).trim() : '';
          const teacherSuffix = teacherName ? `${BOARD_TITLE_TEACHER_SEPARATOR}${teacherName}` : '';
          const nextTitle = `${pdfBaseName}${teacherSuffix}`;

          if (nextTitle !== documentTitle) {
            setDocumentTitle(nextTitle);
            // Flag a durable save so the new title reaches IndexedDB on the next autosave tick even if
            // the teacher imports and leaves without drawing (handleBackPress also flushes on exit).
            needsPersistRef.current = true;
          }
        }
      }

      setPdfModalOpen(false);

      // Background source-PDF upload. NOT awaited: the board is already usable. On success the pages
      // re-key local→server so cross-device load + server-merge can resolve the asset; on failure the
      // pages keep the local id (still fully usable locally) and the self-heal retries on reconnect /
      // next open.
      if (onPersistPdfAsset) {
        const localAssetId = pdfAssetId;

        void Promise.resolve(onPersistPdfAsset({ existingAssetId: null, result }))
          .then((persisted) => {
            const serverAssetId = persisted?.assetId;

            if (serverAssetId && serverAssetId !== localAssetId) {
              return rekeyPdfAsset(localAssetId, serverAssetId);
            }

            return undefined;
          })
          .catch(() => {
            // The host surfaces the failure in the sync menu; nothing else to do here.
          });
      }
    },
    [
      backgroundType,
      documentTitle,
      flushCurrentPageSnapshot,
      loadPage,
      onPdfImported,
      onPersistPdfAsset,
      rekeyPdfAsset,
      saveCurrentPage,
      storage,
    ],
  );

  /**
   * Add IMAGES to this board as PAGES — one page per photo, in the order they were given.
   *
   * The photo becomes the page's BACKGROUND (`pdfImageUrl`), the same field a rasterized PDF page
   * uses, so the renderer fits and centres it, the page rail thumbnails it from the background
   * itself (`resolvePageManagerPdfThumbnail`), and the teacher writes over it exactly as over a
   * scanned worksheet. Nothing here touches the PDF asset store: an image page has no source
   * document, so there is no asset to cache, upload or re-key.
   *
   * Pages land AFTER the page the teacher is on and the first new one becomes current — a photo
   * taken mid-lesson belongs next to what is being taught, not at the end of a 90-page deck.
   *
   * `thumbnail` is left empty on purpose: a page thumbnail is persisted INSIDE the document, and a
   * board of 30 photos would carry 30 extra data URLs through every autosave and every sync enqueue
   * (the cost `persistedPageThumbnail` exists to avoid). The background already is the picture.
   */
  const appendImagePages = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const decoded: Array<{ background: Awaited<ReturnType<typeof decodeImagePageBackground>>; name: string }> = [];

      // Sequential on purpose: each decode is canvas work on the DRAWING thread, and firing thirty
      // photos at once is what freezes the board rather than what speeds it up.
      for (const file of files) {
        try {
          decoded.push({
            background: await decodeImagePageBackground(file, file.type || imageMimeTypeForFileName(file.name)),
            name: file.name,
          });
        } catch (error) {
          // One unreadable photo must not cost the teacher the rest of the selection.
          console.warn('[WhiteboardEditor] could not decode an image for a page:', file.name, error);
        }
      }

      if (decoded.length === 0) return;

      const syncedPages = flushCurrentPageSnapshot();
      // Open each new page scrolled to its TOP, exactly as an imported PDF page does: the width-fill
      // placement is vertically centred, so the page's INITIAL viewport is offset instead of its
      // frame (which anchors the ink and must not move).
      const importCanvas = fabricCanvasRef.current;
      const importCanvasWidth = importCanvas?.getWidth() ?? 0;
      const importCanvasHeight = importCanvas?.getHeight() ?? 0;

      const newPages: WhiteboardPage[] = decoded.map(({ background, name }) => {
        let viewportOffsetY = 0;

        if (importCanvasWidth > 0 && importCanvasHeight > 0 && background.width > 0 && background.height > 0) {
          const placement = getScreenFitPlacement(
            importCanvasWidth,
            importCanvasHeight,
            background.width,
            background.height,
          );

          viewportOffsetY = -placement.top;
        }

        return {
          backgroundType,
          canvasJSON: '',
          id: createWhiteboardId(),
          pdfImageUrl: background.dataUrl,
          pdfSourceName: name,
          thumbnail: '',
          viewportOffsetX: 0,
          viewportOffsetY,
          viewportZoom: 1,
        };
      });

      const insertAt = Math.min(Math.max(0, currentPageIndexRef.current + 1), syncedPages.length);
      const nextPages = [...syncedPages.slice(0, insertAt), ...newPages, ...syncedPages.slice(insertAt)];
      const firstNewPage = nextPages[insertAt];

      if (!firstNewPage) return;

      pagesRef.current = nextPages;
      currentPageIndexRef.current = insertAt;
      setPages(nextPages);
      setCurrentPageIndex(insertAt);
      setBackgroundType(firstNewPage.backgroundType);
      await loadPage(firstNewPage);
      saveCurrentPage(nextPages, insertAt, { includeThumbnail: true });
      // New pages are a document change even when nothing was drawn: without this the autosave has
      // nothing to pick up and a reload loses the import (seen 2026-09-13 on a custom-titled board).
      needsPersistRef.current = true;

      // Name a still-default board after the first photo, keeping any teacher tag the create flow
      // embedded as '<default> — <teacher>'. Same rule (and same reasons) as the PDF import: only
      // while the title is default, so a name the teacher chose is never overwritten.
      if (isDefaultBoardTitle(documentTitle)) {
        const imageBaseName = (decoded[0]?.name ?? '').replace(/\.[a-z0-9]+$/i, '').trim();

        if (imageBaseName) {
          const titleParts = documentTitle.trim().split(BOARD_TITLE_TEACHER_SEPARATOR);
          const teacherName =
            titleParts.length > 1 ? titleParts.slice(1).join(BOARD_TITLE_TEACHER_SEPARATOR).trim() : '';
          const teacherSuffix = teacherName ? `${BOARD_TITLE_TEACHER_SEPARATOR}${teacherName}` : '';
          const nextTitle = `${imageBaseName}${teacherSuffix}`;

          if (nextTitle !== documentTitle) {
            setDocumentTitle(nextTitle);
            needsPersistRef.current = true;
          }
        }
      }

      setPdfModalOpen(false);
    },
    [backgroundType, documentTitle, flushCurrentPageSnapshot, loadPage, saveCurrentPage, setPdfModalOpen],
  );

  const aiBridge = useMemo<BoardAiEditorBridge>(
    () => ({
      renderRegion: renderAiRegion,
      getPageBounds: async (options?: { backgroundOnly?: boolean }) => {
        const page = pagesRef.current[currentPageIndexRef.current];

        if (!page) return null;

        return getPageExportBounds(page, await loadCanvasImage(await resolvePdfPageImageUrl(page, 'export')), options);
      },
      getPageBackgroundInfo: () => {
        const page = pagesRef.current[currentPageIndexRef.current];
        const canvas = fabricCanvasRef.current;

        if (!page) return null;

        return { hasPicture: Boolean(page.pdfAssetId || page.pdfImageUrl), lockedImages: canvas ? getLockedImages(canvas).length : 0 };
      },
      getPageSheet: (sceneY?: number) => {
        // Continuous layout: the sheet under `sceneY` (the current page's when none is given) in the
        // stacked scene — pages sit at x = 0, every one `layout.width` wide. Paged layout: null, so
        // the caller falls back to the page's export bounds.
        const session = scrollSessionRef.current && !scrollSessionRef.current.suspended ? scrollSessionRef.current : null;

        if (!session) return null;

        const index = sceneY === undefined ? currentPageIndexRef.current : findPdfScrollPageAt(session.layout, sceneY);
        const entry = session.layout.entries[index];

        return entry ? { left: 0, top: entry.top, width: session.layout.width, height: entry.height } : null;
      },
      getPageId: () => pagesRef.current[currentPageIndexRef.current]?.id ?? null,
      insertPageAfterCurrent: async () => {
        if (isBatchRenderingRef.current) return false;

        await insertPageAt(currentPageIndexRef.current + 1);

        return true;
      },
      insertImagePageAfterCurrent: async (file: File) => {
        if (isBatchRenderingRef.current) return false;

        await appendImagePages([file]);

        return true;
      },
      insertDraftPageAfterCurrent: async () => {
        if (isBatchRenderingRef.current) return null;

        const syncedPages = flushCurrentPageSnapshot();
        const newPage = createBlankWhiteboardPage(backgroundType);
        const { insertedIndex, pages: nextPages } = insertWhiteboardPageAt(syncedPages, newPage, currentPageIndexRef.current + 1);

        // Marked BEFORE the page exists anywhere a writer could see it.
        transientPageIdsRef.current.add(newPage.id);
        pagesRef.current = nextPages;
        currentPageIndexRef.current = insertedIndex;
        setPages(nextPages);
        setCurrentPageIndex(insertedIndex);
        setBackgroundType(newPage.backgroundType);
        await loadPage(newPage);

        return newPage.id;
      },
      setDraftPageImage: async (pageId: string, file: File) => {
        if (isBatchRenderingRef.current) return false;

        let background: Awaited<ReturnType<typeof decodeImagePageBackground>>;

        try {
          background = await decodeImagePageBackground(file, file.type || imageMimeTypeForFileName(file.name));
        } catch {
          return false;
        }

        const isCurrent = pagesRef.current[currentPageIndexRef.current]?.id === pageId;
        const syncedPages = isCurrent ? flushCurrentPageSnapshot() : pagesRef.current;
        const index = syncedPages.findIndex((page) => page.id === pageId);
        const previous = syncedPages[index];

        if (!previous) return false;

        const canvas = fabricCanvasRef.current;
        const canvasWidth = canvas?.getWidth() ?? 0;
        const canvasHeight = canvas?.getHeight() ?? 0;
        // Opens at its top, exactly like appendImagePages (the frame itself stays centred).
        const viewportOffsetY =
          canvasWidth > 0 && canvasHeight > 0 && background.width > 0 && background.height > 0
            ? -getScreenFitPlacement(canvasWidth, canvasHeight, background.width, background.height).top
            : 0;
        // A fresh image page under the same id: the placeholder's blank geometry must not survive.
        const imagePage: WhiteboardPage = {
          backgroundType: previous.backgroundType,
          canvasJSON: '',
          id: previous.id,
          pdfImageUrl: background.dataUrl,
          pdfSourceName: file.name,
          // Empty, so the page list falls back to the picture itself.
          thumbnail: '',
          viewportOffsetX: 0,
          viewportOffsetY,
          viewportZoom: 1,
        };
        const nextPages = syncedPages.map((page, pageIndex) => (pageIndex === index ? imagePage : page));

        pagesRef.current = nextPages;
        setPages(nextPages);

        if (isCurrent && pagesRef.current[currentPageIndexRef.current]?.id === pageId) {
          setBackgroundType(imagePage.backgroundType);
          await loadPage(imagePage);
        }

        return true;
      },
      keepDraftPage: (pageId: string) => {
        if (!transientPageIdsRef.current.delete(pageId)) return;

        // A new page is a document change even with no stroke on it.
        needsPersistRef.current = true;
      },
      removeDraftPage: async (pageId: string, returnToPageId: string | null) => {
        const index = pagesRef.current.findIndex((page) => page.id === pageId);

        transientPageIdsRef.current.delete(pageId);

        if (index < 0) return;

        const wasCurrent = index === currentPageIndexRef.current;

        await deletePage(index);

        if (wasCurrent && returnToPageId) {
          const back = pagesRef.current.findIndex((page) => page.id === returnToPageId);

          if (back >= 0 && back !== currentPageIndexRef.current) await switchToPage(back);
        }
      },
      switchToPageId: async (pageId: string) => {
        const index = pagesRef.current.findIndex((page) => page.id === pageId);

        if (index >= 0) await switchToPage(index);
      },
      hasPage: (pageId: string) => pagesRef.current.some((page) => page.id === pageId),
    }),
    [
      appendImagePages,
      backgroundType,
      deletePage,
      flushCurrentPageSnapshot,
      getPageExportBounds,
      insertPageAt,
      loadCanvasImage,
      loadPage,
      renderAiRegion,
      resolvePdfPageImageUrl,
      switchToPage,
    ],
  );

  // Host-supplied image PAGES — one-shot, exactly like `pendingPdfImport`: the host is told
  // immediately so it can drop its reference, and a re-render never re-imports the same photos.
  useEffect(() => {
    if (!pendingImagePagesImport || pendingImagePagesImport.length === 0) {
      return;
    }

    void appendImagePages(pendingImagePagesImport);
    onPendingImagePagesImportHandled?.();
  }, [appendImagePages, onPendingImagePagesImportHandled, pendingImagePagesImport]);

  // Self-heal: re-upload any source PDF whose bytes are cached locally but whose background upload
  // never reached the server (imported then closed/offline) — detected as a page still pointing at a
  // LOCAL (non-ObjectId) asset id. Runs once after the board loads; each successful re-upload re-keys
  // the pages to the server id. Failures are silent (kept local, retried next open).
  const selfHealLocalPdfAssets = useCallback(async () => {
    if (!onReuploadPdfAsset) {
      return;
    }

    const localAssetIds = Array.from(
      new Set(
        pagesRef.current
          .map((page) => page.pdfAssetId)
          .filter((assetId): assetId is string => Boolean(assetId) && !isLikelyMongoObjectId(assetId as string)),
      ),
    );

    for (const localAssetId of localAssetIds) {
      let cached;

      try {
        cached = await storage.loadPdfAsset(localAssetId);
      } catch {
        continue;
      }

      if (!cached?.blob) {
        continue; // no bytes to re-upload (can't recover the source from here)
      }

      const pageCount =
        cached.pageCount || pagesRef.current.filter((page) => page.pdfAssetId === localAssetId).length || 1;
      const serverAssetId = await onReuploadPdfAsset({
        assetId: localAssetId,
        blob: cached.blob,
        fileName: cached.fileName || 'document.pdf',
        mimeType: cached.mimeType || 'application/pdf',
        pageCount,
      });

      if (serverAssetId && serverAssetId !== localAssetId) {
        await rekeyPdfAsset(localAssetId, serverAssetId);
      }
    }
  }, [onReuploadPdfAsset, rekeyPdfAsset, storage]);

  // Run the self-heal: once after the initial load settles (so pagesRef holds the real pages), AND
  // again whenever connectivity returns — a source-PDF upload that failed while offline must recover
  // on reconnect, not only on the next board open. A running-guard (not a once-ever flag) prevents
  // overlapping runs while still allowing retries; the scan is a no-op when no local-id pages remain.
  const selfHealRunningRef = useRef(false);
  const didInitialSelfHealRef = useRef(false);

  const runSelfHealOnce = useCallback(async () => {
    if (selfHealRunningRef.current) {
      return;
    }

    selfHealRunningRef.current = true;

    try {
      await selfHealLocalPdfAssets();
    } finally {
      selfHealRunningRef.current = false;
    }
  }, [selfHealLocalPdfAssets]);

  useEffect(() => {
    if (!onReuploadPdfAsset || !storage.isReady || !whiteboardId) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (!initialLoadSettledRef.current || didInitialSelfHealRef.current) {
        return;
      }

      didInitialSelfHealRef.current = true;
      window.clearInterval(intervalId);
      void runSelfHealOnce();
    }, 500);

    const handleOnline = () => {
      void runSelfHealOnce();
    };

    window.addEventListener('online', handleOnline);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('online', handleOnline);
    };
  }, [onReuploadPdfAsset, runSelfHealOnce, storage.isReady, whiteboardId]);

  // --- Background type change ---
  const handleBackgroundTypeChange = useCallback(
    (type: BackgroundType) => {
      setBackgroundType(type);
      // A page that never had a spacing picks up the host's default for the new paper (spacing hosts only).
      const defaultSpacing = allowPaperSpacing ? resolveDefaultPaperSpacingMm(defaultPaperSpacingMm, type) : undefined;
      const nextPages = pagesRef.current.map((page) => ({
        ...page,
        backgroundType: type,
        ...(defaultSpacing !== undefined && page.paperSpacingMm === undefined ? { paperSpacingMm: defaultSpacing } : {}),
      }));

      pagesRef.current = nextPages;
      setPages(nextPages);
    },
    [allowPaperSpacing, defaultPaperSpacingMm],
  );

  // Paper spacing follows the paper type: one setting for the board, written onto every page.
  const handlePaperSpacingChange = useCallback((mm: number) => {
    const spacing = normalizePaperSpacingMm(mm);

    if (spacing === undefined) return;

    const nextPages = pagesRef.current.map((page) => (page.paperSpacingMm === spacing ? page : { ...page, paperSpacingMm: spacing }));

    pagesRef.current = nextPages;
    needsPersistRef.current = true;
    setPages(nextPages);
  }, []);

  // --- Page background rotation (fixes a sideways/tilted scan) ---
  // The INK never turns: only the background raster does, and the page's fit frame becomes the rotated
  // image's bounding box. There is no history entry for this — «Reset» is the way back.
  const commitPageRotation = useCallback(
    (nextRotationDeg: number) => {
      if (isBatchRenderingRef.current) return;

      const normalized = normalizeRotationDeg(nextRotationDeg);
      const pageIndex = currentPageIndexRef.current;
      const syncedPages = flushCurrentPageSnapshot();
      const activePage = syncedPages[pageIndex];

      if (!activePage || normalizeRotationDeg(activePage.pdfRotation) === normalized) {
        pagesRef.current = syncedPages;
        setPages(syncedPages);

        return;
      }

      // 0 is stored as ABSENT, so a page the teacher rotated and straightened again serializes exactly
      // like one that was never touched.
      const nextPages = syncedPages.map((page, index) =>
        index === pageIndex ? { ...page, pdfRotation: normalized === 0 ? undefined : normalized } : page,
      );

      pagesRef.current = nextPages;
      setPages(nextPages);
      // Rotation is a page-level edit fabric never sees, so nothing else would mark the board dirty.
      needsPersistRef.current = true;
    },
    [flushCurrentPageSnapshot],
  );

  const handleToggleRotatePanel = useCallback(() => {
    setIsRotatePanelOpen((open) => !open);
  }, []);

  // Quick actions turn RELATIVE to what is on screen, so pressing «90° right» twice lands at 180.
  const handleRotatePageBy = useCallback(
    (deltaDeg: number) => {
      const nextDeg = toSignedRotationDeg(previewPageRotationDeg + deltaDeg);

      setRotationDraftDeg(nextDeg);
      commitPageRotation(nextDeg);
    },
    [commitPageRotation, previewPageRotationDeg],
  );

  const handleCloseRotatePanel = useCallback(() => {
    setIsRotatePanelOpen(false);

    // A drag released outside the slider never fires onChangeEnd — the draft is what the teacher has
    // been looking at, so closing commits it rather than snapping the page back.
    if (rotationDraftDeg !== null) {
      commitPageRotation(rotationDraftDeg);
    }

    setRotationDraftDeg(null);
  }, [commitPageRotation, rotationDraftDeg]);

  // A page switch must never carry one page's half-chosen angle onto the next page's background.
  useEffect(() => {
    setIsRotatePanelOpen(false);
    setRotationDraftDeg(null);
  }, [currentPage?.id]);

  const handleRotationSliderChange = useCallback((value: number | number[]) => {
    setRotationDraftDeg(Array.isArray(value) ? value[0] : value);
  }, []);

  const handleRotationSliderChangeEnd = useCallback(
    (value: number | number[]) => {
      const nextDeg = Array.isArray(value) ? value[0] : value;

      setRotationDraftDeg(nextDeg);
      commitPageRotation(nextDeg);
    },
    [commitPageRotation],
  );

  const handleResetPageRotation = useCallback(() => {
    setRotationDraftDeg(0);
    commitPageRotation(0);
  }, [commitPageRotation]);

  // dragenter/dragleave fire per child element, so the affordance is driven by a depth counter
  // rather than by the last event — a naive boolean flickers off the moment the pointer crosses the
  // toolbar or the zoom controls.
  const fileDragDepthRef = useRef(0);

  const handleBoardDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event.dataTransfer)) return;

    event.preventDefault();
    fileDragDepthRef.current += 1;
    setIsFileDragOver(true);
  }, []);

  const handleBoardDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event.dataTransfer)) return;

    // Without this the drop is not accepted AND the browser navigates away to the file — in the
    // desktop shell that means the WebView replaces the whole app with the PDF.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleBoardDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event.dataTransfer)) return;

    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);

    if (fileDragDepthRef.current === 0) setIsFileDragOver(false);
  }, []);

  const handleBoardDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!carriesFiles(event.dataTransfer)) return;

      event.preventDefault();
      fileDragDepthRef.current = 0;
      setIsFileDragOver(false);

      const droppedFiles = Array.from(event.dataTransfer.files);
      const route = routeImportSelection(droppedFiles, (candidate) => candidate.name, {
        office: Boolean(convertOfficeFile),
      });

      // Photos go straight on as pages: there is no page range to pick, so a modal would only be a
      // confirmation step between the teacher and the thing they just dropped.
      if (route.kind === 'images') {
        void appendImagePages(route.files);

        return;
      }

      // A document — or a selection the router refused (a mix of PDFs and photos, a HEIC) — goes to
      // the modal, which owns the page-range choice AND the explanation for a refusal. A
      // dropped 500-page book must not start importing itself, and a refused drop must not vanish
      // silently.
      if (route.kind === 'pdf') {
        startImportWithFiles([route.file]);

        return;
      }

      // Nothing importable at all (a video, a folder): stay quiet rather than open a modal on it.
      if (droppedFiles.some((candidate) => IMPORT_ROUTABLE_PATTERN.test(candidate.name))) {
        startImportWithFiles(droppedFiles);
      }
    },
    [appendImagePages, convertOfficeFile, startImportWithFiles],
  );

  // A file dropped anywhere OUTSIDE the canvas — the toolbar, the page rail, the gap around them —
  // would otherwise navigate the window to that file.
  useEffect(() => {
    const blockStrayFileDrag = (event: DragEvent) => {
      if (carriesFiles(event.dataTransfer)) event.preventDefault();
    };
    const clearStrayFileDrop = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;

      event.preventDefault();
      fileDragDepthRef.current = 0;
      setIsFileDragOver(false);
    };

    window.addEventListener('dragover', blockStrayFileDrag);
    window.addEventListener('drop', clearStrayFileDrop);

    return () => {
      window.removeEventListener('dragover', blockStrayFileDrag);
      window.removeEventListener('drop', clearStrayFileDrop);
    };
  }, []);

  const handleUploadSharedBackground = useCallback(() => {
    const input = document.createElement('input');

    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];

      if (!file) return;

      const reader = new FileReader();

      reader.onload = () => {
        if (typeof reader.result !== 'string') return;

        setSharedBackgroundImageUrl(reader.result);
      };

      reader.readAsDataURL(file);
    };

    input.click();
  }, []);

  const handleClearSharedBackground = useCallback(() => {
    setSharedBackgroundImageUrl('');
    setSharedBackgroundImageOpacity(1);
  }, []);

  // Undo/redo write the restored page back like any edit: dirty → flushed into the page list now and
  // persisted by the autosave (the paged flush skips a page it believes clean, so mark it).
  const settleHistoryStep = useCallback(
    (pageIndexAtStart: number) => {
      needsPersistRef.current = true;

      // Scroll layout: the session knows which pages the step touched (it may have scrolled to one).
      if (scrollSessionRef.current) {
        flushCurrentPageSnapshot();

        return;
      }

      // If the user switched pages while the restore was in flight, the canvas belongs to the
      // new page — flushing now would file the restored content under the wrong slot.
      if (pageIndexAtStart !== currentPageIndexRef.current) return;

      isPageDirtyRef.current = true;
      flushCurrentPageSnapshot();
    },
    [flushCurrentPageSnapshot],
  );

  // Steps queue in the history (a double tap is two undos), so the restore guard is held while ANY
  // step is in flight — the first one finishing must not drop it under the second.
  const historyStepsInFlightRef = useRef(0);
  const runHistoryStep = useCallback(async (run: () => ReturnType<typeof history.undo>) => {
    historyStepsInFlightRef.current += 1;
    isRestoringHistoryRef.current = true;

    try {
      return await run();
    } finally {
      historyStepsInFlightRef.current -= 1;

      if (historyStepsInFlightRef.current === 0) isRestoringHistoryRef.current = false;
    }
  }, []);

  const handleUndo = useCallback(async () => {
    const pageIndexAtStart = currentPageIndexRef.current;
    const entry = await runHistoryStep(history.undo);

    // Only a step that actually undid something: a keypress against an empty history would condemn a
    // perfectly good stroke to the top of the review queue.
    if (!entry) return;

    onUndoPerformed?.();
    settleHistoryStep(pageIndexAtStart);
  }, [history, onUndoPerformed, runHistoryStep, settleHistoryStep]);

  const handleRedo = useCallback(async () => {
    const pageIndexAtStart = currentPageIndexRef.current;
    const entry = await runHistoryStep(history.redo);

    if (entry) settleHistoryStep(pageIndexAtStart);
  }, [history, runHistoryStep, settleHistoryStep]);

  // --- Live co-editing: someone else's item changes, put in without a reload ---
  // Never under the pen or during a page load. A page on the canvas changes object by object through
  // the history's restore (only the changed items are revived, its undo restarts there); any other page
  // gets its stored JSON updated. False = could not apply: the host reloads the board instead.
  const applyRemoteItems = useCallback(
    async (ops: RemoteItemOps[]): Promise<boolean> => {
      // Wait for a stroke, a page load, a text being typed, and (briefly) a selection: putting items in
      // replaces the page's objects, which would cut a stroke short or drop what is selected. A pen held
      // down for a full minute is the only case that gives up (the host then reloads the board); typing
      // waits as long as it takes.
      const started = Date.now();
      const typing = () => (fabricCanvasRef.current?.getActiveObject() as { isEditing?: boolean } | undefined)?.isEditing === true;
      const busy = () => {
        if (isPointerDown() || isSyncingCanvasRef.current || isBatchRenderingRef.current) return true;
        if (!fabricCanvasRef.current?.getActiveObject()) return false;

        return typing() || Date.now() - started < 3_000;
      };

      while (busy()) {
        if (!typing() && Date.now() - started > 60_000) return false;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }

      const pageIndexAtStart = currentPageIndexRef.current;
      let onCanvas = false;

      historyStepsInFlightRef.current += 1;
      isRestoringHistoryRef.current = true;

      try {
        for (const op of ops) {
          const result = await history.applyExternal(op.page, (live) => applyItemOpsToState(live, op));

          if (result === 'applied') {
            onCanvas = true;
            continue;
          }

          if (result === 'failed') return false;

          const index = pagesRef.current.findIndex((page) => page.id === op.page);
          const page = pagesRef.current[index];

          if (!page) continue;

          const canvasJSON = applyItemOpsToCanvasJson(page.canvasJSON, op);

          if (canvasJSON === page.canvasJSON) continue;

          const next = pagesRef.current.slice();

          next[index] = { ...page, canvasJSON };
          pagesRef.current = next;
          setPages(next);
          scrollSessionRef.current?.syncPages(next);
          needsPersistRef.current = true;
        }
      } finally {
        historyStepsInFlightRef.current -= 1;

        if (historyStepsInFlightRef.current === 0) isRestoringHistoryRef.current = false;
      }

      if (onCanvas) settleHistoryStep(pageIndexAtStart);

      return true;
    },
    [history, settleHistoryStep],
  );

  useEffect(() => {
    if (!liveBoardRef) return;

    liveBoardRef.current = { getDocument: buildDocumentSnapshot, applyRemoteItems };

    return () => {
      liveBoardRef.current = null;
    };
  }, [applyRemoteItems, buildDocumentSnapshot, liveBoardRef]);

  // Hand the live canvas to a paged export/publish sweep: the scroll session writes every dirty page
  // back, dehydrates to an empty canvas, and stops painting the stacked pages. Returns the session to
  // restore with {@link endCanvasSweep}, or null when no session is active (the paged board).
  const beginCanvasSweep = useCallback(() => {
    const session = scrollSessionRef.current;

    if (!session) return null;

    pdfScrollPainterRef.current = null;
    session.suspend();
    backgroundRepaintRef.current?.();

    return session;
  }, []);

  const endCanvasSweep = useCallback(async (session: PdfScrollSession | null, index: number) => {
    if (!session) return;

    pdfScrollPainterRef.current = (ctx, args) => session.paint(ctx, args);
    await session.resume(index);
    viewportConstraintsRef.current = session.getConstraints();
    backgroundRepaintRef.current?.();
  }, []);

  // --- Export current page ---
  const handleExport = useCallback(async () => {
    // Scroll mode: borrow the canvas so createPageExportSnapshot reads ONE page, not the whole scene.
    const sweep = beginCanvasSweep();
    const restoreIndex = currentPageIndexRef.current;
    const syncedPages = flushCurrentPageSnapshot();
    const page = syncedPages[restoreIndex];

    if (!page) {
      await endCanvasSweep(sweep, restoreIndex);

      return;
    }

    try {
      if (sweep) await loadPage(page);

      const exportGeneration = loadGenerationRef.current;
      const overlayImage = await loadSharedBackgroundImage();
      const snapshot = await createPageExportSnapshot(page, overlayImage, {
        format: 'png',
        multiplier: 2,
      });

      // Discard if a page load/restore landed during the awaits — the pixels aren't this page's.
      if (!snapshot || exportGeneration !== loadGenerationRef.current) {
        return;
      }

      const suggestedName = `${sanitizeFilename(documentTitle)}-page-${restoreIndex + 1}.png`;

      pagesRef.current = syncedPages;
      setPages(syncedPages);

      if (fileBridge) {
        const data = new Uint8Array(await (await fetch(snapshot.dataUrl)).arrayBuffer());

        await fileBridge.saveBinary({ suggestedName, data, mimeType: 'image/png', description: 'PNG' });
      } else {
        const link = document.createElement('a');

        link.download = suggestedName;
        link.href = snapshot.dataUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    } finally {
      await endCanvasSweep(sweep, restoreIndex);
    }
  }, [
    beginCanvasSweep,
    createPageExportSnapshot,
    documentTitle,
    endCanvasSweep,
    fileBridge,
    flushCurrentPageSnapshot,
    loadPage,
    loadSharedBackgroundImage,
  ]);

  const buildPublishPayload = useCallback(async (): Promise<WhiteboardPublishPayload | null> => {
    const canvas = fabricCanvasRef.current;

    if (!canvas) {
      return null;
    }

    const sweep = beginCanvasSweep();
    const syncedPages = flushCurrentPageSnapshot();
    const snapshotDocument = buildSnapshotDocument(syncedPages);
    const originalPageIndex = currentPageIndex;
    const originalPage = syncedPages[originalPageIndex];
    const originalViewport = [...(canvas.viewportTransform ?? IDENTITY_VIEWPORT)] as typeof IDENTITY_VIEWPORT;

    try {
      // The loop cycles every page through the live canvas while currentPageIndexRef stays on the
      // original page — block snapshot writers (autosave/visibility flush) for the whole sweep so
      // foreign page content is never filed under the current page's slot.
      isBatchRenderingRef.current = true;
      // A slide intro still running would keep painting the page the teacher LEFT over each page the
      // sweep loads onto the live canvas. Export snapshots build their own canvas, so nothing leaks
      // into the output — this is about what the teacher watches while a publish runs.
      stopPageIntro();

      const overlayImage = await loadSharedBackgroundImage();
      const exportPages = [];

      for (let index = 0; index < syncedPages.length; index += 1) {
        const page = syncedPages[index];

        // A draft page the teacher has not kept is not part of the board.
        if (!page || transientPageIdsRef.current.has(page.id)) {
          continue;
        }

        if (!(await loadPage(page))) {
          return null;
        }

        const pageGeneration = loadGenerationRef.current;
        const snapshot = await createPageExportSnapshot(page, overlayImage, {
          format: 'jpeg',
          multiplier: 2,
          quality: 0.92,
        });

        // A load/restore superseded the sweep mid-snapshot — abort rather than publish a PDF
        // with another page's pixels (or a silently missing page) in this slot.
        if (pageGeneration !== loadGenerationRef.current) {
          return null;
        }

        if (snapshot) {
          exportPages.push(snapshot);
        }
      }

      if (exportPages.length === 0) {
        return null;
      }

      const blob = await buildPdfFromJpegPages(exportPages);
      const thumbnailDataUrl = snapshotDocument.thumbnail || syncedPages[0]?.thumbnail || undefined;

      return {
        document: snapshotDocument,
        pageCount: snapshotDocument.pages.length,
        pdfBlob: blob,
        pdfFileSize: blob.size,
        thumbnailDataUrl,
      };
    } finally {
      try {
        if (originalPage) {
          canvas.setViewportTransform(originalViewport);
          pagesRef.current = syncedPages;
          currentPageIndexRef.current = originalPageIndex;
          setPages(syncedPages);
          setCurrentPageIndex(originalPageIndex);
          setBackgroundType(originalPage.backgroundType);

          if (sweep) {
            await endCanvasSweep(sweep, originalPageIndex);
          } else {
            await loadPage(originalPage);
          }
        }
      } finally {
        // Cleared only AFTER the restore load, because that load is the sweep's own undo — putting
        // the teacher back on the page they were on — not a page ENTER. Clearing it first made every
        // publish/export replay that page's slide intro under the ink they were writing. The nested
        // finally keeps a throwing restore from stranding the flag on, which would silently block
        // the autosave/idle/visibility writers for the rest of the session.
        isBatchRenderingRef.current = false;
      }
    }
  }, [
    beginCanvasSweep,
    buildSnapshotDocument,
    createPageExportSnapshot,
    currentPageIndex,
    endCanvasSweep,
    loadPage,
    loadSharedBackgroundImage,
    flushCurrentPageSnapshot,
    stopPageIntro,
  ]);

  /**
   * Server-merge (mechanism #3) producer: a guarded ALL-PAGES sweep that renders, per page in order,
   * the transparent overlay PNG (everything EXCEPT the source PDF) + the geometry manifest entry
   * (MINUS `overlayKey`). The host uploads each overlay, attaches `overlayKey`, then calls the
   * backend `generateVersion`. Modeled on {@link buildPublishPayload}: it cycles every page through
   * the live canvas under `isBatchRenderingRef` (blocking the autosave/idle/visibility writers), then
   * restores the original page/viewport in `finally`. Re-checks `loadGenerationRef` after every async
   * await so a page-switch mid-sweep can never file one page's overlay under another page's index;
   * returns `null` (rather than a mixed-up manifest) if the canvas is gone or the sweep is superseded.
   */
  const buildMergeOverlays = useCallback(async (): Promise<MergeOverlaysResult | null> => {
    const canvas = fabricCanvasRef.current;

    if (!canvas) {
      return null;
    }

    const sweep = beginCanvasSweep();
    const syncedPages = flushCurrentPageSnapshot();
    const originalPageIndex = currentPageIndex;
    const originalPage = syncedPages[originalPageIndex];
    const originalViewport = [...(canvas.viewportTransform ?? IDENTITY_VIEWPORT)] as typeof IDENTITY_VIEWPORT;

    try {
      // Same guarded sweep contract as buildPublishPayload: the loop drives every page through the
      // live canvas while currentPageIndexRef stays on the original page, so snapshot writers must be
      // blocked for the whole sweep or foreign page content could be filed under the current slot.
      isBatchRenderingRef.current = true;
      // A slide intro still running would keep painting the page the teacher LEFT over each page the
      // sweep loads onto the live canvas. Export snapshots build their own canvas, so nothing leaks
      // into the output — this is about what the teacher watches while a publish runs.
      stopPageIntro();

      const overlayImage = await loadSharedBackgroundImage();
      const overlayPages: MergeOverlaysResult['pages'] = [];
      // Manifest indices are the PERSISTED document's — a draft page is skipped without a slot.
      let persistedIndex = -1;

      for (let index = 0; index < syncedPages.length; index += 1) {
        const page = syncedPages[index];

        if (!page || transientPageIdsRef.current.has(page.id)) {
          continue;
        }

        persistedIndex += 1;

        if (!(await loadPage(page))) {
          return null;
        }

        const pageGeneration = loadGenerationRef.current;
        // Cap the long edge so one huge page can't balloon the in-memory PNG (the backend scales the
        // overlay to fill the output page anyway, so a slightly lower DPI on giant pages is fine).
        const snapshot = await createPageOverlaySnapshot(page, overlayImage, { maxDimension: 2400 });

        // A load/restore superseded the sweep mid-snapshot — abort rather than emit a manifest with
        // another page's overlay (or a silently missing page) in this slot.
        if (pageGeneration !== loadGenerationRef.current || !snapshot) {
          return null;
        }

        overlayPages.push({
          entry: buildMergeManifestEntry(page, persistedIndex, snapshot),
          overlayDataUrl: snapshot.dataUrl,
        });
      }

      if (overlayPages.length === 0) {
        return null;
      }

      return { pages: overlayPages };
    } finally {
      try {
        if (originalPage) {
          canvas.setViewportTransform(originalViewport);
          pagesRef.current = syncedPages;
          currentPageIndexRef.current = originalPageIndex;
          setPages(syncedPages);
          setCurrentPageIndex(originalPageIndex);
          setBackgroundType(originalPage.backgroundType);

          if (sweep) {
            await endCanvasSweep(sweep, originalPageIndex);
          } else {
            await loadPage(originalPage);
          }
        }
      } finally {
        // Cleared only AFTER the restore load, because that load is the sweep's own undo — putting
        // the teacher back on the page they were on — not a page ENTER. Clearing it first made every
        // publish/export replay that page's slide intro under the ink they were writing. The nested
        // finally keeps a throwing restore from stranding the flag on, which would silently block
        // the autosave/idle/visibility writers for the rest of the session.
        isBatchRenderingRef.current = false;
      }
    }
  }, [
    beginCanvasSweep,
    createPageOverlaySnapshot,
    currentPageIndex,
    endCanvasSweep,
    flushCurrentPageSnapshot,
    loadPage,
    loadSharedBackgroundImage,
    stopPageIntro,
  ]);

  // Expose the server-merge overlay producer to the host (board page) via the same ref-prop pattern
  // as flushBeforeCloseRef: the host calls `buildMergeOverlaysRef.current()` to render every page's
  // overlay + manifest, then uploads + generates the merged version.
  useEffect(() => {
    if (!buildMergeOverlaysRef) {
      return;
    }

    buildMergeOverlaysRef.current = buildMergeOverlays;

    return () => {
      buildMergeOverlaysRef.current = null;
    };
  }, [buildMergeOverlays, buildMergeOverlaysRef]);

  const handleExportPdf = useCallback(async () => {
    if (isExportingPdf) {
      return;
    }

    setIsExportingPdf(true);

    try {
      const publishPayload = await buildPublishPayload();

      if (!publishPayload) {
        return;
      }

      const suggestedName = `${sanitizeFilename(documentTitle)}.pdf`;

      if (fileBridge) {
        const data = new Uint8Array(await publishPayload.pdfBlob.arrayBuffer());

        await fileBridge.saveBinary({ suggestedName, data, mimeType: 'application/pdf', description: 'PDF' });
      } else {
        const url = URL.createObjectURL(publishPayload.pdfBlob);
        const link = document.createElement('a');

        link.download = suggestedName;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
    } finally {
      setIsExportingPdf(false);
    }
  }, [buildPublishPayload, documentTitle, fileBridge, isExportingPdf]);

  // Export the whole whiteboard (all pages + canvas JSON + metadata) as a re-importable .json file.
  // Mirrors handleExport: serialize the snapshot document and trigger a download. Works on the web
  // and inside the Tauri WebView2 shell (which routes anchor downloads to the local disk).
  const handleExportDocument = useCallback(() => {
    const syncedPages = flushCurrentPageSnapshot();
    const snapshotDocument = buildSnapshotDocument(syncedPages);
    const suggestedName = `${sanitizeFilename(documentTitle)}.kawb.json`;
    const text = JSON.stringify(snapshotDocument);

    pagesRef.current = syncedPages;
    setPages(syncedPages);

    if (fileBridge) {
      void fileBridge.saveText({
        suggestedName,
        text,
        mimeType: 'application/json',
        description: 'Whiteboard document',
      });
    } else {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.download = suggestedName;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  }, [buildSnapshotDocument, documentTitle, fileBridge, flushCurrentPageSnapshot]);

  const handlePublishVersion = useCallback(async () => {
    if (!onPublishVersion || isPublishingVersion) {
      return;
    }

    const publishPayload = await buildPublishPayload();

    if (!publishPayload) {
      return;
    }

    await onPublishVersion(publishPayload);
  }, [buildPublishPayload, isPublishingVersion, onPublishVersion]);

  // --- Zoom controls ---
  // Pull the viewport back inside the active cage (paged zoom-lock or scroll). No-op when unconstrained.
  const clampCanvasToConstraints = useCallback((canvas: Canvas) => {
    const constraints = effectiveConstraintsRef.current;

    if (!constraints) return;

    const clamped = clampViewportTransform(canvas.viewportTransform, constraints, canvas.getWidth(), canvas.getHeight());

    if (!isSameViewportTransform(canvas.viewportTransform, clamped)) {
      canvas.setViewportTransform(clamped);
    }
  }, []);

  const handleZoomIn = useCallback(() => {
    const canvas = fabricCanvasRef.current;

    if (!canvas) return;

    const currentZoom = canvas.getZoom();
    const constraints = effectiveConstraintsRef.current;
    const maxZoom = constraints ? constraints.maxZoom : 4;
    const newZoom = Math.min(maxZoom, currentZoom * 1.1);
    const center = canvas.getCenterPoint();

    canvas.zoomToPoint(new Point(center.x, center.y), newZoom);
    clampCanvasToConstraints(canvas);
    setZoom(canvas.getZoom());
    canvas.requestRenderAll();
  }, []);

  const handleZoomOut = useCallback(() => {
    const canvas = fabricCanvasRef.current;

    if (!canvas) return;

    const currentZoom = canvas.getZoom();
    const constraints = effectiveConstraintsRef.current;
    const minZoom = constraints ? constraints.minZoom : 0.25;
    const newZoom = Math.max(minZoom, currentZoom / 1.1);
    const center = canvas.getCenterPoint();

    canvas.zoomToPoint(new Point(center.x, center.y), newZoom);
    clampCanvasToConstraints(canvas);
    setZoom(canvas.getZoom());
    canvas.requestRenderAll();
  }, []);

  const handleResetZoom = useCallback(() => {
    const canvas = fabricCanvasRef.current;

    if (!canvas) return;

    const scrollSession = scrollSessionRef.current;

    if (scrollSession) {
      // "100%" in the continuous layout is the current page filling the width, scrolled to its top.
      void scrollSession.enter(currentPageIndexRef.current);
      setZoom(canvas.getZoom());

      return;
    }

    // A notebook sheet: "100%" is the sheet at its fit width, where the view is reading now.
    const notebookConstraints = notebookConstraintsRef.current;

    if (notebookPageRef.current && notebookConstraints && viewportConstraintsRef.current === notebookConstraints) {
      canvas.setViewportTransform(
        fitNotebookViewport(canvas.viewportTransform, notebookConstraints, canvas.getWidth(), canvas.getHeight()),
      );
      setZoom(canvas.getZoom());
      canvas.requestRenderAll();

      return;
    }

    // "100%" is the page filling the width: identity for a blank page; for a PDF page the zoom that
    // maps its frozen frame onto this window (1 unless the frame was recorded elsewhere), scrolled so
    // a page taller than the frame shows its top — the frame origin alone would cut the top off,
    // since the fit centres a tall page past the top edge.
    const currentPage = pagesRef.current[currentPageIndexRef.current];
    const reset = currentPage
      ? resolveResetViewport({
          canvasWidth: canvas.getWidth(),
          page: currentPage,
          pdfFrame: pdfBackgroundFrameRef.current,
        })
      : { offsetX: 0, offsetY: 0, zoom: 1 };

    canvas.setViewportTransform([reset.zoom, 0, 0, reset.zoom, reset.offsetX, reset.offsetY]);
    clampCanvasToConstraints(canvas);
    setZoom(canvas.getZoom());
    canvas.requestRenderAll();
  }, []);

  // --- Delete selected objects ---
  const handleDeleteSelected = useCallback(() => {
    const canvas = fabricCanvasRef.current;

    if (!canvas) return;

    const selected = canvas.getActiveObjects();

    if (selected.length > 0) {
      canvas.discardActiveObject();
      canvas.remove(...selected);
      canvas.requestRenderAll();
    }
  }, []);

  // --- Insert image ---
  /**
   * Place an image FILE on the current page, centred and scaled to fit, as a normal selectable
   * object. The one insert path: the toolbar's picker and a host-supplied image (a photo that
   * arrived over the LAN and the teacher chose to add to THIS board) both land here, so both behave
   * identically.
   */
  const insertImageFile = useCallback(async (file: File) => {
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();

      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    const canvas = fabricCanvasRef.current;

    if (!canvas || !dataUrl) return;

    const { FabricImage, Point, util } = await import('fabric');
    const img = await FabricImage.fromURL(dataUrl, { crossOrigin: 'anonymous' });

    // Place it in the middle of what is on screen, in SCENE coordinates: once the board is zoomed or
    // scrolled (the continuous PDF column) the canvas pixel centre is somewhere else on the page.
    const inverse = util.invertTransform(canvas.viewportTransform);
    const topLeft = util.transformPoint(new Point(0, 0), inverse);
    const bottomRight = util.transformPoint(new Point(canvas.getWidth(), canvas.getHeight()), inverse);
    const viewWidth = Math.max(1, bottomRight.x - topLeft.x);
    const viewHeight = Math.max(1, bottomRight.y - topLeft.y);
    const scale = Math.min((viewWidth * 0.6) / (img.width || 1), (viewHeight * 0.6) / (img.height || 1), 1);
    const width = (img.width || 0) * scale;
    const height = (img.height || 0) * scale;
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

    img.set({
      originX: 'left',
      originY: 'top',
      scaleX: scale,
      scaleY: scale,
      left: clamp(topLeft.x + (viewWidth - width) / 2, topLeft.x, bottomRight.x - width),
      top: clamp(topLeft.y + (viewHeight - height) / 2, topLeft.y, bottomRight.y - height),
      selectable: true,
      evented: true,
    });

    canvas.add(img);
    canvas.setActiveObject(img);
    canvas.requestRenderAll();
    // Hand the teacher the select tool with the picture already picked up — on the pen or brush the
    // frame showed but every press inked (or panned) instead of moving, scaling or deleting it.
    if (!readOnly) handleToolChange('select');
    onImagePlaced?.(file);
  }, [handleToolChange, onImagePlaced, readOnly]);

  const handleInsertImage = useCallback(() => {
    const input = document.createElement('input');

    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];

      if (!file) return;

      void insertImageFile(file);
    };
    input.click();
  }, [insertImageFile]);

  // A host-supplied image — one-shot, exactly like `pendingPdfImport`: the host is told immediately
  // so it can drop its reference, and a re-render never re-inserts the same photo.
  useEffect(() => {
    if (!pendingImageImport) {
      return;
    }

    void insertImageFile(pendingImageImport);
    onPendingImageImportHandled?.();
  }, [insertImageFile, onPendingImageImportHandled, pendingImageImport]);

  // A host-supplied concept map, drawn in hand ink. One-shot like `pendingImageImport`, but it waits
  // for the page to finish loading first (an add before the load lands would be wiped by it, or land
  // on a sheet that is not measured yet): the canvas idle, the page list in, the notebook sheet
  // measured — three polls in a row.
  const conceptMapHandledRef = useRef(onPendingConceptMapHandled);
  const conceptPenRef = useRef(strokeSettings);

  const conceptPdfUrlRef = useRef(currentPdfPageImageUrl);

  conceptMapHandledRef.current = onPendingConceptMapHandled;
  conceptPenRef.current = strokeSettings;
  conceptPdfUrlRef.current = currentPdfPageImageUrl;

  useEffect(() => {
    if (!pendingConceptMap || !fabricCanvas || readOnly) return;

    let cancelled = false;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // The sheet is waited for ~3 s; a page that never becomes one (a PDF page) draws without it.
    const ready = (attempt: number) =>
      !isSyncingCanvasRef.current &&
      Boolean(pagesRef.current[currentPageIndexRef.current]) &&
      (!verticalNotebook || attempt >= 25 || notebookPageRef.current?.pageId === pagesRef.current[currentPageIndexRef.current]?.id);

    void (async () => {
      let stable = 0;

      for (let attempt = 0; attempt < 100 && stable < 3; attempt += 1) {
        await wait(120);

        if (cancelled) return;

        stable = ready(attempt) ? stable + 1 : 0;
      }

      const canvas = fabricCanvasRef.current;
      const pageId = pagesRef.current[currentPageIndexRef.current]?.id ?? null;

      if (cancelled || !canvas || stable < 3) {
        if (!cancelled) conceptMapHandledRef.current?.(false);

        return;
      }

      const sheet = notebookPageRef.current?.pageId === pageId ? notebookPageRef.current : null;
      let drawn = false;

      try {
        // A PDF / slide page: its printed lines are not board objects — read them so the map is not
        // written over them (the same page rect the paged zoom-lock cages to).
        const page = pagesRef.current[currentPageIndexRef.current];
        let backdrop: ReturnType<typeof readPageBackdrop> | null = null;

        // (The scroll layout stacks every page in one scene; its page-local frame would mislead: there
        // the map keeps going below everything.)
        if (page && (page.pdfAssetId || page.pdfImageUrl) && !isScrollActiveRef.current) {
          const frame = pdfBackgroundFrameRef.current;
          const rotation = normalizeRotationDeg(page.pdfRotation);
          let rect: { x: number; y: number; width: number; height: number } | null = null;

          if (frame && frame.pageId === page.id && frame.fitWidth > 0 && frame.fitHeight > 0) {
            const placement = frame.image
              ? getRotatedScreenFitPlacement(frame.fitWidth, frame.fitHeight, frame.image.width, frame.image.height, rotation)
              : { height: frame.fitHeight, left: 0, top: 0, width: frame.fitWidth };

            rect = { height: placement.height, width: placement.width, x: placement.left, y: placement.top };
          } else {
            const geometry = resolveSnapshotGeometry({ canvasWidth: canvas.getWidth(), page, pdfFrame: null });

            if (geometry && typeof geometry.pdfPlacement === 'object') rect = geometry.pdfPlacement;
          }

          if (rect) {
            const image = rotation === 0 ? await loadCanvasImage(conceptPdfUrlRef.current).catch(() => null) : null;

            backdrop = readPageBackdrop({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }, image);
          }
        }

        drawn = await insertHandConceptMap(canvas, pendingConceptMap, {
          backdrop,
          penColor: conceptPenRef.current.color,
          penWidth: conceptPenRef.current.width,
          lang: 'en',
          sheet: sheet ? { left: sheet.pageLeft, right: sheet.pageRight } : null,
          host: canvas.getElement().parentElement,
          isStillCurrent: () => !cancelled && pagesRef.current[currentPageIndexRef.current]?.id === pageId,
          scrollIntoView: (rect) => {
            // The endless sheet only reaches as far as its ink: stretch it over the map first, so
            // the clamp lets the view travel there.
            const ink = notebookInkRef.current;

            if (ink && ink.pageId === pageId) {
              ink.rect = ink.rect
                ? { ...ink.rect, bottom: Math.max(ink.rect.bottom, rect.top + rect.height) }
                : { bottom: rect.top + rect.height, left: 0, right: 0, top: rect.top };
              notebookUpdateRef.current?.('grow');
            }

            const vpt = [...(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0])] as ViewportTransform6;
            const zoom = vpt[0] || 1;
            const viewTop = -vpt[5] / zoom;
            const viewBottom = viewTop + canvas.getHeight() / zoom;

            if (rect.top >= viewTop && rect.top + Math.min(rect.height, canvas.getHeight() / zoom / 2) <= viewBottom) return;

            vpt[5] = -rect.top * zoom;
            canvas.setViewportTransform(vpt);
            clampCanvasToConstraints(canvas);
            canvas.requestRenderAll();
          },
        });
      } catch {
        drawn = false;
      }

      if (!cancelled) conceptMapHandledRef.current?.(drawn);
    })();

    return () => {
      cancelled = true;
    };
    // `locale` / pen settings are read when it runs; only a new map (or canvas) restarts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fabricCanvas, pendingConceptMap, readOnly]);

  const handleInsertGeometryStencil = useCallback(
    async (kind: GeometryStencilKind) => {
      const canvas = fabricCanvasRef.current;

      if (!canvas) {
        return;
      }

      const { FabricImage } = await import('fabric');
      const stencil = await FabricImage.fromURL(getGeometryStencilDataUrl(kind), { crossOrigin: 'anonymous' });
      const maxWidth = canvas.getWidth() * 0.46;
      const maxHeight = canvas.getHeight() * 0.42;
      const sourceWidth = stencil.width || maxWidth;
      const sourceHeight = stencil.height || maxHeight;
      const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1);

      stencil.set({
        data: {
          geometryStencilKind: kind,
          isGeometryStencil: true,
        },
        left: (canvas.getWidth() - sourceWidth * scale) / 2,
        top: (canvas.getHeight() - sourceHeight * scale) / 2,
        opacity: 0.92,
        scaleX: scale,
        scaleY: scale,
        selectable: true,
        evented: true,
      });

      canvas.add(stencil);
      canvas.setActiveObject(stencil);
      canvas.requestRenderAll();
      handleToolChange('select');
    },
    [handleToolChange],
  );

  // The explicit √ (for when recognition misses): a clean radical in the pen's colour and width at the
  // middle of the view, selected, ready to stretch with its bar / depth handles.
  const handleInsertRadical = useCallback(() => {
    const canvas = fabricCanvasRef.current;

    if (!canvas) {
      return;
    }

    const zoom = canvas.getZoom() || 1;
    const height = 64 / zoom;
    const params = defaultRadicalParams(height);
    const center = canvas.getVpCenter();
    const radical = createSnappedShapeObject(
      radicalShape({ anchor: { x: center.x - params.bar / 2 + height * 0.15, y: center.y - height / 2 }, params }),
      { color: strokeSettings.color, width: strokeSettings.width, opacity: strokeSettings.opacity, blur: 0, nib: null },
    );

    canvas.add(radical);
    canvas.setActiveObject(radical);
    canvas.requestRenderAll();
    handleToolChange('select');
  }, [handleToolChange, strokeSettings.color, strokeSettings.opacity, strokeSettings.width]);

  const handleToggleFullscreen = useCallback(async () => {
    if (typeof document === 'undefined') {
      return;
    }

    const fullscreenDocument = document as Document & {
      webkitFullscreenElement?: Element | null;
    };
    const fullscreenRoot = (overlayPortalContainer ?? editorRootRef.current) as
      | (HTMLDivElement & {
          webkitRequestFullscreen?: () => Promise<void> | void;
        })
      | null;
    const activeFullscreenElement = document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement ?? null;

    if (activeFullscreenElement) {
      await exitFullscreenIfActive();

      return;
    }

    if (fullscreenRoot?.requestFullscreen) {
      await fullscreenRoot.requestFullscreen();
    } else {
      await fullscreenRoot?.webkitRequestFullscreen?.();
    }
  }, [exitFullscreenIfActive, overlayPortalContainer]);

  // --- Toggle lock objects ---
  const handleToggleLock = useCallback(() => {
    const canvas = fabricCanvasRef.current;

    if (!canvas) return;

    const newLocked = !isLocked;

    canvas.forEachObject((obj) => {
      const isEraserMark =
        (obj as { globalCompositeOperation?: string }).globalCompositeOperation === 'destination-out';

      obj.selectable = !newLocked && !isEraserMark;
      obj.evented = !newLocked && !isEraserMark;
    });
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    setIsLocked(newLocked);
  }, [isLocked]);

  // --- Pin / unpin one image ---
  // A pinned image keeps its place in the object list (so it saves, exports, and can be unpinned) but
  // leaves fabric's rendering entirely — the background painter draws it BELOW the ink, the only
  // placement the pixel eraser cannot punch a hole through. Persistence rides on the lock-change
  // subscription above, which schedules the same debounced snapshot every object edit uses.
  const handlePinImage = useCallback(() => {
    const canvas = fabricCanvasRef.current;
    const image = pinImageAction?.image;

    if (!canvas || !image) return;

    applyImageLockState(image, true);
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    notifyLockedImagesChanged(canvas);
  }, [pinImageAction]);

  const handleUnpinImage = useCallback((image: FabricObject) => {
    const canvas = fabricCanvasRef.current;

    if (!canvas) return;

    applyImageLockState(image, false);
    canvas.requestRenderAll();
    notifyLockedImagesChanged(canvas);
  }, []);

  // --- Duplicate current page shortcut ---
  const handleDuplicateCurrentPage = useCallback(() => {
    duplicatePage(currentPageIndex);
  }, [duplicatePage, currentPageIndex]);

  // --- Clear canvas ---
  const handleClearCanvas = useCallback(() => {
    const canvas = fabricCanvasRef.current;

    if (!canvas) return;

    // «Clear writing» clears the WRITING. A pinned image is the sheet being written ON, not writing —
    // it stays, and the unpin chip is how it leaves.
    const objects = canvas.getObjects().filter((object) => !isLockedImage(object));

    canvas.discardActiveObject();

    if (objects.length > 0) {
      canvas.remove(...objects);
    }

    canvas.requestRenderAll();
    flushCurrentPageSnapshot();
  }, [flushCurrentPageSnapshot]);

  const displayStrokeSettings = useMemo(
    () =>
      activeTool === 'highlighter'
        ? {
            ...strokeSettings,
            opacity: FIXED_HIGHLIGHTER_OPACITY,
          }
        : strokeSettings,
    [activeTool, strokeSettings],
  );
  // The PDF stage used to carry a 2.5px border, rounded corners and an offset shadow that a plain
  // board never had. That put the three stacked canvases at a fractional device-pixel offset, so on
  // an integrated GPU every stroke segment re-composited them with resampling — one of the only
  // per-frame costs that existed on PDF boards alone (2026-09-13, ViewSonic). The stage is now
  // pixel-identical to a plain board; only the paper colour behind a letterboxed page remains.
  const canvasStageClassName = hasPdfPageBackground ? 'relative h-full w-full bg-white' : 'relative h-full w-full';
  const isFullScrollToolbar = toolbarLayout === 'full-scroll' && (toolbarDock === 'top' || toolbarDock === 'bottom');
  // A side dock in full-scroll mode is the same flush bar as the bottom one, turned into a column beside the page.
  const isSideColumnToolbar = toolbarLayout === 'full-scroll' && (toolbarDock === 'left' || toolbarDock === 'right');
  const toolbarWrapperClassName = useMemo(() => {
    // Full width, on a row of its own below the title bar / host cluster (both top-3, ~2.25rem tall).
    if (toolbarLayout === 'full-scroll' && toolbarDock === 'top') {
      return 'pointer-events-none absolute inset-x-3 top-[3.5rem] z-20 flex';
    }
    if (toolbarLayout === 'full-scroll' && toolbarDock === 'bottom') {
      // In flow, under the canvas stage: a flush bar that takes its height away from the page instead
      // of covering it (the pager lives inside it, so nothing else sits down here).
      return 'relative z-20 flex w-full shrink-0';
    }
    if (isSideColumnToolbar) {
      // In flow beside the canvas, below the top chip row (the title bar / host cluster sit above it).
      return `relative z-20 flex h-full shrink-0 flex-col pt-[3.75rem] ${toolbarDock === 'left' ? 'order-first' : ''}`;
    }
    switch (toolbarDock) {
      case 'bottom':
        return 'pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center';
      case 'left':
        return 'pointer-events-none absolute inset-y-0 start-[14rem] z-20 flex items-center';
      case 'right':
        return 'pointer-events-none absolute inset-y-0 end-[14rem] z-20 flex items-center';
      case 'top':
      default:
        return 'pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center';
    }
  }, [isSideColumnToolbar, toolbarDock, toolbarLayout]);
  // A horizontal dock shares its row with the chrome at both edges — the title bar here, the host's
  // record/bell/QR cluster — and each publishes its measured width as a CSS variable on this container
  // (utils/chromeInsets). Padding the wrapper by them makes the toolbar's box exactly the gap between
  // the two, centred in that gap, so it wraps into rows instead of running under either.
  const toolbarWrapperStyle = useMemo<React.CSSProperties | undefined>(
    () =>
      !isFullScrollToolbar && (toolbarDock === 'top' || toolbarDock === 'bottom')
        ? {
            paddingInlineStart: 'calc(var(--wb-chrome-inset-start, 0px) + 0.75rem)',
            paddingInlineEnd: 'calc(var(--wb-chrome-inset-end, 0px) + 0.75rem)',
          }
        : undefined,
    [isFullScrollToolbar, toolbarDock],
  );
  const titleBarRef = useChromeInset('start');
  // chromeHideStyle's 'end' slides left (translateX -16px) and 'start' slides right, so a `left` dock
  // hides toward the left edge and a `right` dock toward the right.
  const toolbarHideEdge = toolbarDock === 'bottom' ? 'bottom' : toolbarDock === 'left' ? 'end' : toolbarDock === 'right' ? 'start' : 'top';
  // The rotate panel sits just past the toolbar on whichever edge it is docked to, so the button that
  // opened it stays visible next to it.
  const rotatePanelWrapperClassName = useMemo(() => {
    switch (toolbarDock) {
      case 'bottom':
        return 'pointer-events-none absolute inset-x-0 bottom-20 z-30 flex justify-center';
      case 'left':
        return 'pointer-events-none absolute inset-y-0 start-[21rem] z-30 flex items-center';
      case 'right':
        return 'pointer-events-none absolute inset-y-0 end-[21rem] z-30 flex items-center';
      case 'top':
      default:
        // Below the full-width toolbar row when that row is on (it starts at 3.5rem and is ~3.75rem tall).
        return `pointer-events-none absolute inset-x-0 ${toolbarLayout === 'full-scroll' ? 'top-[7.75rem]' : 'top-20'} z-30 flex justify-center`;
    }
  }, [toolbarDock, toolbarLayout]);
  // Full-scroll row: the page controls ride in the toolbar (see `toolbarLayout`) whenever it is shown.
  const isPagerInToolbar = (isFullScrollToolbar || isSideColumnToolbar) && !isFocusMode && !readOnly;
  const isToolbarInFlow = ((isFullScrollToolbar && toolbarDock === 'bottom') || isSideColumnToolbar) && !isFocusMode && !readOnly;
  const pageListAnchor = useMemo<{ className: string; style?: React.CSSProperties } | undefined>(() => {
    if (!isPagerInToolbar) return undefined;
    if (isSideColumnToolbar) {
      // Beside the column, at its foot where the page group sits.
      return {
        className: `absolute bottom-3 z-30 flex items-end ${toolbarDock === 'left' ? 'start-3 flex-row' : 'end-3 flex-row-reverse'}`,
      };
    }
    if (toolbarDock === 'bottom') {
      // Just above the flush bar (~3.5rem + the gesture-bar inset).
      return {
        className: 'absolute end-3 z-30 flex flex-row-reverse items-end',
        style: { bottom: 'calc(4rem + env(safe-area-inset-bottom, 0px))' },
      };
    }

    // Just under the top row (it starts at 3.5rem and is ~3.75rem tall).
    return { className: 'absolute end-3 top-[7.75rem] z-30 flex flex-row-reverse items-start' };
  }, [isPagerInToolbar, isSideColumnToolbar, toolbarDock]);
  const togglePageList = useCallback(() => setIsPageListOpen((open) => !open), []);
  const pageAddControl =
    allowInsertBlankPages && isScrollActive && !readOnly ? (
      <BlankPageMenu
        canDelete={isInsertedSheet(pages[currentPageIndex])}
        currentLabel={currentPageLabel}
        hasInk={currentSheetHasInk}
        overlayPortalContainer={overlayPortalContainer}
        placement={isPagerInToolbar && toolbarDock === 'top' ? 'bottom-end' : 'top-end'}
        triggerClassName={isPagerInToolbar ? PAGE_GROUP_BUTTON_CLASS : undefined}
        triggerStyle={isPagerInToolbar ? TOOLBAR_SURFACE.brand : undefined}
        onDelete={() => void deleteBlankSheet()}
        onInsertAfter={() => void insertBlankSheet('after')}
        onInsertAtEnd={() => void insertBlankSheet('end')}
      />
    ) : (
      <Tooltip content={t('editor.addPage')} portalContainer={overlayPortalContainer}>
        <Button
          aria-label={t('editor.addPage')}
          className={isPagerInToolbar ? PAGE_GROUP_BUTTON_CLASS : 'border-sk border-ink bg-citrine text-ink shadow-sk'}
          data-wb-add-page
          isIconOnly
          size={isPagerInToolbar ? undefined : 'sm'}
          style={isPagerInToolbar ? TOOLBAR_SURFACE.brand : undefined}
          variant='flat'
          onPress={addPage}
        >
          <Plus className={isPagerInToolbar ? 'h-5 w-5' : 'h-4 w-4'} />
        </Button>
      </Tooltip>
    );
  const toolbarPageGroup = isPagerInToolbar ? (
    <ToolbarPageGroup
      addControl={pageAddControl}
      canNext={currentPageIndex < pages.length - 1}
      canPrev={currentPageIndex > 0}
      currentLabel={currentPageLabel}
      dir={dir}
      isPageListOpen={isPageListOpen}
      overlayPortalContainer={overlayPortalContainer}
      total={pages.length}
      vertical={isSideColumnToolbar}
      onNext={() => navigateToPage(currentPageIndexRef.current + 1)}
      onPrev={() => navigateToPage(currentPageIndexRef.current - 1)}
      onTogglePageList={togglePageList}
    />
  ) : null;

  const toolbarNode = !isFocusMode && !readOnly ? (
          <div
            className={toolbarWrapperClassName}
            style={chromeHideStyle(
              aiChromeHidden,
              toolbarHideEdge,
              // The strip above a side column is board, not page chrome: paint it the board's own base.
              isSideColumnToolbar
                ? { ...toolbarWrapperStyle, background: boardTheme === 'dark' ? DARK_BOARD_BASE_COLOR : LIGHT_BOARD_BASE_COLOR }
                : toolbarWrapperStyle,
            )}
          >
            <div
              className={`pointer-events-auto min-w-0 max-w-full ${isFullScrollToolbar ? 'w-full' : isSideColumnToolbar ? 'min-h-0 flex-1' : ''}`}
              data-wb-chrome='toolbar'
            >
              <Toolbar
                activeTool={activeTool}
                backgroundType={backgroundType}
                backgroundImageOpacity={sharedBackgroundImageOpacity}
                canRedo={history.canRedo}
                canUndo={history.canUndo}
                compactSelectTool={compactSelectTool}
                compactUndoRedo={compactUndoRedo}
                dock={toolbarDock}
                layout={toolbarLayout}
                trailing={toolbarPageGroup}
                eraserMode={eraserMode}
                eraserSize={eraserSize}
                fillColor={fillColor}
                hasPdfPageBackground={hasPdfPageBackground}
                hasSharedBackgroundImage={Boolean(sharedBackgroundImageUrl)}
                isFullscreen={isFullscreen}
                isLocked={isLocked}
                openToolSettings={openToolSettings}
                overlayPortalContainer={overlayPortalContainer}
                smoothingEnabled={smoothingEnabled}
                strokeSettings={displayStrokeSettings}
                zoom={zoom}
                onBackgroundTypeChange={handleBackgroundTypeChange}
                paperSpacingMm={allowPaperSpacing ? currentPage?.paperSpacingMm : undefined}
                onPaperSpacingChange={allowPaperSpacing ? handlePaperSpacingChange : undefined}
                onBackgroundImageOpacityChange={setSharedBackgroundImageOpacity}
                onClear={handleClearCanvas}
                onClearSharedBackground={handleClearSharedBackground}
                onColorSwap={handleQuickStrokeColorToggle}
                onDockChange={setToolbarDock}
                onDuplicatePage={handleDuplicateCurrentPage}
                onPaste={selectionActions.canPaste ? () => void selectionActions.pasteAtViewportCentre() : undefined}
                onEraserModeChange={setEraserMode}
                onEraserSizeChange={setEraserSize}
                onEnterFocusMode={() => setIsFocusMode(true)}
                onExportDocument={handleExportDocument}
                onExportImage={handleExport}
                onExportPdf={handleExportPdf}
                onPublishVersion={onPublishVersion ? handlePublishVersion : undefined}
                onFillColorChange={setFillColor}
                onInsertGeometryStencil={handleInsertGeometryStencil}
                onInsertRadical={handleInsertRadical}
                onInsertImage={handleInsertImage}
                onOpenToolSettings={handleOpenToolSettings}
                isExportingPdf={isExportingPdf}
                isPublishingVersion={isPublishingVersion}
                onRedo={handleRedo}
                onResetZoom={handleResetZoom}
                onRotatePageBackground={handleToggleRotatePanel}
                onSmoothingChange={setSmoothingEnabled}
                onStrokeSettingsChange={handleStrokeSettingsChange}
                onTabletInputSettingsChange={setTabletInputSettings}
                onToggleFullscreen={handleToggleFullscreen}
                onToggleLock={handleToggleLock}
                onToolChange={handleToolChange}
                onUndo={handleUndo}
                onUploadPdf={() => setPdfModalOpen(true)}
                pdfLayout={pdfLayout}
                onPdfLayoutChange={allowPdfLayoutToggle && hasAnyPdfBackground ? setPdfLayout : undefined}
                onUploadSharedBackground={handleUploadSharedBackground}
                onZoomIn={handleZoomIn}
                onZoomOut={handleZoomOut}
                penCaptureLocked={penCaptureLocked}
                tabletInputSettings={tabletInputSettings}
                ai={
                  boardAi
                    ? {
                        lassoActive: isAiLassoActive,
                        onAsk: () => sendAiCommand('ai-lasso-once'),
                        onChat: () => sendAiCommand('ai-chat'),
                        onGenerate: () => sendAiCommand('ai-generate'),
                        onAnalyzePage: () => sendAiCommand('ai-analyze-page'),
                        onRemakePage: () => sendAiCommand('ai-remake-page'),
                        ...(boardAi.penPlan ? { onPenExplain: () => sendAiCommand('ai-pen-explain') } : {}),
                      }
                    : undefined
                }
              />
            </div>
          </div>
        ) : null;

  return (
    <div
      ref={handleEditorRootRef}
      className='sk-canvas text-ink relative flex h-full w-full overflow-hidden'
      dir={dir}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      {/* Saving overlay — shown while the exit/close flush persists the latest snapshot (+ a fresh
          library thumbnail) to disk. Rendered inline (not portaled) so it stays visible in fullscreen.
          The desktop shell holds the window open until that flush resolves, so the user always sees it. */}
      {isExitSaving ? (
        <div
          className='bg-ink/30 absolute inset-0 z-[100] flex items-center justify-center'
          dir={dir}
        >
          <div className='border-sk border-ink bg-paper shadow-sk-xl flex items-center gap-3 rounded-2xl px-6 py-4'>
            <span className='border-ink/25 border-t-ink h-5 w-5 animate-spin rounded-full border-2' aria-hidden />
            <span className='text-ink text-sm font-semibold'>{t('editor.savingBoard')}</span>
          </div>
        </div>
      ) : null}

      {/* On-screen performance HUD (Ctrl+Shift+D); renders nothing unless enabled. */}
      <PerfOverlay />
      {/* Diagnostic touch readout (Settings → tablet input). Renders nothing unless enabled. */}
      <TouchDebugOverlay enabled={tabletInputSettings.touchDebugOverlay} />
      {/* Page Manager — right side panel. Kept in focus mode: its own small toggle (above the focus
          knob) is how a long notebook is still paged through with the toolbar gone. */}
      {(!embedded || isPagerInToolbar) && (
      <PageManager
        currentPageId={currentPage?.id ?? ''}
        pages={deferredPages}
        onAddPage={addPage}
        onDeletePage={handlePageManagerDelete}
        onDuplicatePage={handlePageManagerDuplicate}
        onInsertPage={handlePageManagerInsert}
        onPageSelect={handlePageManagerSelect}
        onReorderPages={handlePageManagerReorder}
        busyPage={remakeBusyPage}
        resolvePdfThumbnail={resolvePageManagerThumbnail}
        {...(pageListAnchor
          ? {
              anchorClassName: pageListAnchor.className,
              anchorStyle: pageListAnchor.style,
              hideToggle: true,
              isExpanded: isPageListOpen,
              onExpandedChange: setIsPageListOpen,
            }
          : {})}
      />
      )}

      {/* Main canvas area. Also the drop target for importing a PDF/PowerPoint straight onto the
          board — the PageManager is a sibling, so its thumbnail drags never reach these handlers. */}
      {/* `min-w-0`: a flex item's floor is its min-content width, and the in-flow full-scroll toolbar's
          min-content is EVERY tool laid end to end. Without it a window narrower than the tools (split
          screen) grew this column past the root — the canvas sized to that width (the page ran off the
          right edge), and the toolbar row never overflowed, so it neither scrolled nor showed its page
          group (clipped by the root's overflow-hidden). */}
      <div
        className={`relative flex min-w-0 flex-1 ${isSideColumnToolbar && isToolbarInFlow ? 'flex-row' : 'flex-col'}`}
        onDragEnter={handleBoardDragEnter}
        onDragLeave={handleBoardDragLeave}
        onDragOver={handleBoardDragOver}
        onDrop={handleBoardDrop}
      >
        {/* Matches the import modal's own dropzone treatment rather than inventing a second one. */}
        {isFileDragOver ? (
          <div
            className='border-primary bg-primary/10 pointer-events-none absolute inset-3 z-50 flex flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed'
            dir={dir}
          >
            <div className='bg-primary/10 flex h-14 w-14 items-center justify-center rounded-full'>
              <Upload className='text-primary h-7 w-7' />
            </div>
            <p className='text-foreground text-sm font-semibold'>
              {convertOfficeFile ? t('editor.dropHereOffice') : t('editor.dropHere')}
            </p>
            <p className='text-default-400 text-xs'>{t('editor.dropHint')}</p>
          </div>
        ) : null}
        {/* Title bar — window-style chrome (back / title / fullscreen / refresh). Hidden while
            recording for a distraction-free writing surface; the drawing Toolbar stays visible. */}
        {!hideChrome && !isFocusMode && (
          <div
            ref={titleBarRef}
            // Full-scroll hosts (Study) put their own cluster at the top end; on a narrow pane the title
            // gives way (truncates) at half the width instead of running under it.
            className={`absolute start-3 top-3 z-20 flex items-center gap-2 ${isFullScrollToolbar ? 'max-w-[calc(100%-1.5rem)] md:max-w-[calc(50%-1.5rem)] [&>*]:shrink-0' : ''}`}
            style={chromeHideStyle(aiChromeHidden, 'top')}
          >
            {onBack && (
              <Tooltip content={t('editor.backToLibrary')} portalContainer={overlayPortalContainer}>
                <button
                  aria-label={t('editor.backToLibrary')}
                  className={CHROME_CHIP}
                  disabled={isExitSaving}
                  type='button'
                  onClick={() => void handleBackPress()}
                >
                  <ArrowLeft className='h-4 w-4' />
                </button>
              </Tooltip>
            )}
            <div
              className={`block h-9 max-w-[18rem] truncate rounded-xl border-2 border-[rgb(var(--st-clay-edge,205_209_224))] bg-[rgb(var(--st-surface,255_255_255))] px-3 text-ink leading-[32px] shadow-[0_4px_0_rgb(var(--st-clay-edge,205_209_224))] text-sm font-semibold ${isFullScrollToolbar ? 'min-w-0 !shrink' : ''}`}
            >
              {documentTitle}
            </div>
            <Tooltip
              content={isFullscreen ? t('editor.exitFullscreen') : t('editor.fullscreen')}
              portalContainer={overlayPortalContainer}
            >
              <button
                className={CHROME_CHIP}
                type='button'
                onClick={() => void handleToggleFullscreen()}
              >
                {isFullscreen ? <Minimize2 className='h-4 w-4' /> : <Maximize2 className='h-4 w-4' />}
              </button>
            </Tooltip>
            <Tooltip content={t('editor.refresh')} portalContainer={overlayPortalContainer}>
              <button
                className={CHROME_CHIP}
                type='button'
                onClick={() => void handleRefresh()}
              >
                <RefreshCw className='h-4 w-4' />
              </button>
            </Tooltip>
          </div>
        )}

        {/* A full-scroll host keeps its pager in the toolbar: focus mode drops it rather than floating it. */}
        {!(embedded && readOnly) && !isPagerInToolbar && !(isFocusMode && isFullScrollToolbar) && (
        <div className='absolute bottom-5 end-5 z-20 flex items-center gap-2' style={chromeHideStyle(aiChromeHidden, 'bottom')}>
          <div className='border-sk border-ink bg-paper text-ink shadow-sk flex items-center gap-1 rounded-sm px-1.5 py-1'>
            <Tooltip content={t('editor.prevPage')} portalContainer={overlayPortalContainer}>
              <Button
                isIconOnly
                className='text-ink bg-transparent shadow-none'
                isDisabled={currentPageIndex <= 0}
                size='sm'
                variant='light'
                onPress={() => navigateToPage(currentPageIndexRef.current - 1)}
              >
                <ChevronLeft className='h-4 w-4' />
              </Button>
            </Tooltip>
            <div className='text-ink min-w-9 text-center text-xs font-semibold' data-wb-page-label>
              {currentPageLabel}
            </div>
            <Tooltip content={t('editor.nextPage')} portalContainer={overlayPortalContainer}>
              <Button
                isIconOnly
                className='text-ink bg-transparent shadow-none'
                isDisabled={currentPageIndex >= pages.length - 1}
                size='sm'
                variant='light'
                onPress={() => navigateToPage(currentPageIndexRef.current + 1)}
              >
                <ChevronRight className='h-4 w-4' />
              </Button>
            </Tooltip>
          </div>
          {pageAddControl}
        </div>
        )}

        {isToolbarInFlow ? null : toolbarNode}

        {/* Rotate-the-page panel. Flat, quiet, and anchored beside the toolbar button that opens it.
            Every control here previews on the canvas first and only writes to the page on release, so
            the teacher can hunt for straight before anything is committed. */}
        {!isFocusMode && isRotatePanelOpen && hasPdfPageBackground && (
          <div className={rotatePanelWrapperClassName} style={chromeHideStyle(aiChromeHidden, toolbarHideEdge)}>
            <div
              className='border-sk border-ink bg-paper shadow-sk pointer-events-auto w-[17rem] rounded-2xl p-3'
              dir={dir}
            >
              <div className='flex items-center justify-between gap-2'>
                <p className='text-ink text-xs font-semibold'>{t('editor.rotate.title')}</p>
                <span className='text-ink text-[11px] font-bold tabular-nums'>{Math.round(rotationSliderValue)}°</span>
              </div>
              <p className='text-ink/65 mt-1 text-[10px] leading-4'>{t('editor.rotate.hint')}</p>

              <div className='mt-2.5 grid grid-cols-2 gap-1.5'>
                <Button
                  className='border-sk border-ink bg-paper text-ink shadow-sk-sm h-8 min-w-0 rounded-xl px-2 text-[11px] font-semibold'
                  size='sm'
                  variant='flat'
                  onPress={() => handleRotatePageBy(90)}
                >
                  {t('editor.rotate.right90')}
                </Button>
                <Button
                  className='border-sk border-ink bg-paper text-ink shadow-sk-sm h-8 min-w-0 rounded-xl px-2 text-[11px] font-semibold'
                  size='sm'
                  variant='flat'
                  onPress={() => handleRotatePageBy(-90)}
                >
                  {t('editor.rotate.left90')}
                </Button>
                <Button
                  className='border-sk border-ink bg-paper text-ink shadow-sk-sm h-8 min-w-0 rounded-xl px-2 text-[11px] font-semibold'
                  size='sm'
                  variant='flat'
                  onPress={() => handleRotatePageBy(180)}
                >
                  {t('editor.rotate.180')}
                </Button>
                <Button
                  className='border-sk border-ink bg-citrine text-ink shadow-sk-sm h-8 min-w-0 rounded-xl px-2 text-[11px] font-semibold'
                  size='sm'
                  variant='flat'
                  onPress={handleResetPageRotation}
                >
                  {t('editor.rotate.reset')}
                </Button>
              </div>

              {/* LTR on purpose: the angle axis has to run -180 on the left to
                  +180 on the right, or the slider disagrees with the number above it. */}
              <div className='mt-3' dir='ltr'>
                <Slider
                  aria-label={t('editor.rotate.angle')}
                  color='primary'
                  dir='ltr'
                  hideValue
                  maxValue={180}
                  minValue={-180}
                  size='sm'
                  step={1}
                  value={rotationSliderValue}
                  onChange={handleRotationSliderChange}
                  onChangeEnd={handleRotationSliderChangeEnd}
                />
              </div>

              <Button
                className='border-sk border-ink bg-ink text-paper shadow-sk-sm mt-3 h-8 w-full rounded-xl text-[11px] font-semibold'
                size='sm'
                variant='flat'
                onPress={handleCloseRotatePanel}
              >
                {t('editor.done')}
              </Button>
            </div>
          </div>
        )}

        {/* `data-page-intro` publishes the slide-intro state of the page on screen — none / loading /
            playing / done — beside the page it belongs to, so an end-to-end test can wait on real
            pixels without reaching into React internals. Nothing renders from it. */}
        <div
          className={
            isToolbarInFlow
              ? isSideColumnToolbar
                ? canvasStageClassName.replace('w-full', 'min-w-0 flex-1')
                : canvasStageClassName.replace('h-full', 'min-h-0 flex-1')
              : canvasStageClassName
          }
          data-page-intro={pageIntroStatus}
          data-page-intro-page={pageIntroStatusPageId ?? undefined}
        >
          {/* Slide-intro decoder. Never seen directly: WhiteboardCanvas blits its frames into the
              page-background layer, under the ink. It IS mounted (not detached) and sized 1×1 rather
              than `display:none`, because a display:none video is a candidate for decode suspension —
              a suspended decoder would hand the painter a frozen first frame. `muted` is what makes
              autoplay legal in WebView2 at all; there is no audio track on these clips regardless. */}
          <video
            ref={pageIntroVideoRef}
            aria-hidden
            muted
            playsInline
            className='pointer-events-none absolute left-0 top-0 h-px w-px opacity-0'
            preload='auto'
            tabIndex={-1}
          />

          {/* Per-page boundary: a single page with a corrupt canvasJSON / broken PDF that throws on
              render shows a per-page fallback while the toolbar, page list, and other pages stay
              usable. Reset (NOT key-remount) on page id so navigating to a healthy page recovers the
              boundary WITHOUT disposing the live Fabric canvas — a `key` remount here dropped the
              freshly-loaded ink onto a disposed canvas and left the replacement blank (data-loss bug). */}
          <WhiteboardErrorBoundary
            resetKeys={[currentPage?.id ?? 'no-page']}
            description={t('editor.pageError.description')}
            locale={locale}
            title={t('editor.pageError.title')}
            onError={handleEditorBoundaryError}
          >
            {/* Canvas — history auto-saves via hook, no onObjectModified needed */}
            <WhiteboardCanvas
              activeTool={readOnly ? 'pan' : activeTool}
              backgroundCanvasRef={backgroundCanvasRef}
              backgroundImageOpacity={sharedBackgroundImageOpacity}
              backgroundOverlayCanvasRef={backgroundOverlayCanvasRef}
              backgroundImageUrl={sharedBackgroundImageUrl || undefined}
              backgroundSpacingPx={boardPatternSpacingPx(currentPage)}
              boardTheme={boardTheme}
              paperOverPdf={paperOverPdf}
              backgroundType={isScrollActive ? 'blank' : (currentPage?.backgroundType ?? 'blank')}
              backgroundRepaintRef={backgroundRepaintRef}
              directTouchPanRef={directTouchPanRef}
              rulerEdgesRef={rulerEdgesRef}
              notebookPageRef={notebookPageRef}
              overscanBackdropDisabled={isZoomLockedToPage}
              panAxisLock={verticalNotebook}
              pdfScrollPainterRef={pdfScrollPainterRef}
              viewportConstraintsRef={effectiveConstraintsRef}
              eraserMode={eraserMode}
              eraserSize={eraserSize}
              tabletInputSettings={tabletInputSettings}
              fillColor={fillColor}
              zoomLocked={isZoomLocked}
              onObjectModified={handleCanvasMutation}
              onShortcutColorCycle={handleQuickStrokeColorCycle}
              onShortcutColorToggle={handleQuickStrokeColorToggle}
              onShortcutToolToggle={handleQuickToolToggle}
              onShortcutQuickMenu={handlePenButtonQuickMenu}
              hasPdfPageBackground={isScrollActive ? false : hasPdfPageBackground}
              introVideoRef={pageIntroVideoRef}
              isIntroPlaying={isScrollActive ? false : isPageIntroPlaying}
              transitionHandleRef={pageTransitionRef}
              isPdfPageLoading={isScrollActive ? false : isCurrentPdfPageLoading}
              pdfFrameRecord={isScrollActive ? null : currentPage}
              pdfPageIdentity={isScrollActive ? undefined : currentPage?.id}
              pdfPageImageUrl={isScrollActive ? undefined : currentPdfPageImageUrl}
              pdfRotationDeg={previewPageRotationDeg}
              strokeSettings={displayStrokeSettings}
              onCanvasReady={handleCanvasReady}
              onCanvasResize={handleCanvasResize}
              onContactCaptured={handleContactCaptured}
              onPdfBackgroundFrameChange={handlePdfBackgroundFrameChange}
              onRedo={handleRedo}
              onUndo={handleUndo}
              onZoomChange={setZoom}
            />
          </WhiteboardErrorBoundary>
          {!isFocusMode && !embedded && !hideQuickPenTrigger && (
            // Fade only: a transform here would re-anchor the trigger's absolute layer.
            <div style={chromeHideStyle(aiChromeHidden, 'none')}>
              <QuickPenTrigger
                anchor={quickPenAnchor}
                isActive={isQuickGestureMenuOpen}
                onAnchorChange={setQuickPenAnchor}
                onOpen={handleQuickGestureMenuOpen}
              />
            </div>
          )}
          <AnimatePresence>
            {isQuickGestureMenuOpen ? (
              <QuickGestureMenu
                key='quick-gesture-menu'
                activeTool={activeTool}
                anchor={penButtonMenuAnchor ?? quickPenAnchor}
                recentColors={recentColors}
                strokeColor={strokeSettings.color}
                strokeWidth={strokeSettings.width}
                onAnchorChange={handleQuickMenuAnchorChange}
                onClose={handleQuickGestureMenuClose}
                onStrokeColorChange={handleQuickStrokeColorChange}
                onStrokeWidthChange={handleQuickStrokeWidthChange}
              />
            ) : null}
          </AnimatePresence>
          {geometryOverlay ? (
            <div
              className='rounded-sk border-sk border-ink bg-paper text-ink shadow-sk pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full px-3 py-2 text-[11px]'
              style={{
                left: geometryOverlay.left,
                top: geometryOverlay.top,
              }}
            >
              <div className='text-ink text-xs font-semibold'>{geometryOverlay.label}</div>
              <div className='text-ink/65 mt-0.5 whitespace-nowrap text-[10px]'>{geometryOverlay.subtitle}</div>
            </div>
          ) : null}
          {/* Pin/unpin affordances. The wrappers are pointer-events-none like the geometry HUD so they
              never swallow a stroke; only the buttons themselves take input. */}
          {pinImageAction ? (
            <div
              className='pointer-events-none absolute z-20 -translate-x-1/2'
              style={{
                left: pinImageAction.left,
                top: pinImageAction.top,
              }}
            >
              <button
                className='rounded-sk border-sk border-ink bg-paper text-ink shadow-sk active:shadow-sk-pressed pointer-events-auto flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1.5 text-[11px] font-semibold active:translate-x-0.5 active:translate-y-0.5'
                title={t('editor.pinImage')}
                type='button'
                onClick={handlePinImage}
              >
                <Pin aria-hidden className='h-3.5 w-3.5' />
                {t('editor.pinImage')}
              </button>
            </div>
          ) : null}
          {lockedImageChips.map((chip) => (
            <div
              key={chip.chipKey}
              className='pointer-events-none absolute z-20'
              style={{
                left: chip.left,
                top: chip.top,
              }}
            >
              <button
                aria-label={t('editor.unpinImage')}
                className='rounded-sk border-sk border-ink bg-paper/90 text-ink/75 shadow-sk pointer-events-auto flex items-center gap-1 whitespace-nowrap px-2 py-1 text-[10px] font-semibold active:translate-x-0.5 active:translate-y-0.5'
                title={t('editor.unpinImage')}
                type='button'
                onClick={() => handleUnpinImage(chip.image)}
              >
                <Pin aria-hidden className='h-3 w-3' />
                {t('editor.pinned')}
              </button>
            </div>
          ))}
          {selectionActions.selectionBox && fabricCanvas ? (
            <SelectionActionBar
              colors={selectionPalette}
              container={{ width: fabricCanvas.getWidth(), height: fabricCanvas.getHeight() }}
              selection={selectionActions.selectionBox}
              topInset={isFullScrollToolbar && toolbarDock === 'top' ? 124 : 64}
              variant={selectionChrome === 'modern' ? 'labeled' : 'compact'}
              extraActions={extraSelectionActions?.filter((action) => !action.scope || (action.scope === 'picture') === selectedPicture)}
              onAsk={boardAi ? () => sendAiCommand('ai-ask-selection') : undefined}
              onMapTerms={termsMap && boardAi?.mapTerms ? () => sendAiCommand('ai-map-terms') : undefined}
              onStraighten={canStraighten ? handleStraightenSelection : undefined}
              onCrop={croppableImage ? handleStartCrop : undefined}
              onExtraAction={(action) => {
                const objectCount = fabricCanvas.getActiveObjects().length;

                action.onSelect({ objectCount, raster: rasterizeSelection(fabricCanvas) });
              }}
              onColor={selectionActions.recolor}
              onCopy={() => void selectionActions.copy()}
              onCut={() => void selectionActions.cut()}
              onDelete={selectionActions.remove}
              onDuplicate={() => void selectionActions.duplicate()}
              onWidth={selectionActions.restroke}
            />
          ) : null}
          {fabricCanvas && !readOnly ? <HandMapControls canvas={fabricCanvas} /> : null}
          {cropTarget && fabricCanvas ? (
            <ImageCropOverlay
              canvas={fabricCanvas}
              image={cropTarget}
              topInset={isFullScrollToolbar && toolbarDock === 'top' ? 124 : 64}
              onCancel={() => finishCrop(null)}
              onDone={(rect) => finishCrop(rect)}
            />
          ) : null}
          {selectionActions.pasteChip ? (
            <PasteChip
              at={selectionActions.pasteChip}
              onPaste={() => void selectionActions.pasteAtScene(selectionActions.pasteChip!.scene)}
            />
          ) : null}
          {autoColor && !readOnly ? (
            <InkAutoColorLayer
              canvas={fabricCanvas}
              commitHistory={history.commitNow}
              config={autoColor}
              inkTool={isPenFamilyTool(activeTool)}
              penColor={strokeSettings.color}
            />
          ) : null}
          {boardAi && !readOnly ? (
            <BoardAiLayer
              hideSelectionChip
              activeTool={activeTool}
              boardId={whiteboardId}
              bridge={aiBridge}
              canvas={fabricCanvas}
              command={aiCommand}
              penColor={strokeSettings.color}
              currentPageId={currentPage?.id ?? null}
              penWidth={strokeSettings.width}
              service={boardAi}
              onLassoActiveChange={setIsAiLassoActive}
              onRemakeStateChange={setRemakeInfo}
            />
          ) : null}
        </div>
        {isToolbarInFlow ? toolbarNode : null}
      </div>

      {isFocusMode && (
        // Fade only: the dock is a fixed full-screen layer; a transform would re-anchor it.
        <div style={chromeHideStyle(aiChromeHidden, 'none')}>
          <FocusModeDock
            activeTool={activeTool}
            canRedo={history.canRedo}
            canUndo={history.canUndo}
            eraserMode={eraserMode}
            eraserSize={eraserSize}
            overlayPortalContainer={overlayPortalContainer}
            smoothingEnabled={smoothingEnabled}
            strokeSettings={displayStrokeSettings}
            wholeHandEraser={tabletInputSettings.wholeHandEraser}
            onEraserModeChange={setEraserMode}
            onEraserSizeChange={setEraserSize}
            onExitFocusMode={() => setIsFocusMode(false)}
            onRedo={handleRedo}
            onSmoothingChange={setSmoothingEnabled}
            onStrokeSettingsChange={handleStrokeSettingsChange}
            onToolChange={handleToolChange}
            onUndo={handleUndo}
            onWholeHandEraserChange={(next) => setTabletInputSettings((prev) => ({ ...prev, wholeHandEraser: next }))}
          />
        </div>
      )}

      {/* PDF Upload Modal */}
      <PdfUploadModal
        convertOfficeFile={convertOfficeFile}
        existingImports={existingPdfImports}
        initialFiles={pendingImportFiles}
        isOpen={pdfModalOpen}
        lastImportedPdf={lastPdfImportHint}
        nativePdfRescue={nativePdfRescue}
        onClose={() => setPdfModalOpen(false)}
        onImagesSelected={(files) => {
          void appendImagePages(files);
        }}
        onPdfProcessed={handlePdfProcessed}
        onSourceDiscarded={handlePdfSourceDiscarded}
        portalContainer={overlayPortalContainer}
        workerSrc={pdfWorkerSrc}
      />
    </div>
  );
};

/**
 * Public editor. Wraps the inner editor in an EDITOR-LEVEL error boundary so a catastrophic render
 * failure (anywhere in the toolbar / page list / canvas tree) shows a clean "reload board" fallback
 * instead of white-screening the host app. On crash it best-effort flushes in-flight ink through the
 * inner editor's existing flush path (exposed via `flushOnCrashRef`) before the fallback renders.
 * The per-page boundary inside handles single-page corruption while keeping the rest usable.
 */
export const WhiteboardEditor: React.FC<WhiteboardEditorProps> = (props) => {
  const locale = props.locale ?? 'en';
  const flushOnCrashRef = useRef<(() => void) | null>(null);

  const handleEditorCrash = useCallback(() => {
    try {
      flushOnCrashRef.current?.();
    } catch {
      // A flush that itself throws must not re-crash the boundary — show the fallback regardless.
    }
  }, []);

  return (
    <WhiteboardErrorBoundary
      description={wbT(locale, 'editor.crash.description')}
      locale={locale}
      title={wbT(locale, 'editor.crash.title')}
      onError={handleEditorCrash}
    >
      <WbLocaleProvider locale={locale}>
        <WhiteboardEditorInner {...props} flushOnCrashRef={flushOnCrashRef} />
      </WbLocaleProvider>
    </WhiteboardErrorBoundary>
  );
};

export default WhiteboardEditor;
