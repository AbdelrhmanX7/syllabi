import { Types } from "mongoose";
import { DateTime } from "luxon";
import { StudyClass, IStudyClass } from "@/models/study/class";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyClassPolicy, IStudyClassPolicy, ClassPolicy } from "@/models/study/class-policy";
import { StudyAnnouncementDigest, IStudyAnnouncementDigest } from "@/models/study/announcement-digest";
import { StudyAPlan, IStudyAPlan } from "@/models/study/a-plan";
import { logger } from "@/services/logger.service";
import { newSpend, textJson, spendForUser } from "../ai-models";
import { recordStudyUsage } from "../usage";
import { classifyAiError, isAiQuotaError, logAiFailure } from "../ai-errors";
import { CanvasDeps, CanvasGroups, clientFor, fetchCourseSyllabus, fetchSyllabusHints, loadAssignmentGroups } from "./canvas";
import { refreshSyllabus } from "./syllabus";
import { ensurePolicy } from "./policy";
import { applyDeadlineChanges, digestDto, processDigests, syncEmphasis } from "./announcements";
import { canvasConflicts, Conflict, linkCanvasGroups, ownerPolicyConflicts } from "./conflicts";
import { getClassGuide, getExamsSchedule, getGradePlan, OwnerPolicy, resolveOwnerPolicy } from "./deps";
import { StudyAssignmentGroup, IStudyAssignmentGroup } from "@/models/study/assignment-group";
import { sha256 } from "./text-utils";
import { BUILD_STALE_MS, planState } from "./rows";
export { BUILD_STALE_MS };
import { withClassGuide } from "../class-guide";
import { StudyClassGuide, IStudyClassGuide } from "@/models/study/library";
import { buildGroups, buildMeetings, buildRecovery, fetchSubmissions, masteryActions } from "./mastery";

/**
 * The per-class A plan: policy + conflicts + deterministic facts from items, then ONE text-model
 * pass that writes requirements / risks / thisWeek. Cached in `study_a_plans` by an inputs hash.
 */

const DAY = 86400e3;
const ZONE = "America/Los_Angeles";

export type ReqStatus = "met" | "on_track" | "at_risk" | "missed";
const STATUSES: ReqStatus[] = ["met", "on_track", "at_risk", "missed"];
const SEVERITIES = ["high", "medium", "low"] as const;

export interface Requirement {
  text: string;
  status: ReqStatus;
  evidence: string;
}
export interface Risk {
  text: string;
  severity: (typeof SEVERITIES)[number];
  itemIds: string[];
}
export interface ThisWeek {
  text: string;
  dueAt: string | null;
  itemId: string | null;
  why: string;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const effDue = (i: Pick<IStudyItem, "dueAt" | "effectiveDueAt">) => i.effectiveDueAt ?? i.dueAt ?? null;
const handedIn = (i: IStudyItem) => ["submitted", "graded", "late"].includes(i.submission?.state ?? "");
const shortTitle = (t: string) => t.replace(/\s*\([^)]*\)/g, "").trim() || t;

// ─── deterministic facts ────────────────────────────────────────────────────────────────

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

export function categoryStats(items: IStudyItem[], groups: CanvasGroups | null): CategoryStat[] {
  if (!groups?.identity.size) return [];
  const byKey = new Map(items.map((i) => [`${i.canvasType}/${i.canvasId}`, i]));
  return groups.groups.map((g) => {
    let earned = 0;
    let possible = 0;
    let graded = 0;
    let missing = 0;
    for (const aid of g.assignmentIds ?? []) {
      const it = byKey.get(groups.identity.get(aid) ?? "");
      if (!it) continue;
      if (it.submission?.state === "missing") missing++;
      if (it.submission?.state === "graded" && typeof it.submission.score === "number" && typeof it.points === "number" && it.points > 0) {
        earned += it.submission.score;
        possible += it.points;
        graded++;
      }
    }
    return { name: g.name, groupId: g.id, weight: g.weight, earned, possible, pct: possible > 0 ? Math.round((earned / possible) * 1000) / 10 : null, graded, missing };
  });
}

