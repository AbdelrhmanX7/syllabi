import sharp from "sharp";
import { Types } from "mongoose";
import { IStudyPage, IStudyPageRender, StudyPage } from "@/models/study/page";
import { IStudyPageRead, StudyPageRead } from "@/models/study/page-read";
import { Spend, visionCall } from "./ai-models";
import { pdfText } from "./extract-sources";
import { renderJpeg } from "./notebook-renders";
import { RENDERS_FOR_VISION } from "./page-meta";
import { createPageRasterizer } from "./page-raster";
import { getStudyObject, pdfAssetKey, PDF_ASSET_ID_RE } from "./storage";

/**
 * The text of one notebook page for the text-only AI steps (flashcards, questions).
 *
 * 1. Handwriting text the app sent (`ocrText`, `ocrAiVersion` null) wins, always.
 * 2. Otherwise AI reads the page: the device's renders of the current version when it uploaded them
 *    (the describe path, services/study/page-meta.ts), else the ink rendered here (page-raster.ts),
 *    at most RENDERS_FOR_VISION images, one vision call on the caller's spend. The result is saved as
 *    `ocrText` with `ocrAiVersion` = the version read, so the next request is free; once the page
 *    moves to a newer version the reading is stale and is made again.
 * 3. A PDF under the pages adds its own text layer (no AI needed for that part).
 *
 * The cheap part (`planPageText`) runs before the request opens its stream; the AI part is the
 * deferred `read`, run inside the stream so its spend, limits and errors are the request's own.
 */

export const PAGE_EMPTY_MESSAGE = "This page is empty — write something first.";
export const PAGE_UNREADABLE_MESSAGE = "Couldn't read the writing on this page — try again.";

/** The fields `planPageText` needs. */
export const PAGE_TEXT_PROJECTION = {
  userId: 1,
  title: 1,
  classId: 1,
  version: 1,
  contentKey: 1,
  ocrText: 1,
  ocrUpdatedAt: 1,
  ocrAiVersion: 1,
  renders: 1,
  rendersCommitVersion: 1,
} as const;

const RENDER_EDGE = 1568; // the vision model's own long-edge limit: no detail is sent that it would drop
const READ_TIMEOUT_MS = 90_000;
const PDF_TEXT_MAX_CHARS = 30_000;
const PDF_PAGES_MAX = 60;
const OCR_MAX_CHARS = 200_000;

export const PAGE_READ_PROMPT = [
  "These images are one page of a student's handwritten notebook, top to bottom, in order.",
  "Transcribe the writing as plain text, top to bottom. Write exactly what is there: do not fix, summarise, complete or add anything.",
  "- Math: write it as LaTeX inline between $ signs (e.g. $\\frac{a}{b}$, $x^2$).",
  "- Headings and list items on their own lines. Words on arrows or diagrams where they appear (an arrow as \"X → Y\").",
  "- Illegible words: [?].",
  "- No writing at all: reply with nothing.",
  "Reply with the transcription only, no comments.",
].join("\n");
const PDF_NOTE = "Printed PDF text under the writing is read separately: transcribe the handwriting (and labels written by hand) only.";

export type PageReadOutcome = { kind: "text"; text: string } | { kind: "empty" } | { kind: "unreadable" };
export type PagePlan = PageReadOutcome | { kind: "read"; read: (spend: Spend, signal?: AbortSignal) => Promise<PageReadOutcome> };

type PageDoc = Pick<IStudyPage, "_id" | "userId" | "version" | "contentKey" | "ocrText" | "ocrUpdatedAt" | "ocrAiVersion" | "renders" | "rendersCommitVersion">;

interface BoardInfo {
  /** Board JSON of just the pages that carry ink (at most RENDERS_FOR_VISION), for the server render. */
  inkJson: string;
  /** Indexes (0-based) of the pages that carry ink. */
  inkPages: number[];
  pdfRefs: Array<{ assetId: string; pageIndex: number }>;
}

/** What the AI and storage steps are; tests swap them for stubs. */
export interface PageTextDeps {
  loadObject(key: string): Promise<Buffer>;
  /** Text of PDF pages `firstPage`..`lastPage` (1-based), one entry per page. */
  pdfPagesText(pdf: Buffer, firstPage: number, lastPage: number): Promise<string[]>;
  /** Images of the page's inked parts (≤ RENDERS_FOR_VISION), JPEG. */
  pageImages(page: PageDoc, board: BoardInfo): Promise<Buffer[]>;
  transcribe(images: Buffer[], hasPdfText: boolean, spend: Spend, signal?: AbortSignal): Promise<string>;
  /** A concept-map reading of this exact version, when one was already paid for. */
  cachedRead(page: PageDoc): Promise<string | null>;
  /** Save the AI reading unless the app sent text meanwhile. */
  saveReading(page: PageDoc, text: string): Promise<void>;
}

