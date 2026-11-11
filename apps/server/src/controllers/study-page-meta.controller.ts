import sharp from "sharp";
import { StudyClass } from "@/models/study/class";
import { StudyItem } from "@/models/study/item";
import { IStudyPage, IStudyPageCover, StudyPage } from "@/models/study/page";
import { denyUnlessAi, premiumAiFor } from "@/auth/verified";
import { imageGen, newSpend, spendFor, spendForUser, textJson, visionCall } from "@/services/study/ai-models";
import { classifyAiError, logAiFailure } from "@/services/study/ai-errors";
import { recordStudyUsage } from "@/services/study/usage";
import { renderJpeg } from "@/services/study/notebook-renders";
import { deleteStudyObject, putStudyObject } from "@/services/study/storage";
import {
  coverImagePrompt,
  DescribeReply,
  DESCRIBE_SYSTEM,
  describeIsFresh,
  describeUserTurn,
  effectiveEdited,
  META_FIELDS,
  pageCoverKey,
  planMetaWrite,
  RENDERS_FOR_VISION,
  sanitizeDescribeReply,
} from "@/services/study/page-meta";
import { PAGE_PROJECTION, pageDtoWithCover } from "./study-pages.controller";
import { fail, isOid, uid, wrap } from "./study.controller";

/**
 * `POST /study/pages/:id/describe {force?, only?: "cover", fileName?}` → `{...Page, coverPending}`.
 *
 * AI names and describes a notebook from its latest page renders (what the device uploaded after a
 * sync), its handwriting text, the PDF file name and the class name. It writes ONLY the fields the
 * owner has not edited (services/study/page-meta.ts planMetaWrite). Without `force`, a notebook whose
 * content did not move since the last describe is answered as it is (no AI call).
 *
 * The cover: premium accounts get a generated picture, made in the background (20–60 s) so the
 * request returns the text fields at once (`coverPending: true`; the app refetches the list later).
 * Everyone else, and any picture failure, gets a brand colour + icon. A cover the owner picked or
 * removed is left alone. `only: "cover"` (Make a new cover) skips the text fields.
 */

const RENDER_EDGE = 1024;
const DESCRIBE_TIMEOUT_MS = 60_000;
const COVER_PX = 512;

/** Covers being made right now (one per notebook at a time). */
const coverJobs = new Set<string>();

const colorCover = (r: DescribeReply): IStudyPageCover => ({ kind: "color", color: r.color, icon: r.icon, key: null, by: "ai", updatedAt: new Date() });

