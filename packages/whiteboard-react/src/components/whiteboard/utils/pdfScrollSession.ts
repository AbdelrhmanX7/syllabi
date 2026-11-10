import { util, version as FABRIC_VERSION } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { drawScreenFitImage, normalizeRotationDeg } from './backgroundLayers';
import { canvasObjectJson, restorePageObjects, stringifyHistoryObject } from './boardHistoryCanvas';
import { compactCanvasJson } from './canvasJson';
import { invalidateInkBake } from './inkBake';
import { enforceLockedImageInvariants, notifyLockedImagesChanged } from './lockedImages';
import {
  buildPdfScrollLayout,
  findPdfScrollPageAt,
  hasPdfBackground,
  invertSceneTransform,
  markRevivedFromJson,
  pageToSceneTransform,
  PDF_SCROLL_GAP_COLOR,
  PDF_SCROLL_GAP_PX,
  PDF_SCROLL_PAGE_EDGE_COLOR,
  pdfScrollLayoutKey,
  pdfScrollPagePaintTransform,
  pdfScrollViewportForPage,
  recordedPlacement,
  resolvePdfPageAspect,
  resolvePdfScrollCurrentPage,
  resolvePdfScrollPageFrame,
  resolvePdfScrollVisibleRange,
  samePdfScrollPageSequence,
  sheetRuleLineYs,
  sheetRulePitch,
  transformCanvasObjectJson,
  visibleSceneBand,
} from './pdfScrollLayout';
import { restoreRenderInvariants } from './restoreRenderInvariants';
import { isInsertedSheet } from '../types';
import { clampViewportTransform, isSameViewportTransform, resolveFitWidthZoom } from './viewportConstraints';

import type { PageState } from './boardHistory';
import type { HistoryObjectCache, RestorePageResult } from './boardHistoryCanvas';
import type { PdfScrollLayout, PdfScrollPaintArgs, PdfScrollPageFrame, PdfScrollRange, SceneTransform } from './pdfScrollLayout';
import type { ViewportConstraints } from './viewportConstraints';
import type { WhiteboardPage } from '../types';

/**
 * The continuous PDF layout's controller: owns the stacked-page scene (utils/pdfScrollLayout) for ONE
 * Fabric canvas and keeps a WINDOW of pages hydrated onto it.
 *
 * ## What is on the canvas
 *
 * The pages intersecting the viewport, plus {@link PdfScrollSessionOptions.overscanViewports} of
 * canvas height above and below. Each hydrated page's objects are the page's `canvasJSON` enlivened
 * and moved from the page-local frame into the scene (`pageToSceneTransform`); every object carries a
 * tag naming its page. Pages scrolling out of the window are written back (if anything on them
 * changed) and their objects removed. A 120-page book therefore costs the canvas three or four pages
 * of ink at any time, never the book.
 *
 * ## Where new ink goes
 *
 * An object the teacher adds is tagged with the page under its centre at the moment it is added; the
 * tag is re-derived when the object is moved. Flushing a page serializes the objects tagged with it,
 * moved back into the page-local frame, so `canvasJSON` keeps the format the paged layout, the
 * exports and the server-side renderer read today.
 *
 * ## Writers it must not fight
 *
 * The editor's page loads, undo/redo restores and export sweeps replace the WHOLE object set via
 * `loadFromJSON`. A session is never active during a sweep (the editor suspends it), and a history
 * restore within a window is handled by `canvas:cleared`: afterwards every object is re-tagged from
 * its position and every hydrated page is considered changed. The editor keys undo history by the
 * session's window GENERATION — a stack is only ever restored onto the window it was recorded in.
 */

export interface PdfScrollSessionOptions {
  canvas: Canvas;
  /** Scene width: the canvas CSS width when the layout was entered. Fit-width zoom = canvas width ÷ this. */
  width: number;
  gap?: number;
  /** How much of a canvas height to keep hydrated beyond each edge of the viewport. */
  overscanViewports?: number;
  /** Ceiling on the zoom range the constraints hand out. */
  maxZoom: number;
  /** Resolve a page's raster (the editor's live PDF resolver). `null` = nothing to paint for now. */
  resolveImage: (page: WhiteboardPage) => Promise<HTMLImageElement | null>;
  /** The page under the view centre changed. */
  onCurrentPageChange: (index: number) => void;
  /** The hydrated set changed; `generation` is the new undo-history key. */
  onWindowChange: (generation: number) => void;
  /**
   * Pages changed OUTSIDE an owner-driven flush (a page scrolled out of the window with new ink on it,
   * a geometry record learned from a raster). The owner applies `patch` to its live page list.
   */
  onPagesPatched: (patch: (pages: WhiteboardPage[]) => WhiteboardPage[], options: { persist: boolean }) => void;
  /**
   * Raised around the session's own `canvas.add` / `canvas.remove` so the editor's mutation handlers
   * (dirty flag, idle snapshot) do not take hydration for teacher input.
   */
  setExternalWrite: (active: boolean) => void;
  /** True while something else owns the canvas (a page load, a history restore, an export sweep). */
  isWriteBlocked: () => boolean;
  /** The background layer must repaint (a raster landed, the layout moved). */
  requestRepaint: () => void;
  /**
   * A page's objects just landed on the canvas. `sources` are their page-local JSON strings, in the
   * same order — the undo history's baseline for the page and the cached strings of its objects.
   */
  onPageHydrated?: (pageId: string, objects: FabricObject[], sources: string[]) => void;
  /**
   * The undo history's per-object string cache. Flushing a page reuses the strings of its unchanged
   * objects, so a page is written back with exactly the strings it was hydrated with (no float drift
   * through the page→scene→page round trip) and a flush serializes only what was drawn since.
   */
  objectCache?: HistoryObjectCache;
  /** About to take a page's objects off the canvas: the undo history checkpoints what is pending on it. */
  beforeDehydrate?: () => void;
  /**
   * Host opt-in (`WhiteboardEditor.paperOverPdf`): a PDF page's own paper (lined / grid / dotted) is
   * ruled ON TOP of its raster with `multiply`, so the lines show on the white sheet. Read on every
   * sync/paint, so the host may flip it without rebuilding the session.
   */
  paperOverPdf?: () => boolean;
}

