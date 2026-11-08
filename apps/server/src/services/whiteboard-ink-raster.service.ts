/**
 * Server-side rasterisation of whiteboard ink into transparent overlay PNGs.
 *
 * ─── Why a browser ───────────────────────────────────────────────────────────
 * The ink is Fabric.js vector JSON written by Fabric 7.2.0 in a browser. The only
 * way to reproduce it EXACTLY — path smoothing, stroke joins, per-object transforms,
 * and text shaping — is to run the same Fabric build in a real engine.
 * node-canvas has drifted from browser Canvas2D behaviour, so headless Chrome is
 * the only correct path.
 *
 * ─── Lifecycle ───────────────────────────────────────────────────────────────
 * ONE browser and ONE page per job, reused across every board page. A 121-page
 * board would spend minutes in browser startup alone if it relaunched per page.
 * Each call builds and disposes its own `fabric.StaticCanvas` so nothing leaks
 * across pages. The browser is ALWAYS closed by `close()`; callers must run it in
 * a `finally`.
 *
 * ─── What an overlay is ──────────────────────────────────────────────────────
 * Pure ink on transparency. The source PDF page is composited underneath by the
 * merge step, so the background is stripped from the Fabric JSON before it is
 * loaded — an overlay that painted its own background would hide the PDF.
 */

import fs from "fs";
import path from "path";
import puppeteer, { Browser, Page } from "puppeteer";
import { InkBbox, OverlayPlan } from "@/services/whiteboard-ink-geometry";
import { parsePageCanvas } from "@/services/whiteboard-snapshot-reader.service";

/**
 * Hard cap on how many pages one job may rasterise. A 121-page board is normal;
 * a 5000-page one is a runaway. Exported as a plain const because the CALLER
 * enforces it — silently truncating inside the renderer would ship a PDF that is
 * quietly missing a teacher's later pages.
 */
