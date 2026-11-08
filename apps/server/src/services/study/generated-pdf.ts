import { createHash, randomUUID } from "crypto";
import { Types } from "mongoose";
import { IStudyClass } from "@/models/study/class";
import { StudyItem } from "@/models/study/item";
import { StudyPage } from "@/models/study/page";
import { createPage } from "@/controllers/study-pages.controller";
import { DECK_MAX_IMAGE_BYTES, DECK_MAX_IMAGES, DeckInputError, escapeHtml, inboxImageDataUri, markdownToHtml, pdfPageCount, renderHtmlPdf } from "./lecture-pdf";
import { resolveLectureScope } from "./lecture-material";
import { invokeController, Invoked } from "./mcp-invoke";
import { deleteStudyObject, putStudyObject, signedGetUrl, studyFileKey } from "./storage";

/**
 * Generated PDFs that become notebook pages: the `create_lecture_pdf` deck, `render_pdf_to_inbox`
 * documents, and inbox PDFs moved to a page (`POST /study/inbox/:id/to-page`). One helper files
 * the bytes as a Canvas-file-shaped item + a `pdf` page, all-or-nothing.
 */

export const DOC_PAGE_SIZES = {
  A4: { widthIn: 8.27, heightIn: 11.69 },
  Letter: { widthIn: 8.5, heightIn: 11 },
  "16:9": { widthIn: 13.333, heightIn: 7.5 },
  "4:3": { widthIn: 10, heightIn: 7.5 },
} as const;
export type DocPageSize = keyof typeof DOC_PAGE_SIZES;

/** The print stylesheet for rendered documents. */
const docCss = (page: DocPageSize) => `
@page { size: ${DOC_PAGE_SIZES[page].widthIn}in ${DOC_PAGE_SIZES[page].heightIn}in; margin: 16mm 15mm; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; }
body { font-family: 'Source Sans 3', 'Noto Sans', 'DejaVu Sans', Arial, sans-serif; color: #1f2328; font-size: 12pt; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { font-size: 22pt; margin: 0 0 12pt; line-height: 1.2; }
h3 { font-size: 16pt; margin: 14pt 0 6pt; } h4 { font-size: 13.5pt; margin: 12pt 0 4pt; } h5 { font-size: 12pt; margin: 10pt 0 4pt; }
p, li, h1, h3, h4, h5, blockquote, pre { unicode-bidi: plaintext; text-align: start; }
p { margin: 0 0 8pt; } ul, ol { margin: 0 0 8pt; padding-inline-start: 22pt; }
blockquote { margin: 8pt 0; padding: 6pt 12pt; border-inline-start: 3pt solid #c9a27a; background: #f7f1e8; }
code, pre { font-family: 'DejaVu Sans Mono', Consolas, monospace; font-size: 10.5pt; background: #f4f4f4; border-radius: 3px; }
code { padding: 0 .2em; } pre { padding: 8pt 10pt; white-space: pre-wrap; break-inside: avoid; }
img, svg { max-width: 100%; }
`;