/** Requirement statuses we can compute without a model. */
export function deterministicRequirements(
  a: ClassPolicy["aRequirement"] | OwnerPolicy | null,
  stats: CategoryStat[],
  cls: Pick<IStudyClass, "grade" | "term">,
  policy: ClassPolicy | null,
  now: Date,
  label = "Syllabus"
): Requirement[] {
  if (!a) return [];
  const termOver = cls.term?.endAt ? new Date(cls.term.endAt).getTime() < now.getTime() : false;
  const out: Requirement[] = [];
  if (a.kind === "all_categories_min" && a.min !== null && stats.length) {
    for (const name of a.categories) {
      const s = stats.find((x) => x.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(x.name.toLowerCase()));
      if (!s) continue;
      const status: ReqStatus = s.pct === null ? "on_track" : s.pct >= a.min ? (termOver ? "met" : "on_track") : termOver ? "missed" : "at_risk";
      out.push({
        text: `${label}: ≥ ${a.min}% in ${s.name}`,
        status,
        evidence: s.pct === null ? "No graded work in this category yet." : `${s.pct}% so far (${s.earned}/${s.possible} pts, ${s.graded} graded${s.missing ? `, ${s.missing} missing` : ""}).`,
      });
    }
  } else if (a.kind === "weighted" || a.kind === "points") {
    const aMin = a.min ?? policy?.scale.find((r) => /^A$/i.test(r.letter))?.min ?? null;
    const score = cls.grade?.score ?? null;
    if (aMin !== null && score !== null && a.kind === "weighted") {
      out.push({
        text: `${label}: course total ≥ ${aMin}%`,
        status: score >= aMin ? (termOver ? "met" : "on_track") : termOver ? "missed" : "at_risk",
        evidence: `Canvas current score ${score}%${cls.grade?.letter ? ` (${cls.grade.letter})` : ""}.`,
      });
    }
  }
  return out;
}

export function deterministicRisks(items: IStudyItem[], stats: CategoryStat[], conflicts: Conflict[], a: { kind: string; min: number | null } | null): Risk[] {
  const out: Risk[] = [];
  const missing = items.filter((i) => i.submission?.state === "missing");
  if (missing.length) out.push({ text: `${missing.length} missing assignment(s): ${missing.slice(0, 5).map((i) => shortTitle(i.title)).join(", ")}`, severity: "high", itemIds: missing.map((i) => String(i._id)) });
  const late = items.filter((i) => i.submission?.state === "late");
  if (late.length) out.push({ text: `${late.length} late submission(s) — check the late-work penalty`, severity: "medium", itemIds: late.map((i) => String(i._id)) });
  if (a?.kind === "all_categories_min" && a.min !== null) {
    for (const s of stats) if (s.pct !== null && s.pct < a.min) out.push({ text: `${s.name} is at ${s.pct}%, below the ${a.min}% needed for an A`, severity: "high", itemIds: [] });
  }
  for (const c of conflicts) if (c.severity === "high") out.push({ text: c.text, severity: "medium", itemIds: [] });
  return out;
}

export function deterministicThisWeek(items: IStudyItem[], now: Date): ThisWeek[] {
  const end = now.getTime() + 7 * DAY;
  return items
    .filter((i) => {
      const d = effDue(i);
      return d && d.getTime() >= now.getTime() && d.getTime() <= end && !handedIn(i) && i.type !== "announcement";
    })
    .sort((x, y) => effDue(x)!.getTime() - effDue(y)!.getTime())
    .slice(0, 10)
    .map((i) => ({
      text: shortTitle(i.title),
      dueAt: iso(effDue(i)),
      itemId: String(i._id),
      why: i.dueChangedBy ? `Due date moved by announcement "${i.dueChangedBy.text}"` : `Due ${iso(effDue(i))}`,
    }));
}

export const overallStatus = (reqs: Requirement[]): ReqStatus | "unknown" => {
  if (!reqs.length) return "unknown";
  for (const s of ["missed", "at_risk", "on_track"] as ReqStatus[]) if (reqs.some((r) => r.status === s)) return s;
  return "met";
};

