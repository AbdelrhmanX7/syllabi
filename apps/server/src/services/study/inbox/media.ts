import { execFile } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { decodeHeic, HeicDecodeError } from "./heic";

/**
 * Inbox media pipeline: sniff the real type from magic bytes (iOS Shortcuts often sends
 * `application/octet-stream`, and a filename proves nothing), then normalise.
 *
 * Images: decode (HEIC via the libheif shim in ./heic), auto-orient from EXIF, downscale to a
 * 3000 px long side, re-encode WITHOUT any metadata (EXIF/GPS/XMP/ICC dropped — sharp writes
 * none unless `withMetadata()` is asked for), JPEG q85 — or PNG when the source has real alpha.
 * Thumb: 400 px long side, same format. PDFs are stored byte-for-byte; the thumb is page 1 via
 * `pdftoppm` when it is installed (prod: /usr/bin/pdftoppm), else null.
 */

export const INBOX_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_LONG_SIDE = 3000;
export const THUMB_LONG_SIDE = 400;
export const JPEG_QUALITY = 85;
/** Decoded-pixel guard for the non-HEIC decoders (decompression bombs). */
export const MAX_INPUT_PIXELS = 100_000_000;

export type SniffedType = "jpeg" | "png" | "webp" | "heif" | "pdf";

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "heif", "avif", "avis"]);

/** The real type of `buf`, or null. Content-Type and filename are deliberately ignored. */
export function sniffType(buf: Buffer): SniffedType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp") {
    const boxSize = buf.readUInt32BE(0);
    const end = Math.min(buf.length, boxSize >= 16 ? boxSize : 12);
    const brands = [buf.toString("latin1", 8, 12)];
    for (let o = 16; o + 4 <= end; o += 4) brands.push(buf.toString("latin1", o, o + 4));
    if (brands.some((b) => HEIF_BRANDS.has(b))) return "heif";
  }
  return null;
}

export class InboxMediaError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface ProcessedMedia {
  kind: "image" | "pdf";
  body: Buffer;
  ext: "jpg" | "png" | "pdf";
  contentType: string;
  width: number | null;
  height: number | null;
  thumb: { body: Buffer; ext: "jpg" | "png"; contentType: string } | null;
}

/** Decode → upright sharp pipeline, plus whether the image has meaningful alpha. */
async function openImage(buf: Buffer, type: Exclude<SniffedType, "pdf">): Promise<{ img: sharp.Sharp; alpha: boolean }> {
  if (type === "heif") {
    // AVIF (and any HEIF that sharp's bundled libheif can decode) goes through sharp; HEVC-coded
    // HEIC — every iPhone photo — needs the system libheif shim.
    try {
      const probe = sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS });
      await probe.clone().raw().toBuffer({ resolveWithObject: false });
      const meta = await probe.metadata();
      return { img: probe.rotate(), alpha: !!meta.hasAlpha };
    } catch {
      /* fall through to libheif */
    }
    let raw;
    try {
      raw = await decodeHeic(buf);
    } catch (e) {
      const unavailable = e instanceof HeicDecodeError && e.unavailable;
      throw new InboxMediaError(
        415,
        "HEIC_UNSUPPORTED",
        unavailable
          ? "HEIC could not be decoded on the server — add a “Convert Image” (JPEG) step before uploading"
          : "This HEIC/HEIF file could not be decoded"
      );
    }
    // libheif already applied the HEIF rotation/mirror; raw pixels carry no metadata.
    return { img: sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } }), alpha: raw.channels === 4 };
  }
  const img = sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
  let meta: sharp.Metadata;
  try {
    meta = await img.metadata();
  } catch {
    throw new InboxMediaError(415, "UNSUPPORTED_TYPE", "The image could not be decoded");
  }
  // .rotate() with no angle = auto-orient from EXIF (and the orientation tag is not re-written).
  return { img: img.rotate(), alpha: type !== "jpeg" && !!meta.hasAlpha };
}

/** True when an RGBA image has at least one non-opaque pixel (PNG screenshots are often RGBA but opaque). */
async function hasRealAlpha(img: sharp.Sharp): Promise<boolean> {
  const stats = await img.clone().stats();
  const a = stats.channels[3];
  return !!a && a.min < 255;
}

async function encode(img: sharp.Sharp, longSide: number, png: boolean, quality: number) {
  const resized = img.clone().resize({ width: longSide, height: longSide, fit: "inside", withoutEnlargement: true });
  const out = png
    ? resized.png({ compressionLevel: 9, adaptiveFiltering: true })
    : resized.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" });
  return out.toBuffer({ resolveWithObject: true });
}

export async function processImage(buf: Buffer, type: Exclude<SniffedType, "pdf">): Promise<ProcessedMedia> {
  const { img, alpha } = await openImage(buf, type);
  let png = false;
  try {
    png = alpha && (await hasRealAlpha(img));
    const main = await encode(img, MAX_LONG_SIDE, png, JPEG_QUALITY);
    const thumb = await encode(img, THUMB_LONG_SIDE, png, 75);
    const ext = png ? "png" : "jpg";
    const contentType = png ? "image/png" : "image/jpeg";
    return {
      kind: "image",
      body: main.data,
      ext,
      contentType,
      width: main.info.width,
      height: main.info.height,
      thumb: { body: thumb.data, ext, contentType },
    };
  } catch (e) {
    if (e instanceof InboxMediaError) throw e;
    throw new InboxMediaError(415, "UNSUPPORTED_TYPE", "The image could not be decoded");
  }
}

export const PDFTOPPM_TIMEOUT_MS = 15_000;

/** Page 1 of a PDF as a ≤400 px JPEG, or null (pdftoppm missing, encrypted, broken, slow). */
export async function pdfThumb(buf: Buffer): Promise<Buffer | null> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "study-inbox-"));
  const src = path.join(dir, `${randomUUID()}.pdf`);
  const outBase = path.join(dir, "thumb");
  try {
    await fs.promises.writeFile(src, buf);
    await new Promise<void>((resolve, reject) =>
      execFile(
        "pdftoppm",
        ["-f", "1", "-l", "1", "-singlefile", "-jpeg", "-jpegopt", "quality=75", "-scale-to", String(THUMB_LONG_SIDE), src, outBase],
        { timeout: PDFTOPPM_TIMEOUT_MS },
        (err) => (err ? reject(err) : resolve())
      )
    );
    const jpg = await fs.promises.readFile(`${outBase}.jpg`);
    return jpg.length ? jpg : null;
  } catch {
    return null;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Sniff + normalise one upload. Throws InboxMediaError (415) for anything not accepted. */
export async function processUpload(buf: Buffer): Promise<ProcessedMedia> {
  const type = sniffType(buf);
  if (!type) throw new InboxMediaError(415, "UNSUPPORTED_TYPE", "Only JPEG, PNG, HEIC/HEIF, WebP and PDF files are accepted");
  if (type === "pdf") {
    const thumb = await pdfThumb(buf);
    return {
      kind: "pdf",
      body: buf,
      ext: "pdf",
      contentType: "application/pdf",
      width: null,
      height: null,
      thumb: thumb ? { body: thumb, ext: "jpg", contentType: "image/jpeg" } : null,
    };
  }
  return processImage(buf, type);
}