// ─── pure helpers ────────────────────────────────────────────────────────────────────────

/** Stored handwriting text that may be used as it is: the app's, or an AI reading of the current version. */
export function storedPageText(p: Pick<IStudyPage, "ocrText" | "ocrAiVersion" | "version">): string | null {
  const t = p.ocrText?.trim();
  if (!t) return null;
  if (p.ocrAiVersion === null || p.ocrAiVersion === undefined) return t;
  return p.ocrAiVersion >= (p.version ?? 0) ? t : null;
}

const hasObjects = (canvasJSON: unknown): boolean => {
  try {
    const c = typeof canvasJSON === "string" ? JSON.parse(canvasJSON) : canvasJSON;
    return Array.isArray(c?.objects) && c.objects.length > 0;
  } catch {
    return false;
  }
};

/** Board JSON → which pages carry ink, and the PDF pages under them. Malformed JSON → no ink, no PDF. */
export function boardInfo(raw: string): BoardInfo {
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { inkJson: JSON.stringify({ pages: [] }), inkPages: [], pdfRefs: [] };
  }
  const pages: any[] = Array.isArray(doc?.pages) ? doc.pages : Array.isArray(doc?.objects) ? [{ canvasJSON: doc }] : [];
  const inkPages: number[] = [];
  const pdfRefs: BoardInfo["pdfRefs"] = [];
  pages.forEach((p, i) => {
    if (hasObjects(p?.canvasJSON)) inkPages.push(i);
    if (typeof p?.pdfAssetId === "string" && PDF_ASSET_ID_RE.test(p.pdfAssetId) && Number.isInteger(p?.pdfPageIndex) && p.pdfPageIndex >= 0)
      pdfRefs.push({ assetId: p.pdfAssetId, pageIndex: p.pdfPageIndex });
  });
  const picked = inkPages.slice(0, RENDERS_FOR_VISION);
  return { inkJson: JSON.stringify({ pages: picked.map((i) => pages[i]) }), inkPages: picked, pdfRefs: pdfRefs.slice(0, PDF_PAGES_MAX) };
}

/** The model's reply → the transcription ("" when it said there was nothing). */
export function cleanReading(raw: string): string {
  const t = raw
    .trim()
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```$/, "")
    .trim();
  return /^(?:["'`]{0,2}|\(?(?:empty|nothing|none|no writing|no text)\)?\.?)$/i.test(t) ? "" : t;
}

export function joinPageText(handwriting: string, printed: string): string {
  const parts = [handwriting.trim(), printed.trim() ? `Printed text on the page:\n${printed.trim().slice(0, PDF_TEXT_MAX_CHARS)}` : ""].filter(Boolean);
  return parts.join("\n\n").slice(0, OCR_MAX_CHARS);
}

// ─── the plan ────────────────────────────────────────────────────────────────────────────

async function pdfTextOf(page: PageDoc, refs: BoardInfo["pdfRefs"], deps: PageTextDeps): Promise<string> {
  if (!refs.length) return "";
  const byAsset = new Map<string, number[]>();
  for (const r of refs) byAsset.set(r.assetId, [...(byAsset.get(r.assetId) ?? []), r.pageIndex]);
  const out: string[] = [];
  for (const [assetId, idx] of byAsset) {
    const pdf = await deps.loadObject(pdfAssetKey(String(page.userId), assetId)).catch(() => null); // not uploaded yet
    if (!pdf) continue;
    // One run over the whole range, not one per page (a 30-page import would mean 30 runs).
    const wanted = [...new Set(idx)].sort((a, b) => a - b);
    const first = wanted[0];
    const pages = await deps.pdfPagesText(pdf, first + 1, wanted[wanted.length - 1] + 1).catch(() => [] as string[]);
    for (const i of wanted) {
      const t = (pages[i - first] ?? "").trim();
      if (t) out.push(t);
    }
  }
  return out.join("\n\n").slice(0, PDF_TEXT_MAX_CHARS);
}

/**
 * What it takes to get this page's text: ready text, an empty page, or an AI `read` to run on the
 * request's spend. Storage failures reading the board count as "no board" (empty).
 */