// ─── synthesis ──────────────────────────────────────────────────────────────────────────

export const SYNTH_SYSTEM_PROMPT = [
  "You are a study coach writing a college student's plan to earn an A in ONE class.",
  "You get: the syllabus policy, conflicts between sources, computed facts (fixed requirements with statuses, per-category scores, items with due dates and submission states), and recent announcement digests.",
  "Return ONE JSON object:",
  '{"requirements":[{"text":"...","status":"met|on_track|at_risk|missed","evidence":"..."}],',
  ' "risks":[{"text":"...","severity":"high|medium|low","itemIds":["..."]}],',
  ' "thisWeek":[{"text":"...","dueAt":"ISO or null","itemId":"... or null","why":"..."}]}',
  "Rules:",
  "- requirements: ONLY additional A requirements not already in FIXED_REQUIREMENTS (e.g. revisions, attendance, exam minimums). At most 5. Use the evidence given; on_track when there is no evidence against it.",
  "- risks: things that could cost the A, most serious first, at most 6. itemIds only from the ITEMS list.",
  "- MASTERY_ACTIONS_ALREADY_LISTED are added to thisWeek automatically — do not repeat them.",
  "- thisWeek: the 3–8 most valuable actions for the next 7 days, in order. Prefer real items (use their id and due date exactly) and announcement actions; add study actions for an upcoming exam (use EMPHASIS topics when given).",
  "- If CONFLICTS exist, never choose a side: say both values and tell the student to confirm with the instructor.",
  "- Plain, short sentences. Never invent dates, scores or items.",
].join("\n");

function sanitizeSynth(raw: any, itemIds: Set<string>) {
  const s = (v: unknown, n = 400) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const okId = (v: unknown) => (typeof v === "string" && itemIds.has(v) ? v : null);
  const date = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  return {
    requirements: (Array.isArray(raw?.requirements) ? raw.requirements : [])
      .map((r: any) => ({ text: s(r?.text), status: STATUSES.includes(r?.status) ? r.status : "on_track", evidence: s(r?.evidence) }))
      .filter((r: Requirement) => r.text)
      .slice(0, 5) as Requirement[],
    risks: (Array.isArray(raw?.risks) ? raw.risks : [])
      .map((r: any) => ({ text: s(r?.text), severity: (SEVERITIES as readonly string[]).includes(r?.severity) ? r.severity : "medium", itemIds: (Array.isArray(r?.itemIds) ? r.itemIds : []).map(okId).filter(Boolean) }))
      .filter((r: Risk) => r.text)
      .slice(0, 6) as Risk[],
    thisWeek: (Array.isArray(raw?.thisWeek) ? raw.thisWeek : [])
      .map((t: any) => ({ text: s(t?.text), dueAt: date(t?.dueAt), itemId: okId(t?.itemId), why: s(t?.why) }))
      .filter((t: ThisWeek) => t.text)
      .slice(0, 8) as ThisWeek[],
  };
}

// ─── inputs hash ────────────────────────────────────────────────────────────────────────