/** Markdown (escaped, same renderer as the deck body; math stays as text) or caller HTML → a print document. */
export function documentHtml(input: { title: string; page: DocPageSize; html?: string; markdown?: string }): string {
  if (input.html !== undefined) {
    // A full document keeps its own head/@page; a fragment gets our shell. Either way the browser
    // loads nothing but data:/about: and runs none of its scripts (renderHtmlPdf scripts:false).
    if (/<html[\s>]/i.test(input.html)) return input.html;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title><style>${docCss(input.page)}</style></head><body>${input.html}</body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title><style>${docCss(input.page)}</style></head><body><h1>${escapeHtml(input.title)}</h1>${markdownToHtml(input.markdown ?? "")}</body></html>`;
}

// inbox:<inboxItemId> (phone uploads, generate_image) or canvas-image:<canvasFileId> (synced Canvas figures).
const INBOX_SRC = /\bsrc\s*=\s*(["'])((?:inbox:[0-9a-f]{24})|(?:canvas-image:\d{1,15}))\1/gi;

/**
 * `src="inbox:<id>"` → the owner's inbox image as a data: URI (inboxImageDataUri checks owner,
 * kind and size). The renderer loads nothing but data:, so an unresolved ref would print as a
 * silent blank — instead any bad ref is a DeckInputError and nothing renders.
 */
export async function inlineInboxImages(userId: Types.ObjectId, html: string): Promise<string> {
  const uses = new Map<string, number>();
  for (const m of html.matchAll(INBOX_SRC)) uses.set(m[2].toLowerCase(), (uses.get(m[2].toLowerCase()) ?? 0) + 1);
  if (!uses.size) return html;
  if (uses.size > DECK_MAX_IMAGES) throw new DeckInputError("TOO_MANY_IMAGES", `At most ${DECK_MAX_IMAGES} inbox images per document`);
  const uris = new Map<string, string>();
  let bytes = 0;
  for (const [id, n] of uses) {
    const uri = await inboxImageDataUri(userId, id.startsWith("inbox:") ? id.slice(6) : id);
    // Same budget as a deck: every inlined occurrence counts; checked as we go so memory stays bounded.
    bytes += n * Math.floor((uri.length - uri.indexOf(",") - 1) * 0.75);
    if (bytes > DECK_MAX_IMAGE_BYTES) throw new DeckInputError("VALIDATION_ERROR", `Images total more than ${DECK_MAX_IMAGE_BYTES / 1048576} MB — use fewer or smaller images`);
    uris.set(id, uri);
  }
  return html.replace(INBOX_SRC, (_m, q: string, id: string) => `src=${q}${uris.get(id.toLowerCase())}${q}`);
}

export async function renderDocumentPdf(input: { title: string; page: DocPageSize; html?: string; markdown?: string }, userId: Types.ObjectId) {
  const html = await inlineInboxImages(userId, documentHtml(input));
  const { pdf } = await renderHtmlPdf(html, DOC_PAGE_SIZES[input.page], { fit: false, scripts: false });
  return { pdf, pages: await pdfPageCount(pdf) };
}

export type GeneratedPdfPageResult =
  | { ok: true; pageId: string; itemId: string; page: any; pdfUrl: string; expiresAt: string }
  | { ok: false; invoked: Invoked };

/**
 * Stores `pdf` under a FRESH `studyFileKey` and opens it as a `pdf` page in `cls`. Everything from
 * the upload on is one unit: a failure (or a refused page) leaves no stored PDF, no file item and
 * no page behind — and the rollback only ever deletes the key it wrote, never a source object.
 */
export async function createGeneratedPdfPage(
  ownerId: string,
  cls: IStudyClass,
  pdf: Buffer,
  opts: {
    title: string;
    week?: number | null;
    lecture?: { number?: number | null; key: string; date: string } | null;
    /** Searchable outline/text for the item; optional. */
    html?: string;
    label: string;
  }
): Promise<GeneratedPdfPageResult> {
  const userId = new Types.ObjectId(ownerId);
  const { title, lecture, week: wk } = opts;
  const scope = lecture || wk ? await resolveLectureScope(userId, cls, { lecture: lecture ?? undefined, week: wk ?? undefined }) : null;
  const storageKey = studyFileKey(ownerId, "pdf");
  let itemId: Types.ObjectId | null = null;
  let pageId: string | null = null;
  const rollback = async () => {
    await Promise.allSettled([
      pageId ? StudyPage.deleteOne({ _id: pageId, userId }) : null,
      itemId ? StudyItem.deleteOne({ _id: itemId, userId }) : null,
      deleteStudyObject(storageKey),
    ]);
  };
  try {
    await putStudyObject(storageKey, pdf, "application/pdf");
    // A Canvas-file-shaped item (canvasId "generated:<uuid>", never synced or pruned by Canvas) so the
    // notebook opens it exactly like an annotated Canvas PDF: page kind "pdf" pointing at a file item.
    // No moduleId: a generated PDF must not feed back into its own lecture's material.
    const item = await StudyItem.create({
      userId,
      classId: cls._id,
      canvasType: "File",
      canvasId: `generated:${randomUUID()}`,
      type: "file",
      title,
      seenAt: new Date(),
      submittable: false,
      html: opts.html,
      file: { name: `${title.replace(/[^\w .-]+/g, "").trim().slice(0, 120) || "document"}.pdf`, mime: "application/pdf", size: pdf.length, version: 1, sha256: createHash("sha256").update(pdf).digest("hex"), storageKey, canvasUpdatedAt: null },
    });
    itemId = item._id;
    const weekOut = wk ?? (scope?.week != null && scope.week >= 1 && scope.week <= 30 ? scope.week : null);
    const created = await invokeController(createPage, {
      userId: ownerId,
      body: { classId: String(cls._id), itemId: String(item._id), title, kind: "pdf", week: weekOut, lecture: lecture ? { number: lecture.number ?? null, key: lecture.key, date: lecture.date } : null, moduleId: scope?.moduleId ? String(scope.moduleId) : null },
      label: opts.label,
    });
    if (created.status !== 201) {
      await rollback();
      return { ok: false, invoked: created };
    }
    pageId = String(created.body.id);
    const { url, expiresAt } = await signedGetUrl(storageKey, { contentType: "application/pdf" });
    return { ok: true, pageId, itemId: String(item._id), page: created.body, pdfUrl: url, expiresAt };
  } catch (e) {
    await rollback();
    throw e;
  }
}