export async function planPageText(page: PageDoc, deps: PageTextDeps = defaultDeps): Promise<PagePlan> {
  const stored = storedPageText(page);
  const appSent = page.ocrAiVersion === null || page.ocrAiVersion === undefined;
  // An AI reading of this version already carries the PDF text: nothing to load.
  if (stored && !appSent) return { kind: "text", text: stored };
  const board = page.version && page.contentKey ? await deps.loadObject(page.contentKey).then((b) => boardInfo(b.toString("utf8")), () => null) : null;
  const printed = board ? await pdfTextOf(page, board.pdfRefs, deps) : "";

  // The app's text is the handwriting only: add the PDF's.
  if (stored) return { kind: "text", text: joinPageText(stored, printed) };
  if (!board || !board.inkPages.length) return printed ? { kind: "text", text: joinPageText("", printed) } : { kind: "empty" };

  const cached = await deps.cachedRead(page).catch(() => null);
  if (cached?.trim()) {
    const text = joinPageText(cached, printed);
    await deps.saveReading(page, text).catch(() => undefined);
    return { kind: "text", text };
  }

  return {
    kind: "read",
    read: async (spend, signal) => {
      const images = await deps.pageImages(page, board);
      const handwriting = images.length ? cleanReading(await deps.transcribe(images, !!printed, spend, signal)) : "";
      if (signal?.aborted) return { kind: "unreadable" };
      // The board has ink, so nothing read means the writing could not be made out (not an empty page).
      if (!handwriting) return printed ? { kind: "text", text: joinPageText("", printed) } : { kind: "unreadable" };
      const text = joinPageText(handwriting, printed);
      await deps.saveReading(page, text).catch(() => undefined);
      return { kind: "text", text };
    },
  };
}

// ─── the real steps ──────────────────────────────────────────────────────────────────────

const toJpeg = (png: Buffer) =>
  sharp(png).resize({ width: RENDER_EDGE, height: RENDER_EDGE, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();

/** The device's renders of the current version when it uploaded one for every inked page, else a server render. */
async function pageImages(page: PageDoc, board: BoardInfo): Promise<Buffer[]> {
  const current = new Map<number, IStudyPageRender>();
  for (const r of page.renders ?? []) if (r.version === page.version) current.set(r.index, r);
  const renders = board.inkPages.map((i) => current.get(i)).filter((r): r is IStudyPageRender => !!r);
  if (renders.length && renders.length === board.inkPages.length) {
    const out: Buffer[] = [];
    for (const r of renders) {
      const jpg = await renderJpeg(r, RENDER_EDGE, 80).catch(() => null);
      if (jpg) out.push(jpg.data);
    }
    if (out.length === renders.length) return out;
  }
  const raster = await createPageRasterizer();
  try {
    const tiles = (await raster.render(board.inkJson)).slice(0, RENDERS_FOR_VISION);
    return Promise.all(tiles.map(toJpeg));
  } finally {
    await raster.close();
  }
}

export const defaultDeps: PageTextDeps = {
  loadObject: getStudyObject,
  // pdftotext ends every page with a form feed.
  pdfPagesText: async (pdf, first, last) => (await pdfText(pdf, last, first)).split("\f"),
  pageImages,
  transcribe: (images, hasPdfText, spend, signal) =>
    visionCall(images, "image/jpeg", hasPdfText ? `${PAGE_READ_PROMPT}\n${PDF_NOTE}` : PAGE_READ_PROMPT, spend, {
      signal,
      timeoutMs: READ_TIMEOUT_MS,
      reasoning: { effort: "low" },
      claude: "haiku",
      maxTokens: 4000,
    }),
  async cachedRead(page) {
    const hit = await StudyPageRead.findOne({ userId: page.userId, pageId: page._id, version: page.version }, { text: 1 }).lean<IStudyPageRead>();
    return hit?.text ?? null;
  },
  async saveReading(page, text) {
    // Guarded on the text it replaced: text the app sends while AI is reading wins.
    await StudyPage.updateOne(
      { _id: page._id, userId: page.userId, ocrText: page.ocrText ?? null, ocrUpdatedAt: page.ocrUpdatedAt ?? null },
      { $set: { ocrText: text, ocrUpdatedAt: new Date(), ocrAiVersion: page.version ?? 0 } },
      { timestamps: false }
    );
  },
};

/** Load the page's fields for `planPageText`; null when it is not the caller's. */
export const findPageForText = (userId: Types.ObjectId, pageId: string) =>
  StudyPage.findOne({ _id: pageId, userId, deletedAt: null }, PAGE_TEXT_PROJECTION).lean<IStudyPage>();