interface HydratedPage {
  pageId: string;
  objects: Set<FabricObject>;
  /** The page→scene map the objects were hydrated through (kept in step with soft relayouts). */
  transform: SceneTransform;
  /** The frame that map was built from; `null` when it was derived from a guess and is recomputed on flush. */
  recordedFrame: PdfScrollPageFrame | null;
}

/** How many times a missing page raster is asked for again on its own (≈ 300 ms … 4 s apart). */
const IMAGE_RETRY_LIMIT = 8;

interface PageImageEntry {
  image: HTMLImageElement | null;
  loading: boolean;
}

type TaggedObject = FabricObject & { excludeFromExport?: boolean };

const DEFAULT_OVERSCAN_VIEWPORTS = 1;
/** Ruling on an inserted sheet's lined/grid/dotted paper (the paged board's pattern colour). */
const SHEET_RULE_COLOR = '#e0e0e0';
/** Rasters kept beyond the hydration window on each side. */
const IMAGE_KEEP_MARGIN_PAGES = 2;
/** How long an ink-carrying page without a geometry record waits for its raster before hydrating on the A4 guess. */
const ASPECT_WAIT_MS = 2_500;

const isPdfPage = (page: WhiteboardPage) => hasPdfBackground(page);

function objectCentreY(object: FabricObject): number {
  try {
    return object.getCenterPoint().y;
  } catch {
    return (object.top ?? 0) + ((object.height ?? 0) * (object.scaleY ?? 1)) / 2;
  }
}

/** The frame an object's cached history string is written in: its page and that page's scene map. */
function historyKey(pageId: string, transform: SceneTransform): string {
  return `${pageId}@${transform.scale},${transform.dx},${transform.dy}`;
}

function pageHasInk(page: WhiteboardPage): boolean {
  if (!page.canvasJSON) return false;

  // Cheap and exact enough: a page without objects serializes with an empty array.
  return !/"objects"\s*:\s*\[\s*\]/.test(page.canvasJSON);
}

export class PdfScrollSession {
  readonly width: number;
  readonly gap: number;
  layout: PdfScrollLayout;
  /** True while an export sweep owns the canvas: events are ignored and nothing is hydrated. */
  suspended = false;

  private readonly canvas: Canvas;
  private readonly options: PdfScrollSessionOptions;
  private pages: WhiteboardPage[] = [];
  private pagesById = new Map<string, WhiteboardPage>();
  private layoutKey = '';
  private paperKey = '';
  private readonly hydrated = new Map<string, HydratedPage>();
  private readonly tags = new WeakMap<FabricObject, string>();
  private readonly dirty = new Set<string>();
  private needsRetag = false;
  private readonly images = new Map<string, PageImageEntry>();
  /** Aspects learned from rasters for pages without a record. */
  private readonly learnedAspects = new Map<string, number>();
  private windowRange: PdfScrollRange | null = null;
  private readonly imageRetries = new Map<string, number>();
  private generation = 0;
  private currentIndex = -1;
  private disposed = false;
  private adding = false;
  private removing = false;
  private windowTask: Promise<void> = Promise.resolve();
  private windowTaskQueued = false;
  private viewportFrame: number | null = null;
  private lastViewportSignature = '';
  private readonly detach: () => void;

