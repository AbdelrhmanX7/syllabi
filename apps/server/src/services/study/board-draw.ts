import { randomUUID } from "crypto";
import { publishPageEvent } from "@/services/study/page-live";
import { Types } from "mongoose";
import { z } from "zod";
import { StudyPage, IStudyPage } from "@/models/study/page";
import { getStudyObject, pageContentKey, putStudyObject } from "./storage";

/**
 * `draw_on_notebook_page`: real-size ink from millimetre coordinates. Shapes become Fabric 7
 * objects (the board's own stroke format: dashed strokes carry `strokeDashArray` scaled to the
 * width, exactly `dashArrayFor`) appended to one board page of the page's current content, then
 * committed as the next version by the same compare-and-set the REST commit uses.
 *
 * Coordinates: mm on the page, math axes — x right, y UP from the origin (default bottom-left).
 * With origin 'top-left' y is measured DOWN from the top edge; angles are counter-clockwise from
 * +x in both. Board y points down, so the conversion flips it.
 */

export const DRAW_MAX_SHAPES = 500;
export const ARC_STEP_DEG = 3;
const TEXT_MAX = 200;
const FABRIC_VERSION = "7.2.0";
const DEFAULT_COLOR = "#000000";
const DEFAULT_WIDTH_MM = 0.5;
/** A coordinate this far past the edge (float noise) still counts as inside. */
const EDGE_EPS_MM = 0.01;

const mm = z.number().finite().min(-10_000).max(10_000);
const pt = z.tuple([mm, mm]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be #rrggbb");
const stroke = { dashed: z.boolean().optional(), color: color.optional(), widthMm: z.number().min(0.1).max(5).optional() };

export const drawShapeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("line"), from: pt, to: pt, ...stroke }).strict(),
  z.object({ type: z.literal("polyline"), points: z.array(pt).min(2).max(2000), closed: z.boolean().optional(), ...stroke }).strict(),
  z.object({ type: z.literal("arc"), center: pt, radiusMm: z.number().positive().max(10_000), startDeg: z.number().finite(), endDeg: z.number().finite(), ...stroke }).strict(),
  z.object({ type: z.literal("text"), at: pt, text: z.string().min(1).max(TEXT_MAX), sizeMm: z.number().min(1).max(100).optional(), color: color.optional() }).strict(),
  z.object({ type: z.literal("scaleBar"), at: pt, realLength: z.string().min(1).max(30), ratio: z.number().positive().max(1e9), color: color.optional() }).strict(),
]);
export type DrawShape = z.infer<typeof drawShapeSchema>;
export type Origin = "bottom-left" | "top-left";

export class DrawError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** The sheet the mm coordinates live on: where it sits in board units and how big it is in mm. */
export interface Frame {
  x0: number;
  y0: number;
  wMm: number;
  hMm: number;
  /** Board units per mm. */
  k: number;
}

const LENGTH_UNITS_M: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 };

/** "1 km" / "500m" / "2.5 mi" → metres, or null. */
export function parseRealLength(s: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|km|in|ft|yd|mi)\s*$/i.exec(s);
  return m ? Number(m[1]) * LENGTH_UNITS_M[m[2].toLowerCase()] : null;
}

/** Paper mm a real length occupies at 1:N — `L * 1000 / N` with L in metres. */
export const scaleBarMm = (metres: number, ratio: number) => (metres * 1000) / ratio;

const dashFor = (widthUnits: number, dashed?: boolean) => (dashed ? [widthUnits * 1.5, widthUnits * 2.5] : null);
const round = (n: number) => Math.round(n * 1e4) / 1e4;

interface Ids {
  stroke: string;
  drawing: string;
}

const base = (ids: Ids) => ({
  version: FABRIC_VERSION,
  originX: "left",
  originY: "top",
  fill: "",
  stroke: DEFAULT_COLOR,
  strokeDashOffset: 0,
  strokeLineCap: "round",
  strokeLineJoin: "round",
  strokeUniform: true,
  strokeMiterLimit: 10,
  scaleX: 1,
  scaleY: 1,
  angle: 0,
  flipX: false,
  flipY: false,
  opacity: 1,
  shadow: null,
  visible: true,
  backgroundColor: "",
  fillRule: "nonzero",
  paintFirst: "fill",
  globalCompositeOperation: "source-over",
  skewX: 0,
  skewY: 0,
  // AI provenance + undo handle. Survive a board re-save only if the FE registers these as
  // fabric customProperties (see the handoff); delete_notebook_drawing reports what it removed.
  aiAuthored: true,
  aiStrokeId: ids.stroke,
  aiDrawingId: ids.drawing,
});

