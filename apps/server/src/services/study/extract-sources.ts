import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import sharp from "sharp";
import { PDFTOPPM, pdftoppmAvailable } from "@/services/ai-chat/pdf-raster";

/**
 * Turning an extraction source into model input: PDF pages → PNG (poppler `pdftoppm`, the same
 * rasteriser the /ai chat uses — present on prod and in dev), images → flattened PNG, HTML →
 * plain text.
 */
const run = promisify(execFile);

export const MAX_EXTRACT_PAGES = 20;
export const PDF_DPI = 150;

export class SourceError extends Error {
  constructor(message: string, public code = "SOURCE_UNREADABLE") {
    super(message);
  }
}

/** `pageRange`: "3-7", "4", [3,7], {from,to} / {start,end}. 1-based, inclusive, capped at 20 pages. */
export function parsePageRange(raw: unknown): { first: number; last: number } {
  let a: number | undefined;
  let b: number | undefined;
  if (typeof raw === "string" && raw.trim()) {
    const m = raw.trim().match(/^(\d+)\s*(?:[-–]\s*(\d+))?$/);
    if (!m) throw new SourceError('pageRange must look like "3-7"', "VALIDATION_ERROR");
    a = Number(m[1]);
    b = m[2] ? Number(m[2]) : a;
  } else if (Array.isArray(raw)) {
    a = Number(raw[0]);
    b = raw.length > 1 ? Number(raw[1]) : a;
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    a = Number(o.from ?? o.start);
    b = o.to ?? o.end ? Number(o.to ?? o.end) : a;
  } else if (raw !== undefined && raw !== null) {
    throw new SourceError('pageRange must look like "3-7"', "VALIDATION_ERROR");
  }
  if (a === undefined) return { first: 1, last: MAX_EXTRACT_PAGES };
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || (b as number) < a) throw new SourceError("pageRange is invalid", "VALIDATION_ERROR");
  return { first: a, last: Math.min(b as number, a + MAX_EXTRACT_PAGES - 1) };
}

export async function rasterisePdfRange(bytes: Buffer, range: { first: number; last: number }): Promise<{ page: number; png: Buffer }[]> {
  if (!(await pdftoppmAvailable())) throw new SourceError("PDF rendering is not available on this server");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "study-pdf-"));
  const src = path.join(dir, "in.pdf");
  try {
    await fs.writeFile(src, bytes);
    await run(PDFTOPPM, ["-r", String(PDF_DPI), "-f", String(range.first), "-l", String(range.last), "-png", src, path.join(dir, "page")], {
      maxBuffer: 1 << 20,
    }).catch((e) => {
      throw new SourceError(`Could not render this PDF (${String(e?.message ?? e).slice(0, 120)})`);
    });
    const names = (await fs.readdir(dir)).filter((n) => n.startsWith("page") && n.endsWith(".png"));
    const pages = await Promise.all(
      names.map(async (n) => ({ page: Number(n.replace(/^page-?/, "").replace(/\.png$/, "")) || 0, png: await fs.readFile(path.join(dir, n)) }))
    );
    const usable = pages.filter((p) => p.page > 0 && p.png.length).sort((x, y) => x.page - y.page);
    if (!usable.length) throw new SourceError("That page range is outside this PDF");
    return usable;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Any image → PNG flattened on white (ink overlays are transparent), long side ≤ 2400 px. */
export async function toPng(input: Buffer, maxPx = 2400): Promise<Buffer> {
  try {
    return await sharp(input).rotate().resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).png().toBuffer();
  } catch {
    throw new SourceError("Could not open that image", "BAD_IMAGE");
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** Canvas HTML → readable text (block tags become line breaks; MathJax/LaTeX alt text kept). */
export function htmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|pre|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_m, e) => ENTITIES[e] ?? " ")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A PDF's text layer (poppler `pdftotext`, next to pdftoppm), pages `firstPage`..`maxPages` (1-based).
 * "" when it has none or poppler is missing.
 */
export async function pdfText(bytes: Buffer, maxPages = 60, firstPage = 1): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "study-pdftext-"));
  const src = path.join(dir, "in.pdf");
  try {
    await fs.writeFile(src, bytes);
    const { stdout } = await run("pdftotext", ["-layout", "-f", String(firstPage), "-l", String(maxPages), src, "-"], { maxBuffer: 32 << 20, timeout: 60_000 });
    return String(stdout).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  } catch {
    return "";
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
