import { Types } from "mongoose";
import { CALIBRATION_SOURCES, IStudyDrawingProfile, PEN_MODES, StudyDrawingProfile } from "@/models/study/drawing-profile";

/** 1 mm of paper in board units: 1 unit = 1 CSS px at zoom 1, paper printed at 96 dpi. */
export const PAGE_UNITS_PER_MM = 96 / 25.4;

/** What Claude reads before giving or making any drawing (seeded; the owner may edit it via PATCH). */
export const DRAWING_GUIDE = `# Giving and making drawings for the owner's notebook

The owner takes notes by hand on a Samsung Galaxy Tab S9 Ultra (14.6", 2960x1848, 239 ppi). The notebook has an on-screen ruler with TRUE cm/mm marks and pen line modes (freehand, straight on hold, always straight, dashed). A page holds about 150 x 200 mm of usable drawing area; if something does not fit, scale it down and say the scale.

## Rules for every drawing (diagrams, graphs, geometry, maps, technical sketches)
1. State the scale first when the drawing represents real sizes (e.g. 1:N for a map or plan, or "1 cm = 2 N" for a vector diagram). A real length of L metres at 1:N is L x 1000 / N mm on the page (2 km at 1:25,000 = 80 mm).
2. Give every length in real mm (or cm), rounded to 0.5 mm. Never pixels or "units".
3. Give every angle in degrees, measured from horizontal and counter-clockwise (up-right positive). For a slanted line also say the direction, e.g. "30 deg down to the right".
4. Use ONE origin, normally the bottom-left corner of the figure. Points are (x mm right, y mm up).
5. Say which lines are solid and which are dashed (e.g. a measured edge vs a construction or hidden line).
6. When the drawing is to scale, include a scale bar: a round real distance, e.g. "1 km at 1:25,000 = 40 mm", plus the ratio label.
7. Give numbered construction steps in this order: frame/axes, main outlines, inner details, labels.

## Drawing it yourself
draw_on_notebook_page draws real ink on a board page from the same mm coordinates (y up from the origin, default bottom-left of the page). Shapes: line, polyline, arc, text, scaleBar. Everything must fit inside the page; max 500 shapes per call. It returns drawingId + stroke ids; delete_notebook_drawing removes them. Look at the result with get_notebook_page (the tablet re-renders after it syncs).

Example step: "3. From (20, 45), draw a straight line 60 mm long at 25 deg down to the right, dashed (construction line)."`;

/** The owner's seeded profile (the app is single-owner; the row is created on first read). */
export const defaultProfile = () => ({
  device: { name: "Samsung Galaxy Tab S9 Ultra", diagonalIn: 14.6, screenPx: [2960, 1848] as [number, number], ppi: 239 },
  calibration: { cssPxPerMm: null as number | null, source: "device" as const, updatedAt: null as Date | null },
  pageUnitsPerMm: PAGE_UNITS_PER_MM,
  usablePageMm: { w: 150, h: 200 },
  penModes: [...PEN_MODES],
  dashed: false,
  guide: DRAWING_GUIDE,
});

/** The profile row, created from the defaults on first read (a racing create re-reads the winner). */
export async function getOrSeedProfile(userId: Types.ObjectId): Promise<IStudyDrawingProfile> {
  const found = await StudyDrawingProfile.findOne({ userId }).lean<IStudyDrawingProfile>();
  if (found) return found;
  try {
    const created = await StudyDrawingProfile.create({ userId, ...defaultProfile() });
    return created.toObject() as IStudyDrawingProfile;
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
    return (await StudyDrawingProfile.findOne({ userId }).lean<IStudyDrawingProfile>())!;
  }
}

export const profileDto = (p: IStudyDrawingProfile) => ({
  device: p.device,
  calibration: { cssPxPerMm: p.calibration.cssPxPerMm ?? null, source: p.calibration.source, updatedAt: p.calibration.updatedAt ? new Date(p.calibration.updatedAt).toISOString() : null },
  pageUnitsPerMm: p.pageUnitsPerMm,
  usablePageMm: p.usablePageMm,
  penModes: p.penModes,
  dashed: p.dashed,
  guide: p.guide,
  updatedAt: new Date(p.updatedAt).toISOString(),
});

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const inRange = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const GUIDE_MAX = 20_000;

