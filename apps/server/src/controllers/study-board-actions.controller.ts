import { RequestHandler } from "express";
import multer from "multer";
import sharp from "sharp";
import { newSpend, spendFor } from "@/services/study/ai-models";
import { classifyAiError, logAiFailure } from "@/services/study/ai-errors";
import { boardActionsFromPage, parseBoardInput } from "@/services/study/board-actions";
import { isPngOrJpeg } from "@/services/study/concept-map-from-terms";
import { writeUsage } from "./study-concept-maps.controller";
import { fail, uid, wrap } from "./study.controller";

/** Board actions: the tutor marks up the owner's visible page. See services/study/board-actions. */

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Longest side the vision model sees; a larger page is scaled down, never rejected. */
const IMAGE_MAX_PX = 1600;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_BYTES, files: 1, fields: 1, fieldSize: 64 * 1024, parts: 3 },
});
const single = upload.single("image") as unknown as RequestHandler;

/** multer for `image` + `json`, with its errors shaped like the rest of /study (all 400). */
export const boardActionsMultipart: RequestHandler = (req, res, next) => {
  if (!req.is("multipart/form-data")) return fail(res, 400, "VALIDATION_ERROR", "Send multipart/form-data with an `image` file and a `json` field");
  single(req, res, (err?: any) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") return fail(res, 400, "VALIDATION_ERROR", "image exceeds the 8 MB limit");
      return fail(res, 400, "VALIDATION_ERROR", "Send one `image` file and one `json` field");
    }
    return fail(res, 400, "VALIDATION_ERROR", "Malformed multipart body");
  });
};

/**
 * `POST /study/ai/board-actions` multipart {image: JPEG/PNG of the visible page, json: {question,
 * clusters:[{id, box:{x,y,w,h}}]}} → 200 `{actions, say?}` (sanitized, ≤12,
 * normalised 0..1). 400 {message, code} on bad input, 429 AI_QUOTA when the provider is out of
 * credit, 502 AI_EMPTY when both replies were unusable. One `study_ai_usages` row per call.
 */
export const boardActions = wrap(async (req, res) => {
  const parsed = parseBoardInput(req.body?.json);
  if ("error" in parsed) return fail(res, 400, "VALIDATION_ERROR", parsed.error);
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file?.buffer?.length || !isPngOrJpeg(file.buffer)) return fail(res, 400, "VALIDATION_ERROR", "image must be a JPEG or PNG file");
  let image: Buffer = file.buffer;
  let mime = image[0] === 0xff ? "image/jpeg" : "image/png";
  try {
    const meta = await sharp(image).metadata();
    if (!meta.width || !meta.height) throw new Error("no size");
    if (Math.max(meta.width, meta.height) > IMAGE_MAX_PX) {
      image = await sharp(image).rotate().resize(IMAGE_MAX_PX, IMAGE_MAX_PX, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
      mime = "image/jpeg";
    }
  } catch {
    return fail(res, 400, "BAD_IMAGE", "image could not be decoded");
  }

  const userId = uid(req);
  const startedAt = Date.now();
  const spend = await spendFor(req);
  const ctrl = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ctrl.abort();
  });
  let r: Awaited<ReturnType<typeof boardActionsFromPage>>;
  try {
    r = await boardActionsFromPage({ image, mime, input: parsed.input, spend, signal: ctrl.signal });
  } catch (e) {
    const c = classifyAiError(e);
    if (!ctrl.signal.aborted) await logAiFailure("study board_actions failed", e, {}, c.code);
    await writeUsage(userId, "board_actions", spend, startedAt, ctrl.signal.aborted ? "stopped" : "error", String((e as Error)?.message ?? e), c.code);
    if (res.headersSent || ctrl.signal.aborted) return;
    return fail(res, c.code === "AI_QUOTA" ? 429 : 502, c.code, c.message);
  }
  if (ctrl.signal.aborted) {
    await writeUsage(userId, "board_actions", spend, startedAt, "stopped");
    return;
  }
  if (!r) {
    await writeUsage(userId, "board_actions", spend, startedAt, "error", "reply was not valid JSON twice", "AI_EMPTY");
    return fail(res, 502, "AI_EMPTY", "Couldn't mark up the page this time — try again");
  }
  await writeUsage(userId, "board_actions", spend, startedAt, "done");
  res.json(r.reply);
});
