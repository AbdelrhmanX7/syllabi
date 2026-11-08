// "A plan" contract types. Everything here matches the live backend: grade-plan, PATCH targetLetter /
// gradePolicy and /today.warnings (#573), a-plan + /today.aPlan / highAnnouncements (#576).

export type GroupStatus = 'on_track' | 'at_risk' | 'below';
export type RequirementStatus = 'met' | 'on_track' | 'at_risk' | 'missed';
export type PolicyKind = 'weighted' | 'all_categories_min';

/** One letter cutoff, `min` as a percent (90 → A). Sorted high → low. */
export interface SchemeEntry {
  name: string;
  min: number;
}

/** Not graded yet. `estimated` = not in Canvas yet (a scheduled exam): no item to open. */
export interface RemainingItem {
  itemId: string | null;
  assignmentId?: string | null;
  title: string;
  points: number;
  dueAt: string | null;
  estimated?: boolean;
}

/** One counted score BEFORE drops (excused / omitted already left out) — what-if re-runs the drops. */
export interface GradedItem {
  itemId: string | null;
  assignmentId?: string;
  title: string;
  score: number;
  possible: number;
}

export interface GradePlanGroup {
  /** Canvas assignment-group id. */
  id: string;
  name: string;
  /** Percent weight (15 = 15%). Ignored when the course is not weighted. */
  weight: number;
  dropLowest: number;
  dropHighest: number;
  /** Item ids (or `canvas:<assignmentId>`) the drop rules may never drop. */
  neverDrop?: string[];
  /** After drops. */
  earned: number;
  possible: number;
  /** earned / possible as a percent, null when nothing is graded yet. */
  effectivePct: number | null;
  gradedCount: number;
  graded: GradedItem[];
  dropped?: { itemId: string | null; title: string }[];
  remaining: RemainingItem[];
}

/** Wire policy. `min` is a FRACTION (0.9); `categories` are group ids. */
export interface GradePolicy {
  kind: PolicyKind;
  min: number | null;
  categories: string[];
}

/** One category of an `all_categories_min` policy, over the SEMESTER total (graded + published + estimated). */
export interface PolicyCategory {
  groupId?: string;
  name: string;
  /** "credit" | "question" | "point". */
  unit: string;
  earned: number;
  possible: number;
  /** Today: earned / graded, percent. */
  pct: number | null;
  gradedCount: number;
  remainingCount: number;
  /** Not in Canvas yet, estimated from the course calendar. */
  estimatedRemaining: number;
  total: number;
  estimated: boolean;
  estimateBasis: string;
  /** Best case over the semester total, percent. */
  maxPct: number | null;
  maxMissesAllowed: number;
  status: GroupStatus;
  /** unit "question": Canvas only has totals, so this is a count with no per-question detail. */
  notYetSuccessful?: number;
  pendingRevisions?: number | null;
  questionDetail?: 'totals_only' | 'per_question';
}

export interface ExamNeed {
  itemId: string | null;
  title: string;
  /** May exceed 100 (= not reachable); 0 = already safe; null = nothing left to solve over. */
  neededPct: number | null;
  estimated?: boolean;
  points?: number;
  dueAt?: string | null;
}

export interface GradeRequired {
  byGroup: { groupId: string; neededPct: number | null }[];
  exams: ExamNeed[];
  examGroupId: string | null;
  examScheduleAvailable: boolean;
}

export interface GradePlan {
  /** `min` 0–100. */
  scheme: SchemeEntry[];
  weighted: boolean;
  policy: GradePolicy;
  current: {
    score: number | null;
    letter: string | null;
    canvasScore: number | null;
    /** `lowest_category`: the letter comes from the weakest policy category; `score` stays Canvas's (may be null). */
    basis: 'canvas' | 'lowest_category';
    lowestCategoryPct?: number | null;
  };
  groups: GradePlanGroup[];
  /** all_categories_min only. */
  categories?: PolicyCategory[];
  /** `min` 0–100. */
  target: { letter: string; min: number };
  /** null under all_categories_min (the categories carry the story). */
  required: GradeRequired | null;
}

/* ------------------------------------------------------------------ a-plan: wire (GET /classes/:id/a-plan) */

export type WireDay = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

/** A syllabus slot, 24h "HH:mm" in the course's time zone. */
export interface WireSlot {
  day: WireDay;
  start: string;
  end: string | null;
  place?: string | null;
}

export interface SyllabusQuote {
  field: string;
  text: string;
}

export type ARequirementKind = 'weighted' | 'all_categories_min' | 'points' | 'other';

export interface WireARequirement {
  text: string;
  kind: ARequirementKind;
  min: number | null;
  categories: string[];
}

export interface WireExam {
  name: string;
  date: string | null;
  week: string | null;
  topics: string[];
  format: string | null;
  allowed: string | null;
}

/** "Know X for the exam" lines lifted from announcements. */
export interface PolicyEmphasis {
  text: string;
  exam: string | null;
  itemId: string;
  postedAt: string | null;
}

