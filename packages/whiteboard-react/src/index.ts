export * from '@repo/whiteboard-core';

export { JS_BUNDLE_BUILD } from './jsBuild';
export { default as WhiteboardLibrary } from './components/whiteboard/WhiteboardLibrary';
export { default as WhiteboardPdfLibrary } from './components/whiteboard/WhiteboardPdfLibrary';
export type { WhiteboardPdfLibraryProps } from './components/whiteboard/WhiteboardPdfLibrary';
export { default as WhiteboardEditor } from './components/whiteboard/WhiteboardEditor';
export type { WhiteboardEditorProps, WhiteboardLiveHandle } from './components/whiteboard/WhiteboardEditor';
// Live co-editing: another person's item changes for one page (matched by the items' `oid`).
export type { RemoteItemOps } from './components/whiteboard/utils/itemIds';
// Host buttons on the selection bar and the selection picture they receive.
export type { WhiteboardSelectionAction, WhiteboardSelectionSnapshot } from './components/whiteboard/SelectionActionBar';
export type { SelectionRaster } from './components/whiteboard/utils/selectionActions';
// Slide intros: the clip a page plays on ENTER (`resolvePageIntro` / `pageIntroVersion` on the
// editor). Presentation only — no part of it reaches the document model or sync.
export type {
  PageIntro,
  PageIntroPeek,
  PageIntroStatus,
  PageTransition,
  PeekPageIntro,
  ResolvePageIntro,
} from './components/whiteboard/utils/pageIntroPolicy';
// The transition kinds drawn natively, for a host that wants to know what it can ask for.
export type { TransitionKind } from './components/whiteboard/utils/pageTransitions';
export { WhiteboardErrorBoundary } from './components/whiteboard/WhiteboardErrorBoundary';
export type { WhiteboardErrorBoundaryProps } from './components/whiteboard/WhiteboardErrorBoundary';
export type {
  MergeOverlaysResult,
  WhiteboardFileBridge,
  WhiteboardNativePdfCapability,
  WhiteboardPersistPdfAssetInput,
  WhiteboardPersistPdfAssetResult,
  WhiteboardPdfImportDiscardedEvent,
  WhiteboardPdfImportedEvent,
  WhiteboardPublishPayload,
  WhiteboardReuploadPdfAssetInput,
} from './components/whiteboard/WhiteboardEditor';
export {
  useWhiteboardStorage,
  WHITEBOARD_STORAGE_UPDATED_EVENT,
} from './components/whiteboard/hooks/useWhiteboardStorage';
export type { WhiteboardStorageUpdatedEventDetail } from './components/whiteboard/hooks/useWhiteboardStorage';
export { useSnapshotSyncer } from './components/whiteboard/hooks/useSnapshotSyncer';
export type {
  SyncEnvironment,
  SnapshotSyncerFactory,
  UseSnapshotSyncerOptions,
  UseSnapshotSyncerResult,
} from './components/whiteboard/hooks/useSnapshotSyncer';
// Cloud-sync capture, off the drawing thread. The app builds one of these and hands it to
// `useSnapshotSyncer`; `null` (no `Worker`) keeps the old main-thread path.
export { createWorkerDocumentCapture } from './components/whiteboard/utils/documentCaptureWorker';
export { observeChromeInset, useChromeInset } from './components/whiteboard/utils/chromeInsets';
export type { ChromeInsetSide } from './components/whiteboard/utils/chromeInsets';
export { chromeHideStyle } from './components/whiteboard/ai/generatingState';
export type { CaptureDocument } from './components/whiteboard/utils/documentCaptureWorker';
export { importPdfFile } from './components/whiteboard/utils/pdfAssetRenderer';
export { pageInkKey } from './components/whiteboard/utils/pageThumbnail';
// The offscreen half of background staging (`apps/whiteboard/lib/cloud-sync/offscreen-overlays.ts`):
// the geometry the live sweep uses, so the app-side renderer never forks it, and the Fabric canvas
// factory, so the app never imports Fabric itself.
export { buildMergeManifestEntry } from './components/whiteboard/utils/pageRender';
export type { PageOverlaySnapshot } from './components/whiteboard/utils/pageRender';
export { normalizeRotationDeg } from './components/whiteboard/utils/backgroundLayers';
export { resolveFrozenPdfFit } from './components/whiteboard/utils/snapshotGeometry';
export type { PdfFitSize } from './components/whiteboard/utils/snapshotGeometry';
export { createOffscreenOverlayCanvas } from './components/whiteboard/utils/offscreenOverlayCanvas';
// The yield strategy the PDF import loop already uses (`scheduler.yield()` → MessageChannel →
// setTimeout). Background staging needs exactly the same thing between its heavy steps, and a
// second implementation of "hand the main thread back" is how the two drift apart.
export { yieldToBrowserDuringImport } from './components/whiteboard/utils/pdfYieldScheduler';
export type {
  OffscreenOverlayBounds,
  OffscreenOverlayCanvas,
  OffscreenOverlayFrame,
  OffscreenOverlayRenderInput,
} from './components/whiteboard/utils/offscreenOverlayCanvas';
export type {
  ImportedPdfPagePreview,
  PdfImportNativePagePreview,
  PdfImportNativePageRequest,
  PdfImportNativeRescue,
  PdfImportResult,
  PdfImportSummary,
  ResolveRemotePdfAsset,
  WhiteboardRemotePdfAsset,
} from './components/whiteboard/utils/pdfAssetRenderer';
// The calm line for pages the native tier-2 rescue saved — deliberately NOT a warning (see
// `PdfImportSummary.rescuedPageNumbers`), so a host that wants to mention them renders it itself.
export { formatRescuedPdfPagesNotice } from './components/whiteboard/utils/pdfAssetRenderer';
export { parseWhiteboardDocumentFile, prepareImportedDocument } from './components/whiteboard/utils/whiteboardFile';
export type { ParseWhiteboardFileResult } from './components/whiteboard/utils/whiteboardFile';
export {
  getActivePdfQualityTuning,
  getPdfBackgroundPixelRatio,
  getPdfQualityMode,
  isPdfQualityMode,
  setPdfQualityMode,
} from './components/whiteboard/utils/pdfRenderSizing';
export {
  clearInputTrace,
  getInputTrace,
  isInputTraceEnabled,
  refreshInputTraceEnabled,
  setInputTraceEnabled,
} from './components/whiteboard/utils/inputTrace';
export type { InputTraceEntry } from './components/whiteboard/utils/inputTrace';
export {
  addPenButtonBinding,
  ANDROID_BUTTON_NAMES,
  ANDROID_TOOL_NAMES,
  DEFAULT_PEN_BUTTON_CONTACT_ACTION,
  DEFAULT_PEN_BUTTON_HOVER_ACTION,
  DEFAULT_PEN_BUTTON_LONG_HOVER_ACTION,
  describeSignature,
  detectPenSignalEdges,
  EMPTY_PEN_BUTTON_MAP,
  findBindingForSignature,
  mergePenButtonCapture,
  NATIVE_PEN_EVENT,
  PEN_BUTTON_ACTIONS,
  PEN_BUTTON_HOVER_ACTIONS,
  PEN_BUTTON_LONG_HOVER_ACTIONS,
  PEN_BUTTON_MAP_CHANGED_EVENT,
  PEN_CAPTURE_WINDOW_MS,
  readPenButtonMap,
  removePenButtonBinding,
  updatePenButtonBinding,
  writePenButtonMap,
} from './components/whiteboard/utils/penButtonMap';
export type {
  PenButtonAction,
  PenButtonBinding,
  PenButtonCapture,
  PenButtonMap,
  PenSignal,
  PenSignalEdge,
} from './components/whiteboard/utils/penButtonMap';
export {
  clearPenNativeTrace,
  createNativeMoveRateMeter,
  PEN_NATIVE_TRACE_EVENT,
  readPenNativeTrace,
} from './components/whiteboard/utils/penNativeTrace';
export type { PenNativeTraceEntry } from './components/whiteboard/utils/penNativeTrace';
export type { PdfQualityMode, PdfQualityTuning } from './components/whiteboard/utils/pdfRenderSizing';
export { invalidateInkBake, readInkBakeStats } from './components/whiteboard/utils/inkBake';
export type { InkBakeHandle, InkBakeOptions, InkBakeStats } from './components/whiteboard/utils/inkBake';
export {
  isPerfSpanRecorderInstalled,
  PERF_SPAN_MIN_MS,
  perfMark,
  perfSpan,
  setPerfSpanRecorder,
} from './components/whiteboard/utils/perfSpan';
export type { PerfSpanRecorder } from './components/whiteboard/utils/perfSpan';
// Board AI: the transport contract a host implements (`boardAi` prop), the pen-button command door,
// and the pure parsers the guest transport reuses to turn markdown/JSON answers into blocks.
export * from './components/whiteboard/ai';
// Paper spacing (mm ↔ board units, presets) for hosts that offer `allowPaperSpacing`.
export { BOARD_PX_PER_MM, resolveDefaultPaperSpacingMm, SHEET_WIDTH_MM } from './components/whiteboard/utils/paperSpacing';
export type { EditorViewport, RulerEdge, RulerEdgesRef } from './components/whiteboard/brushes/rulerSnap';
// «Auto colour»: auto-colour handwriting — the recognizer / cloud-classifier contract hosts implement.
export * from './components/whiteboard/autoColor';
export { inkClassLabel } from './components/whiteboard/autoColor/labels';
export { formatInkTelemetry, inkTelemetry } from './components/whiteboard/utils/inkTelemetry';
export type { InkTelemetryEvent, InkTelemetryOp } from './components/whiteboard/utils/inkTelemetry';
