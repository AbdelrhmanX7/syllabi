import { createHash } from "crypto";
import sharp from "sharp";
import { Types } from "mongoose";
import { StudyCanvasImage, IStudyCanvasImage } from "@/models/study/canvas-image";
import { logger } from "@/services/logger.service";
import { CanvasApiError, CanvasClient, createLimiter } from "./canvas-client";
import { InboxMediaError, processUpload } from "./inbox/media";
import { getStudyObject, putStudyObject } from "./storage";

/**
 * Images embedded in synced Canvas HTML. Canvas pages carry figures as
 * `<img src="https://<canvas>/courses/:c/files/:id/preview?verifier=…">`; that url needs the
 * owner's session/token, so Claude cannot open it. Sync downloads each distinct Canvas file id
 * ONCE (CanvasClient.download — the token only ever goes to the Canvas origin, redirects to
 * canvas-user-content / inst-fs carry none), normalises it through the inbox media pipeline
 * (re-encode, metadata stripped, ≤ 3000 px) and caches it per owner in `study_canvas_images`.
 * Only Canvas-origin `/files/:id` images are fetched — any other host is reported, never fetched.
 */

export const CANVAS_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
/** New downloads per sync run; the rest wait for the next sync. */
export const CANVAS_IMAGES_PER_SYNC = 150;
/** Ref accepted by the PDF renderers: `canvas-image:<canvasFileId>`. */
export const CANVAS_IMAGE_REF = /^canvas-image:(\d{1,15})$/;

export interface EmbeddedImage {
  /** 1-based position among the item's <img> tags. */
  index: number;
  /** Canvas file id when the src is a Canvas-origin /files/:id url, else null (not fetched). */
  fileId: number | null;
  src: string;
  alt: string | null;
}

const IMG_TAG = /<img\b[^>]*>/gi;
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? "") : null;
};
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** A Canvas-origin `/files/:id` url → the id; anything else → null. `origin` = the Canvas origin. */
export function canvasFileId(src: string, origin: string | null): number | null {
  let url: URL;
  try {
    url = new URL(decode(src), origin ?? undefined);
  } catch {
    return null;
  }
  if (!origin || url.protocol !== "https:" || url.origin !== new URL(origin).origin) return null;
  const m = /\/files\/(\d{1,15})(?:\/|$)/.exec(url.pathname);
  return m ? Number(m[1]) : null;
}

/** Every <img> in document order. */
export function extractImages(html: string | null | undefined, origin: string | null): EmbeddedImage[] {
  const out: EmbeddedImage[] = [];
  for (const m of String(html ?? "").matchAll(IMG_TAG)) {
    const src = attr(m[0], "src") ?? "";
    const alt = attr(m[0], "alt") ?? attr(m[0], "title");
    out.push({ index: out.length + 1, fileId: src ? canvasFileId(src, origin) : null, src: decode(src), alt: alt ? decode(alt).trim() || null : null });
  }
  return out;
}

/** Each <img> → a text marker «⟦image N: alt⟧» so plain text keeps WHERE every figure sits. */
export function withImageMarkers(html: string): string {
  let n = 0;
  return html.replace(IMG_TAG, (tag) => {
    n += 1;
    const alt = attr(tag, "alt") ?? attr(tag, "title");
    const label = alt ? decode(alt).replace(/[<>]/g, "").trim() : "";
    return ` ⟦image ${n}${label ? `: ${label}` : ""}⟧ `;
  });
}

// Prod runs with autoIndex off; this collection is new and tiny, so build its unique index once per process.
let indexes: Promise<unknown> | null = null;
const ensureIndexes = () => (indexes ??= StudyCanvasImage.createIndexes().catch((e) => {
  indexes = null;
  return logger.warn("study canvas image index build failed", { error: String((e as Error)?.message ?? e) });
}));

export const canvasImageKey = (userId: string, fileId: number, ext: string) => `study/${userId}/canvas-images/${fileId}.${ext}`;

export type ImageSyncResult = { stored: number; skipped: number; failed: number; deferred: number };

