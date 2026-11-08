/** Per-class "A plan" (syllabus policy, conflicts, announcement digests, synthesized plan). */
export { getAPlan, runBuild, startBuild, buildAPlan } from "./plan";
export type { APlanResult } from "./plan";
export { aPlanTodayExtras } from "./today";
export { aPlanAfterSync } from "./hooks";
export { processDigests, applyDeadlineChanges } from "./announcements";
