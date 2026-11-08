import { Types } from "mongoose";
import { DateTime } from "luxon";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyAnnouncementDigest, IStudyAnnouncementDigest, DIGEST_TAGS, DigestTag, DigestDeadlineChange } from "@/models/study/announcement-digest";
import { StudyClassPolicy } from "@/models/study/class-policy";
import { logger } from "@/services/logger.service";
import { htmlToText } from "../extract-sources";
import { createLimiter } from "../canvas-client";
import { newSpend, Spend, textJson } from "../ai-models";
import { recordStudyUsage } from "../usage";
import { classifyAiError, logAiFailure } from "../ai-errors";
import { bestTitleMatch, sha256 } from "./text-utils";

/**
 * One AI digest per announcement (cached by `version`), then two derived effects:
 *  - deadline changes → `effectiveDueAt` on the matched item, ONLY on a confident, unambiguous
 *    title match (text-utils `bestTitleMatch`); otherwise the change is just listed as an action;
 *  - emphasis ("know X for the exam") → `study_class_policies.emphasis`.
 */

export const DIGEST_CONCURRENCY = 4;
const DEFAULT_ZONE = "America/Los_Angeles";

export const DIGEST_SYSTEM_PROMPT = [
  "You digest ONE course announcement for a college student's study planner.",
  "Return ONE JSON object:",
  '{"summary":"...","actions":[{"text":"...","due":"YYYY-MM-DD or YYYY-MM-DDTHH:mm or null"}],"importance":"high|normal",',
  ' "tags":["exam|deadline-change|emphasis|policy|resource"],',
  ' "deadlineChanges":[{"itemTitle":"...","newDue":"YYYY-MM-DD or YYYY-MM-DDTHH:mm"}],',
  ' "emphasis":[{"text":"...","exam":"... or null"}]}',
  "Rules:",
  "- summary: 1–2 plain sentences, only what the announcement says.",
  "- actions: concrete things the student must do, each with its deadline (local course time, 24h) when one is stated; [] if none.",
  "- importance high ONLY for: an exam/test/quiz date or scope, a changed deadline, a grading/policy change, or something due within days that the student could miss. Routine weekly reminders, office hours, clubs, tutoring and support services are normal.",
  "- deadlineChanges: ONLY when the announcement says an assignment's due date was moved/extended/changed. itemTitle = the assignment as named (match the ITEMS list wording when one clearly fits). newDue = the new deadline. Reminders of unchanged deadlines are NOT changes, and neither are late-pass / 'last opportunity' deadlines that follow the course's normal late policy. [] otherwise.",
  "- emphasis: topics the instructor says to know/study/focus on for an exam or quiz (exam = which one). [] otherwise.",
  "- Resolve weekday names and dates relative to the POSTED date. Dates like 10/5/26 are month/day/year.",
].join("\n");

export const digestVersion = (item: Pick<IStudyItem, "title" | "html" | "canvasUpdatedAt">) =>
  sha256(`${item.canvasUpdatedAt ? new Date(item.canvasUpdatedAt).toISOString() : ""}\n${item.title}\n${item.html ?? ""}`).slice(0, 32);

/** Local wall time in the course zone → Date. Date-only uses `fallbackTime` (HH:mm) or 23:59. */
export function localToDate(v: unknown, zone: string | null, fallbackTime?: string | null): Date | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (!m) return null;
  const dt = DateTime.fromISO(`${m[1]}T${m[2] ?? fallbackTime ?? "23:59"}`, { zone: zone || DEFAULT_ZONE });
  return dt.isValid ? dt.toJSDate() : null;
}

const hasTime = (v: unknown) => typeof v === "string" && /T\d{2}:\d{2}/.test(v);
const localTimeOf = (d: Date | null, zone: string | null) => (d ? DateTime.fromJSDate(d, { zone: zone || DEFAULT_ZONE }).toFormat("HH:mm") : null);

