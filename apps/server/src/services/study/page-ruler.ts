import { IStudyPageRuler, STUDY_GROUND_UNITS, StudyGroundUnit } from "@/models/study/page";

/**
 * Per-board-page ruler preset: how the owner's on-screen ruler opens on a page. Lengths are paper
 * mm (the drawing-profile unit); board pages are 1-based. Shared by the MCP tool and the REST routes.
 */

export const RULER_MAX_PAGE = 500;
export const RULER_FACTOR_MIN = 0.2;
export const RULER_FACTOR_MAX = 10;
export const RULER_MAX_MM = 5000;
export const RULER_MAP_SCALE_MAX = 100_000_000;

export class RulerError extends Error {
  constructor(message: string, public code = "INVALID") {
    super(message);
  }
}

const MM_PER_UNIT: Record<StudyGroundUnit, number> = { ft: 304.8, m: 1000, km: 1_000_000, mi: 1_609_344 };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** `scaleBar` → N of 1:N. 100 mm drawn for 2400 m on the ground → 2 400 000 mm / 100 mm = 24000. */
export function mapScaleFromScaleBar(bar: { lengthMm: number; groundLength: number; groundUnit: StudyGroundUnit }): number {
  const n = (bar.groundLength * MM_PER_UNIT[bar.groundUnit]) / bar.lengthMm;
  // round to 6 decimals so 1e-12 float noise never leaks into the stored N
  return Math.round(n * 1e6) / 1e6;
}

export interface RulerInput {
  pageFactor?: unknown;
  angleDeg?: unknown;
  zeroAt?: unknown;
  mapScale?: unknown;
  groundUnit?: unknown;
}

export interface ScaleBarInput {
  lengthMm?: unknown;
  groundLength?: unknown;
  groundUnit?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function validatePage(page: unknown): number {
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > RULER_MAX_PAGE) throw new RulerError(`page must be an integer 1..${RULER_MAX_PAGE}`);
  return page;
}

/** Validates a preset body (+ optional scaleBar) into the stored shape, minus setBy/updatedAt. Throws RulerError. */
export function parseRuler(body: unknown, scaleBar?: unknown): Omit<IStudyPageRuler, "setBy" | "updatedAt"> {
  if (!isObj(body)) throw new RulerError("ruler must be an object");
  const allowed = new Set(["pageFactor", "angleDeg", "zeroAt", "mapScale", "groundUnit", "setBy", "updatedAt"]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw new RulerError(`unknown ruler field ${k}`);
  const out: Omit<IStudyPageRuler, "setBy" | "updatedAt"> = {};
  if (body.pageFactor !== undefined) {
    if (!num(body.pageFactor) || body.pageFactor < RULER_FACTOR_MIN || body.pageFactor > RULER_FACTOR_MAX) throw new RulerError(`pageFactor must be ${RULER_FACTOR_MIN}..${RULER_FACTOR_MAX}`);
    out.pageFactor = body.pageFactor;
  }
  if (body.angleDeg !== undefined) {
    if (!num(body.angleDeg) || body.angleDeg < 0 || body.angleDeg > 360) throw new RulerError("angleDeg must be 0..360");
    out.angleDeg = body.angleDeg;
  }
  if (body.zeroAt !== undefined) {
    const z = body.zeroAt;
    if (!isObj(z) || !num(z.xMm) || !num(z.yMm) || Object.keys(z).some((k) => k !== "xMm" && k !== "yMm")) throw new RulerError("zeroAt must be {xMm, yMm} numbers");
    if (z.xMm < 0 || z.xMm > RULER_MAX_MM || z.yMm < 0 || z.yMm > RULER_MAX_MM) throw new RulerError(`zeroAt must be within 0..${RULER_MAX_MM} mm from the page's top-left`);
    out.zeroAt = { xMm: z.xMm, yMm: z.yMm };
  }
  if (body.mapScale !== undefined) {
    if (!num(body.mapScale) || body.mapScale < 1 || body.mapScale > RULER_MAP_SCALE_MAX) throw new RulerError(`mapScale must be 1..${RULER_MAP_SCALE_MAX} (the N of 1:N)`);
    out.mapScale = body.mapScale;
  }
  if (body.groundUnit !== undefined) {
    if (typeof body.groundUnit !== "string" || !(STUDY_GROUND_UNITS as readonly string[]).includes(body.groundUnit)) throw new RulerError(`groundUnit must be one of ${STUDY_GROUND_UNITS.join(", ")}`);
    out.groundUnit = body.groundUnit as StudyGroundUnit;
  }
  if (scaleBar !== undefined && scaleBar !== null) {
    if (out.mapScale !== undefined) throw new RulerError("give either mapScale or scaleBar, not both");
    const b = scaleBar as ScaleBarInput;
    if (!isObj(scaleBar) || !num(b.lengthMm) || b.lengthMm <= 0 || b.lengthMm > RULER_MAX_MM) throw new RulerError(`scaleBar.lengthMm must be a number in (0, ${RULER_MAX_MM}]`);
    if (!num(b.groundLength) || b.groundLength <= 0) throw new RulerError("scaleBar.groundLength must be a positive number");
    if (typeof b.groundUnit !== "string" || !(STUDY_GROUND_UNITS as readonly string[]).includes(b.groundUnit)) throw new RulerError(`scaleBar.groundUnit must be one of ${STUDY_GROUND_UNITS.join(", ")}`);
    const n = mapScaleFromScaleBar({ lengthMm: b.lengthMm, groundLength: b.groundLength, groundUnit: b.groundUnit as StudyGroundUnit });
    if (n < 1 || n > RULER_MAP_SCALE_MAX) throw new RulerError(`scaleBar implies 1:${n}, outside 1..${RULER_MAP_SCALE_MAX}`);
    out.mapScale = n;
    if (out.groundUnit === undefined) out.groundUnit = b.groundUnit as StudyGroundUnit;
  }
  if (!Object.keys(out).length) throw new RulerError("ruler needs at least one of pageFactor, angleDeg, zeroAt, mapScale/scaleBar, groundUnit");
  return out;
}

export const rulerDto = (r: IStudyPageRuler) => ({
  ...(r.pageFactor !== undefined && r.pageFactor !== null ? { pageFactor: r.pageFactor } : {}),
  ...(r.angleDeg !== undefined && r.angleDeg !== null ? { angleDeg: r.angleDeg } : {}),
  ...(r.zeroAt ? { zeroAt: { xMm: r.zeroAt.xMm, yMm: r.zeroAt.yMm } } : {}),
  ...(r.mapScale !== undefined && r.mapScale !== null ? { mapScale: r.mapScale } : {}),
  ...(r.groundUnit ? { groundUnit: r.groundUnit } : {}),
  setBy: r.setBy,
  updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
});

/** `{ [page]: preset }` from a page row's stored map (lean object or Map). */
export function rulersDto(raw: unknown): Record<string, ReturnType<typeof rulerDto>> {
  const entries = raw instanceof Map ? [...raw.entries()] : isObj(raw) ? Object.entries(raw) : [];
  const out: Record<string, ReturnType<typeof rulerDto>> = {};
  for (const [k, v] of entries) if (isObj(v)) out[k] = rulerDto(v as unknown as IStudyPageRuler);
  return out;
}
