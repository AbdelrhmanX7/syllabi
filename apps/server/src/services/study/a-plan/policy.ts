import { Types } from "mongoose";
import { StudyClassPolicy, IStudyClassPolicy, ClassPolicy, ClassPolicyQuote, PolicySlot } from "@/models/study/class-policy";
import { newSpend, Spend, textJson, spendForUser } from "../ai-models";
import { recordStudyUsage } from "../usage";
import { classifyAiError, logAiFailure } from "../ai-errors";
import { verifyQuotes } from "./text-utils";

/**
 * Syllabus text → ClassPolicy (DeepSeek flash, json_object). Cached on the class's
 * `study_class_policies` row by the syllabus text hash. Quotes are verified verbatim against
 * the source; anything the model paraphrased or invented is dropped.
 */

export const POLICY_MAX_CHARS = 60_000;

export const POLICY_SYSTEM_PROMPT = [
  "You read a college course syllabus and extract its grading and course policies for the student.",
  "Return ONE JSON object with exactly these keys:",
  '{"gradingCategories":[{"name":"...","weight":25,"unit":"credits|questions|points|null","rules":"..."}],',
  ' "aRequirement":{"text":"...","kind":"weighted|all_categories_min|points|other","min":90,"categories":["..."]},',
  ' "scale":[{"letter":"A","min":90}],',
  ' "lateWork":"...","makeupAndRevisions":"...","drops":"...","attendance":"...",',
  ' "exams":[{"name":"...","date":"YYYY-MM-DD or null","week":"... or null","topics":["..."],"format":"...","allowed":"..."}],',
  ' "extraCredit":"...","instructor":{"name":"...","email":"...","officeHours":"..."},',
  ' "requiredMaterials":["..."],"keyDates":[{"date":"YYYY-MM-DD","label":"..."}],',
  ' "meetings":{"slots":[{"day":"Mon","start":"HH:mm","end":"HH:mm","place":"..."}],"creditsPerMeeting":2} or null,',
  ' "recovery":{"newAttempts":{"perWeek":2,"formLeadHours":24,"formName":"...","slots":[{"day":"Mon","start":"HH:mm","end":"HH:mm","place":"..."}]} or null,',
  '   "revisionDays":3,"revisionReturnDayIsDayOne":true,"revisionFormName":"...","rules":["..."]} or null,',
  ' "closedDates":["YYYY-MM-DD"],',
  ' "quotes":[{"field":"gradingCategories|aRequirement|scale|lateWork|makeupAndRevisions|drops|attendance|exams|extraCredit|meetings|recovery","text":"..."}]}',
  "Rules:",
  "- Only what the syllabus says. Unknown → null (or [] for lists). Never guess weights, dates or cutoffs.",
  "- weight: the category's percent of the final grade as a number (25 for 25%); null when the syllabus gives points or no weight.",
  "- rules: one short line on how that category works (drops, retries, revisions), \"\" if nothing is said.",
  "- aRequirement: what it takes to earn an A. kind=weighted when the A comes from a weighted percentage; all_categories_min when the A needs a minimum in EVERY listed category; points when it is a total-points cutoff; else other. min = the percent (or points) threshold.",
  "- scale: every letter cutoff the syllabus lists, min as a percent (or points if it only gives points).",
  "- attendance: attendance or participation policy.",
  "- unit: what the category counts — credits (earned credits, e.g. 1 per completed task), questions (per-question marks such as Successful/Revise/Retry), points (ordinary points); null if unclear.",
  "- meetings: the class meeting days/times (24h, local), and how many engagement/participation credits one meeting is worth when stated. null if not stated.",
  "- recovery: ONLY for mastery-style grading where work can be re-earned. newAttempts = retries/new attempts: how many per week, how many hours ahead the request form is due, the form's name, and where/when attempts are taken (e.g. student/office hours slots). revisionDays = days allowed to submit a revision; revisionReturnDayIsDayOne = true when the day work is returned counts as day 1. rules = 1–6 short lines on how re-earning works. null when the syllabus has no such system.",
  "- closedDates: holidays / campus closed / no-class dates the syllabus lists for this term. [] if none are listed.",
  "- exams: every exam/test/midterm/final with its date (or week) and the chapters/topics it covers when stated.",
  "- quotes: for each rule you extracted, the exact sentence(s) from the syllabus that state it, COPIED CHARACTER FOR CHARACTER (a contiguous span of the text, 1–3 sentences). Never paraphrase, merge or fix a quote. If you cannot copy the exact words, omit that quote. Up to 25 quotes.",
].join("\n");