type RawDigest = {
  summary: string;
  actions: { text: string; due: string | null }[];
  importance: "high" | "normal";
  tags: DigestTag[];
  deadlineChanges: { itemTitle: string; newDue: string | null }[];
  emphasis: { text: string; exam: string | null }[];
};

export function normalizeDigest(raw: any): RawDigest {
  const s = (v: unknown, n = 600) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const tags = (Array.isArray(raw?.tags) ? raw.tags : []).filter((t: unknown) => (DIGEST_TAGS as readonly string[]).includes(String(t)));
  const deadlineChanges = (Array.isArray(raw?.deadlineChanges) ? raw.deadlineChanges : [])
    .map((d: any) => ({ itemTitle: s(d?.itemTitle, 300), newDue: s(d?.newDue, 40) || null }))
    .filter((d: any) => d.itemTitle)
    .slice(0, 10);
  if (deadlineChanges.length && !tags.includes("deadline-change")) tags.push("deadline-change");
  const emphasis = (Array.isArray(raw?.emphasis) ? raw.emphasis : []).map((e: any) => ({ text: s(e?.text, 400), exam: s(e?.exam, 120) || null })).filter((e: any) => e.text).slice(0, 10);
  if (emphasis.length && !tags.includes("emphasis")) tags.push("emphasis");
  return {
    summary: s(raw?.summary, 1200),
    actions: (Array.isArray(raw?.actions) ? raw.actions : []).map((a: any) => ({ text: s(a?.text, 400), due: s(a?.due, 40) || null })).filter((a: any) => a.text).slice(0, 10),
    importance: raw?.importance === "high" ? "high" : "normal",
    tags: [...new Set(tags)] as DigestTag[],
    deadlineChanges,
    emphasis,
  };
}

const candidatesFor = (items: IStudyItem[]) => items.filter((i) => i.type === "assignment" || i.type === "quiz" || (i.dueAt && i.type !== "announcement"));

async function digestOne(ann: IStudyItem, ctx: { className: string; zone: string | null; items: IStudyItem[] }, spend: Spend): Promise<RawDigest> {
  const posted = ann.canvasUpdatedAt ? DateTime.fromJSDate(ann.canvasUpdatedAt, { zone: ctx.zone || DEFAULT_ZONE }).toFormat("cccc yyyy-MM-dd HH:mm") : "unknown";
  const itemList = candidatesFor(ctx.items)
    .slice(0, 120)
    .map((i) => `- ${i.title.replace(/\s*\([^)]*\)/g, "").trim() || i.title}${i.dueAt ? ` (due ${DateTime.fromJSDate(i.dueAt, { zone: ctx.zone || DEFAULT_ZONE }).toFormat("yyyy-MM-dd HH:mm")})` : ""}`)
    .join("\n");
  const user = `CLASS: ${ctx.className}\nPOSTED: ${posted}\nITEMS:\n${itemList || "(none)"}\n\nTITLE: ${ann.title}\nANNOUNCEMENT:\n${htmlToText(ann.html ?? "").slice(0, 12_000)}`;
  return normalizeDigest(await textJson(DIGEST_SYSTEM_PROMPT, user, spend, { maxTokens: 2000 }));
}

/**
 * Digest every announcement of the class whose version changed. Returns how many were (re)digested.
 * Errors on one announcement are logged and skipped; the rest still run.
 */
