// `@repo/whiteboard-react/telemetry` — the dependency-free slice a host's performance collector needs
// (board context + gesture edges, the renderer span recorder, the native pen trace). Importing the
// main entry from an app shell would pull fabric into its first bundle; this entry never does.
export {
  BOARD_GESTURE_TAIL_MS,
  BOARD_WHEEL_IDLE_MS,
  getBoardTelemetryContext,
  hasBoardTelemetryListeners,
  subscribeBoardGestures,
} from './components/whiteboard/utils/boardTelemetry';
export type {
  BoardGestureEdge,
  BoardGestureKind,
  BoardGestureListener,
  BoardLayout,
  BoardTelemetryContext,
} from './components/whiteboard/utils/boardTelemetry';
export { PERF_SPAN_MIN_MS, setPerfSpanRecorder } from './components/whiteboard/utils/perfSpan';
export type { PerfSpanRecorder } from './components/whiteboard/utils/perfSpan';
export { PEN_NATIVE_TRACE_EVENT, readPenNativeTrace } from './components/whiteboard/utils/penNativeTrace';
export type { PenNativeTraceEntry } from './components/whiteboard/utils/penNativeTrace';
export { formatInkTelemetry, inkTelemetry } from './components/whiteboard/utils/inkTelemetry';
export type { InkTelemetryEvent, InkTelemetryOp } from './components/whiteboard/utils/inkTelemetry';
export { isFeatureLabel, PERF_FEATURE_PREFIX } from './components/whiteboard/utils/perfSpan';