const str = (v: unknown, max = 2000): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/[%\s]/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const date = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const KINDS = ["weighted", "all_categories_min", "points", "other"] as const;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const hhmm = (v: unknown): string | null => {
  const m = typeof v === "string" ? v.trim().match(/^(\d{1,2}):(\d{2})/) : null;
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};
/** Slots with a recognisable day + start time; anything else is dropped, never guessed. */
const slots = (v: unknown): PolicySlot[] =>
  arr(v)
    .map((x) => ({ day: DAYS.find((d) => String(x?.day ?? "").toLowerCase().startsWith(d.toLowerCase())), start: hhmm(x?.start), end: hhmm(x?.end), place: str(x?.place, 120) }))
    .filter((x): x is PolicySlot => !!x.day && !!x.start)
    .slice(0, 20);

/** Model JSON → ClassPolicy with types enforced. `quotes` still unverified here. */
export function normalizePolicy(raw: any): Omit<ClassPolicy, "quotesDropped"> {
  const a = raw?.aRequirement;
  return {
    gradingCategories: arr(raw?.gradingCategories)
      .map((c) => ({
        name: str(c?.name, 200) ?? "",
        weight: num(c?.weight),
        canvasGroupId: null,
        rules: str(c?.rules, 600) ?? "",
        unit: (["credits", "questions", "points"] as const).find((u) => u === c?.unit) ?? null,
      }))
      .filter((c) => c.name)
      .slice(0, 20),
    aRequirement:
      a && (str(a.text) || num(a.min) !== null)
        ? {
            text: str(a.text, 1000) ?? "",
            kind: (KINDS as readonly string[]).includes(a.kind) ? a.kind : "other",
            min: num(a.min),
            categories: arr(a.categories).map((x) => str(x, 200)).filter(Boolean).slice(0, 20) as string[],
          }
        : null,
    scale: arr(raw?.scale)
      .map((r) => ({ letter: str(r?.letter, 5) ?? "", min: num(r?.min) }))
      .filter((r): r is { letter: string; min: number } => !!r.letter && r.min !== null)
      .sort((x, y) => y.min - x.min)
      .slice(0, 20),
    lateWork: str(raw?.lateWork),
    makeupAndRevisions: str(raw?.makeupAndRevisions),
    drops: str(raw?.drops),
    attendance: str(raw?.attendance ?? raw?.participation),
    exams: arr(raw?.exams)
      .map((e) => ({
        name: str(e?.name, 200) ?? "",
        date: date(e?.date),
        week: str(e?.week, 100),
        topics: arr(e?.topics ?? e?.chapters).map((t) => str(t, 300)).filter(Boolean).slice(0, 30) as string[],
        format: str(e?.format, 500),
        allowed: str(e?.allowed, 500),
      }))
      .filter((e) => e.name)
      .slice(0, 20),
    extraCredit: str(raw?.extraCredit),
    instructor: { name: str(raw?.instructor?.name, 200), email: str(raw?.instructor?.email, 200), officeHours: str(raw?.instructor?.officeHours, 1000) },
    requiredMaterials: arr(raw?.requiredMaterials).map((m) => str(m, 500)).filter(Boolean).slice(0, 20) as string[],
    keyDates: arr(raw?.keyDates)
      .map((k) => ({ date: date(k?.date) ?? "", label: str(k?.label, 300) ?? "" }))
      .filter((k) => k.date && k.label)
      .slice(0, 40),
    meetings: raw?.meetings && arr(raw.meetings.slots).length ? { slots: slots(raw.meetings.slots), creditsPerMeeting: num(raw.meetings.creditsPerMeeting) } : null,
    recovery: raw?.recovery && typeof raw.recovery === "object"
      ? {
          newAttempts: raw.recovery.newAttempts && typeof raw.recovery.newAttempts === "object"
            ? {
                perWeek: num(raw.recovery.newAttempts.perWeek),
                formLeadHours: num(raw.recovery.newAttempts.formLeadHours),
                formName: str(raw.recovery.newAttempts.formName, 200),
                slots: slots(raw.recovery.newAttempts.slots),
              }
            : null,
          revisionDays: num(raw.recovery.revisionDays),
          revisionReturnDayIsDayOne: typeof raw.recovery.revisionReturnDayIsDayOne === "boolean" ? raw.recovery.revisionReturnDayIsDayOne : null,
          revisionFormName: str(raw.recovery.revisionFormName, 200),
          rules: arr(raw.recovery.rules).map((r) => str(r, 400)).filter(Boolean).slice(0, 8) as string[],
        }
      : null,
    closedDates: [...new Set(arr(raw?.closedDates).map(date).filter(Boolean) as string[])].slice(0, 40),
    quotes: arr(raw?.quotes)
      .map((q) => ({ field: str(q?.field, 60) ?? "other", text: str(q?.text, 1500) ?? "" }))
      .filter((q) => q.text)
      .slice(0, 40),
  };
}

