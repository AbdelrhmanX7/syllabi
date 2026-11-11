import crypto, { randomUUID } from "crypto";
import { Types } from "mongoose";
import { IStudyClass } from "@/models/study/class";
import { StudyCanvasConnection } from "@/models/study/canvas-connection";
import { IStudyLibraryDoc, StudyLibraryChunk, StudyLibraryDoc } from "@/models/study/library";
import { pdfText } from "./extract-sources";
import { deleteStudyObject, putStudyObject } from "./storage";

/**
 * A PDF someone uploads to a class Library from the app (POST /study/classes/:id/library). It becomes
 * the same kind of row the class-folder import writes (models/study/library.ts): the file in storage,
 * one text chunk per page for search, flashcards and questions, opened by «Write on it» like any
 * Library PDF. Uploads live under `UPLOAD_DIR/` in the class, so they never collide with imported paths.
 */

export const UPLOAD_DIR = "Uploaded";
/** Pages of text kept for search / flashcards (pdftotext runs over at most this many). */
const TEXT_PAGES_MAX = 2000;
const TITLE_MAX = 200;

/** A file name → the title shown in the Library ("Week 3 slides.pdf" → "Week 3 slides"). */
export function uploadTitle(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/\.pdf$/i, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX);
  return clean || "Uploaded PDF";
}

/** `Uploaded/<title>.pdf`, or `Uploaded/<title> (2).pdf` when that path is taken. */
export function uploadPath(title: string, taken: ReadonlySet<string>): string {
  const safe = title.replace(/[/\\]/g, "-");
  for (let n = 1; ; n++) {
    const p = `${UPLOAD_DIR}/${safe}${n === 1 ? "" : ` (${n})`}.pdf`;
    if (!taken.has(p)) return p;
  }
}

/** pdftotext over the whole PDF → one entry per page (form feeds), "" for a page without text. */
export async function pdfTextPages(pdf: Buffer): Promise<string[]> {
  const pages = (await pdfText(pdf, TEXT_PAGES_MAX, 1)).split("\f");
  if (pages.length && !pages[pages.length - 1].trim()) pages.pop(); // pdftotext ends every page with \f
  return pages;
}

export interface UploadResult {
  doc: IStudyLibraryDoc;
  /** False when this exact file was already in the class Library (that row is returned). */
  created: boolean;
}

/**
 * Store `pdf` in the class Library of `userId`. The same file twice in one class returns the first
 * row (a double tap, or the same slides uploaded again). `textPages` is injectable for tests.
 */
export async function uploadLibraryPdf(
  userId: Types.ObjectId,
  cls: Pick<IStudyClass, "canvasCourseId">,
  pdf: Buffer,
  name: unknown,
  textPages: (pdf: Buffer) => Promise<string[]> = pdfTextPages
): Promise<UploadResult> {
  const sha256 = crypto.createHash("sha256").update(pdf).digest("hex");
  const scope = { userId, canvasCourseId: cls.canvasCourseId };
  const same = await StudyLibraryDoc.findOne({ ...scope, kind: "pdf", sha256 }, { markdown: 0 }).lean<IStudyLibraryDoc>();
  if (same) return { doc: same, created: false };

  const title = uploadTitle(name);
  const taken = new Set(
    (await StudyLibraryDoc.find({ ...scope, relPath: { $regex: `^${UPLOAD_DIR}/` } }, { relPath: 1 }).lean<{ relPath: string }[]>()).map((d) => d.relPath)
  );
  const conn = await StudyCanvasConnection.findOne({ userId }, { canvasUser: 1 }).lean<{ canvasUser?: { id?: number } }>();
  const pages = await textPages(pdf);
  const key = `study/${userId}/library/${randomUUID()}.pdf`;
  await putStudyObject(key, pdf, "application/pdf");

  let doc: IStudyLibraryDoc;
  try {
    doc = (
      await StudyLibraryDoc.create({
        ...scope,
        // The import's identity is (canvasUserId, canvasCourseId, relPath); 0 = no Canvas account.
        canvasUserId: Number.isFinite(conn?.canvasUser?.id) ? conn!.canvasUser!.id : 0,
        relPath: uploadPath(title, taken),
        title,
        kind: "pdf",
        week: null,
        markdown: null,
        file: { storageKey: key, mime: "application/pdf", size: pdf.length, sha256 },
        size: pdf.length,
        sha256,
        pages: pages.length || null,
        textChars: pages.reduce((n, p) => n + p.length, 0),
      })
    ).toObject() as IStudyLibraryDoc;
  } catch (e: any) {
    await deleteStudyObject(key).catch(() => undefined);
    // Two uploads of the same file at once: the other one won the path; answer with its row.
    if (e?.code === 11000) {
      const winner = await StudyLibraryDoc.findOne({ ...scope, kind: "pdf", sha256 }, { markdown: 0 }).lean<IStudyLibraryDoc>();
      if (winner) return { doc: winner, created: false };
    }
    throw e;
  }

  // No transaction (a standalone MongoDB has none): the row goes if its pages can't be written.
  try {
    const rows = pages
      .map((text, i) => ({ docId: doc._id, userId, canvasUserId: doc.canvasUserId, canvasCourseId: cls.canvasCourseId, week: null, page: i + 1, text }))
      .filter((r) => r.text.trim());
    for (let i = 0; i < rows.length; i += 500) await StudyLibraryChunk.insertMany(rows.slice(i, i + 500));
  } catch (e) {
    await StudyLibraryChunk.deleteMany({ docId: doc._id }).catch(() => undefined);
    await StudyLibraryDoc.deleteOne({ _id: doc._id }).catch(() => undefined);
    await deleteStudyObject(key).catch(() => undefined);
    throw e;
  }
  return { doc, created: true };
}