/**
 * Downloads every not-yet-cached Canvas image referenced by `htmls`. Idempotent: ids that already
 * have a row (stored OR permanently skipped) cost nothing; a transient failure (network, throttle,
 * 5xx) leaves no row so the next sync retries. Never throws — a sync must not fail over a figure.
 */
export async function syncEmbeddedImages(
  userId: Types.ObjectId,
  client: CanvasClient,
  htmls: string[],
  budget: { left: number }
): Promise<ImageSyncResult> {
  const result: ImageSyncResult = { stored: 0, skipped: 0, failed: 0, deferred: 0 };
  const srcById = new Map<number, string>();
  for (const html of htmls) for (const im of extractImages(html, client.origin)) if (im.fileId !== null && !srcById.has(im.fileId)) srcById.set(im.fileId, im.src);
  if (!srcById.size) return result;
  await ensureIndexes();
  const known = new Set((await StudyCanvasImage.find({ userId, canvasFileId: { $in: [...srcById.keys()] } }, { canvasFileId: 1 }).lean()).map((r) => r.canvasFileId));
  const todo = [...srcById].filter(([id]) => !known.has(id));
  const now = todo.slice(0, Math.max(0, budget.left));
  result.deferred = todo.length - now.length;
  budget.left -= now.length;

  const limit = createLimiter(2);
  const skip = async (fileId: number, reason: string) => {
    await StudyCanvasImage.updateOne({ userId, canvasFileId: fileId }, { $setOnInsert: { status: "skipped", reason, bytes: 0 } }, { upsert: true });
    result.skipped++;
  };
  await Promise.all(
    now.map(([fileId, src]) =>
      limit(async () => {
        let buf: Buffer;
        try {
          buf = await client.download(src, CANVAS_IMAGE_MAX_BYTES);
        } catch (e) {
          if (e instanceof CanvasApiError && e.code === "FILE_TOO_LARGE") return skip(fileId, "too_large");
          if (e instanceof CanvasApiError && (e.status === 404 || e.status === 410)) return skip(fileId, `gone_${e.status}`);
          result.failed++;
          return;
        }
        try {
          // The inbox pipeline takes JPEG/PNG/WebP/HEIC only; a GIF figure is flattened to a PNG (first frame).
          if (buf.length > 6 && buf.toString("latin1", 0, 4) === "GIF8") buf = await sharp(buf, { animated: false, limitInputPixels: 100_000_000 }).png().toBuffer();
          const media = await processUpload(buf);
          if (media.kind !== "image") return skip(fileId, "not_an_image");
          const key = canvasImageKey(String(userId), fileId, media.ext);
          await putStudyObject(key, media.body, media.contentType);
          await StudyCanvasImage.updateOne(
            { userId, canvasFileId: fileId },
            {
              $set: {
                status: "stored",
                reason: null,
                storageKey: key,
                contentType: media.contentType,
                bytes: media.body.length,
                width: media.width,
                height: media.height,
                sha256: createHash("sha256").update(media.body).digest("hex"),
              },
            },
            { upsert: true }
          );
          result.stored++;
        } catch (e) {
          if (e instanceof InboxMediaError) return skip(fileId, `unsupported: ${e.code}`);
          result.failed++;
          await logger.warn("study canvas image store failed", { userId: String(userId), fileId, error: String((e as Error)?.message ?? e).slice(0, 200) });
        }
      })
    )
  );
  return result;
}

/** The owner's cached image, or null (unknown id, skipped, another owner's). */
export async function storedCanvasImage(userId: Types.ObjectId, fileId: number): Promise<IStudyCanvasImage | null> {
  return StudyCanvasImage.findOne({ userId, canvasFileId: fileId, status: "stored" }).lean<IStudyCanvasImage>();
}

/** A cached image re-encoded for an MCP image block (JPEG, long edge ≤ maxEdge). */
export async function canvasImageJpeg(row: IStudyCanvasImage, maxEdge: number, quality = 80): Promise<{ data: Buffer; width: number; height: number }> {
  const src = await getStudyObject(row.storageKey!);
  const { data, info } = await sharp(src)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
