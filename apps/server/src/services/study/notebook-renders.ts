import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { IStudyPage, IStudyPageRender } from "@/models/study/page";
import { getStudyObject } from "./storage";

/**
 * MCP side of the notebook page renders (controllers/study-page-renders.controller.ts stores them).
 * MCP page numbers are 1-based ("page 3" = render index 2).
 */

/** Claude's vision input tops out around 1568 px on the long edge — anything bigger is downscaled by the model anyway. */
export const MCP_IMAGE_MAX_EDGE = 1568;
export const NOTEBOOK_DEFAULT_PAGES = 4;
export const NOTEBOOK_MAX_PAGES = 10;
/** Total JPEG bytes per get_notebook_page call (base64 adds a third on the wire). */
export const NOTEBOOK_MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Long edge of a PDF page in points (A4's long edge). */
const PDF_LONG_EDGE_PT = 842;
export const NOTEBOOK_PDF_MAX_PAGES = 200;

/** Board page count: the last committed count, else what the stored renders imply. */
export const notebookPageCount = (p: Pick<IStudyPage, "rendersPageCount" | "renders">) =>
  p.rendersPageCount ?? (p.renders?.length ? Math.max(...p.renders.map((r) => r.index)) + 1 : 0);

export const rendersByPage = (p: Pick<IStudyPage, "renders">) => new Map((p.renders ?? []).map((r) => [r.index + 1, r] as const));

/** One render → JPEG, long edge ≤ maxEdge, white behind any transparency. */
export async function renderJpeg(r: IStudyPageRender, maxEdge: number, quality: number) {
  const src = await getStudyObject(r.key);
  const { data, info } = await sharp(src)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Renders → one PDF, one page per render at its own aspect ratio (long edge = A4 long edge). */
export async function notebookPdf(renders: IStudyPageRender[], title: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer("Study");
  for (const r of renders) {
    const { data, width, height } = await renderJpeg(r, 2400, 85);
    const img = await doc.embedJpg(data);
    const scale = PDF_LONG_EDGE_PT / Math.max(width, height);
    const w = width * scale;
    const h = height * scale;
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return Buffer.from(await doc.save());
}