export type SyllabusKind = 'body' | 'body_file' | 'module_file' | 'module_page' | 'none';

/** Where the syllabus was found. `itemId` opens it in the app; `note` e.g. "no_text_layer" (scanned PDF). */
export interface SyllabusRef {
  kind: SyllabusKind;
  itemId: string | null;
  title: string | null;
  note: string | null;
}

export interface WirePolicy {
  gradingCategories: {
    name: string;
    weight: number | null;
    canvasGroupId: number | null;
    rules: string;
    unit?: GroupUnit | null;
  }[];
  aRequirement: WireARequirement | null;
  scale: { letter: string; min: number }[];
  lateWork: string | null;
  makeupAndRevisions: string | null;
  drops: string | null;
  attendance: string | null;
  exams: WireExam[];
  extraCredit: string | null;
  instructor: { name: string | null; email: string | null; officeHours: string | null };
  requiredMaterials: string[];
  keyDates: KeyDate[];
  meetings?: { slots: WireSlot[]; creditsPerMeeting: number | null } | null;
  recovery?: {
    newAttempts: {
      perWeek: number | null;
      formLeadHours: number | null;
      formName: string | null;
      slots: WireSlot[];
    } | null;
    revisionDays: number | null;
    revisionReturnDayIsDayOne: boolean | null;
    revisionFormName: string | null;
    rules: string[];
  } | null;
  closedDates?: string[];
  quotes: SyllabusQuote[];
  quotesDropped: number;
  emphasis: PolicyEmphasis[];
  syllabus: SyllabusRef;
}

export type GroupUnit = 'credits' | 'questions' | 'points';

export interface Recoverable {
  itemId: string;
  title: string;
  /** Points still recoverable; null when the per-question value is unknown. */
  points: number | null;
  status: 'revise' | 'retry' | null;
  source: 'rubric' | 'comments' | 'score';
}

/** One Canvas assignment group with the syllabus unit and what can still be won back in it. */
export interface PlanGroup {
  canvasGroupId: number;
  name: string;
  weight: number | null;
  unit: GroupUnit | null;
  recoverable: Recoverable[];
}

export interface WireRecovery {
  newAttempts: {
    perWeek: number | null;
    formLeadHours: number | null;
    formItemId: string | null;
    slots: WireSlot[];
    closedDates: string[];
    /** Question labels marked not yet Successful (rubric / comments). */
    questions: string[];
  } | null;
  revisions: { title: string; itemId: string | null; dueAt: string }[];
  rules: string[];
}

export interface WireMeetings {
  slots: { day: WireDay; start: string; end: string | null }[];
  timeZone: string;
  engagementGroupId: number | null;
  creditsPerMeeting: number | null;
}

export type ConflictKind =
  | 'weight_mismatch'
  | 'category_missing_in_canvas'
  | 'category_missing_in_syllabus'
  | 'canvas_unweighted'
  | 'owner_policy';

/** Two sources disagree. Never resolved for the student: both values are shown. */
export interface PlanConflict {
  kind?: ConflictKind;
  severity?: 'high' | 'medium' | 'low';
  text: string;
  otherSource?: 'canvas' | 'owner';
}

export interface CategoryStat {
  name: string;
  groupId: number;
  weight: number | null;
  earned: number;
  possible: number;
  pct: number | null;
  graded: number;
  missing: number;
}

export interface DeadlineChange {
  itemTitle: string;
  newDueAt: string | null;
  matchedItemId: string | null;
  confidence: number;
  /** applied = the item's effectiveDueAt moved; the rest were not applied. */
  outcome: 'applied' | 'already_in_canvas' | 'low_confidence' | 'no_date' | 'canvas_moved';
}

export interface AnnouncementDigest {
  itemId: string;
  title: string;
  postedAt: string | null;
  summary: string;
  actions: { text: string; dueAt: string | null }[];
  importance: 'high' | 'normal';
  tags: string[];
  deadlineChanges: DeadlineChange[];
}

export interface APlanRequirement {
  text: string;
  status: RequirementStatus;
  evidence: string;
}

export interface APlanRisk {
  text: string;
  severity: 'high' | 'medium' | 'low';
  itemIds: string[];
}

export interface APlanAction {
  text: string;
  dueAt: string | null;
  itemId: string | null;
  why: string;
}

export interface APlanSource {
  itemId: string | null;
  title: string;
  kind: 'syllabus' | 'announcement' | 'canvas' | 'guide';
}

export type PlanStatus = RequirementStatus | 'unknown';
/** ready | error | no_syllabus | a syllabus note ("no_text_layer") | unavailable. */
export type PolicyStatus = string;

export interface OwnerPolicy extends WireARequirement {
  source: 'owner';
}