/** Hash of every LOCAL input (no Canvas call), so a GET can tell cheaply whether the plan is stale. */
export async function localInputsHash(userId: Types.ObjectId, cls: IStudyClass, now = new Date()): Promise<string> {
  // Grade-plan INPUTS (not its output — that is computed against the clock and would mark every GET stale).
  const [items, digests, pol, groupRows, guideRow] = await Promise.all([
    StudyItem.find({ userId, classId: cls._id, type: { $ne: "announcement" } }, { dueAt: 1, effectiveDueAt: 1, submission: 1, title: 1, points: 1 }).sort({ _id: 1 }).lean<IStudyItem[]>(),
    StudyAnnouncementDigest.find({ userId, classId: cls._id }, { version: 1, itemId: 1 }).sort({ itemId: 1 }).lean<IStudyAnnouncementDigest[]>(),
    StudyClassPolicy.findOne({ userId, classId: cls._id }, { policyTextHash: 1, "syllabus.textHash": 1, timeZone: 1 }).lean<IStudyClassPolicy>(),
    StudyAssignmentGroup.find({ userId, classId: cls._id }, { canvasGroupId: 1, weight: 1, rules: 1, assignments: 1 }).sort({ canvasGroupId: 1 }).lean<IStudyAssignmentGroup[]>(),
    StudyClassGuide.findOne({ userId, canvasCourseId: cls.canvasCourseId }, { updatedAt: 1 }).sort({ updatedAt: -1 }).lean<IStudyClassGuide>(),
  ]);
  const day = DateTime.fromJSDate(now, { zone: pol?.timeZone || ZONE }).toISODate();
  return sha256(
    JSON.stringify({
      day,
      grade: cls.grade?.score ?? null,
      items: items.map((i) => [String(i._id), iso(i.dueAt), iso(i.effectiveDueAt), i.submission?.state ?? null, i.submission?.score ?? null, i.title, i.points]),
      digests: digests.map((d) => [String(d.itemId), d.version]),
      policy: [pol?.policyTextHash ?? null, pol?.syllabus?.textHash ?? null],
      groups: groupRows.map((g) => [g.canvasGroupId, g.weight, g.rules, (g.assignments ?? []).map((a) => [a.canvasAssignmentId, a.score, a.points, a.excused, a.omit])]),
      gradePolicy: cls.gradePolicy ?? null,
      targetLetter: cls.targetLetter ?? null,
      guide: guideRow?.updatedAt ? new Date(guideRow.updatedAt).toISOString() : null,
      weighted: cls.grading?.weighted ?? null,
    })
  );
}

// ─── build ──────────────────────────────────────────────────────────────────────────────

export type BuildDeps = CanvasDeps & { now?: () => Date };

/** Every model call of the build runs with the class guide as system context (P-CM `guidedSystem`). */
export const buildAPlan = (userId: Types.ObjectId, classId: Types.ObjectId, deps: BuildDeps = {}) =>
  withClassGuide(userId, classId, () => buildAPlanInner(userId, classId, deps));

