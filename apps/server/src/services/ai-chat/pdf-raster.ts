/**
 * A scanned PDF, one page at a time.
 *
 * Why this exists: sending a 26-page exam to vision as ONE document produced a reading that
 * stopped at question 40 (pages 24–26 never came back), and described one sub-circuit as
 * identical to another that is visibly different. A photograph of a single page, through the
 * layout-plus-crops pipeline, does neither. Rasterising each page turns a PDF into exactly
 * that: a sequence of photographs, read the way photographs are read here.
 *
 * `pdftoppm` (poppler-utils) does the rasterising. It is present on prod and in dev, but it is
 * an external binary and this path must not be the thing that makes an attachment unreadable —
 * every failure here returns null and the caller falls back to the whole-document read.
 */
import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

const run = promisify(execFile);

export const PDFTOPPM = "pdftoppm";

/** Cached per process: asking the shell whether poppler exists, once, not once per upload. */
let available: Promise<boolean> | null = null;

export function pdftoppmAvailable(): Promise<boolean> {
  if (!available) {
    available = run(PDFTOPPM, ["-v"])
      .then(() => true)
      .catch((error: unknown) => {
        // `-v` exits non-zero on some builds while still being present; only a missing binary
        // (ENOENT) means we cannot rasterise.
        if ((error as { code?: string })?.code === "ENOENT") return false;
        return true;
      });
  }
  return available;
}

/** Test seam: forget what we decided about the binary. */
export const resetPdftoppmProbe = () => {
  available = null;
};

export interface RasterPage {
  /** 1-based, matching the PDF's own page numbering. */
  page: number;
  png: Buffer;
}

/**
 * Every page of `bytes` as a PNG, or null when poppler could not do it.
 *
 * Bounded by `maxPages` because the caller already refuses PDFs past its own page cap, and an
 * unbounded rasterise of a thousand-page upload would fill the disk before anyone noticed.
 */
export async function rasterisePdf(
  bytes: Buffer,
  /** `firstPage` (default 1) through `maxPages`, inclusive — a range, not the whole file. */
  opts: { dpi: number; maxPages: number; firstPage?: number }
): Promise<RasterPage[] | null> {
  if (!(await pdftoppmAvailable())) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-chat-pdf-"));
  const src = path.join(dir, "in.pdf");
  try {
    await fs.writeFile(src, bytes);
    // `-png` + a prefix makes pdftoppm write `page-1.png`, `page-2.png`, … zero-padded to the
    // width of the page count, which is why the numbers are parsed back out rather than assumed.
    await run(PDFTOPPM, ["-r", String(opts.dpi), "-f", String(opts.firstPage ?? 1), "-l", String(opts.maxPages), "-png", src, path.join(dir, "page")], {
      maxBuffer: 1 << 20,
    });
    const names = (await fs.readdir(dir)).filter((n) => n.startsWith("page") && n.endsWith(".png"));
    const pages = await Promise.all(
      names.map(async (name) => ({
        page: Number(name.replace(/^page-?/, "").replace(/\.png$/, "")) || 0,
        png: await fs.readFile(path.join(dir, name)),
      }))
    );
    const usable = pages.filter((p) => p.page > 0 && p.png.length > 0).sort((a, b) => a.page - b.page);
    return usable.length ? usable : null;
  } catch {
    return null; // a PDF poppler cannot open is one the whole-document read still might
  } finally {
    // Best effort: a leftover temp dir is untidy, never wrong.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
