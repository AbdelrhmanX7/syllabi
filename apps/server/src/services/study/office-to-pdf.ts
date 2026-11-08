import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

/**
 * Office → PDF for the Study app (POST /study/convert/pdf) via host LibreOffice
 * (`apt install libreoffice-{writer,impress,calc}-nogui` + metric-compatible fonts on the box).
 *
 * Two warm slots per process, each with its own persistent profile (keyed by pid — prod runs
 * several forked API processes): concurrent soffice runs that share a profile hang or silently
 * no-op, and a fresh profile per call costs a cold start.
 */
export const CONVERT_MAX_BYTES = 50 * 1024 * 1024;
/** Under nginx's default 60 s proxy_read_timeout, so the client gets our 422, not an HTML 504. */
const TIMEOUT_MS = 55_000;
const SOFFICE = "soffice";
const SLOTS = 2;

/** Extension → accepted mimes. The extension picks soffice's import filter. */
const TYPES: Record<string, string[]> = {
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ppt: ["application/vnd.ms-powerpoint"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  odt: ["application/vnd.oasis.opendocument.text"],
  odp: ["application/vnd.oasis.opendocument.presentation"],
  ods: ["application/vnd.oasis.opendocument.spreadsheet"],
  rtf: ["application/rtf", "text/rtf"],
  txt: ["text/plain"],
};

/** Extension from the file name first, then the mime; null ⇒ unsupported. */
export const resolveExt = (fileName: string | null, mime: string | undefined): string | null => {
  const fromName = fileName ? path.extname(fileName).slice(1).toLowerCase() : "";
  if (fromName && TYPES[fromName]) return fromName;
  const m = (mime || "").split(";")[0].trim().toLowerCase();
  return Object.keys(TYPES).find((ext) => TYPES[ext].includes(m)) ?? null;
};

export class ConversionError extends Error {}

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const OOXML = new Set(["docx", "pptx", "xlsx"]);
const ODF = new Set(["odt", "odp", "ods"]);

/**
 * soffice falls back to its text importer for bytes it can't parse and "succeeds" with a PDF of
 * garbage, so the container format is checked up front. Null ⇒ looks valid.
 */
export const sniffError = (input: Buffer, ext: string): string | null => {
  const head = input.subarray(0, 8);
  if (OOXML.has(ext)) {
    // An encrypted OOXML file is an OLE container, not a zip.
    if (head.equals(OLE)) return "This file is password-protected. Remove the password and try again.";
    return input.subarray(0, 4).equals(ZIP) ? null : `This is not a valid .${ext} file.`;
  }
  if (ODF.has(ext)) return input.subarray(0, 4).equals(ZIP) ? null : `This is not a valid .${ext} file.`;
  if (ext === "doc" || ext === "ppt" || ext === "xls") return head.equals(OLE) ? null : `This is not a valid .${ext} file.`;
  if (ext === "rtf") return input.subarray(0, 5).toString("latin1") === "{\\rtf" ? null : "This is not a valid .rtf file.";
  if (ext === "txt") return input.subarray(0, 8192).includes(0) ? "This is not a text file." : null;
  return null;
};

let free = Array.from({ length: SLOTS }, (_, i) => i);
const waiters: Array<(slot: number) => void> = [];
const acquire = () =>
  new Promise<number>((resolve) => {
    const slot = free.shift();
    if (slot !== undefined) resolve(slot);
    else waiters.push(resolve);
  });
const release = (slot: number) => {
  const next = waiters.shift();
  if (next) next(slot);
  else free.push(slot);
};

const run = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    // detached ⇒ own process group, so a timeout kills soffice.bin too, not just the wrapper.
    const child = spawn(SOFFICE, args, { detached: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      reject(new ConversionError("Conversion timed out"));
    }, TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Converts `input` (bytes of a file with extension `ext`) to PDF bytes. Throws ConversionError on a bad document. */
export async function officeToPdf(input: Buffer, ext: string): Promise<Buffer> {
  const bad = sniffError(input, ext);
  if (bad) throw new ConversionError(bad);
  const slot = await acquire();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "study-convert-"));
  try {
    const src = path.join(dir, `input.${ext}`);
    await fs.writeFile(src, input);
    const profile = `file://${path.join(os.tmpdir(), `study-soffice-profile-${process.pid}-${slot}`)}`;
    await run([
      `-env:UserInstallation=${profile}`,
      "--headless",
      "--norestore",
      "--nolockcheck",
      // Without it a .txt decodes by the process locale and non-ASCII text comes out as mojibake.
      ...(ext === "txt" ? ["--infilter=Text (encoded):UTF8"] : []),
      "--convert-to",
      "pdf",
      "--outdir",
      dir,
      src,
    ]);
    // soffice exits 0 on most failures (corrupt, password-protected): the output file is the only signal.
    const out = await fs.readFile(path.join(dir, "input.pdf")).catch(() => null);
    if (!out || out.length < 5 || out.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new ConversionError("Could not convert this file. It may be corrupt or password-protected.");
    }
    return out;
  } finally {
    release(slot);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