async function buildAPlanInner(userId: Types.ObjectId, classId: Types.ObjectId, deps: BuildDeps): Promise<Record<string, any>> {
  const now = deps.now?.() ?? new Date();
  const cls = await StudyClass.findOne({ _id: classId, userId }).lean<IStudyClass>();
  if (!cls) throw Object.assign(new Error("Class not found"), { code: "NOT_FOUND" });

  // 1. Syllabus + policy.
  // A manual class has no Canvas course (its canvasCourseId is a negative sentinel).
  const client = cls.source === "manual" ? null : await clientFor(userId, deps).catch(() => null);
  const canvasCourse = client
    ? await fetchCourseSyllabus(client, cls.canvasCourseId)
        .then(async (c) => ({ ...c, hints: await fetchSyllabusHints(client, cls.canvasCourseId).catch(() => undefined) }))
        .catch(() => null)
    : null;
  const { doc: syllabusDoc } = await refreshSyllabus(userId, cls._id, canvasCourse);
  const polDoc = await ensurePolicy(userId, syllabusDoc, cls.name);
  const zone = polDoc.timeZone ?? null;

  // 2. Announcements → digests → deadline overrides + emphasis.
  await processDigests(userId, cls, { zone });
  await applyDeadlineChanges(userId, cls._id, zone);
  await syncEmphasis(userId, cls._id);

  // 3. Canvas groups, owner policy, adapters.
  const groups = await loadAssignmentGroups(userId, cls._id, cls.canvasCourseId, client).catch(async (e) => {
    await logger.warn("study a-plan: assignment groups unavailable", { classId: String(cls._id), error: (e as Error)?.message });
    return null;
  });
  const owner = await resolveOwnerPolicy(userId, cls._id);
  const [gradePlan, guide, examsSchedule] = await Promise.all([getGradePlan(userId, cls._id), getClassGuide(userId, cls._id), getExamsSchedule(userId, cls._id)]);
  const fresh = (await StudyClassPolicy.findOne({ userId, classId: cls._id }).lean<IStudyClassPolicy>())!;
  const basePolicy = fresh.policy ? (groups ? linkCanvasGroups(fresh.policy, groups.groups) : fresh.policy) : null;
  const conflicts: Conflict[] = [...(basePolicy && groups ? canvasConflicts(basePolicy, groups) : []), ...ownerPolicyConflicts(basePolicy, owner?.policy ?? null, groups?.groups ?? [])];

  // 4. Deterministic facts.
  const items = await StudyItem.find({ userId, classId: cls._id, type: { $ne: "announcement" } }, { html: 0 }).lean<IStudyItem[]>();
  const stats = categoryStats(items, groups);
  const needsSubs = !!(basePolicy?.recovery || basePolicy?.gradingCategories.some((c) => c.unit === "questions"));
  const subs = needsSubs && client ? await fetchSubmissions(client, cls.canvasCourseId).catch(() => []) : [];
  const groupsCtx = buildGroups(basePolicy, groups, items, subs, { now, zone });
  const recovery = buildRecovery(basePolicy, groupsCtx, items, subs, { zone });
  const meetings = buildMeetings(basePolicy, groupsCtx, zone);
  const closedDates = basePolicy?.closedDates ?? [];
  const mastery = masteryActions(recovery, meetings, now, closedDates);
  const ownerA = owner?.policy ?? null;
  const fixedReqs = [
    ...deterministicRequirements(basePolicy?.aRequirement ?? null, stats, cls, basePolicy, now, "Syllabus"),
    ...(ownerA && conflicts.some((c) => c.kind === "owner_policy") ? deterministicRequirements(ownerA, stats, cls, basePolicy, now, "Your rule") : []),
  ];
  if (!fixedReqs.length && ownerA) fixedReqs.push(...deterministicRequirements(ownerA, stats, cls, basePolicy, now, "Your rule"));
  const aRule = basePolicy?.aRequirement ?? ownerA;
  const fixedRisks = deterministicRisks(items, stats, conflicts, aRule);
  const fallbackWeek = deterministicThisWeek(items, now);
  const digests = await StudyAnnouncementDigest.find({ userId, classId: cls._id }).sort({ postedAt: -1 }).lean<IStudyAnnouncementDigest[]>();

  // 5. One synthesis pass.
  const horizon = now.getTime() + 14 * DAY;
  const relevant = items.filter((i) => {
    const d = effDue(i);
    return i.submission?.state === "missing" || i.submission?.state === "late" || (d && d.getTime() >= now.getTime() - 2 * DAY && d.getTime() <= horizon);
  });
  const recent = digests.filter((d) => !d.postedAt || now.getTime() - new Date(d.postedAt).getTime() < 21 * DAY).slice(0, 15);
  const synthInput = {
    class: { name: cls.name, code: cls.code, currentScore: cls.grade?.score ?? null, letter: cls.grade?.letter ?? null },
    today: DateTime.fromJSDate(now, { zone: zone || ZONE }).toFormat("cccc yyyy-MM-dd HH:mm ZZZZ"),
    policy: basePolicy && {
      aRequirement: basePolicy.aRequirement,
      scale: basePolicy.scale,
      gradingCategories: basePolicy.gradingCategories.map((c) => ({ name: c.name, weight: c.weight, rules: c.rules })),
      lateWork: basePolicy.lateWork,
      makeupAndRevisions: basePolicy.makeupAndRevisions,
      drops: basePolicy.drops,
      attendance: basePolicy.attendance,
      exams: basePolicy.exams,
    },
    ownerRule: ownerA,
    conflicts: conflicts.map((c) => c.text),
    emphasis: fresh.emphasis.slice(0, 20).map((e) => ({ text: e.text, exam: e.exam })),
    categoryStats: stats,
    FIXED_REQUIREMENTS: fixedReqs,
    ITEMS: relevant.slice(0, 60).map((i) => ({ id: String(i._id), title: shortTitle(i.title), type: i.type, dueAt: iso(effDue(i)), state: i.submission?.state ?? null, score: i.submission?.score ?? null, points: i.points })),
    announcements: recent.map((d) => ({ posted: iso(d.postedAt), title: d.title, summary: d.summary, actions: d.actions, tags: d.tags })),
    recovery,
    meetings,
    MASTERY_ACTIONS_ALREADY_LISTED: [...mastery.first, ...mastery.later].map((a) => a.text),
    gradePlan: gradePlan ? JSON.stringify(gradePlan).slice(0, 8000) : null,
    examsSchedule,
    // The guide itself reaches the model as system context (withClassGuide); not repeated here.
  };
  const spend = await spendForUser(userId, { background: true });
  const started = Date.now();
  let synth: ReturnType<typeof sanitizeSynth> | null = null;
  try {
    const raw = await textJson(SYNTH_SYSTEM_PROMPT, JSON.stringify(synthInput), spend, { maxTokens: 16_000, claude: "sonnet" }); // background build: fixed tier, no router
    synth = raw ? sanitizeSynth(raw, new Set(items.map((i) => String(i._id)))) : null;
    await recordStudyUsage(userId, "a_plan", spend, started, synth ? "done" : "error", synth ? {} : { error: "no JSON" });
  } catch (e) {
    const c = classifyAiError(e, { code: "AI_FAILED", message: "" });
    await recordStudyUsage(userId, "a_plan", spend, started, "error", { error: (e as Error)?.message, errorCode: c.code });
    if (c.code === "AI_QUOTA") await logAiFailure("study a-plan synthesis failed", e, { classId: String(cls._id) }, c.code);
    else await logger.warn("study a-plan synthesis failed", { classId: String(cls._id), error: (e as Error)?.message });
  }

  const requirements = [...fixedReqs, ...(synth?.requirements ?? [])];
  const risks = [...fixedRisks, ...(synth?.risks ?? []).filter((r) => !fixedRisks.some((f) => f.text === r.text))];
  const base = synth?.thisWeek.length ? synth.thisWeek : fallbackWeek;
  const thisWeek = [...mastery.first, ...base, ...mastery.later].slice(0, 10);
  const sources = [
    ...(fresh.syllabus?.kind && fresh.syllabus.kind !== "none" ? [{ itemId: fresh.syllabus.itemId ? String(fresh.syllabus.itemId) : null, title: fresh.syllabus.title ?? "Syllabus", kind: "syllabus" as const }] : []),
    ...recent.map((d) => ({ itemId: String(d.itemId), title: d.title, kind: "announcement" as const })),
    ...(groups ? [{ itemId: null, title: `Canvas assignment groups (${groups.source})`, kind: "canvas" as const }] : []),
    ...(guide ? [{ itemId: null, title: "Class guide", kind: "guide" as const }] : []),
  ];

  return {
    classId: String(cls._id),
    status: overallStatus(requirements),
    policy: basePolicy && {
      ...basePolicy,
      emphasis: fresh.emphasis.map((e) => ({ text: e.text, exam: e.exam, itemId: String(e.itemId), postedAt: iso(e.postedAt) })),
      syllabus: { kind: fresh.syllabus.kind, itemId: fresh.syllabus.itemId ? String(fresh.syllabus.itemId) : null, title: fresh.syllabus.title, note: fresh.syllabus.note },
    },
    policyStatus: basePolicy ? "ready" : fresh.policyError ? "error" : fresh.syllabus?.kind === "none" ? "no_syllabus" : (fresh.syllabus?.note ?? "unavailable"),
    ownerPolicy: owner ? { ...owner.policy, source: owner.source } : null,
    conflicts,
    gradePlan,
    categoryStats: stats,
    groups: groupsCtx,
    recovery,
    meetings,
    requirements,
    risks,
    thisWeek,
    announcements: digests.map(digestDto),
    sources,
    synthesis: synth ? "model" : "fallback",
    generatedAt: now.toISOString(),
  };
}

