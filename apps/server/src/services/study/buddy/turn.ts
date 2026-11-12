import sharp from "sharp";
import { Types } from "mongoose";
import { StudyBuddyExpert, StudyBuddyTurn, type BuddyTraceStep } from "@/models/study/buddy";
import { StudyClass } from "@/models/study/class";
import { logger } from "@/services/logger.service";
import { spendTotal, textJson, visionCall, parseJsonLoose, type Spend } from "../ai-models";
import { boardActionsFromPage, type BoardInput, type BoardReply } from "../board-actions";
import { classKnowledge } from "../concepts";
import { putStudyObject } from "../storage";
import { BUDDY_EXPERTS, DEFAULT_EXPERT, PICKER_SYSTEM, buildBrief, mergeExperts, pickerTurn, type BuddyExpert } from "./experts";
import { readBuddyMemory, rememberForBuddy } from "./memory";

/**
 * One buddy turn, as a fixed sequence the owner can read and test:
 *   1 pick      which expert answers (the button the student tapped, else a small picker call)
 *   2 memory    what the buddy remembers about the student
 *   3 knowledge the class's weakest topics (only for experts that use them)
 *   4 expert    ONE model call with the page, the expert's job and what 2–3 found
 *   5 remember  what the expert asked to keep
 * Every step lands in `trace` (what ran, which model, how long, what it cost) and the whole turn is
 * saved (`study_buddy_turns`). Nothing else runs: the model cannot call tools of its own.
 */

export const WEAK_TOPICS_MAX = 5;
export const buddyImageKey = (userId: string, turnId: string) => `study/${userId}/buddy/${turnId}.jpg`;

export interface BuddyTurnResult {
  /** The reply for the client (`remember` stripped). */
  reply: Omit<BoardReply, "remember"> & { skill: string; turnId: string; trace: BuddyTraceStep[] };
}

/** Runs `fn`, and returns its value with the models, time and cost it added to the spend. */
async function timed<T>(spend: Spend, fn: () => Promise<T>): Promise<{ value: T; models: string[]; ms: number; costUsd: number }> {
  const t0 = Date.now();
  const cost0 = spendTotal(spend);
  const models0 = spend.models.length;
  const value = await fn();
  return { value, models: spend.models.slice(models0), ms: Date.now() - t0, costUsd: Number((spendTotal(spend) - cost0).toFixed(6)) };
}

/** The picker: a small model reads the request (typed, or the handwritten pad image) and names an expert. */
export async function pickExpert(
  question: string | null,
  ask: Buffer | null,
  spend: Spend,
  signal?: AbortSignal,
  experts: readonly BuddyExpert[] = BUDDY_EXPERTS
): Promise<{ expert: BuddyExpert; heard: string; ok: boolean }> {
  try {
    const out = ask
      ? parseJsonLoose(await visionCall(ask, "image/jpeg", `${PICKER_SYSTEM}\n\n${pickerTurn(null, experts)}`, spend, { signal, json: true, deadlineMs: 20_000, claude: "haiku", maxTokens: 300, reasoning: { effort: "low" } }))
      : await textJson(PICKER_SYSTEM, pickerTurn(question, experts), spend, { signal, maxTokens: 300, disableThinking: true, claude: "haiku", effort: "low" });
    const expert = experts.find((e) => e.id === out?.skill) ?? null;
    const heard = typeof out?.heard === "string" ? out.heard.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (expert) return { expert, heard, ok: true };
  } catch (e) {
    if (signal?.aborted) throw e;
    await logger.error("study buddy picker failed", e as Error, {});
  }
  return { expert: experts.find((e) => e.id === DEFAULT_EXPERT.id) ?? experts[0] ?? DEFAULT_EXPERT, heard: "", ok: false };
}