/** A Fabric Polyline/Polygon from board-unit points (left/top/width/height = the points' bbox, as fabric computes it). */
function polylineObject(type: "Polyline" | "Polygon", pts: [number, number][], opts: { color?: string; widthUnits: number; dashed?: boolean }, ids: Ids) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    ...base(ids),
    type,
    stroke: opts.color ?? DEFAULT_COLOR,
    strokeWidth: round(opts.widthUnits),
    strokeDashArray: dashFor(opts.widthUnits, opts.dashed),
    left: round(left),
    top: round(top),
    width: round(Math.max(...xs) - left),
    height: round(Math.max(...ys) - top),
    points: pts.map(([x, y]) => ({ x: round(x), y: round(y) })),
  };
}

function textObject(x: number, y: number, text: string, fontSize: number, color: string, ids: Ids) {
  return {
    ...base(ids),
    type: "IText",
    stroke: null,
    strokeWidth: 1,
    strokeDashArray: null,
    fill: color,
    left: round(x),
    top: round(y),
    // fabric measures the box on load; these are placeholders it recomputes.
    width: round(text.length * fontSize * 0.55),
    height: round(fontSize * 1.16),
    text,
    fontSize: round(fontSize),
    fontWeight: "normal",
    fontFamily: "Arial",
    fontStyle: "normal",
    lineHeight: 1.16,
    underline: false,
    overline: false,
    linethrough: false,
    textAlign: "left",
    textBackgroundColor: "",
    charSpacing: 0,
    styles: [],
    direction: "ltr",
    path: null,
    pathStartOffset: 0,
    pathSide: "left",
    pathAlign: "baseline",
    minWidth: 20,
    splitByGrapheme: false,
  };
}

export interface BuiltDrawing {
  drawingId: string;
  objects: any[];
  /** Per input shape, the stroke ids it produced (a scaleBar makes several). */
  shapes: { index: number; type: string; strokeIds: string[] }[];
}

/**
 * Shapes → Fabric objects in board units. Throws DrawError (`OUT_OF_BOUNDS`, `BAD_SCALE_BAR`,
 * `TOO_MANY_SHAPES`) with the offending shape index — nothing is partially built.
 */
export function buildDrawing(shapes: DrawShape[], frame: Frame, origin: Origin = "bottom-left"): BuiltDrawing {
  if (shapes.length > DRAW_MAX_SHAPES) throw new DrawError("TOO_MANY_SHAPES", `At most ${DRAW_MAX_SHAPES} shapes per call`);
  const { k, wMm, hMm } = frame;
  const drawingId = randomUUID();
  const objects: any[] = [];
  const out: BuiltDrawing["shapes"] = [];

  // input (x,y) → math coords (u right, v up) from the page's bottom-left, in mm
  const uv = (p: [number, number]): [number, number] => (origin === "bottom-left" ? [p[0], p[1]] : [p[0], hMm - p[1]]);
  const toBoard = ([u, v]: [number, number]): [number, number] => [frame.x0 + u * k, frame.y0 + (hMm - v) * k];
  const inside = ([u, v]: [number, number]) => u >= -EDGE_EPS_MM && u <= wMm + EDGE_EPS_MM && v >= -EDGE_EPS_MM && v <= hMm + EDGE_EPS_MM;
  const guard = (i: number, points: [number, number][]) => {
    const bad = points.find((p) => !inside(p));
    if (bad) throw new DrawError("OUT_OF_BOUNDS", `shape ${i}: point (${round(bad[0])}, ${round(origin === "bottom-left" ? bad[1] : hMm - bad[1])}) mm is outside the ${round(wMm)} x ${round(hMm)} mm page`);
  };

  shapes.forEach((s, i) => {
    const ids = (): Ids => ({ stroke: randomUUID(), drawing: drawingId });
    const made: string[] = [];
    const push = (o: any) => {
      objects.push(o);
      made.push(o.aiStrokeId);
    };
    const wUnits = (s as any).widthMm ? (s as any).widthMm * k : DEFAULT_WIDTH_MM * k;

    if (s.type === "line" || s.type === "polyline") {
      const pts = (s.type === "line" ? [s.from, s.to] : s.points).map(uv);
      guard(i, pts);
      push(polylineObject(s.type === "polyline" && s.closed ? "Polygon" : "Polyline", pts.map(toBoard), { color: s.color, widthUnits: wUnits, dashed: s.dashed }, ids()));
    } else if (s.type === "arc") {
      const c = uv(s.center);
      let sweep = s.endDeg - s.startDeg;
      if (sweep === 0) throw new DrawError("BAD_SHAPE", `shape ${i}: arc startDeg and endDeg are equal`);
      if (Math.abs(sweep) > 360) sweep = Math.sign(sweep) * 360;
      const n = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP_DEG) + 1);
      const pts: [number, number][] = Array.from({ length: n }, (_, j) => {
        const a = ((s.startDeg + (sweep * j) / (n - 1)) * Math.PI) / 180;
        return [c[0] + s.radiusMm * Math.cos(a), c[1] + s.radiusMm * Math.sin(a)];
      });
      guard(i, pts);
      push(polylineObject("Polyline", pts.map(toBoard), { color: s.color, widthUnits: wUnits, dashed: s.dashed }, ids()));
    } else if (s.type === "text") {
      const sizeMm = s.sizeMm ?? 4;
      const [u, v] = uv(s.at);
      // `at` is the text's bottom-left; the box is estimated for the fit check only
      const estWidthMm = s.text.length * sizeMm * 0.55;
      guard(i, [[u, v], [u + estWidthMm, v + sizeMm]]);
      const [bx, by] = toBoard([u, v + sizeMm * 1.16]);
      push(textObject(bx, by, s.text, sizeMm * k, s.color ?? DEFAULT_COLOR, ids()));
    } else {
      const metres = parseRealLength(s.realLength);
      if (metres === null) throw new DrawError("BAD_SCALE_BAR", `shape ${i}: realLength must look like "1 km", "500 m", "2.5 mi"`);
      const barMm = scaleBarMm(metres, s.ratio);
      if (barMm < 1) throw new DrawError("BAD_SCALE_BAR", `shape ${i}: that bar is ${round(barMm)} mm at 1:${s.ratio} — too short to draw`);
      const [u, v] = uv(s.at);
      const tick = 2;
      const labelMm = 3;
      guard(i, [[u, v], [u + barMm, v], [u, v + tick + labelMm * 1.4]]);
      const opts = { color: s.color, widthUnits: DEFAULT_WIDTH_MM * k };
      push(polylineObject("Polyline", [toBoard([u, v]), toBoard([u + barMm, v])], opts, ids()));
      for (let t = 0; t <= 4; t++) {
        const x = u + (barMm * t) / 4;
        push(polylineObject("Polyline", [toBoard([x, v]), toBoard([x, v + tick])], opts, ids()));
      }
      const [lx, ly] = toBoard([u, v + tick + labelMm * 1.16 + 0.5]);
      push(textObject(lx, ly, `${s.realLength.trim()}   1:${Math.round(s.ratio).toLocaleString("en-US")}`, labelMm * k, s.color ?? DEFAULT_COLOR, ids()));
    }
    out.push({ index: i, type: s.type, strokeIds: made });
  });
  return { drawingId, objects, shapes: out };
}

