import { Types } from "mongoose";
import { StudyAPlan } from "@/models/study/a-plan";
import { StudyClass, IStudyClass } from "@/models/study/class";
import { StudyClassPolicy } from "@/models/study/class-policy";
import { logger } from "@/services/logger.service";
import { applyDeadlineChanges, processDigests, syncEmphasis } from "./announcements";

/**
 * Runs after every successful Canvas sync (canvas-sync.service → SyncDeps.afterSync), in the
 * background. Incremental: only announcements whose version changed are digested. Only classes
 * whose A plan the owner has opened at least once are processed, so a user who never uses the
 * A plan never pays for digests. The plan itself is NOT rebuilt here — its next GET sees the
 * moved inputs hash and rebuilds.
 */
export async function aPlanAfterSync(userId: string): Promise<void> {
  const uid = new Types.ObjectId(userId);
  const optedIn = await StudyAPlan.distinct("classId", { userId: uid });
  if (!optedIn.length) return;
  const classes = await StudyClass.find({ _id: { $in: optedIn }, userId: uid, current: true }, { name: 1 }).lean<IStudyClass[]>();
  for (const cls of classes) {
    try {
      const pol = await StudyClassPolicy.findOne({ userId: uid, classId: cls._id }, { timeZone: 1 }).lean();
      const zone = (pol as any)?.timeZone ?? null;
      await processDigests(uid, cls, { zone });
      await applyDeadlineChanges(uid, cls._id, zone);
      await syncEmphasis(uid, cls._id);
    } catch (e) {
      await logger.error("study a-plan post-sync failed", e as Error, { userId, classId: String(cls._id) });
    }
  }
}
