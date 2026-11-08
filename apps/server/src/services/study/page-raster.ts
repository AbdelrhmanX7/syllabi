import sharp from "sharp";
import { createInkRenderer, InkRenderer } from "@/services/whiteboard-ink-raster.service";
import type { OverlayPlan } from "@/services/whiteboard-ink-geometry";

/**
 * Notebook page (whiteboard document JSON, the same shape the whiteboard editor saves) → PNG
 * tiles for a vision read. Ink and pasted images (Fabric `image` objects, data: URLs) are drawn
 * by the whiteboard ink rasterizer (headless Chrome + the board's own Fabric build); a PDF/image
 * BACKGROUND (`pdfImageUrl` + `pdfPlacement`) is composited underneath with sharp, on white.
 *
 * Sizing: each board page is scaled so its width is ≤ TARGET_WIDTH, then cut into tiles of
 * ≤ TILE_HEIGHT; one study page yields at most MAX_TILES tiles (a taller page is downscaled
 * further rather than truncated — never silently drop the end of the notes, where the concept
 * map usually is).
 */
export const TARGET_WIDTH = 1600;
export const TILE_HEIGHT = 2000;
export const MAX_TILES = 4;
/** Board pages per document read (a "note" is normally one long page). */
export const MAX_BOARD_PAGES = 4;
const PAD = 16;
const BG_FETCH_MS = 10_000;

export interface PageRasterizer {
  /** Board JSON (the stored version's bytes) → PNG tiles, top to bottom. [] = nothing drawn. */
  render(boardJson: string): Promise<Buffer[]>;
  close(): Promise<void>;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface BoardPage {
  canvasJSON: string | null;
  bg: { url: string; rect: Rect; rotation: number } | null;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Whiteboard document `{pages:[{canvasJSON, pdfImageUrl?, pdfPlacement?}]}`, or a bare Fabric canvas `{objects}`. */
export function boardPages(raw: string): BoardPage[] {
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error("page content is not valid JSON");
  }
  const list: any[] = Array.isArray(doc?.pages) ? doc.pages : Array.isArray(doc?.objects) ? [{ canvasJSON: raw }] : [];
  return list.slice(0, MAX_BOARD_PAGES).map((p) => {
    const cj = typeof p?.canvasJSON === "string" ? p.canvasJSON : p?.canvasJSON && typeof p.canvasJSON === "object" ? JSON.stringify(p.canvasJSON) : null;
    const pl = p?.pdfPlacement;
    const url = typeof p?.pdfImageUrl === "string" && /^(https?:|data:image\/)/i.test(p.pdfImageUrl) ? p.pdfImageUrl : null;
    const bg =
      url && pl && finite(pl.x) && finite(pl.y) && finite(pl.width) && finite(pl.height) && pl.width > 0 && pl.height > 0
        ? { url, rect: { left: pl.x, top: pl.y, right: pl.x + pl.width, bottom: pl.y + pl.height }, rotation: finite(p.pdfRotation) ? p.pdfRotation : 0 }
        : null;
    return { canvasJSON: cj, bg };
  });
}

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    if (url.startsWith("data:")) return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    const ctl = AbortSignal.timeout(BG_FETCH_MS);
    const r = await fetch(url, { signal: ctl });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** Cut one full-width image into ≤ `budget` tiles, downscaling first when it would need more. */
async function tilesOf(png: Buffer, width: number, height: number, budget: number): Promise<Buffer[]> {
  if (budget <= 0) return [];
  let img = png;
  let w = width;
  let h = height;
  if (Math.ceil(h / TILE_HEIGHT) > budget) {
    const s = (budget * TILE_HEIGHT) / h;
    w = Math.max(1, Math.round(w * s));
    h = Math.min(budget * TILE_HEIGHT, Math.max(1, Math.round(h * s)));
    img = await sharp(png).resize(w, h, { fit: "fill" }).png().toBuffer();
  }
  if (h <= TILE_HEIGHT * 1.2) return [img];
  const n = Math.ceil(h / TILE_HEIGHT);
  const step = Math.ceil(h / n);
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const top = i * step;
    out.push(await sharp(img).extract({ left: 0, top, width: w, height: Math.min(step, h - top) }).png().toBuffer());
  }
  return out;
}

export async function createPageRasterizer(): Promise<PageRasterizer> {
  let ink: InkRenderer | null = null;
  const renderer = async () => (ink ??= await createInkRenderer());
  return {
    async render(boardJson: string) {
      const out: Buffer[] = [];
      for (const [index, p] of boardPages(boardJson).entries()) {
        const bbox = p.canvasJSON ? await (await renderer()).measureInk(p.canvasJSON) : null;
        const rects: Rect[] = [];
        if (bbox) rects.push({ left: bbox.minX, top: bbox.minY, right: bbox.maxX, bottom: bbox.maxY });
        if (p.bg) rects.push(p.bg.rect);
        if (!rects.length) continue;
        const r = {
          left: Math.min(...rects.map((x) => x.left)) - PAD,
          top: Math.min(...rects.map((x) => x.top)) - PAD,
          right: Math.max(...rects.map((x) => x.right)) + PAD,
          bottom: Math.max(...rects.map((x) => x.bottom)) + PAD,
        };
        const scale = Math.min(1, TARGET_WIDTH / (r.right - r.left));
        const W = Math.max(1, Math.round((r.right - r.left) * scale));
        const H = Math.max(1, Math.round((r.bottom - r.top) * scale));
        const layers: sharp.OverlayOptions[] = [];
        if (p.bg) {
          const src = await fetchImage(p.bg.url);
          if (src) {
            const bw = Math.max(1, Math.round((p.bg.rect.right - p.bg.rect.left) * scale));
            const bh = Math.max(1, Math.round((p.bg.rect.bottom - p.bg.rect.top) * scale));
            const bgPng = await sharp(src)
              .rotate(p.bg.rotation || 0, { background: "#ffffff" })
              .resize(bw, bh, { fit: "fill" })
              .png()
              .toBuffer()
              .catch(() => null);
            if (bgPng) layers.push({ input: bgPng, left: Math.round((p.bg.rect.left - r.left) * scale), top: Math.round((p.bg.rect.top - r.top) * scale) });
          }
        }
        if (bbox && p.canvasJSON) {
          const plan = { index, exportScale: scale, tx: -r.left, ty: -r.top, pixelWidth: W, pixelHeight: H, hasInk: true } as OverlayPlan;
          layers.push({ input: await (await renderer()).renderOverlay(p.canvasJSON, plan), left: 0, top: 0 });
        }
        if (!layers.length) continue;
        const full = await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
          .composite(layers)
          .png()
          .toBuffer();
        out.push(...(await tilesOf(full, W, H, MAX_TILES - out.length)));
        if (out.length >= MAX_TILES) break;
      }
      return out;
    },
    async close() {
      if (ink) await ink.close().catch(() => undefined);
      ink = null;
    },
  };
}