export const MAX_RENDERED_PAGES: number = (() => {
  const raw = Number(process.env.WHITEBOARD_INK_MAX_PAGES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
})();

/** PNG signature — an overlay that does not start with this is not an image. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The exact Fabric build that wrote the data. Vendored — never fetched at runtime. */
const FABRIC_BUNDLE_RELATIVE = path.join("assets", "whiteboard", "fabric-7.2.0.min.js");

/**
 * Resolve a repo asset. `process.cwd()` is the repo root for both `ts-node-dev
 * index.ts` and `node dist/index.js`, and assets are NOT copied into dist, so cwd
 * is the only path that works in both — but a missing asset must be LOUD, since a
 * silently absent Fabric bundle would make every page render blank.
 */
function resolveAsset(relative: string): string {
  const candidates = [
    path.join(process.cwd(), relative),
    path.join(__dirname, "..", relative),
    path.join(__dirname, "..", "..", relative),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `whiteboard-ink-raster: required asset "${relative}" not found. Looked in:\n  ${candidates.join(
      "\n  "
    )}`
  );
}

/**
 * Compositing layers stripped from a page's Fabric JSON before it is loaded.
 * `background` is Fabric's serialised name for `backgroundColor`; the rest are
 * included so a board that ever starts serialising them cannot opaque an overlay.
 */
const BACKGROUND_KEYS = [
  "background",
  "backgroundColor",
  "backgroundImage",
  "overlay",
  "overlayColor",
  "overlayImage",
] as const;

/**
 * Remove every background/overlay layer, leaving only the ink.
 *
 * Pure and exported so the stripping can be asserted directly rather than inferred
 * from a rendered pixel.
 */
export function stripBackgroundLayers<T extends Record<string, any>>(
  canvasData: T
): Record<string, any> {
  const stripped: Record<string, any> = { ...canvasData };
  for (const key of BACKGROUND_KEYS) delete stripped[key];
  return stripped;
}

/**
 * The Fabric viewport transform for one overlay: `screen = a * world + e`.
 *
 * `[s, 0, 0, s, tx*s, ty*s]` applies the world → page translation from the plan and
 * THEN the page → overlay export scale, which is the order the board itself uses.
 * The translation is pre-multiplied by the scale because Fabric's `e`/`f` are in
 * post-scale screen units.
 */
export function overlayViewportTransform(
  plan: Pick<OverlayPlan, "exportScale" | "tx" | "ty">
): [number, number, number, number, number, number] {
  return [
    plan.exportScale,
    0,
    0,
    plan.exportScale,
    plan.tx * plan.exportScale,
    plan.ty * plan.exportScale,
  ];
}

export interface InkRenderer {
  /** World-space bounding box of a page's ink; null when the page has none. */
  measureInk(canvasJSON: string): Promise<InkBbox | null>;
  /** Rasterise a page's ink to a transparent PNG sized by the plan. */
  renderOverlay(canvasJSON: string, plan: OverlayPlan): Promise<Buffer>;
  /** Close the browser. Idempotent; callers must run it in a `finally`. */
  close(): Promise<void>;
}

// ─── Browser-side functions ──────────────────────────────────────────────────
// These run inside Chrome, so they must obey three rules:
//
//  1. No reference to anything in module scope — puppeteer ships them as
//     `fn.toString()`, so only their own body crosses the boundary.
//  2. No DOM types: this tsconfig has no "dom" lib, hence the `globalThis` casts.
//  3. NO async/await ANYWHERE INSIDE THEM. This tsconfig targets es2016, so TS
//     downlevels every `async` function into a call to its `__awaiter` helper —
//     a helper that exists in the compiled module but NOT in the browser, where
//     the stringified function lands. It fails at runtime with the useless
//     "__awaiter is not defined". Promise chains compile to themselves and are
//     therefore the only safe form here.

interface MeasurePayload {
  canvasData: any;
}

interface RenderPayload {
  canvasData: any;
  width: number;
  height: number;
  viewportTransform: [number, number, number, number, number, number];
}

const browserMeasureInk = (payload: MeasurePayload): Promise<any> => {
  const g: any = globalThis as any;
  if (!g.fabric) return Promise.reject(new Error("fabric global is missing in the render page"));

  const element = g.document.createElement("canvas");
  element.width = 1;
  element.height = 1;

  const canvas = new g.fabric.StaticCanvas(element, {
    renderOnAddRemove: false,
    enableRetinaScaling: false,
  });

  return Promise.resolve(canvas.loadFromJSON(payload.canvasData))
    .then(() => {
      const objects = canvas.getObjects();
      if (!objects.length) return null;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const object of objects) {
        // getBoundingRect() already accounts for stroke width, scale and angle,
        // and is in scene (world) coordinates — untouched by the viewport.
        const rect = object.getBoundingRect();
        if (
          !Number.isFinite(rect.left) ||
          !Number.isFinite(rect.top) ||
          !Number.isFinite(rect.width) ||
          !Number.isFinite(rect.height)
        ) {
          continue;
        }
        if (rect.left < minX) minX = rect.left;
        if (rect.top < minY) minY = rect.top;
        if (rect.left + rect.width > maxX) maxX = rect.left + rect.width;
        if (rect.top + rect.height > maxY) maxY = rect.top + rect.height;
      }

      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
      return { minX, minY, maxX, maxY };
    })
    .then(
      // Inlined dispose-and-settle: a module-scope helper would NOT cross the
      // puppeteer boundary (only this function's own source is stringified).
      (value: any) => Promise.resolve(canvas.dispose()).then(() => value),
      (error: any) =>
        Promise.resolve(canvas.dispose()).then(() => {
          throw error;
        })
    );
};

const browserRenderOverlay = (payload: RenderPayload): Promise<any> => {
  const g: any = globalThis as any;
  if (!g.fabric) return Promise.reject(new Error("fabric global is missing in the render page"));

  const element = g.document.createElement("canvas");
  element.width = payload.width;
  element.height = payload.height;

  const canvas = new g.fabric.StaticCanvas(element, {
    width: payload.width,
    height: payload.height,
    renderOnAddRemove: false,
    enableRetinaScaling: false,
    backgroundColor: "",
  });

  return Promise.resolve(canvas.loadFromJSON(payload.canvasData))
    .then(() => {
      // Belt and braces: loadFromJSON restores whatever the JSON carried, and the
      // overlay must be pure transparent ink so the PDF page shows through.
      canvas.backgroundColor = "";
      canvas.backgroundImage = undefined;
      canvas.overlayColor = "";
      canvas.overlayImage = undefined;

      // AFTER the load — loadFromJSON `set()`s leftover top-level keys onto the
      // canvas, so sizing first would let a stale width/height in the JSON win.
      canvas.setDimensions({ width: payload.width, height: payload.height });
      canvas.setViewportTransform(payload.viewportTransform);
      canvas.renderAll();

      return canvas.toDataURL({ format: "png", enableRetinaScaling: false }) as string;
    })
    .then(
      // Inlined dispose-and-settle: a module-scope helper would NOT cross the
      // puppeteer boundary (only this function's own source is stringified).
      (value: any) => Promise.resolve(canvas.dispose()).then(() => value),
      (error: any) =>
        Promise.resolve(canvas.dispose()).then(() => {
          throw error;
        })
    );
};

