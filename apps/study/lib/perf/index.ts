// Study perf telemetry — public surface. The collector is client-only; `_app` starts it through a
// dynamic import so the server render never touches it.
export {
  clearPerfLog,
  exportPerfLog,
  getPerfStatus,
  PERF_UPLOAD_INTERVAL_MS,
  setPerfEnabled,
  startPerfTelemetry,
  stopPerfTelemetry,
  subscribePerfStatus,
  uploadPerfNow,
} from './collector';
export type { PerfStatus } from './collector';
export type { PerfBatch, PerfEvent } from './types';