export async function runBuddyTurn(o: {
  userId: Types.ObjectId;
  image: Buffer;
  mime: string;
  input: BoardInput;
  ask: Buffer | null;
  spend: Spend;
  signal?: AbortSignal;
  /** Evals: do not write the turn, the memory or the page image. */
  dryRun?: boolean;
  /** Evals: memory lines instead of the stored ones. */
  memory?: string[];
}): Promise<BuddyTurnResult | null> {
  const startedAt = Date.now();
  const trace: BuddyTraceStep[] = [];
  const classId = o.input.classId && (o.dryRun || (await StudyClass.exists({ _id: o.input.classId, userId: o.userId }))) ? new Types.ObjectId(o.input.classId) : null;
  const pageId = o.input.pageId ? new Types.ObjectId(o.input.pageId) : null;
  let question = o.ask ? "" : o.input.question;
  let ask = o.ask;

  // 1 pick — among this student's experts: ours, their edits of ours, and their own (switched-off ones left out).
  const all = o.dryRun ? mergeExperts([]) : mergeExperts(await StudyBuddyExpert.find({ userId: o.userId }).lean().catch(() => []));
  const experts = all.filter((e) => e.enabled !== false);
  let expert = experts.find((e) => e.id === o.input.skill) ?? null;
  let pickedBy: "button" | "picker" | "fallback" = "button";
  if (expert) {
    trace.push({ kind: "pick", name: expert.name, models: [], ms: 0, costUsd: 0, detail: "You tapped this one." });
  } else {
    const pick = await timed(o.spend, () => pickExpert(o.ask ? null : o.input.question, o.ask, o.spend, o.signal, experts.length ? experts : all));
    expert = pick.value.expert;
    pickedBy = pick.value.ok ? "picker" : "fallback";
    // A handwritten request that was read once is passed on as text: the expert does not read the pad again.
    if (o.ask && pick.value.heard) {
      question = pick.value.heard;
      ask = null;
    }
    trace.push({
      kind: "pick",
      name: expert.name,
      models: pick.models,
      ms: pick.ms,
      costUsd: pick.costUsd,
      detail: pick.value.ok ? `Chosen for: “${(pick.value.heard || o.input.question).slice(0, 160)}”` : "Could not choose, so the Checker answered.",
    });
  }
  if (o.signal?.aborted) return null;

  // 2 memory, 3 knowledge
  const t1 = Date.now();
  const memory = o.memory ?? (o.dryRun ? [] : await readBuddyMemory(o.userId, classId).catch(() => []));
  trace.push({ kind: "memory", name: "What I remember about you", models: [], ms: Date.now() - t1, costUsd: 0, detail: memory.length ? memory.join(" · ") : "Nothing yet." });
  let weakTopics: string[] = [];
  if (expert.weakTopics && classId && !o.dryRun) {
    const t2 = Date.now();
    try {
      const knowledge = await classKnowledge(o.userId, classId);
      weakTopics = knowledge.concepts
        .filter((c) => c.strength !== null && c.attempts > 0)
        .sort((a, b) => (a.strength ?? 1) - (b.strength ?? 1))
        .slice(0, WEAK_TOPICS_MAX)
        .map((c) => `${c.label} (${Math.round((c.strength ?? 0) * 100)}%)`);
    } catch (e) {
      await logger.error("study buddy knowledge read failed", e as Error, {});
    }
    trace.push({ kind: "knowledge", name: "Your weakest topics in this class", models: [], ms: Date.now() - t2, costUsd: 0, detail: weakTopics.length ? weakTopics.join(" · ") : "No results yet for this class." });
  }

  // 4 expert
  const input: BoardInput = { ...o.input, question: question || o.input.question };
  const brief = buildBrief(expert, { memory, weakTopics });
  const turnId = new Types.ObjectId();
  const save = async (status: "done" | "error", reply: BoardReply | null, error: string | null) => {
    if (o.dryRun) return;
    let imageKey: string | null = null;
    try {
      const small = await sharp(o.image).resize(1100, 1100, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 68 }).toBuffer();
      imageKey = buddyImageKey(String(o.userId), String(turnId));
      await putStudyObject(imageKey, small, "image/jpeg");
    } catch {
      imageKey = null;
    }
    try {
      await StudyBuddyTurn.create({
        _id: turnId,
        userId: o.userId,
        classId,
        pageId,
        question: (reply?.heard || input.question).slice(0, 2000),
        handwritten: Boolean(o.ask),
        skill: expert!.id,
        pickedBy,
        route: o.spend.route,
        status,
        error,
        trace,
        reply: reply
          ? {
              ...(reply.say ? { say: reply.say } : {}),
              ...(reply.verdict ? { verdict: reply.verdict } : {}),
              ...(reply.steps ? { steps: reply.steps } : {}),
              ...(reply.quiz ? { quiz: reply.quiz } : {}),
              ...(reply.similar ? { similar: reply.similar } : {}),
              marks: reply.actions.length,
            }
          : null,
        imageKey,
        models: o.spend.models,
        costUsd: Number(spendTotal(o.spend).toFixed(6)),
        latencyMs: Date.now() - startedAt,
      });
    } catch (e) {
      await logger.error("study buddy turn write failed", e as Error, {});
    }
  };

  let answered: Awaited<ReturnType<typeof timed<Awaited<ReturnType<typeof boardActionsFromPage>>>>>;
  try {
    answered = await timed(o.spend, () => boardActionsFromPage({ image: o.image, mime: o.mime, input, spend: o.spend, signal: o.signal, ask, brief }));
  } catch (e) {
    if (!o.signal?.aborted) {
      trace.push({ kind: "expert", name: expert.name, models: [], ms: Date.now() - startedAt, costUsd: 0, detail: `Failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
      await save("error", null, String((e as Error)?.message ?? e).slice(0, 500));
    }
    throw e;
  }
  if (o.signal?.aborted) return null;
  const r = answered.value;
  if (!r) {
    trace.push({ kind: "expert", name: expert.name, models: answered.models, ms: answered.ms, costUsd: answered.costUsd, detail: "The answer could not be read, twice." });
    await save("error", null, "reply was not valid JSON twice");
    return null;
  }
  const { remember, ...reply } = r.reply;
  // An expert hands back only its own part: a hint never carries steps, a quick check never a verdict.
  if (expert.gives !== "steps") delete reply.steps;
  if (expert.gives !== "quiz") delete reply.quiz;
  if (expert.gives !== "similar") delete reply.similar;
  if (expert.id === "hint" || expert.id === "quiz" || expert.id === "similar") delete reply.verdict;
  const gave = [
    reply.actions.length ? `${reply.actions.length} mark${reply.actions.length === 1 ? "" : "s"} on the page` : "",
    reply.verdict ? `verdict: ${reply.verdict}` : "",
    reply.steps ? `${reply.steps.length} steps` : "",
    reply.quiz ? "a quick check" : "",
    reply.similar ? "a practice question" : "",
  ].filter(Boolean);
  trace.push({
    kind: "expert",
    name: expert.name,
    models: answered.models,
    ms: answered.ms,
    costUsd: answered.costUsd,
    detail: `${gave.length ? gave.join(", ") : "A spoken answer only"}${r.attempts > 1 ? " (second try)" : ""}.`,
  });

  // 5 remember
  if (remember?.length && !o.dryRun) {
    const kept = await rememberForBuddy(o.userId, classId, remember.slice(0, 1), expert.id).catch(() => []);
    if (kept.length) trace.push({ kind: "remember", name: "Saved to memory", models: [], ms: 0, costUsd: 0, detail: kept.join(" · ") });
  } else if (remember?.length) {
    trace.push({ kind: "remember", name: "Saved to memory", models: [], ms: 0, costUsd: 0, detail: remember.slice(0, 1).join(" · ") });
  }

  await save("done", { ...reply, heard: reply.heard || (o.ask ? question : "") || undefined } as BoardReply, null);
  const heard = reply.heard || (o.ask && question ? question : "");
  return { reply: { ...reply, ...(heard ? { heard } : {}), skill: expert.id, turnId: String(turnId), trace } };
}

export { BUDDY_EXPERTS };