export const describePage = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid page id");
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const force = body.force === true;
  const only = body.only === "cover" ? ("cover" as const) : undefined;
  const fileName = typeof body.fileName === "string" ? body.fileName.trim().slice(0, 200) || null : null;
  const userId = uid(req);
  const page = await StudyPage.findOne({ _id: req.params.id, userId, deletedAt: null }, { annotations: 0, versionLog: 0 }).lean<IStudyPage>();
  if (!page) return fail(res, 404, "NOT_FOUND", "Page not found");

  if (describeIsFresh(page, force || !!only)) return res.json({ ...(await pageDtoWithCover(page)), coverPending: coverJobs.has(String(page._id)) });
  if (await denyUnlessAi(req, res)) return;
  // "Make a new cover" is the owner asking: the cover is AI's again (even after "Remove cover").
  if (only === "cover" && page.metaEdited?.cover !== false) {
    await StudyPage.updateOne({ _id: page._id, userId }, { $set: { "metaEdited.cover": false } }, { timestamps: false });
    page.metaEdited = { ...(page.metaEdited ?? {}), cover: false };
  }

  const [cls, item] = await Promise.all([
    page.classId ? StudyClass.findOne({ _id: page.classId, userId }, { name: 1 }).lean<{ name?: string }>() : null,
    page.itemId ? StudyItem.findOne({ _id: page.itemId, userId }, { title: 1 }).lean<{ title?: string }>() : null,
  ]);
  const renders = [...(page.renders ?? [])].sort((a, b) => a.index - b.index).slice(0, RENDERS_FOR_VISION);
  const turn = describeUserTurn({
    title: page.title,
    className: cls?.name ?? null,
    fileName: fileName ?? item?.title ?? null,
    text: page.ocrText,
    pageCount: renders.length,
  });

  // The app's quiet automatic run is background work (not counted against the daily limit); Redo,
  // Make a new cover and Let AI pick are the owner asking, so they count.
  const spend = force || only ? await spendFor(req) : await spendForUser(userId, { background: true });
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DESCRIBE_TIMEOUT_MS);
  let reply: DescribeReply;
  try {
    let raw: unknown = null;
    const images: Buffer[] = [];
    for (const r of renders) {
      const jpg = await renderJpeg(r, RENDER_EDGE, 70).catch(() => null);
      if (jpg) images.push(jpg.data);
    }
    if (images.length) {
      const text = await visionCall(images, "image/jpeg", `${DESCRIBE_SYSTEM}\n\n${turn}`, spend, {
        json: true,
        signal: ctrl.signal,
        timeoutMs: DESCRIBE_TIMEOUT_MS,
        reasoning: { effort: "low" },
        claude: "haiku",
        maxTokens: 800,
      });
      raw = parseLoose(text);
    } else {
      raw = await textJson(DESCRIBE_SYSTEM, turn, spend, { signal: ctrl.signal, maxTokens: 800, disableThinking: true });
    }
    if (!raw || typeof raw !== "object") throw Object.assign(new Error("describe reply was not JSON"), { code: "AI_EMPTY" });
    reply = sanitizeDescribeReply(raw);
  } catch (e) {
    clearTimeout(timer);
    const empty = (e as { code?: string })?.code === "AI_EMPTY";
    const c = empty ? { code: "AI_EMPTY", message: "Couldn't describe this notebook this time — try again" } : classifyAiError(e);
    await recordStudyUsage(userId, "page_describe", spend, startedAt, "error", { error: String((e as Error)?.message ?? e), errorCode: c.code });
    if (!empty) await logAiFailure("study page describe failed", e, { pageId: String(page._id) }, c.code);
    return fail(res, c.code === "AI_QUOTA" ? 429 : 502, c.code, c.message);
  }
  clearTimeout(timer);
  await recordStudyUsage(userId, "page_describe", spend, startedAt, "done");

  // Re-read the flags right before writing: the owner may have edited a field while AI was thinking.
  const fresh = await StudyPage.findOne({ _id: page._id, userId, deletedAt: null }, PAGE_PROJECTION).lean<IStudyPage>();
  if (!fresh) return fail(res, 404, "NOT_FOUND", "Page not found");
  const plan = planMetaWrite(fresh, reply, { only });
  const premium = plan.cover ? await premiumAiFor(userId) : false;
  const set: Record<string, unknown> = { ...plan.set, metaAiAt: new Date() };
  // Pin every flag: once AI wrote a title, the "typed by the owner?" guess from the data must not apply.
  const edited = effectiveEdited(fresh);
  for (const f of META_FIELDS) set[`metaEdited.${f}`] = edited[f];
  if (!only) set.metaAiVersion = page.version ?? 0;
  // Premium: a new picture when there is none yet, or when asked (Redo / Make a new cover); a colour
  // cover meanwhile so the row is never blank. Everyone else: the colour + icon AI picked.
  const hasImage = fresh.cover?.kind === "image";
  const wantImage = plan.cover && premium && (force || !!only || !hasImage);
  if (plan.cover && (!premium || !hasImage)) set.cover = colorCover(reply);
  // Guard on every flag AI is writing around (a PATCH between the read and this update wins).
  const guard: Record<string, unknown> = { _id: page._id, userId, deletedAt: null };
  for (const f of META_FIELDS) if (!edited[f]) guard[`metaEdited.${f}`] = { $ne: true };
  let updated = await StudyPage.findOneAndUpdate(guard, { $set: set }, { new: true, projection: PAGE_PROJECTION, timestamps: false }).lean<IStudyPage>();
  // Lost the race on a flag: write just the bookkeeping, keep the owner's edit.
  updated ??= await StudyPage.findOneAndUpdate(
    { _id: page._id, userId, deletedAt: null },
    { $set: { metaAiAt: set.metaAiAt, ...(set.metaAiVersion !== undefined ? { metaAiVersion: set.metaAiVersion } : {}) } },
    { new: true, projection: PAGE_PROJECTION, timestamps: false }
  ).lean<IStudyPage>();
  if (!updated) return fail(res, 404, "NOT_FOUND", "Page not found");

  let coverPending = coverJobs.has(String(page._id));
  if (wantImage && !coverPending) {
    coverPending = true;
    void makeCoverImage(updated, reply).catch(() => undefined);
  }
  res.json({ ...(await pageDtoWithCover(updated)), coverPending });
});

/** Background: generate, shrink to 512² webp, store, point the page at it. Failure → colour cover. */
async function makeCoverImage(page: IStudyPage, reply: DescribeReply): Promise<void> {
  const id = String(page._id);
  coverJobs.add(id);
  const userId = page.userId;
  const spend = newSpend("premium", userId);
  const startedAt = Date.now();
  const previousKey = page.cover?.kind === "image" ? page.cover.key : null;
  try {
    const { image } = await imageGen(coverImagePrompt(reply), "square", spend);
    await recordStudyUsage(userId, "page_cover", spend, startedAt, "done");
    const webp = await sharp(image).resize(COVER_PX, COVER_PX, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
    const key = pageCoverKey(String(userId), id, Date.now().toString(36));
    await putStudyObject(key, webp, "image/webp");
    const cover: IStudyPageCover = { kind: "image", key, color: reply.color, icon: reply.icon, by: "ai", updatedAt: new Date() };
    const done = await StudyPage.updateOne({ _id: page._id, userId, deletedAt: null, "metaEdited.cover": { $ne: true } }, { $set: { cover } }, { timestamps: false });
    if (!done.modifiedCount) await deleteStudyObject(key).catch(() => undefined);
    else if (previousKey && previousKey !== key) await deleteStudyObject(previousKey).catch(() => undefined);
  } catch (e) {
    const c = classifyAiError(e, { code: "AI_FAILED", message: "The cover could not be made" });
    await recordStudyUsage(userId, "page_cover", spend, startedAt, "error", { error: String((e as Error)?.message ?? e), errorCode: c.code });
    await logAiFailure("study page cover failed", e, { pageId: id }, c.code);
    if (!previousKey)
      await StudyPage.updateOne(
        { _id: page._id, userId, deletedAt: null, "metaEdited.cover": { $ne: true } },
        { $set: { cover: colorCover(reply) } },
        { timestamps: false }
      ).catch(() => undefined);
  } finally {
    coverJobs.delete(id);
  }
}

function parseLoose(raw: string): unknown {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}