export async function processDigests(
  userId: Types.ObjectId,
  cls: { _id: Types.ObjectId; name: string },
  opts: { zone?: string | null } = {}
): Promise<{ digested: number; failed: number; costUsd: number }> {
  const [anns, items, existing, pol] = await Promise.all([
    StudyItem.find({ userId, classId: cls._id, type: "announcement" }).lean<IStudyItem[]>(),
    StudyItem.find({ userId, classId: cls._id, type: { $ne: "announcement" } }, { html: 0 }).lean<IStudyItem[]>(),
    StudyAnnouncementDigest.find({ userId, classId: cls._id }, { itemId: 1, version: 1 }).lean<IStudyAnnouncementDigest[]>(),
    StudyClassPolicy.findOne({ userId, classId: cls._id }, { timeZone: 1 }).lean(),
  ]);
  const zone = opts.zone ?? (pol as any)?.timeZone ?? null;
  const have = new Map(existing.map((d) => [String(d.itemId), d.version]));
  const todo = anns.filter((a) => have.get(String(a._id)) !== digestVersion(a));
  const limit = createLimiter(DIGEST_CONCURRENCY);
  let digested = 0;
  let failed = 0;
  let costUsd = 0;
  await Promise.all(
    todo.map((ann) =>
      limit(async () => {
        const spend = newSpend();
        const started = Date.now();
        try {
          const d = await digestOne(ann, { className: cls.name, zone, items }, spend);
          const deadlineChanges: DigestDeadlineChange[] = d.deadlineChanges.map((c) => ({
            itemTitle: c.itemTitle,
            rawDue: c.newDue,
            newDueAt: localToDate(c.newDue, zone),
            matchedItemId: null,
            confidence: 0,
            outcome: "low_confidence",
          }));
          await StudyAnnouncementDigest.findOneAndUpdate(
            { userId, itemId: ann._id },
            {
              $set: {
                classId: cls._id,
                version: digestVersion(ann),
                postedAt: ann.canvasUpdatedAt ?? null,
                title: ann.title,
                summary: d.summary,
                actions: d.actions.map((a) => ({ text: a.text, dueAt: localToDate(a.due, zone) })),
                importance: d.importance,
                tags: d.tags,
                emphasis: d.emphasis,
                deadlineChanges,
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
          digested++;
          costUsd += spend.textCostUsd;
          await recordStudyUsage(userId, "digest", spend, started, "done", { itemId: ann._id });
        } catch (e) {
          failed++;
          const c = classifyAiError(e, { code: "AI_FAILED", message: "" });
          await recordStudyUsage(userId, "digest", spend, started, "error", { itemId: ann._id, error: (e as Error)?.message, errorCode: c.code });
          if (c.code === "AI_QUOTA") await logAiFailure("study announcement digest failed", e, { userId: String(userId), itemId: String(ann._id) }, c.code);
          else await logger.warn("study announcement digest failed", { userId: String(userId), itemId: String(ann._id), error: (e as Error)?.message });
        }
      })
    )
  );
  // Digests of announcements that vanished from Canvas go too.
  await StudyAnnouncementDigest.deleteMany({ userId, classId: cls._id, itemId: { $nin: anns.map((a) => a._id) } });
  return { digested, failed, costUsd };
}

const SAME_MS = 60_000;

/**
 * Recompute every deadline override for the class from its digests (oldest → newest, so the
 * latest announcement wins). Idempotent. Rules per change:
 *  - no confident match → low_confidence (listed as an action only, item untouched);
 *  - Canvas already shows the new date → already_in_canvas (no override needed);
 *  - Canvas moved the date AFTER we applied the override → canvas_moved (Canvas is newer, wins);
 *  - else → applied: `effectiveDueAt` = new date, `dueChangedBy` records the announcement.
 */
export async function applyDeadlineChanges(userId: Types.ObjectId, classId: Types.ObjectId, zone: string | null = null): Promise<{ applied: number }> {
  const [digests, items] = await Promise.all([
    StudyAnnouncementDigest.find({ userId, classId, "deadlineChanges.0": { $exists: true } }).sort({ postedAt: 1 }).lean<any[]>(),
    StudyItem.find({ userId, classId, type: { $ne: "announcement" } }, { html: 0 }).lean<IStudyItem[]>(),
  ]);
  const cands = candidatesFor(items);
  const byId = new Map(items.map((i) => [String(i._id), i]));
  const desired = new Map<string, NonNullable<IStudyItem["dueChangedBy"]> & { effectiveDueAt: Date }>();

  for (const d of digests) {
    const changes: DigestDeadlineChange[] = d.deadlineChanges.map((c: DigestDeadlineChange): DigestDeadlineChange => {
      const { item, confidence } = bestTitleMatch(c.itemTitle, cands);
      const out: DigestDeadlineChange = { ...c, matchedItemId: item?._id ?? null, confidence };
      if (!item) return { ...out, outcome: "low_confidence" };
      // Date-only announcement → keep the item's own local time of day.
      const due = c.rawDue && !hasTime(c.rawDue) ? localToDate(c.rawDue, zone, localTimeOf(item.dueAt, zone)) : c.newDueAt;
      if (!due) return { ...out, outcome: "no_date" };
      out.newDueAt = due;
      const prev = item.dueChangedBy;
      if (prev && String(prev.announcementItemId) === String(d.itemId) && (prev.canvasDueAtWas?.getTime() ?? null) !== (item.dueAt?.getTime() ?? null)) {
        return { ...out, outcome: "canvas_moved" };
      }
      if (item.dueAt && Math.abs(item.dueAt.getTime() - due.getTime()) < SAME_MS) {
        desired.delete(String(item._id)); // a later announcement agrees with Canvas → drop an earlier override
        return { ...out, outcome: "already_in_canvas" };
      }
      desired.set(String(item._id), {
        effectiveDueAt: due,
        announcementItemId: d.itemId,
        postedAt: d.postedAt ?? null,
        text: `${d.title}`.slice(0, 300),
        canvasDueAtWas: prev && String(prev.announcementItemId) === String(d.itemId) ? prev.canvasDueAtWas : item.dueAt ?? null,
        confidence,
      });
      return { ...out, outcome: "applied" };
    });
    await StudyAnnouncementDigest.updateOne({ _id: d._id }, { $set: { deadlineChanges: changes } });
  }

  const ops: any[] = [];
  for (const [id, ch] of desired) {
    const { effectiveDueAt, ...by } = ch;
    ops.push({ updateOne: { filter: { _id: byId.get(id)!._id, userId }, update: { $set: { effectiveDueAt, dueChangedBy: by } } } });
  }
  const stale = items.filter((i) => (i.effectiveDueAt || i.dueChangedBy) && !desired.has(String(i._id)));
  for (const i of stale) ops.push({ updateOne: { filter: { _id: i._id, userId }, update: { $set: { effectiveDueAt: null, dueChangedBy: null } } } });
  if (ops.length) await StudyItem.bulkWrite(ops);
  return { applied: desired.size };
}

/** Emphasis lines from all digests → the class policy row (newest first). */
export async function syncEmphasis(userId: Types.ObjectId, classId: Types.ObjectId): Promise<void> {
  const digests = await StudyAnnouncementDigest.find({ userId, classId, "emphasis.0": { $exists: true } }).sort({ postedAt: -1 }).lean<IStudyAnnouncementDigest[]>();
  const emphasis = digests.flatMap((d) => d.emphasis.map((e) => ({ text: e.text, exam: e.exam ?? null, itemId: d.itemId, postedAt: d.postedAt ?? null }))).slice(0, 60);
  await StudyClassPolicy.updateOne({ userId, classId }, { $set: { emphasis } }, { upsert: true });
}

export const digestDto = (d: IStudyAnnouncementDigest) => ({
  itemId: String(d.itemId),
  title: d.title,
  postedAt: d.postedAt ? new Date(d.postedAt).toISOString() : null,
  summary: d.summary,
  actions: (d.actions ?? []).map((a) => ({ text: a.text, dueAt: a.dueAt ? new Date(a.dueAt).toISOString() : null })),
  importance: d.importance,
  tags: d.tags ?? [],
  deadlineChanges: (d.deadlineChanges ?? []).map((c) => ({
    itemTitle: c.itemTitle,
    newDueAt: c.newDueAt ? new Date(c.newDueAt).toISOString() : null,
    matchedItemId: c.matchedItemId ? String(c.matchedItemId) : null,
    confidence: c.confidence,
    outcome: c.outcome,
  })),
});