// ─── board document I/O ──────────────────────────────────────────────────────────────────

const MAX_COMMIT_TRIES = 3;

interface Doc {
  raw: any;
  /** The Fabric canvas JSON object of each board page, parsed (write-back re-stringifies). */
  canvases: any[];
  bare: boolean;
}

function parseDoc(buf: Buffer): Doc {
  const raw = JSON.parse(buf.toString("utf8"));
  if (Array.isArray(raw?.objects)) return { raw, canvases: [raw], bare: true };
  if (!Array.isArray(raw?.pages)) throw new DrawError("BAD_CONTENT", "The stored page content is not a board document");
  const canvases = raw.pages.map((p: any) => {
    if (typeof p?.canvasJSON === "string") return p.canvasJSON ? JSON.parse(p.canvasJSON) : { version: FABRIC_VERSION, objects: [] };
    if (p?.canvasJSON && typeof p.canvasJSON === "object") return p.canvasJSON;
    return { version: FABRIC_VERSION, objects: [] };
  });
  return { raw, canvases, bare: false };
}

const serialize = (d: Doc) => {
  if (!d.bare) d.raw.pages.forEach((p: any, i: number) => (p.canvasJSON = JSON.stringify(d.canvases[i])));
  return Buffer.from(JSON.stringify(d.raw), "utf8");
};

const blankDoc = (): Doc => ({ raw: { pages: [], currentPageIndex: 0 }, canvases: [], bare: false });
const blankPage = () => ({ id: randomUUID(), canvasJSON: "", thumbnail: "", backgroundType: "blank" });

/** The sheet for board page `n` (1-based) of a parsed doc: the PDF placement when it has one, else the usable page at the board origin. */
export function frameFor(doc: Doc | null, n: number, usablePageMm: { w: number; h: number }, k: number): Frame {
  const pl = doc && !doc.bare ? doc.raw.pages?.[n - 1]?.pdfPlacement : null;
  const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (pl && fin(pl.x) && fin(pl.y) && fin(pl.width) && fin(pl.height) && pl.width > 0 && pl.height > 0)
    return { x0: pl.x, y0: pl.y, wMm: pl.width / k, hMm: pl.height / k, k };
  return { x0: 0, y0: 0, wMm: usablePageMm.w, hMm: usablePageMm.h, k };
}

type Mutation<T> = (doc: Doc, page: IStudyPage) => T;

