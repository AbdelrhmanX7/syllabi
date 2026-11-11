import { startStudyCanvasCron, STUDY_CANVAS_SYNC_SCHEDULE } from "@/cron/study-canvas-sync.cron";
import { backfillPageBookmarks } from "@/services/study/page-bookmarks";
import { scheduleSandboxImageCheck } from "@/cron/study-code-image.cron";
import { logger } from "@/services/logger.service";
import { drainStudyJobs, setStudyJobsAutoKick, sweepUploadedSummaries } from "./jobs";

/**
 * Where the study module's background work runs.
 *
 * RUN_WORKER_IN_PROCESS (default true): the API process does everything — single container.
 * Set it to false to run the heavy work in `node dist/worker.js` instead: the API then stops
 * running video/lecture jobs on the request path and schedules nothing but the sandbox image
 * check, and the worker polls the job tables.
 *
 * Every background job and its trigger(s):
 *   video transcript   (StudyTranscript pending)    queueVideoTranscript → kickStudyJobs; + jobs poll
 *   lecture processing (StudyLecture processing)    lectures controller → kickStudyJobs; + jobs poll
 *   uploaded-transcript summary (summary null)      kickUploadedTranscriptSummary; + jobs poll sweep
 *       (the three above: API kicks only in in-process mode; the poll runs wherever jobs run)
 *   Canvas sync (+ grade sync inside each run)      STUDY_CANVAS_SYNC_CRON (30 min) wherever jobs run;
 *                                                   + request path startSync (connect / manual sync) in the API
 *   A-plan build                                    request path only (startBuild/getAPlan in the API);
 *                                                   a dead `building` lock is re-claimed on the next GET
 *   code sandbox image (docker gcc:14)              API process, once 30 s after boot (both modes)
 *   index maintenance, library import               CLI/script only, never scheduled (autoIndex builds indexes)
 *
 * Only one process should schedule: a replica with NODE_APP_INSTANCE set to anything but "0"
 * schedules nothing (row claims are atomic, so overlapping schedulers waste work but never
 * double-process a row).
 */

const FALSY = /^(0|false|no|off)$/i;

/** RUN_WORKER_IN_PROCESS, default true. */
export const runWorkerInProcess = (): boolean => !FALSY.test(process.env.RUN_WORKER_IN_PROCESS?.trim() ?? "");

/** Single scheduler per deployment: unset/empty (single process) or the first instance. */
export const isSchedulerLeader = (): boolean => {
  const v = process.env.NODE_APP_INSTANCE?.trim();
  return !v || v === "0";
};

const posInt = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : fallback;
};

export type BackgroundRole = "api" | "worker";

export interface BackgroundHandle {
  /** Stop scheduling; waits (bounded) for an in-flight tick to finish. */
  stop(timeoutMs?: number): Promise<void>;
}

/**
 * Start the study background work for this process.
 * - role "api": in-process mode → everything; separate-worker mode → request kicks off, only the
 *   sandbox image check.
 * - role "worker": Canvas cron + a fast jobs poll (kicks never reach this process).
 */
export function startStudyBackground(role: BackgroundRole): BackgroundHandle {
  const noop: BackgroundHandle = { stop: async () => {} };
  if (process.env.NODE_ENV === "test") return noop;

  const inProcess = runWorkerInProcess();
  if (role === "api") {
    if (isSchedulerLeader()) scheduleSandboxImageCheck();
    if (!inProcess) {
      // The worker owns ffmpeg/ASR; rows queued by requests wait for its poll.
      setStudyJobsAutoKick(false);
      console.log("[background] RUN_WORKER_IN_PROCESS=false: study jobs run in the worker process (node dist/worker.js)");
      return noop;
    }
  }
  if (!isSchedulerLeader()) return noop;

  // In-process the request path kicks jobs immediately, so the poll is only crash recovery.
  // A separate worker relies on the poll alone, so it ticks fast and skips the upload age floor.
  const worker = role === "worker";
  const pollMs = posInt(process.env.STUDY_JOBS_POLL_MS, worker ? 15_000 : 120_000);
  const uploadMinAgeMs = worker ? 0 : 3 * 60 * 1000;

  const canvas = startStudyCanvasCron();

  let tick: Promise<unknown> | null = null;
  let stopped = false;
  const runTick = () => {
    if (tick || stopped) return;
    tick = (async () => {
      await drainStudyJobs();
      if (!stopped) await sweepUploadedSummaries(5, uploadMinAgeMs);
      // Older notebooks get their bookmarks onto the page row (a no-op once every row has the field).
      if (!stopped) await backfillPageBookmarks(25);
    })()
      .catch((error) => logger.error("study jobs poll failed", error))
      .finally(() => {
        tick = null;
      });
  };
  const timer = setInterval(runTick, pollMs);
  // A worker picks up whatever was queued while it was down right away.
  const first = worker ? setTimeout(runTick, 2_000) : null;

  console.log(
    `[background] ${role}: study jobs poll every ${Math.round(pollMs / 1000)}s` +
      (canvas ? `, Canvas sync cron "${STUDY_CANVAS_SYNC_SCHEDULE}"` : ", Canvas sync cron off")
  );

  return {
    async stop(timeoutMs = 20_000) {
      stopped = true;
      clearInterval(timer);
      if (first) clearTimeout(first);
      // A long ASR job is not cancelled; if it outlives the timeout its claim goes stale (60 min)
      // and the next poll re-claims it.
      const wait = Promise.all([canvas?.stop(), tick]).then(() => undefined);
      await Promise.race([wait, new Promise<void>((r) => setTimeout(r, timeoutMs).unref())]);
    },
  };
}