/** `GET /classes/:id/a-plan` 200 body. */
export interface APlanWire {
  classId: string;
  status: PlanStatus;
  policy: WirePolicy | null;
  policyStatus: PolicyStatus;
  ownerPolicy: OwnerPolicy | null;
  conflicts: PlanConflict[];
  gradePlan: GradePlan | null;
  categoryStats: CategoryStat[];
  groups: PlanGroup[];
  recovery: WireRecovery | null;
  meetings: WireMeetings | null;
  requirements: APlanRequirement[];
  risks: APlanRisk[];
  thisWeek: APlanAction[];
  announcements: AnnouncementDigest[];
  sources: APlanSource[];
  synthesis: 'model' | 'fallback';
  generatedAt: string;
  /** The inputs moved since this was built; a rebuild is running in the background. */
  stale: boolean;
}

/** `GET` 202 while the first build runs (20–60 s); `lastError` = the previous build's failure. */
export interface APlanBuilding {
  status: 'building';
  lastError: string | null;
}

export type APlanResponse = APlanWire | APlanBuilding;

/** `POST /classes/:id/a-plan/refresh` 202. `started` false = a build was already running. */
export interface APlanRefreshResult {
  status: 'building';
  started: boolean;
}

/* ------------------------------------------------------------------ a-plan: view (what the components read) */

/** A weekly-recurring slot in the class's time zone. `day` 0 = Sunday; times "HH:MM". */
export interface WeeklySlot {
  day: number;
  start: string;
  end: string;
  place?: string;
}

export interface SyllabusExam {
  name: string;
  date?: string | null;
  week?: string | null;
  topics: string;
  format: string | null;
  allowed: string | null;
}

export interface KeyDate {
  label: string;
  date: string;
}

export interface SyllabusPolicy {
  gradingCategories: { name: string; weight: number | null; unit?: GroupUnit | null }[];
  aRequirement: WireARequirement | null;
  scale: SchemeEntry[];
  lateWork: string | null;
  makeupAndRevisions: string | null;
  drops: string | null;
  attendance: string | null;
  exams: SyllabusExam[];
  extraCredit: string | null;
  instructor: { name: string | null; email: string | null; officeHours: string | null };
  requiredMaterials: string[];
  keyDates: KeyDate[];
  quotes: SyllabusQuote[];
  quotesDropped?: number;
  closedDates?: string[];
  emphasis?: PolicyEmphasis[];
  syllabus?: SyllabusRef | null;
}

/**
 * Syllabi with re-attempts (mastery grading): how to win points back. Drives the "use your New
 * Attempts" card and the Revision Form countdowns.
 */
export interface RecoveryPlan {
  newAttempts: {
    perWeek: number | null;
    /** The request form must be in this many hours before the slot (0 when the syllabus does not say). */
    formLeadHours: number;
    formItemId: string | null;
    slots: WeeklySlot[];
    /** YYYY-MM-DD days with no slots (campus closures). */
    closedDates: string[];
    /** Count of questions not yet Successful; null = unknown. */
    notYetSuccessful: number | null;
    questions?: string[];
  } | null;
  /** Open "Revise" results: each needs a Revision Form by `dueAt`. */
  revisions: { title: string; itemId: string | null; dueAt: string }[];
  rules: string[];
}

/** When the class meets, so engagement credits can be warned about the evening before. */
export interface ClassMeetings {
  slots: WeeklySlot[];
  timeZone: string;
  engagementGroupId: string | null;
  creditsPerMeeting: number | null;
}

export interface APlan {
  status?: PlanStatus;
  policy: SyllabusPolicy | null;
  policyStatus?: PolicyStatus;
  ownerPolicy?: OwnerPolicy | null;
  conflicts: PlanConflict[];
  gradePlan: GradePlan | null;
  categoryStats?: CategoryStat[];
  groups?: PlanGroup[];
  requirements: APlanRequirement[];
  risks: APlanRisk[];
  thisWeek: APlanAction[];
  announcements: AnnouncementDigest[];
  sources: APlanSource[];
  generatedAt: string;
  recovery?: RecoveryPlan | null;
  meetings?: ClassMeetings | null;
  synthesis?: 'model' | 'fallback';
  stale?: boolean;
}

/* ------------------------------------------------------------------ /today additions */

/**
 * One row per class. `status` 'building' / 'none' = no plan to show (the backend can also report
 * 'building' with a null topAction for a built plan — treated the same: the row is hidden).
 */
export interface TodayAPlanEntry {
  classId: string;
  status: PlanStatus | 'building' | 'none';
  topAction: string | null;
  /** e.g. the engagement-credit warning the evening before class. */
  alerts: string[];
}

export interface TodayHighAnnouncement extends AnnouncementDigest {
  classId: string;
}

/** Live: a policy-category item due in the next 48 h and not handed in. */
export interface TodayWarning {
  itemId: string;
  classId: string;
  title: string;
  dueAt: string | null;
  reason: string;
}

export interface TodayAPlanFields {
  aPlan?: TodayAPlanEntry[];
  highAnnouncements?: TodayHighAnnouncement[];
  warnings?: TodayWarning[];
}