// ─── cache + lock ───────────────────────────────────────────────────────────────────────

/**
 * Take the per-class build lock. Returns the claimed row's _id, or null when a build is already
 * running. Never upserts against a busy filter (that inserted duplicate rows on prod, where the
 * unique index is not built — see rows.ts): it creates the row only when the class has none,
 * then claims ONE existing row by _id.
 */
export async function claimBuild(userId: Types.ObjectId, classId: Types.ObjectId, now = new Date()): Promise<Types.ObjectId | null> {
  let st = await planState(userId, classId, now.getTime());
  if (st.building) return null;
  if (!st.canonical) {
    await StudyAPlan.updateOne({ userId, classId }, { $setOnInsert: { building: false, buildStartedAt: null } }, { upsert: true }).catch((e: any) => {
      if (e?.code !== 11000) throw e;
    });
    st = await planState(userId, classId, now.getTime());
    if (!st.canonical || st.building) return null;
  }
  const doc = await StudyAPlan.findOneAndUpdate(
    { _id: st.canonical._id, $or: [{ building: false }, { buildStartedAt: null }, { buildStartedAt: { $lt: new Date(now.getTime() - BUILD_STALE_MS) } }] },
    { $set: { building: true, buildStartedAt: now } },
    { new: true }
  ).lean<IStudyAPlan>();
  return doc?._id ?? null;
}

