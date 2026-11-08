import { Types } from "mongoose";
import { planStates } from "./rows";
import { StudyAnnouncementDigest, IStudyAnnouncementDigest } from "@/models/study/announcement-digest";
import { digestDto } from "./announcements";
import { engagementAlert } from "./mastery";

/** Additive `/study/today` fields: one line per class from its cached A plan + high-importance digests. */
export const HIGH_ANNOUNCEMENT_WINDOW_MS = 14 * 86400e3;
export const HIGH_ANNOUNCEMENT_LIMIT = 10;

export async function aPlanTodayExtras(userId: Types.ObjectId, classIds: Types.ObjectId[], now = new Date()) {
  const [plans, highs] = await Promise.all([
    planStates(userId, classIds, now.getTime()),
    StudyAnnouncementDigest.find({ userId, classId: { $in: classIds }, importance: "high", postedAt: { $gte: new Date(now.getTime() - HIGH_ANNOUNCEMENT_WINDOW_MS) } })
      .sort({ postedAt: -1 })
      .limit(HIGH_ANNOUNCEMENT_LIMIT)
      .lean<IStudyAnnouncementDigest[]>(),
  ]);
  return {
    aPlan: classIds.map((id) => {
      // The CACHED plan wins: a rebuild running in the background never hides it.
      const st = plans.get(String(id))!;
      const plan = st.planRow?.plan;
      return {
        classId: String(id),
        status: plan ? (plan.status as string) : st.building ? "building" : "none",
        topAction: plan ? (plan.thisWeek?.[0]?.text ?? plan.risks?.[0]?.text ?? null) : null,
        // Computed at request time from the cached meetings, so it moves with the clock.
        alerts: plan ? [engagementAlert(plan.meetings ?? null, now, plan.policy?.closedDates ?? [])].filter(Boolean) : [],
      };
    }),
    highAnnouncements: highs.map((d) => ({ classId: String(d.classId), ...digestDto(d) })),
  };
}