// ─── Renderer ────────────────────────────────────────────────────────────────

class PuppeteerInkRenderer implements InkRenderer {
  private closed = false;
  /**
   * Serialises calls onto the single shared page. Two concurrent renders on one
   * page would interleave their canvases and hand back each other's pixels.
   */
  private queue: Promise<unknown> = Promise.resolve();
  /** Last uncaught browser-side error, folded into thrown messages for context. */
  private lastPageError: string | null = null;

  constructor(private browser: Browser, private page: Page) {
    this.page.on("pageerror", (error: any) => {
      this.lastPageError = error instanceof Error ? error.message : String(error);
    });
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    // Keep the chain alive even when a task rejects, without leaving an
    // unhandled rejection behind on the internal handle.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private assertOpen(operation: string) {
    if (this.closed) {
      throw new Error(`whiteboard-ink-raster: ${operation} called after the renderer was closed`);
    }
  }

  private context(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return this.lastPageError ? `${message} (page error: ${this.lastPageError})` : message;
  }

  async measureInk(canvasJSON: string): Promise<InkBbox | null> {
    this.assertOpen("measureInk");
    const parsed = parsePageCanvas(canvasJSON);
    if (!parsed) return null;

    return this.run(async () => {
      try {
        const bbox = await this.page.evaluate(browserMeasureInk, { canvasData: parsed });
        return (bbox as InkBbox | null) ?? null;
      } catch (error) {
        throw new Error(
          `whiteboard-ink-raster: measureInk failed for a page with ${parsed.objects.length} ` +
            `object(s): ${this.context(error)}`
        );
      }
    });
  }

  async renderOverlay(canvasJSON: string, plan: OverlayPlan): Promise<Buffer> {
    this.assertOpen("renderOverlay");
    const parsed = parsePageCanvas(canvasJSON);
    if (!parsed) {
      // Never return a blank PNG here: the caller decides which pages need an
      // overlay from `plan.hasInk`, so arriving with no ink means the caller and
      // the data disagree, and a silent empty overlay would hide that.
      throw new Error(
        `whiteboard-ink-raster: renderOverlay called for page index ${plan.index} whose ` +
          `canvasJSON has no ink — check plan.hasInk before rendering`
      );
    }

    const canvasData = stripBackgroundLayers(parsed);
    const viewportTransform = overlayViewportTransform(plan);

    return this.run(async () => {
      let dataUrl: string;
      try {
        dataUrl = (await this.page.evaluate(browserRenderOverlay, {
          canvasData,
          width: plan.pixelWidth,
          height: plan.pixelHeight,
          viewportTransform,
        })) as string;
      } catch (error) {
        throw new Error(
          `whiteboard-ink-raster: renderOverlay failed for page index ${plan.index} ` +
            `(${plan.pixelWidth}x${plan.pixelHeight}, ${parsed.objects.length} objects): ${this.context(
              error
            )}`
        );
      }

      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
        throw new Error(
          `whiteboard-ink-raster: page index ${plan.index} produced a non-PNG data URL ` +
            `(${typeof dataUrl === "string" ? dataUrl.slice(0, 40) : typeof dataUrl})`
        );
      }

      const buffer = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
      if (!buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
        throw new Error(
          `whiteboard-ink-raster: page index ${plan.index} produced ${buffer.length} bytes that ` +
            `are not a PNG (magic ${buffer.subarray(0, 8).toString("hex")})`
        );
      }

      return buffer;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.browser.close();
  }
}

/** Minimal host document; text on boards uses the system fonts. */
const HOST_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html, body { margin: 0; padding: 0; background: transparent; }</style>
</head><body></body></html>`;

/**
 * Launch a renderer. The caller owns the lifetime and MUST call `close()` in a
 * `finally` — a leaked Chrome outlives the request.
 */
export async function createInkRenderer(): Promise<InkRenderer> {
  const fabricBundle = fs.readFileSync(resolveAsset(FABRIC_BUNDLE_RELATIVE), "utf8");

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(HOST_HTML, { waitUntil: "load" });
    await page.addScriptTag({ content: fabricBundle });

    // Wait for the system font set to settle so board text measures the same every run.
    // Promise chain, not async/await: see the browser-side rules above.
    await page.evaluate(() => {
      const g: any = globalThis as any;
      if (!g.fabric) return Promise.reject(new Error("fabric bundle did not define globalThis.fabric"));
      return Promise.resolve(g.document.fonts.ready).then(() => true);
    });

    return new PuppeteerInkRenderer(browser, page);
  } catch (error) {
    await browser.close();
    throw new Error(
      `whiteboard-ink-raster: failed to initialise the render page: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
