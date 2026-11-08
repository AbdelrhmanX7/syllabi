import cron from "node-cron";
import { StudyCanvasConnection } from "@/models/study/canvas-connection";
import { runSync } from "@/services/study/canvas-sync.service";
import { logger } from "@/services/logger.service";

/**
 * Study app: pull every connected Canvas account (incremental — unchanged files are not
 * re-downloaded; grade sync runs inside each run). Users run one after another; a run already
 * in flight (manual sync, token save) holds the per-user lock and is simply skipped.
 */
export async function runStudyCanvasSyncAll(): Promise<number> {
  const conns = await StudyCanvasConnection.find({}, { userId: 1 }).lean();
  let ran = 0;
  for (const c of conns) {
    try {
      if (await runSync(String(c.userId))) ran++;
    } catch (error) {
      await logger.error("study canvas cron sync failed", error, { userId: String(c.userId) });
    }
  }
  return ran;
}

/** Every 30 min by default; STUDY_CANVAS_SYNC_CRON overrides (node-cron syntax, "off" disables). */
export const STUDY_CANVAS_SYNC_SCHEDULE = process.env.STUDY_CANVAS_SYNC_CRON?.trim() || "*/30 * * * *";

/** Schedule the all-users Canvas sync. Returns a stop handle that waits for an in-flight run. */
export function startStudyCanvasCron(): { stop(): Promise<void> } | null {
  if (/^(off|false|0|none)$/i.test(STUDY_CANVAS_SYNC_SCHEDULE)) return null;
  if (!cron.validate(STUDY_CANVAS_SYNC_SCHEDULE)) {
    void logger.error("study canvas cron disabled: invalid STUDY_CANVAS_SYNC_CRON", new Error(STUDY_CANVAS_SYNC_SCHEDULE));
    return null;
  }
  let inFlight: Promise<unknown> | null = null;
  const task = cron.schedule(STUDY_CANVAS_SYNC_SCHEDULE, () => {
    if (inFlight) return; // the previous pass is still walking users
    inFlight = runStudyCanvasSyncAll()
      .catch((error) => logger.error("study canvas cron failed", error))
      .finally(() => {
        inFlight = null;
      });
  });
  return {
    async stop() {
      task.stop();
      if (inFlight) await inFlight;
    },
  };
}
