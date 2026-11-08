import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { IStudyClass } from "@/models/study/class";
import { IStudyConceptMap, StudyConceptMap } from "@/models/study/concept-map";
import { IStudyItem, StudyItem } from "@/models/study/item";
import { logger } from "@/services/logger.service";
import { CanvasApiError, CanvasClient } from "./canvas-client";
import { linkCanvasConceptMaps } from "./concept-maps";
import { fillPromptTerms } from "./concept-map-terms";
import { rasterisePdfRange } from "./extract-sources";
import { INBOX_MAX_BYTES, processImage, sniffType } from "./inbox/media";
import { putStudyObject } from "./storage";

/**
 * Canvas sync step for concept maps. The assignment list only carries the submission's state and
 * score, so after the lazy link (score via resolveScore) this pulls each linked map's own
 * submission — with its comments — in ONE call per course, and fills:
 *  - instructor: the professor's comments; a long one (≥ MODEL_ANSWER_MIN_CHARS) is her model
 *    answer, short ones are the comment. Only empty fields are filled — the folder import wins.
 *  - submission.imageKey: the uploaded photo copied into study storage (same key shape as the
 *    folder import), once per Canvas attachment id. HEIC is decoded, a PDF keeps page 1; anything
 *    else is marked and skipped. A map that already has an image from the import keeps it.
 *  - promptTerms: fillPromptTerms, which reads them from the model answer when Canvas has none.
 * Never fails the sync: errors are logged per map.
 */

type Json = Record<string, any>;

export const MODEL_ANSWER_MIN_CHARS = 200;

/** The professor's submission comments → { comment, modelAnswer } (null fields = none). */
export function instructorFromSubmission(sub: Json | null | undefined): { comment: string | null; modelAnswer: string | null } {
  const student = sub?.user_id != null ? String(sub.user_id) : null;
  const texts = (Array.isArray(sub?.submission_comments) ? sub!.submission_comments : [])
    .filter((c: Json) => typeof c?.comment === "string" && c.comment.trim() && (student === null || String(c.author_id) !== student))
    .sort((a: Json, b: Json) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
    .map((c: Json) => String(c.comment).trim());
  const long = texts.filter((t: string) => t.length >= MODEL_ANSWER_MIN_CHARS);
  const short = texts.filter((t: string) => t.length < MODEL_ANSWER_MIN_CHARS);
  return { comment: short.join("\n") || null, modelAnswer: long.join("\n\n") || null };
}

const STORABLE = /^(image\/|application\/pdf)|\.(jpe?g|png|webp|heic|heif|pdf)$/i;

/** The first uploaded attachment that can be a concept-map image (image or PDF). */
export function submissionImageAttachment(sub: Json | null | undefined): Json | null {
  const atts: Json[] = Array.isArray(sub?.attachments) ? sub!.attachments : [];
  return atts.find((a) => a?.id != null && a?.url && (STORABLE.test(String(a["content-type"] ?? "")) || STORABLE.test(String(a.filename ?? a.display_name ?? "")))) ?? null;
}

/** Attachment bytes → a stored image ({ body, ext, contentType }); null = not an image/PDF we can read. */
async function toStoredImage(buf: Buffer): Promise<{ body: Buffer; ext: string; contentType: string } | null> {
  const type = sniffType(buf);
  if (!type) return null;
  if (type === "pdf") {
    const [page] = await rasterisePdfRange(buf, { first: 1, last: 1 });
    return page ? { body: page.png, ext: "png", contentType: "image/png" } : null;
  }
  const img = await processImage(buf, type);
  return { body: img.body, ext: img.ext, contentType: img.contentType };
}

export async function syncConceptMapSubmissions(client: CanvasClient, userId: Types.ObjectId, cls: IStudyClass): Promise<void> {
  await linkCanvasConceptMaps(userId, cls);
  const maps = await StudyConceptMap.find({ userId, canvasCourseId: cls.canvasCourseId, source: { $ne: "practice" }, canvasItemId: { $ne: null } }).lean<IStudyConceptMap[]>();
  if (!maps.length) return;
  const items = await StudyItem.find({ userId, _id: { $in: maps.map((m) => m.canvasItemId) } }, { canvasId: 1, canvasType: 1 }).lean<IStudyItem[]>();
  const assignmentOf = new Map(items.filter((i) => i.canvasType === "Assignment").map((i) => [String(i._id), i.canvasId]));
  const ids = [...new Set(maps.map((m) => assignmentOf.get(String(m.canvasItemId))).filter((x): x is string => !!x))];
  if (!ids.length) return;
  const subs = await client.getAll<Json>(
    `/api/v1/courses/${cls.canvasCourseId}/students/submissions?student_ids[]=self&${ids.map((id) => `assignment_ids[]=${encodeURIComponent(id)}`).join("&")}&include[]=submission_comments&include[]=rubric_assessment&per_page=100`
  );
  const subOf = new Map(subs.map((s) => [String(s.assignment_id), s]));
  for (const m of maps) {
    const sub = subOf.get(assignmentOf.get(String(m.canvasItemId)) ?? "");
    try {
      if (sub) await applySubmission(client, userId, m, sub);
      await fillPromptTerms(userId, (await StudyConceptMap.findById(m._id).lean<IStudyConceptMap>()) ?? m);
    } catch (e) {
      if (e instanceof CanvasApiError && e.status === 401) throw e;
      await logger.warn("study concept-map canvas submission failed", { mapId: String(m._id), error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
}

async function applySubmission(client: CanvasClient, userId: Types.ObjectId, m: IStudyConceptMap, sub: Json) {
  const set: Record<string, unknown> = {};
  const got = instructorFromSubmission(sub);
  const cur = { comment: m.instructor?.comment ?? null, modelAnswer: m.instructor?.modelAnswer ?? null };
  const next = { comment: cur.comment ?? got.comment, modelAnswer: cur.modelAnswer ?? got.modelAnswer };
  if (next.comment !== cur.comment || next.modelAnswer !== cur.modelAnswer) set.instructor = next;

  const att = submissionImageAttachment(sub);
  const attId = att ? String(att.id) : null;
  const had = m.submission ?? null;
  // Already handled (same attachment, even one that could not be read), or the import's own photo — never re-download.
  const keep = !att || had?.canvasAttachmentId === attId || (!!had?.imageKey && !had.canvasAttachmentId);
  if (!keep) {
    const size = typeof att!.size === "number" ? att!.size : null;
    // A download error throws (retried next sync); bytes that are not an image/PDF are marked and left.
    const img = size !== null && size > INBOX_MAX_BYTES ? null : await toStoredImage(await client.download(String(att!.url), INBOX_MAX_BYTES)).catch(() => null);
    let imageKey = had?.imageKey ?? null;
    if (img) {
      imageKey = `study/${userId}/library/${randomUUID()}.${img.ext}`;
      await putStudyObject(imageKey, img.body, img.contentType);
    }
    set.submission = { imageKey, transcription: had?.transcription ?? null, canvasAttachmentId: attId };
  }
  if (Object.keys(set).length) await StudyConceptMap.updateOne({ _id: m._id, userId }, { $set: set });
}
