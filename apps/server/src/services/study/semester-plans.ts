/**
 * Semester facts a grade policy needs that Canvas does not hold — read off a course's own
 * calendar/syllabus by hand and hardcoded here (keyed by Canvas course id). Used to turn
 * "≥ 90 % of the SEMESTER total" into numbers before the instructor has published the rest.
 *
 * Every number derived from this is returned with `estimated: true`.
 */

export type CategoryEstimate =
  /** N credits per remaining class meeting (after the last published item's date). */
  | { kind: "per_meeting"; perMeeting: number }
  /** A fixed semester total (e.g. one credit per lesson on the calendar). */
  | { kind: "fixed_total"; total: number }
  /** Remaining dated events (assessments), each worth as many points as the first graded one. */
  | { kind: "events"; dates: string[] };

export type SemesterPlan = {
  source: string;
  tz: string;
  meetingWeekdays: number[];
  lastClassDay: string;
  /** Meeting days with no credit: holidays, assessment days, days with no lesson on the calendar. */
  noCreditDays: string[];
  categories: { match: RegExp; estimate: CategoryEstimate; unit: "credit" | "question" }[];
};

/**
 * Keyed by Canvas course id. Empty by default; add your own course's calendar facts. Example:
 *
 *   12345: {
 *     source: "Course calendar PDF",
 *     tz: "America/New_York",
 *     meetingWeekdays: [1, 3], // Mon/Wed
 *     lastClassDay: "2026-12-11",
 *     noCreditDays: ["2026-09-07", "2026-11-11"], // holidays, assessment days
 *     categories: [
 *       { match: /^engagement credits$/i, estimate: { kind: "per_meeting", perMeeting: 2 }, unit: "credit" },
 *       { match: /^practice credits$/i, estimate: { kind: "fixed_total", total: 26 }, unit: "credit" },
 *       { match: /^assessments$/i, estimate: { kind: "events", dates: ["2026-10-19", "2026-11-16"] }, unit: "question" },
 *     ],
 *   },
 */
export const SEMESTER_PLANS: Record<number, SemesterPlan> = {};