/** The build body; the caller holds the lock on `rowId`, released in `finally` on success AND error. */
async function executeBuild(userId: Types.ObjectId, classId: Types.ObjectId, rowId: Types.ObjectId, deps: BuildDeps): Promise<Record<string, any>> {
  let set: Record<string, unknown> = {};
  try {
    const plan = await buildAPlan(userId, classId, deps);
    const cls = (await StudyClass.findOne({ _id: classId, userId }).lean<IStudyClass>())!;
    const inputsHash = await localInputsHash(userId, cls, deps.now?.());
    set = { plan, inputsHash, generatedAt: new Date(plan.generatedAt), lastError: null };
    return plan;
  } catch (e) {
    set = { lastError: isAiQuotaError(e) ? `${classifyAiError(e).code}: ${classifyAiError(e).message}` : String((e as Error)?.message ?? e).slice(0, 500) };
    throw e;
  } finally {
    await StudyAPlan.updateOne({ _id: rowId }, { $set: { ...set, building: false, buildStartedAt: null } });
  }
}

/** Awaitable build (probe, tests). Null when another build holds the lock. */
export async function runBuild(userId: Types.ObjectId, classId: Types.ObjectId, deps: BuildDeps = {}): Promise<Record<string, any> | null> {
  const rowId = await claimBuild(userId, classId, deps.now?.());
  if (!rowId) return null;
  return executeBuild(userId, classId, rowId, deps);
}

/** Fire-and-forget rebuild. Returns false when one is already running. */
export async function startBuild(userId: Types.ObjectId, classId: Types.ObjectId, deps: BuildDeps = {}): Promise<boolean> {
  const rowId = await claimBuild(userId, classId, deps.now?.());
  if (!rowId) return false;
  void executeBuild(userId, classId, rowId, deps).catch((e) => logger.error("study a-plan build failed", e, { userId: String(userId), classId: String(classId) }));
  return true;
}

export type APlanResult =
  | { status: "ready"; plan: Record<string, any>; stale: boolean }
  | { status: "building"; lastError: string | null }
  | { status: "not_found" };

/**
 * The service behind GET /study/classes/:id/a-plan and the future MCP `get_a_plan` tool.
 * Cached plan → returned (marked `stale` + rebuilt in the background when its inputs moved).
 * No plan yet → a build starts and `building` is returned (the FE polls).
 */
export async function getAPlan(userId: Types.ObjectId | string, classId: Types.ObjectId | string, deps: BuildDeps = {}): Promise<APlanResult> {
  const uid = new Types.ObjectId(String(userId));
  const cid = new Types.ObjectId(String(classId));
  const cls = await StudyClass.findOne({ _id: cid, userId: uid }).lean<IStudyClass>();
  if (!cls) return { status: "not_found" };
  const st = await planState(uid, cid, deps.now?.().getTime());
  const cached = st.planRow;
  if (!cached?.plan) {
    await startBuild(uid, cid, deps);
    return { status: "building", lastError: st.lastError };
  }
  const stale = (await localInputsHash(uid, cls, deps.now?.())) !== cached.inputsHash;
  if (stale && !st.building) await startBuild(uid, cid, deps);
  return { status: "ready", plan: cached.plan, stale };
}