/** Read current content → mutate → write version+1 to a fresh key → CAS the pointer; a lost race re-reads and retries. */
async function withBoardDoc<T>(userId: Types.ObjectId, pageId: string, mutate: Mutation<T>): Promise<{ result: T; version: number }> {
  for (let attempt = 0; attempt < MAX_COMMIT_TRIES; attempt++) {
    const page = await StudyPage.findOne({ _id: pageId, userId, deletedAt: null }).lean<IStudyPage>();
    if (!page) throw new DrawError("NOT_FOUND", "Notebook page not found");
    if (page.kind === "pdf" && !page.version && !page.contentKey) {
      // an unopened PDF page has no board yet — its placement is unknown until the tablet opens it
      throw new DrawError("NOT_OPENED", "Open this page on the tablet once so it syncs, then draw");
    }
    const doc = page.version && page.contentKey ? parseDoc(await getStudyObject(page.contentKey)) : blankDoc();
    const result = mutate(doc, page);
    const version = (page.version ?? 0) + 1;
    // A key of our own, never the shared `v<n>.json` a presigned upload may also target: two racing
    // writers (or a client that uploaded and never committed) can't overwrite each other's bytes,
    // and an orphan from a lost CAS is harmless — only the pointer decides which object is current.
    const key = `${pageContentKey(String(page.userId), String(page._id), version).replace(/\.json$/, "")}-ai-${randomUUID()}.json`;
    await putStudyObject(key, serialize(doc), "application/json");
    const won = await StudyPage.findOneAndUpdate(
      { _id: page._id, userId, deletedAt: null, version: version - 1 },
      { $set: { version, contentKey: key, updatedAt: new Date() } },
      { new: true, projection: { _id: 1 }, timestamps: false }
    ).lean();
    if (won) {
      // Anyone live on the page re-reads it (sharing phase 2 part B).
      publishPageEvent(String(page._id), { type: "ops", prevVersion: version - 1, version, ops: null, by: { clientId: "", userId: String(userId), name: "Claude" } });
      return { result, version };
    }
  }
  throw new DrawError("CONFLICT", "The page keeps changing (another device is saving) — try again");
}

export interface DrawResult extends BuiltDrawing {
  version: number;
  page: number;
}

export async function drawOnPage(
  userId: Types.ObjectId,
  pageId: string,
  input: { page: number; origin?: Origin; shapes: DrawShape[] },
  profile: { pageUnitsPerMm: number; usablePageMm: { w: number; h: number } }
): Promise<DrawResult> {
  const { version, result } = await withBoardDoc(userId, pageId, (doc) => {
    const count = doc.canvases.length;
    if (input.page > count + 1) throw new DrawError("BAD_PAGE", `The page has ${count} board page(s); page ${input.page} does not exist`);
    // a brand-new board page is appended blank when asked for exactly one past the end
    const frame = frameFor(doc, input.page, profile.usablePageMm, profile.pageUnitsPerMm);
    const built = buildDrawing(input.shapes, frame, input.origin ?? "bottom-left");
    if (input.page === count + 1) {
      if (!doc.bare) {
        doc.raw.pages.push(blankPage());
        doc.canvases.push({ version: FABRIC_VERSION, objects: [] });
      }
    }
    const canvas = doc.canvases[input.page - 1];
    if (!canvas) throw new DrawError("BAD_PAGE", "Bare board content has a single page");
    canvas.objects = [...(canvas.objects ?? []), ...built.objects];
    return built;
  });
  return { ...result, version, page: input.page };
}

/** Removes every object whose aiStrokeId or aiDrawingId is in `ids`. Returns how many went. */
export async function deleteDrawing(userId: Types.ObjectId, pageId: string, ids: string[]): Promise<{ removed: number; version: number | null }> {
  const want = new Set(ids);
  let removed = 0;
  const hit = (o: any) => want.has(o?.aiStrokeId) || want.has(o?.aiDrawingId);
  // dry look first so a no-op never mints a version
  const page = await StudyPage.findOne({ _id: pageId, userId, deletedAt: null }).lean<IStudyPage>();
  if (!page) throw new DrawError("NOT_FOUND", "Notebook page not found");
  if (!page.version || !page.contentKey) return { removed: 0, version: null };
  const peek = parseDoc(await getStudyObject(page.contentKey));
  if (!peek.canvases.some((c) => (c.objects ?? []).some(hit))) return { removed: 0, version: null };
  const r = await withBoardDoc(userId, pageId, (doc) => {
    let n = 0;
    for (const c of doc.canvases) {
      const keep = (c.objects ?? []).filter((o: any) => !hit(o));
      n += (c.objects ?? []).length - keep.length;
      c.objects = keep;
    }
    removed = n;
    return n;
  });
  return { removed, version: r.version };
}