  constructor(options: PdfScrollSessionOptions) {
    this.options = options;
    this.canvas = options.canvas;
    this.width = Math.max(1, options.width);
    this.gap = options.gap ?? PDF_SCROLL_GAP_PX;
    this.layout = buildPdfScrollLayout([], { aspectOf: () => 1, gap: this.gap, width: this.width });

    const canvas = this.canvas;
    const onAdded = (event: { target?: FabricObject }) => this.handleAdded(event.target);
    const onRemoved = (event: { target?: FabricObject }) => this.handleRemoved(event.target);
    const onModified = (event: { target?: FabricObject }) => this.handleModified(event.target);
    const onCleared = () => this.handleCleared();
    const onAfterRender = () => this.handleAfterRender();

    canvas.on('object:added', onAdded as never);
    canvas.on('object:removed', onRemoved as never);
    canvas.on('object:modified', onModified as never);
    canvas.on('canvas:cleared', onCleared as never);
    canvas.on('after:render', onAfterRender as never);

    this.detach = () => {
      canvas.off('object:added', onAdded as never);
      canvas.off('object:removed', onRemoved as never);
      canvas.off('object:modified', onModified as never);
      canvas.off('canvas:cleared', onCleared as never);
      canvas.off('after:render', onAfterRender as never);
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------------------------

  getFitZoom(): number {
    return resolveFitWidthZoom(this.canvas.getWidth(), this.width);
  }

  getConstraints(): ViewportConstraints {
    const minZoom = this.getFitZoom();

    return {
      maxZoom: Math.max(this.options.maxZoom, minZoom),
      minZoom,
      scene: { bottom: Math.max(this.layout.totalHeight, 1), left: 0, right: this.width, top: 0 },
    };
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getGeneration(): number {
    return this.generation;
  }

  /**
   * The page→scene map of the page at scene `y` — what copy/paste converts through so a copy keeps its
   * page-local size between pages of different scale. The hydrated page's own map when it is on the
   * canvas (that is the one its ink round-trips through), otherwise the one it would be hydrated with.
   */
  sceneTransformAt(y: number): SceneTransform {
    const index = findPdfScrollPageAt(this.layout, y);
    const entry = this.layout.entries[index];
    const page = entry ? this.pagesById.get(entry.pageId) : undefined;

    if (!entry || !page) return { scale: 1, dx: 0, dy: 0 };

    return this.hydrated.get(page.id)?.transform ?? pageToSceneTransform(this.frameFor(page, index), entry, this.layout);
  }

  private aspectOf(page: WhiteboardPage): number {
    const learned = this.learnedAspects.get(page.id);

    if (recordedPlacement(page)) return resolvePdfPageAspect(page);

    if (learned !== undefined) return learned;

    const image = this.images.get(page.id)?.image;

    return resolvePdfPageAspect(page, image ? { height: image.naturalHeight || image.height, width: image.naturalWidth || image.width } : null);
  }

  private buildLayout(pages: WhiteboardPage[]): PdfScrollLayout {
    return buildPdfScrollLayout(pages, { aspectOf: (page) => this.aspectOf(page as WhiteboardPage), gap: this.gap, width: this.width });
  }

  private canvasSize() {
    return { height: this.canvas.getHeight(), width: this.canvas.getWidth() };
  }

  private frameFor(page: WhiteboardPage, index: number): PdfScrollPageFrame {
    const entry = this.layout.entries[index] ?? { aspect: this.aspectOf(page) };

    return resolvePdfScrollPageFrame(page, entry, this.layout, this.canvasSize());
  }

  // ---------------------------------------------------------------------------------------------
  // Pages → layout
  // ---------------------------------------------------------------------------------------------

  /**
   * Take the owner's latest page list. Same geometry: nothing. Same pages with new heights (a raster
   * corrected an A4 guess): a SOFT relayout — hydrated ink moves with its page, nothing is flushed.
   * A different page sequence (insert/delete/reorder/import): a HARD relayout — changed pages are
   * written back, everything is dehydrated, and the window is rebuilt for the new layout.
   */
  syncPages(pages: WhiteboardPage[]): void {
    if (this.disposed) return;

    this.pages = pages;
    this.pagesById = new Map(pages.map((page) => [page.id, page]));

    const nextLayout = this.buildLayout(pages);
    const nextKey = pdfScrollLayoutKey(nextLayout);
    // Inserted sheets paint their paper from the page record: a new paper type or spacing repaints.
    // With paper-over-PDF on, a PDF page's paper is painted too, so its change repaints the same way.
    const paperOverPdf = this.options.paperOverPdf?.() ?? false;
    const nextPaperKey = pages
      .filter((page) => paperOverPdf || isInsertedSheet(page))
      .map((page) => `${page.id}:${page.backgroundType}:${page.paperSpacingMm ?? ''}`)
      .join(',');

    if (nextPaperKey !== this.paperKey) {
      this.paperKey = nextPaperKey;
      this.options.requestRepaint();
    }

    if (nextKey === this.layoutKey) return;

    if (this.layoutKey !== '' && samePdfScrollPageSequence(this.layout, nextLayout)) {
      this.softRelayout(nextLayout, nextKey);

      return;
    }

    this.hardRelayout(nextLayout, nextKey);
  }

  private softRelayout(nextLayout: PdfScrollLayout, nextKey: string): void {
    const previous = this.layout;

    this.layout = nextLayout;
    this.layoutKey = nextKey;

    let moved = false;

    for (const hydratedPage of Array.from(this.hydrated.values())) {
      const before = previous.entries.find((entry) => entry.pageId === hydratedPage.pageId);
      const after = nextLayout.entries.find((entry) => entry.pageId === hydratedPage.pageId);

      if (!before || !after) continue;

      const delta = after.top - before.top;

      if (Math.abs(delta) < 1e-6) continue;

      hydratedPage.transform = { ...hydratedPage.transform, dy: hydratedPage.transform.dy + delta };

      for (const object of Array.from(hydratedPage.objects)) {
        object.set('top', (object.top ?? 0) + delta);
        object.setCoords();
      }

      moved = true;
    }

    if (moved) {
      invalidateInkBake(this.canvas);
      this.canvas.requestRenderAll();
    }

    this.options.requestRepaint();
    this.scheduleViewportCheck();
  }

  private hardRelayout(nextLayout: PdfScrollLayout, nextKey: string): void {
    // Whatever changed on the canvas belongs to the pages as they were laid out.
    this.writeBackDirty({ persist: true });
    this.dehydrateAll();
    this.layout = nextLayout;
    this.layoutKey = nextKey;
    this.windowRange = null;
    this.options.requestRepaint();
    this.scheduleWindowUpdate();
  }

  // ---------------------------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------------------------

  /**
   * Show page `index` from its top. The zoom is kept when the view is already zoomed in (a tap on
   * the page list while reading a detail), else the page fills the width.
   */
  async enter(index: number, options?: { keepZoom?: boolean }): Promise<void> {
    if (this.disposed || this.suspended) return;

    const entryCount = this.layout.entries.length;

    if (entryCount === 0) return;

    const safeIndex = Math.min(Math.max(index, 0), entryCount - 1);
    const fitZoom = this.getFitZoom();
    const currentZoom = this.canvas.getZoom();
    const zoom = options?.keepZoom && currentZoom > fitZoom + 1e-6 ? currentZoom : fitZoom;
    const target = pdfScrollViewportForPage(this.layout, safeIndex, zoom);
    const clamped = clampViewportTransform(
      [target.zoom, 0, 0, target.zoom, options?.keepZoom ? (this.canvas.viewportTransform?.[4] ?? 0) : 0, target.offsetY],
      this.getConstraints(),
      this.canvas.getWidth(),
      this.canvas.getHeight(),
    );

    if (!isSameViewportTransform(this.canvas.viewportTransform, clamped)) {
      this.canvas.setViewportTransform(clamped);
    }

    this.canvas.requestRenderAll();
    this.setCurrentIndex(safeIndex);
    await this.updateWindow();
  }

  private setCurrentIndex(index: number): void {
    if (index === this.currentIndex) return;

    this.currentIndex = index;
    this.options.onCurrentPageChange(index);
  }

  // ---------------------------------------------------------------------------------------------
  // Viewport tracking
  // ---------------------------------------------------------------------------------------------

  private handleAfterRender(): void {
    if (this.disposed || this.suspended) return;

    const vt = this.canvas.viewportTransform;
    const signature = vt ? `${vt[0]?.toFixed(4)},${vt[4]?.toFixed(1)},${vt[5]?.toFixed(1)}` : '';

    if (signature === this.lastViewportSignature) return;

    this.lastViewportSignature = signature;
    this.scheduleViewportCheck();
  }

  private scheduleViewportCheck(): void {
    if (this.viewportFrame !== null || typeof window === 'undefined') return;

    this.viewportFrame = window.requestAnimationFrame(() => {
      this.viewportFrame = null;
      this.checkViewport();
    });
  }

  private viewport() {
    const vt = this.canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];

    return { offsetY: vt[5] ?? 0, zoom: vt[0] || 1 };
  }

  private checkViewport(): void {
    if (this.disposed || this.suspended || this.layout.entries.length === 0) return;

    const viewport = this.viewport();
    const canvasHeight = this.canvas.getHeight();
    const current = resolvePdfScrollCurrentPage(this.layout, viewport, canvasHeight);

    if (current >= 0) this.setCurrentIndex(current);

    const range = resolvePdfScrollVisibleRange(this.layout, viewport, canvasHeight, canvasHeight * (this.options.overscanViewports ?? DEFAULT_OVERSCAN_VIEWPORTS));

    if (range && (!this.windowRange || range.start !== this.windowRange.start || range.end !== this.windowRange.end)) {
      this.scheduleWindowUpdate();
    }

    this.ensureImagesAround(range);
  }

  // ---------------------------------------------------------------------------------------------
  // Hydration window
  // ---------------------------------------------------------------------------------------------

  private scheduleWindowUpdate(): void {
    if (this.windowTaskQueued) return;

    this.windowTaskQueued = true;
    this.windowTask = this.windowTask.then(() => {
      this.windowTaskQueued = false;

      return this.updateWindow();
    });
  }

  private async updateWindow(): Promise<void> {
    if (this.disposed || this.suspended || this.layout.entries.length === 0) return;

    const canvasHeight = this.canvas.getHeight();
    const range = resolvePdfScrollVisibleRange(
      this.layout,
      this.viewport(),
      canvasHeight,
      canvasHeight * (this.options.overscanViewports ?? DEFAULT_OVERSCAN_VIEWPORTS),
    );

    if (!range) return;

    const wanted = new Set<string>();

    for (let index = range.start; index <= range.end; index += 1) {
      const entry = this.layout.entries[index];

      if (entry) wanted.add(entry.pageId);
    }

    let changed = false;

    // Pages leaving the window: write back what changed, then take their objects down.
    for (const pageId of Array.from(this.hydrated.keys())) {
      if (wanted.has(pageId)) continue;

      this.writeBackDirty({ onlyPageIds: [pageId], persist: true });
      this.dehydratePage(pageId);
      changed = true;
    }

    // Pages entering the window, in reading order.
    const toHydrate = Array.from(wanted).filter((pageId) => !this.hydrated.has(pageId));

    if (toHydrate.length > 0) {
      // An ink-carrying page without a geometry record is framed from its RASTER's aspect (the paged
      // layout would frame it from the live canvas the same way); hydrating it on the A4 guess would
      // put its ink on the wrong part of the page, so its raster is waited for — briefly.
      await Promise.all(
        toHydrate.map((pageId) => {
          const page = this.pagesById.get(pageId);

          if (!page || recordedPlacement(page) || !isPdfPage(page) || !pageHasInk(page)) return Promise.resolve();

          return this.waitForAspect(page, ASPECT_WAIT_MS);
        }),
      );

      if (this.disposed || this.suspended) return;

      // The wait may have corrected heights (a soft relayout); the entries below are read fresh.
      for (const pageId of toHydrate) {
        const page = this.pagesById.get(pageId);
        const index = this.layout.entries.findIndex((entry) => entry.pageId === pageId);

        if (!page || index < 0) continue;

        await this.hydratePage(page, index);
        changed = true;
      }
    }

    this.windowRange = range;
    this.ensureImagesAround(range);

    if (changed) {
      this.generation += 1;
      this.options.onWindowChange(this.generation);
    }
  }

  private async hydratePage(page: WhiteboardPage, index: number): Promise<void> {
    if (this.disposed || this.suspended || this.hydrated.has(page.id)) return;

    const entry = this.layout.entries[index];

    if (!entry) return;

    const frame = this.frameFor(page, index);
    const transform = pageToSceneTransform(frame, entry, this.layout);
    const hydratedPage: HydratedPage = {
      objects: new Set(),
      pageId: page.id,
      recordedFrame: frame.recorded ? frame : null,
      transform,
    };

    let objects: FabricObject[] = [];
    let sources: string[] = [];

    if (page.canvasJSON) {
      try {
        const parsed = JSON.parse(page.canvasJSON) as { objects?: Array<Record<string, unknown>> };
        const localObjects = parsed.objects ?? [];
        const sceneObjects = localObjects.map((object) => transformCanvasObjectJson(object, transform));

        sources = localObjects.map((object) => JSON.stringify(object));
        objects = await util.enlivenObjects<FabricObject>(sceneObjects);
      } catch {
        objects = [];
      }
    }

    if (objects.length !== sources.length) sources = [];

    // The page may have left the window (or the session ended) while its objects were enlivened.
    if (this.disposed || this.suspended || this.hydrated.has(page.id)) return;

    const stillWanted = this.layout.entries[index]?.pageId === page.id;

    if (!stillWanted) return;

    // A page hydrated with no ink has no frame to honour: its frame is derived on flush from
    // whatever is known about its raster by then.
    if (objects.length === 0) hydratedPage.recordedFrame = frame.recorded ? frame : null;

    this.hydrated.set(page.id, hydratedPage);

    if (objects.length > 0) {
      const key = historyKey(page.id, transform);

      objects.forEach((object, objectIndex) => {
        this.tags.set(object, page.id);
        hydratedPage.objects.add(object);

        const source = sources[objectIndex];

        if (source !== undefined) this.options.objectCache?.seed(object, key, source);
      });

      // These are revived, not drawn: a host's `_onObjectAdded` hook (the lecture stroke clock) must
      // not stamp them as new ink the way `loadFromJSON`'s reviver would have told it.
      markRevivedFromJson(objects);

      this.options.setExternalWrite(true);
      this.adding = true;

      try {
        this.canvas.add(...objects);
        restoreRenderInvariants(this.canvas);
        enforceLockedImageInvariants(this.canvas);
        notifyLockedImagesChanged(this.canvas);
      } finally {
        this.adding = false;
        this.options.setExternalWrite(false);
      }

      // No `invalidateInkBake` here: the page's objects are APPENDED, so the baked prefix still holds
      // (anything the invariants above reorder is caught by the bake's identity check). Invalidating
      // threw the bake away every time a scroll crossed into a new page, and since nothing can be
      // rebaked while the finger is down, the rest of the gesture re-rendered every stroke per frame.
      this.canvas.requestRenderAll();
    }

    this.options.onPageHydrated?.(page.id, objects, sources);
  }

  private dehydratePage(pageId: string): void {
    const hydratedPage = this.hydrated.get(pageId);

    if (!hydratedPage) return;

    this.options.beforeDehydrate?.();

    this.hydrated.delete(pageId);
    this.dirty.delete(pageId);

    const objects = Array.from(hydratedPage.objects).filter((object) => this.canvas.getObjects().includes(object));

    if (objects.length === 0) return;

    const active = this.canvas.getActiveObject();

    if (active && (objects.includes(active) || hydratedPage.objects.has(active))) {
      this.canvas.discardActiveObject();
    }

    this.options.setExternalWrite(true);
    this.removing = true;

    try {
      this.canvas.remove(...objects);
    } finally {
      this.removing = false;
      this.options.setExternalWrite(false);
    }

    // No `invalidateInkBake`: every removal fires `object:removed`, which the bake handles itself — an
    // off-screen page (the usual case here) is simply dropped from its record, an on-screen one is
    // patched in place or marks it stale (see `patchRemoval` in inkBake.ts).
    this.canvas.requestRenderAll();
  }

  private dehydrateAll(): void {
    for (const pageId of Array.from(this.hydrated.keys())) {
      this.dehydratePage(pageId);
    }

    this.dirty.clear();
    this.needsRetag = false;
  }

  // ---------------------------------------------------------------------------------------------
  // Tagging
  // ---------------------------------------------------------------------------------------------

  private isTrackable(object: FabricObject | undefined): object is TaggedObject {
    return Boolean(object) && !(object as TaggedObject).excludeFromExport;
  }

  /** The hydrated page an object at scene `y` belongs to — the nearest one when `y` is on a page that is not hydrated. */
  private pageIdForY(y: number): string | null {
    const index = findPdfScrollPageAt(this.layout, y);

    if (index < 0) return null;

    const direct = this.layout.entries[index]?.pageId;

    if (direct && this.hydrated.has(direct)) return direct;

    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const pageId of Array.from(this.hydrated.keys())) {
      const entry = this.layout.entries.find((candidate) => candidate.pageId === pageId);

      if (!entry) continue;

      const distance = y < entry.top ? entry.top - y : y > entry.top + entry.height ? y - (entry.top + entry.height) : 0;

      if (distance < bestDistance) {
        bestDistance = distance;
        best = pageId;
      }
    }

    return best;
  }

  private tagObject(object: FabricObject): string | null {
    const pageId = this.pageIdForY(objectCentreY(object));

    if (!pageId) return null;

    const previous = this.tags.get(object);

    if (previous && previous !== pageId) {
      this.hydrated.get(previous)?.objects.delete(object);
      this.dirty.add(previous);
    }

    this.tags.set(object, pageId);
    this.hydrated.get(pageId)?.objects.add(object);
    this.dirty.add(pageId);

    return pageId;
  }

  private handleAdded(target: FabricObject | undefined): void {
    if (this.disposed || this.suspended || this.adding || this.options.isWriteBlocked()) return;
    if (!this.isTrackable(target)) return;

    this.tagObject(target);
  }

  private handleRemoved(target: FabricObject | undefined): void {
    if (this.disposed || this.suspended || this.removing || this.options.isWriteBlocked()) return;
    if (!target) return;

    const pageId = this.tags.get(target);

    if (!pageId) return;

    this.hydrated.get(pageId)?.objects.delete(target);
    this.dirty.add(pageId);
  }

  private handleModified(target: FabricObject | undefined): void {
    if (this.disposed || this.suspended || this.options.isWriteBlocked()) return;
    if (!target) return;

    // A multi-selection is not on the canvas itself: its members are what moved.
    const group = target as FabricObject & { getObjects?: () => FabricObject[] };
    const members = typeof group.getObjects === 'function' && !this.canvas.getObjects().includes(target) ? group.getObjects() : [target];

    for (const member of members) {
      if (!this.isTrackable(member)) continue;

      const previous = this.tags.get(member);

      this.tagObject(member);

      if (previous) this.dirty.add(previous);
    }
  }

  private handleCleared(): void {
    if (this.disposed || this.suspended || this.removing) return;

    // Something replaced the whole object set (a history restore): the objects now on the canvas are
    // new instances positioned in the scene. They are re-tagged from their positions on the next
    // flush and every hydrated page is written, since any of them may have changed.
    this.needsRetag = true;

    for (const pageId of Array.from(this.hydrated.keys())) this.dirty.add(pageId);
  }

  private retagAll(): void {
    this.needsRetag = false;

    for (const hydratedPage of Array.from(this.hydrated.values())) hydratedPage.objects.clear();

    for (const object of this.canvas.getObjects()) {
      if (!this.isTrackable(object)) continue;

      this.tagObject(object);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Flush
  // ---------------------------------------------------------------------------------------------

  private serializePage(hydratedPage: HydratedPage, page: WhiteboardPage): { canvasJSON: string; frame: PdfScrollPageFrame } {
    const { frame, transform } = this.sceneMapFor(hydratedPage, page);
    const toLocal = invertSceneTransform(transform);
    const ordered = this.pageObjectsInOrder(hydratedPage);
    // Through the canvas's own per-object serializer: a member of an active multi-selection is stored
    // relative to the selection, and only that path realizes the selection's transform onto it.
    const toJson = (object: FabricObject) => transformCanvasObjectJson(canvasObjectJson(this.canvas, object), toLocal);
    const cache = this.options.objectCache;

    if (!cache) {
      const json = compactCanvasJson({ background: 'transparent', objects: ordered.map(toJson), version: FABRIC_VERSION });

      return { canvasJSON: JSON.stringify(json), frame };
    }

    // Same bytes JSON.stringify writes for { background, objects, version } — built from the cached
    // per-object strings.
    const key = historyKey(hydratedPage.pageId, transform);
    const objects = ordered.map((object) => cache.get(object, key, () => stringifyHistoryObject(toJson(object))));

    return {
      canvasJSON: `{"background":"transparent","objects":[${objects.join(',')}],"version":${JSON.stringify(FABRIC_VERSION)}}`,
      frame,
    };
  }

  /** The frame a page is recorded with on flush, and the page→scene map its ink round-trips through. */
  private sceneMapFor(hydratedPage: HydratedPage, page: WhiteboardPage): { frame: PdfScrollPageFrame; transform: SceneTransform } {
    const index = this.layout.entries.findIndex((entry) => entry.pageId === page.id);
    const entry = this.layout.entries[index];
    // A recorded page round-trips through the exact map it was hydrated with. A page framed from a
    // guess is framed NOW, from the best-known aspect, and that frame is what gets recorded.
    const frame = hydratedPage.recordedFrame ?? this.frameFor(page, index);
    const transform = hydratedPage.recordedFrame || !entry ? hydratedPage.transform : pageToSceneTransform(frame, entry, this.layout);

    return { frame, transform };
  }

  private pageObjectsInOrder(hydratedPage: HydratedPage): FabricObject[] {
    return this.canvas.getObjects().filter((object) => hydratedPage.objects.has(object) && this.isTrackable(object));
  }

  // ---------------------------------------------------------------------------------------------
  // Undo history (utils/boardHistory) — page-local states of the hydrated pages
  // ---------------------------------------------------------------------------------------------

  /**
   * Every hydrated page with its objects in z-order, and `key`: the page plus the map its strings are
   * written through (a string cached under another key is stale).
   */
  historyPages(): Array<{ pageId: string; objects: FabricObject[]; key: string }> {
    if (this.disposed || this.suspended) return [];

    if (this.needsRetag) this.retagAll();

    const result: Array<{ pageId: string; objects: FabricObject[]; key: string }> = [];

    this.hydrated.forEach((hydratedPage, pageId) => {
      const page = this.pagesById.get(pageId);

      if (!page) return;

      const { transform } = this.sceneMapFor(hydratedPage, page);

      result.push({ key: historyKey(pageId, transform), objects: this.pageObjectsInOrder(hydratedPage), pageId });
    });

    return result;
  }

  /** One object of a hydrated page as the page's `canvasJSON` would hold it (page-local, unrounded). */
  historyObjectJson(pageId: string, object: FabricObject): Record<string, unknown> {
    const hydratedPage = this.hydrated.get(pageId);
    const page = this.pagesById.get(pageId);
    const json = canvasObjectJson(this.canvas, object);

    if (!hydratedPage || !page) return json;

    return transformCanvasObjectJson(json, invertSceneTransform(this.sceneMapFor(hydratedPage, page).transform));
  }

  pageIndexOf(pageId: string): number {
    return this.layout.entries.findIndex((entry) => entry.pageId === pageId);
  }

  /**
   * Bring a page into view (an undo landing on it must be SEEN) and onto the canvas. A page already
   * intersecting the viewport is left where it is. Resolves true once the page is hydrated.
   */
  async revealPage(pageId: string): Promise<boolean> {
    if (this.disposed || this.suspended) return false;

    const index = this.pageIndexOf(pageId);
    const entry = this.layout.entries[index];

    if (!entry) return false;

    const band = visibleSceneBand(this.viewport(), this.canvas.getHeight());
    const onScreen = entry.top < band.bottom && entry.top + entry.height > band.top;

    if (!onScreen) {
      await this.enter(index, { keepZoom: true });
    } else if (!this.hydrated.has(pageId)) {
      await this.updateWindow();
    }

    return this.hydrated.has(pageId);
  }

  /**
   * Put a hydrated page's objects into a recorded state (see restorePageObjects). Written as the
   * session's own write — tagged to the page, the page marked changed for the next flush — so the
   * editor's input handlers do not take it for a new stroke.
   */
  async restorePageState(pageId: string, liveState: PageState, target: PageState, isCurrent?: () => boolean): Promise<RestorePageResult | null> {
    const hydratedPage = this.hydrated.get(pageId);
    const page = this.pagesById.get(pageId);

    if (this.disposed || this.suspended || !hydratedPage || !page) return null;

    const { transform } = this.sceneMapFor(hydratedPage, page);
    const live = this.pageObjectsInOrder(hydratedPage);

    if (live.length !== liveState.length) return null;

    const enliven = async (values: string[]) => {
      const sceneObjects = values.map((value) => transformCanvasObjectJson(JSON.parse(value) as Record<string, unknown>, transform));
      const objects = await util.enlivenObjects<FabricObject>(sceneObjects);

      markRevivedFromJson(objects);

      return objects;
    };

    let result: RestorePageResult;

    this.options.setExternalWrite(true);
    this.adding = true;
    this.removing = true;

    try {
      result = await restorePageObjects({
        canvas: this.canvas,
        enliven,
        isCurrent: () => !this.disposed && !this.suspended && this.hydrated.get(pageId) === hydratedPage && (isCurrent?.() ?? true),
        live,
        liveState,
        target,
      });

      if (result.ok) {
        for (const object of result.removed) hydratedPage.objects.delete(object);

        for (const object of result.added) {
          this.tags.set(object, pageId);
          hydratedPage.objects.add(object);
        }

        restoreRenderInvariants(this.canvas);
        enforceLockedImageInvariants(this.canvas);
        notifyLockedImagesChanged(this.canvas);
      }
    } finally {
      this.adding = false;
      this.removing = false;
      this.options.setExternalWrite(false);
    }

    if (result.ok) {
      this.dirty.add(pageId);
      invalidateInkBake(this.canvas);
      this.canvas.requestRenderAll();
    }

    return result;
  }

  private patchPage(page: WhiteboardPage, canvasJSON: string, frame: PdfScrollPageFrame): WhiteboardPage {
    const next: WhiteboardPage = { ...page, canvasJSON, canvasWidthPx: frame.frameWidth };

    if (isPdfPage(page)) {
      next.pdfPlacement = { ...frame.placement };
    } else {
      delete next.pdfPlacement;
    }

    // The page frame is document-wide now: a per-page viewport no longer describes anything.
    delete next.viewportOffsetX;
    delete next.viewportOffsetY;
    delete next.viewportZoom;

    return next;
  }

  /**
   * Write every changed hydrated page into `sourcePages` (matched by id). Returns the same array when
   * nothing changed. This is what the editor's snapshot path calls in place of serializing the canvas.
   */
  flush(sourcePages: WhiteboardPage[], options?: { onlyPageIds?: readonly string[] }): WhiteboardPage[] {
    if (this.disposed || this.hydrated.size === 0) return sourcePages;

    if (this.needsRetag) this.retagAll();

    const targets = options?.onlyPageIds ? options.onlyPageIds.filter((pageId) => this.dirty.has(pageId)) : Array.from(this.dirty);

    if (targets.length === 0) return sourcePages;

    let next: WhiteboardPage[] | null = null;

    for (const pageId of targets) {
      const hydratedPage = this.hydrated.get(pageId);
      const index = sourcePages.findIndex((page) => page.id === pageId);
      const page = sourcePages[index];

      this.dirty.delete(pageId);

      if (!hydratedPage || !page) continue;

      const { canvasJSON, frame } = this.serializePage(hydratedPage, page);
      const patched = this.patchPage(page, canvasJSON, frame);

      if (
        patched.canvasJSON === page.canvasJSON &&
        patched.canvasWidthPx === page.canvasWidthPx &&
        JSON.stringify(patched.pdfPlacement) === JSON.stringify(page.pdfPlacement) &&
        page.viewportZoom === undefined
      ) {
        continue;
      }

      next ??= sourcePages.slice();
      next[index] = patched;
    }

    if (next) {
      this.pages = next;
      this.pagesById = new Map(next.map((page) => [page.id, page]));
    }

    return next ?? sourcePages;
  }

  /** Flush through the owner (a write the owner did not ask for: dehydration, a hard relayout). */
  private writeBackDirty(options: { onlyPageIds?: readonly string[]; persist: boolean }): void {
    if (this.needsRetag) this.retagAll();

    const targets = options.onlyPageIds ? options.onlyPageIds.filter((pageId) => this.dirty.has(pageId)) : Array.from(this.dirty);

    if (targets.length === 0) return;

    this.options.onPagesPatched((pages) => this.flush(pages, { onlyPageIds: targets }), { persist: options.persist });
  }

  /** Everything hydrated becomes dirty (the owner is about to lose the canvas). */
  markAllDirty(): void {
    for (const pageId of Array.from(this.hydrated.keys())) this.dirty.add(pageId);
  }

  // ---------------------------------------------------------------------------------------------
  // Rasters
  // ---------------------------------------------------------------------------------------------

  private ensureImagesAround(range: PdfScrollRange | null): void {
    if (!range) return;

    const start = Math.max(0, range.start - 1);
    const end = Math.min(this.layout.entries.length - 1, range.end + 1);

    for (let index = start; index <= end; index += 1) {
      const page = this.pagesById.get(this.layout.entries[index]?.pageId ?? '');

      if (page && isPdfPage(page)) void this.ensureImage(page);
    }

    // Evict rasters far from the window; the renderers keep their own caches.
    for (const pageId of Array.from(this.images.keys())) {
      const index = this.layout.entries.findIndex((entry) => entry.pageId === pageId);

      if (index < 0 || index < range.start - IMAGE_KEEP_MARGIN_PAGES || index > range.end + IMAGE_KEEP_MARGIN_PAGES) {
        this.images.delete(pageId);
      }
    }
  }

  private ensureImage(page: WhiteboardPage): Promise<void> {
    const existing = this.images.get(page.id);

    if (existing && (existing.image || existing.loading)) return Promise.resolve();

    const entry: PageImageEntry = { image: null, loading: true };

    this.images.set(page.id, entry);

    return this.options
      .resolveImage(page)
      .then((image) => {
        if (this.disposed) return;

        entry.loading = false;
        entry.image = image;

        if (image) {
          this.imageRetries.delete(page.id);
          this.learnAspect(page, image);
        } else {
          this.retryImageSoon(page.id);
        }

        this.options.requestRepaint();
      })
      .catch(() => {
        entry.loading = false;
        this.retryImageSoon(page.id);
      });
  }

  /**
   * A page whose raster was not ready yet (the PDF still being saved or fetched right after an
   * import) is asked for again by itself — otherwise it stayed blank until the next scroll.
   */
  private retryImageSoon(pageId: string): void {
    const attempt = (this.imageRetries.get(pageId) ?? 0) + 1;

    if (attempt > IMAGE_RETRY_LIMIT || this.disposed) return;

    this.imageRetries.set(pageId, attempt);
    setTimeout(() => {
      if (this.disposed || this.suspended) return;

      const entry = this.images.get(pageId);

      if (entry && !entry.image && !entry.loading) this.images.delete(pageId);

      this.checkViewport();
    }, Math.min(4000, 300 * 2 ** (attempt - 1)));
  }

  private learnAspect(page: WhiteboardPage, image: HTMLImageElement): void {
    if (recordedPlacement(page)) return;

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;

    if (!(width > 0) || !(height > 0)) return;

    const aspect = resolvePdfPageAspect(page, { height, width });
    const previous = this.learnedAspects.get(page.id);

    this.learnedAspects.set(page.id, aspect);

    if (previous !== undefined && Math.abs(previous - aspect) < 1e-4) return;

    // Heights changed → a soft relayout through the owner's page list (same ids, new aspects).
    this.syncPages(this.pages);

    // Record the frame now, so the next open lays the page out right from the first frame. A page
    // with ink on screen is written on its own flush; this is for the clean ones.
    const current = this.pagesById.get(page.id);

    if (current && !recordedPlacement(current) && !this.dirty.has(page.id)) {
      const index = this.layout.entries.findIndex((candidate) => candidate.pageId === page.id);

      if (index >= 0) {
        const frame = this.frameFor(current, index);

        this.options.onPagesPatched(
          (pages) =>
            pages.map((candidate) =>
              candidate.id === page.id && !recordedPlacement(candidate)
                ? { ...candidate, canvasWidthPx: frame.frameWidth, pdfPlacement: { ...frame.placement } }
                : candidate,
            ),
          { persist: true },
        );
      }
    }
  }

  private waitForAspect(page: WhiteboardPage, timeoutMs: number): Promise<void> {
    if (this.learnedAspects.has(page.id)) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;

        settled = true;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);

      void this.ensureImage(page).finally(() => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Painting
  // ---------------------------------------------------------------------------------------------

  paint(ctx: CanvasRenderingContext2D, args: PdfScrollPaintArgs): void {
    if (this.disposed || this.layout.entries.length === 0) return;

    const { height, pixelRatio, quality, viewportTransform, width } = args;
    const dpr = pixelRatio > 0 ? pixelRatio : 1;
    const zoom = viewportTransform[0] || 1;
    const offsetX = viewportTransform[4] || 0;
    const offsetY = viewportTransform[5] || 0;
    const band = visibleSceneBand({ offsetY, zoom }, height);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PDF_SCROLL_GAP_COLOR;
    ctx.fillRect(0, 0, Math.round(width * dpr), Math.round(height * dpr));

    // Scene → device: the live viewport with the pixel ratio folded in.
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * offsetX, dpr * offsetY);

    const first = Math.max(0, findPdfScrollPageAt(this.layout, band.top));
    const last = Math.max(first, findPdfScrollPageAt(this.layout, band.bottom));

    for (let index = first; index <= last; index += 1) {
      const entry = this.layout.entries[index];

      if (!entry || entry.top > band.bottom || entry.top + entry.height < band.top) continue;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, entry.top, this.width, entry.height);
      this.paintSheetRuling(ctx, entry, band, zoom);
      ctx.strokeStyle = PDF_SCROLL_PAGE_EDGE_COLOR;
      ctx.lineWidth = 1 / zoom;
      ctx.strokeRect(0.5 / zoom, entry.top + 0.5 / zoom, this.width - 1 / zoom, entry.height - 1 / zoom);
    }

    ctx.restore();

    for (let index = first; index <= last; index += 1) {
      const entry = this.layout.entries[index];
      const page = entry ? this.pagesById.get(entry.pageId) : undefined;
      const image = entry ? this.images.get(entry.pageId)?.image : null;

      if (!entry || !page || !image) continue;
      if (entry.top > band.bottom || entry.top + entry.height < band.top) continue;

      const frame = this.frameFor(page, index);
      const transform = pageToSceneTransform(frame, entry, this.layout);

      // The paged layout's own fit math, against the page-local frame, through the page→scene map:
      // the raster lands exactly on the sheet drawn above, rotation included.
      drawScreenFitImage(
        ctx,
        frame.frameWidth,
        frame.frameHeight,
        image,
        image.naturalWidth || image.width,
        image.naturalHeight || image.height,
        1,
        pdfScrollPagePaintTransform(viewportTransform, transform),
        quality,
        dpr,
        normalizeRotationDeg(page.pdfRotation),
      );
    }

    // Paper over the PDF (host opt-in): the white PDF sheet hides nothing drawn under it, so a PDF
    // page's paper is ruled AFTER its raster, clipped to its sheet, with `multiply` — white stays the
    // page, the lines show on it, and the print stays dark. Same pitch/colour as an inserted sheet.
    if (this.options.paperOverPdf?.()) {
      for (let index = first; index <= last; index += 1) {
        const entry = this.layout.entries[index];
        const page = entry ? this.pagesById.get(entry.pageId) : undefined;

        if (!entry || !page || isInsertedSheet(page) || !page.backgroundType || page.backgroundType === 'blank') continue;
        if (entry.top > band.bottom || entry.top + entry.height < band.top) continue;

        ctx.save();
        ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * offsetX, dpr * offsetY);
        ctx.beginPath();
        ctx.rect(0, entry.top, this.width, entry.height);
        ctx.clip();
        ctx.globalCompositeOperation = 'multiply';
        this.paintSheetRuling(ctx, entry, band, zoom, true);
        ctx.restore();
      }
    }
  }

  /**
   * A sheet's paper (lined / grid / dotted) inside its own rect. Inserted sheets only, unless
   * `overPdf` (the paper-over-PDF pass, which rules a PDF page on top of its raster).
   */
  private paintSheetRuling(
    ctx: CanvasRenderingContext2D,
    entry: PdfScrollLayout['entries'][number],
    band: { top: number; bottom: number },
    zoom: number,
    overPdf = false,
  ): void {
    const page = this.pagesById.get(entry.pageId);
    const paper = page?.backgroundType;

    if (!page || (!overPdf && !isInsertedSheet(page)) || !paper || paper === 'blank') return;

    const ys = sheetRuleLineYs(entry, this.width, band.top, band.bottom, page.paperSpacingMm);

    if (ys.length === 0) return;

    const pitch = sheetRulePitch(this.width, page.paperSpacingMm);

    ctx.save();
    ctx.strokeStyle = SHEET_RULE_COLOR;
    ctx.fillStyle = SHEET_RULE_COLOR;
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();

    if (paper === 'dotted') {
      const radius = Math.max(1 / zoom, pitch / 24);

      for (const y of ys) {
        for (let x = pitch; x < this.width; x += pitch) {
          ctx.moveTo(x + radius, y);
          ctx.arc(x, y, radius, 0, Math.PI * 2);
        }
      }

      ctx.fill();
    } else {
      for (const y of ys) {
        ctx.moveTo(0, y);
        ctx.lineTo(this.width, y);
      }

      if (paper === 'grid') {
        const top = Math.max(entry.top, band.top);
        const bottom = Math.min(entry.top + entry.height, band.bottom);

        for (let x = pitch; x < this.width; x += pitch) {
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
        }
      }

      ctx.stroke();
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  /**
   * Hand the canvas to a sweep that will `loadFromJSON` every page through it: write back, take the
   * window down, ignore events until {@link resume}.
   */
  suspend(): void {
    if (this.disposed || this.suspended) return;

    this.writeBackDirty({ persist: true });
    this.dehydrateAll();
    this.windowRange = null;
    this.suspended = true;
  }

  async resume(index: number): Promise<void> {
    if (this.disposed || !this.suspended) return;

    this.suspended = false;
    this.lastViewportSignature = '';
    this.currentIndex = -1;
    await this.enter(index);
  }

  /** Write back and remove everything. The owner reloads its current page in the paged layout afterwards. */
  dispose(): WhiteboardPage[] | null {
    if (this.disposed) return null;

    let patched: WhiteboardPage[] | null = null;

    if (!this.suspended) {
      if (this.needsRetag) this.retagAll();

      const targets = Array.from(this.dirty);

      if (targets.length > 0) {
        this.options.onPagesPatched(
          (pages) => {
            patched = this.flush(pages, { onlyPageIds: targets });

            return patched;
          },
          { persist: true },
        );
      }

      this.dehydrateAll();
    }

    this.disposed = true;
    this.detach();

    if (this.viewportFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.viewportFrame);
      this.viewportFrame = null;
    }

    this.images.clear();

    return patched;
  }
}
