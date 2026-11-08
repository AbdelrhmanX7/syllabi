import { Types } from "mongoose";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyClassPolicy, IStudyClassPolicy, SyllabusSourceKind } from "@/models/study/class-policy";
import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { htmlToText } from "../extract-sources";
import { getStudyObject } from "../storage";
import { sha256 } from "./text-utils";

/**
 * Where a class's syllabus lives, and its text. Rules (designed from the 4 real classes):
 *  1. course `syllabus_body` with real content → body;
 *  2. a body that is mostly a link to a course file → that synced File item;
 *  3. otherwise a module item titled /syllabus/i — a File (MATH-192) or a Page.
 * `getText` turns the chosen source into text (HTML → text; PDF → pdftotext).
 */

export const MOSTLY_LINK_MAX_TEXT = 400;
export const MIN_SYLLABUS_TEXT = 200;

export type SyllabusSource =
  | { kind: "body"; html: string; title: string }
  | { kind: "body_file" | "module_file" | "module_page"; item: IStudyItem; title: string }
  | { kind: "none" };

/** Canvas file ids linked from HTML (`/files/123`, `data-api-endpoint=…/files/123`). */
export function linkedFileIds(html: string): string[] {
  const out: string[] = [];
  for (const m of String(html ?? "").matchAll(/\/files\/(\d+)/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

const SYLLABUS_RE = /syllabus/i;
/** "Syllabus Quiz" / "Syllabus lecture recordings" are about the syllabus, not the syllabus. */
const NOT_SYLLABUS_RE = /quiz|recording|video|acknowledg|agreement|discussion/i;
export const isSyllabusTitle = (t: string) => SYLLABUS_RE.test(t) && !NOT_SYLLABUS_RE.test(t);

/** Module items Canvas titles as the syllabus (canvas.ts `fetchSyllabusHints`). */
export type SyllabusHints = { fileIds: string[]; pageUrls: string[] };

export function detectSyllabusSource(syllabusBody: string, items: IStudyItem[], hints: SyllabusHints = { fileIds: [], pageUrls: [] }): SyllabusSource {
  const bodyText = htmlToText(syllabusBody ?? "");
  const fileIds = linkedFileIds(syllabusBody ?? "");
  if (bodyText.length >= MIN_SYLLABUS_TEXT && !(bodyText.length < MOSTLY_LINK_MAX_TEXT && fileIds.length)) {
    return { kind: "body", html: syllabusBody, title: "Course syllabus" };
  }
  if (fileIds.length) {
    for (const fid of fileIds) {
      const item = items.find((i) => i.canvasType === "File" && i.canvasId === fid);
      if (item) return { kind: "body_file", item, title: item.title };
    }
  }
  const hinted = items.filter(
    (i) => (i.canvasType === "File" && hints.fileIds.includes(i.canvasId)) || (i.canvasType === "Page" && hints.pageUrls.includes(i.canvasId))
  );
  const inModules = [
    ...hinted,
    ...items.filter((i) => i.moduleId && isSyllabusTitle(i.title) && !hinted.includes(i)).sort((a, b) => (a.modulePosition ?? 0) - (b.modulePosition ?? 0)),
  ];
  const file = inModules.find((i) => i.type === "file");
  if (file) return { kind: "module_file", item: file, title: file.title };
  const page = inModules.find((i) => i.type === "page");
  if (page) return { kind: "module_page", item: page, title: page.title };
  // A short body with no link is still better than nothing.
  if (bodyText.length >= 50) return { kind: "body", html: syllabusBody, title: "Course syllabus" };
  return { kind: "none" };
}

export type SyllabusText = { text: string; note: string | null };

const run = promisify(execFile);

/**
 * PDF text in READING order (`pdftotext` without `-layout`). Syllabi are often two-column; the
 * shared `pdfText` (-layout) interleaves the columns line by line, so no sentence the model
 * quotes is contiguous in it and the verbatim-quote check drops every real quote.
 */
export async function pdfReadingText(bytes: Buffer, maxPages = 60): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "study-syllabus-"));
  const src = path.join(dir, "in.pdf");
  try {
    await fs.writeFile(src, bytes);
    const { stdout } = await run("pdftotext", ["-l", String(maxPages), src, "-"], { maxBuffer: 32 << 20, timeout: 60_000 });
    return String(stdout).replace(/\f/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  } catch {
    return "";
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function syllabusText(
  src: SyllabusSource,
  read: (key: string) => Promise<Buffer> = getStudyObject,
  pdf: (bytes: Buffer) => Promise<string> = pdfReadingText
): Promise<SyllabusText> {
  if (src.kind === "none") return { text: "", note: "no syllabus found" };
  if (src.kind === "body") return { text: htmlToText(src.html), note: null };
  const item = src.item;
  if (item.type === "page") return { text: htmlToText(item.html ?? ""), note: item.html ? null : "page body not synced" };
  if (!item.file?.storageKey) return { text: "", note: "file not synced (locked or skipped)" };
  if (item.file.mime !== "application/pdf") return { text: "", note: `unsupported file type ${item.file.mime}` };
  const text = (await pdf(await read(item.file.storageKey))).trim();
  return { text, note: text.length < MIN_SYLLABUS_TEXT ? "no_text_layer" : null };
}

/**
 * Detect + extract + store. Returns the stored doc and whether the text changed (new hash).
 * The policy is not touched here — policy.ts re-extracts when `policyTextHash` lags.
 */
export async function refreshSyllabus(
  userId: Types.ObjectId,
  classId: Types.ObjectId,
  canvas: { syllabusBody: string; timeZone: string | null; hints?: SyllabusHints } | null,
  deps: { read?: (key: string) => Promise<Buffer>; pdf?: (bytes: Buffer) => Promise<string> } = {}
): Promise<{ doc: IStudyClassPolicy; changed: boolean }> {
  const existing = await StudyClassPolicy.findOne({ userId, classId }).lean<IStudyClassPolicy>();
  const items = await StudyItem.find(
    { userId, classId, type: { $in: ["file", "page"] } },
    { canvasType: 1, canvasId: 1, type: 1, title: 1, moduleId: 1, modulePosition: 1, html: 1, file: 1 }
  ).lean<IStudyItem[]>();
  // Canvas unreachable → keep the stored body-based syllabus rather than wiping it.
  if (!canvas && existing?.syllabus?.kind === "body") return { doc: existing, changed: false };
  const src = detectSyllabusSource(canvas?.syllabusBody ?? "", items, canvas?.hints);
  const { text, note } = await syllabusText(src, deps.read, deps.pdf);
  const textHash = text ? sha256(text) : null;
  const kind: SyllabusSourceKind = src.kind;
  const doc = await StudyClassPolicy.findOneAndUpdate(
    { userId, classId },
    {
      $set: {
        syllabus: {
          kind,
          itemId: src.kind === "none" || src.kind === "body" ? null : src.item._id,
          title: src.kind === "none" ? null : src.title,
          text,
          textHash,
          note,
          checkedAt: new Date(),
        },
        ...(canvas?.timeZone ? { timeZone: canvas.timeZone } : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean<IStudyClassPolicy>();
  return { doc: doc!, changed: (existing?.syllabus?.textHash ?? null) !== textHash };
}