/** A partial body → the dotted `$set`, or the 400 message. Unknown keys are refused so a typo can't no-op silently. */
export function parseProfilePatch(body: unknown): { set: Record<string, unknown> } | { error: string } {
  if (!isObj(body)) return { error: "body must be an object" };
  const set: Record<string, unknown> = {};
  const known = new Set(["device", "calibration", "pageUnitsPerMm", "usablePageMm", "penModes", "dashed", "guide"]);
  for (const k of Object.keys(body)) if (!known.has(k)) return { error: `unknown field ${k}` };

  if (body.device !== undefined) {
    const d = body.device;
    if (!isObj(d)) return { error: "device must be an object" };
    for (const k of Object.keys(d)) if (!["name", "diagonalIn", "screenPx", "ppi"].includes(k)) return { error: `unknown device field ${k}` };
    if (d.name !== undefined) {
      if (typeof d.name !== "string" || !d.name.trim() || d.name.length > 120) return { error: "device.name must be a non-empty string (max 120)" };
      set["device.name"] = d.name.trim();
    }
    if (d.diagonalIn !== undefined) {
      if (!inRange(d.diagonalIn, 1, 100)) return { error: "device.diagonalIn must be 1..100" };
      set["device.diagonalIn"] = d.diagonalIn;
    }
    if (d.ppi !== undefined) {
      if (!inRange(d.ppi, 10, 2000)) return { error: "device.ppi must be 10..2000" };
      set["device.ppi"] = d.ppi;
    }
    if (d.screenPx !== undefined) {
      const s = d.screenPx;
      if (!Array.isArray(s) || s.length !== 2 || !s.every((n) => inRange(n, 100, 20000))) return { error: "device.screenPx must be [width, height] (100..20000)" };
      set["device.screenPx"] = s;
    }
  }
  if (body.calibration !== undefined) {
    const c = body.calibration;
    if (!isObj(c)) return { error: "calibration must be an object" };
    for (const k of Object.keys(c)) if (!["cssPxPerMm", "source"].includes(k)) return { error: `unknown calibration field ${k}` };
    if (c.cssPxPerMm !== undefined) {
      if (c.cssPxPerMm !== null && !inRange(c.cssPxPerMm, 0.5, 50)) return { error: "calibration.cssPxPerMm must be 0.5..50 or null" };
      set["calibration.cssPxPerMm"] = c.cssPxPerMm;
    }
    if (c.source !== undefined) {
      if (!(CALIBRATION_SOURCES as readonly unknown[]).includes(c.source)) return { error: `calibration.source must be one of ${CALIBRATION_SOURCES.join(", ")}` };
      set["calibration.source"] = c.source;
    }
    if (!Object.keys(c).length) return { error: "calibration is empty" };
    set["calibration.updatedAt"] = new Date();
  }
  if (body.pageUnitsPerMm !== undefined) {
    if (!inRange(body.pageUnitsPerMm, 0.5, 20)) return { error: "pageUnitsPerMm must be 0.5..20" };
    set.pageUnitsPerMm = body.pageUnitsPerMm;
  }
  if (body.usablePageMm !== undefined) {
    const u = body.usablePageMm;
    if (!isObj(u) || (u.w === undefined && u.h === undefined)) return { error: "usablePageMm must be {w?, h?}" };
    for (const k of Object.keys(u)) if (!["w", "h"].includes(k)) return { error: `unknown usablePageMm field ${k}` };
    if (u.w !== undefined) {
      if (!inRange(u.w, 10, 2000)) return { error: "usablePageMm.w must be 10..2000" };
      set["usablePageMm.w"] = u.w;
    }
    if (u.h !== undefined) {
      if (!inRange(u.h, 10, 2000)) return { error: "usablePageMm.h must be 10..2000" };
      set["usablePageMm.h"] = u.h;
    }
  }
  if (body.penModes !== undefined) {
    const m = body.penModes;
    if (!Array.isArray(m) || !m.length || !m.every((x) => (PEN_MODES as readonly unknown[]).includes(x))) return { error: `penModes must be a non-empty subset of ${PEN_MODES.join(", ")}` };
    set.penModes = [...new Set(m)];
  }
  if (body.dashed !== undefined) {
    if (typeof body.dashed !== "boolean") return { error: "dashed must be a boolean" };
    set.dashed = body.dashed;
  }
  if (body.guide !== undefined) {
    if (typeof body.guide !== "string" || body.guide.length > GUIDE_MAX) return { error: `guide must be a string (max ${GUIDE_MAX})` };
    set.guide = body.guide;
  }
  if (!Object.keys(set).length) return { error: "send at least one field" };
  return { set };
}

export async function patchProfile(userId: Types.ObjectId, set: Record<string, unknown>): Promise<IStudyDrawingProfile> {
  await getOrSeedProfile(userId);
  return (await StudyDrawingProfile.findOneAndUpdate({ userId }, { $set: set }, { new: true }).lean<IStudyDrawingProfile>())!;
}