/** Normalize + verify quotes against the exact text the model was shown. */
export function settlePolicy(raw: any, sourceText: string): { policy: ClassPolicy; dropped: ClassPolicyQuote[] } {
  const p = normalizePolicy(raw);
  const { kept, dropped } = verifyQuotes(p.quotes, sourceText);
  return { policy: { ...p, quotes: kept, quotesDropped: dropped.length }, dropped };
}

export async function extractPolicy(text: string, className: string, spend: Spend): Promise<{ policy: ClassPolicy; dropped: ClassPolicyQuote[] }> {
  const source = text.slice(0, POLICY_MAX_CHARS);
  const raw = await textJson(POLICY_SYSTEM_PROMPT, `CLASS: ${className}\n\nSYLLABUS:\n${source}`, spend, { maxTokens: 12_000, disableThinking: true, claude: "haiku" });
  if (!raw) throw new Error("policy extraction returned no JSON");
  return settlePolicy(raw, source);
}

/** Re-extract only when the syllabus text hash moved (or `force`). */
export async function ensurePolicy(
  userId: Types.ObjectId,
  doc: IStudyClassPolicy,
  className: string,
  opts: { force?: boolean } = {}
): Promise<IStudyClassPolicy> {
  const hash = doc.syllabus?.textHash ?? null;
  if (!hash || !doc.syllabus.text) return doc;
  if (!opts.force && doc.policy && doc.policyTextHash === hash) return doc;
  const spend = await spendForUser(userId, { background: true });
  const started = Date.now();
  try {
    const { policy, dropped } = await extractPolicy(doc.syllabus.text, className, spend);
    await recordStudyUsage(userId, "policy", spend, started, "done", { itemId: doc.syllabus.itemId ?? null });
    return (await StudyClassPolicy.findOneAndUpdate(
      { _id: doc._id },
      { $set: { policy, policyTextHash: hash, droppedQuotes: dropped, policyExtractedAt: new Date(), policyError: null } },
      { new: true }
    ).lean<IStudyClassPolicy>())!;
  } catch (e) {
    const c = classifyAiError(e, { code: "AI_FAILED", message: "" });
    await recordStudyUsage(userId, "policy", spend, started, "error", { error: (e as Error)?.message, errorCode: c.code });
    if (c.code === "AI_QUOTA") await logAiFailure("study policy extraction failed", e, { userId: String(userId) }, c.code);
    await StudyClassPolicy.updateOne({ _id: doc._id }, { $set: { policyError: c.code === "AI_QUOTA" ? `${c.code}: ${c.message}` : String((e as Error)?.message ?? e).slice(0, 500) } });
    return doc;
  }
}
