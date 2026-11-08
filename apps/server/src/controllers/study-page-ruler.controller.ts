import { StudyPage, IStudyPage } from "@/models/study/page";
import { parseRuler, RulerError, rulersDto, rulerDto, validatePage } from "@/services/study/page-ruler";
import { fail, isOid, uid, wrap } from "./study.controller";

/**
 * Per-board-page ruler presets for the Study FE. `:page` is the 1-based board page number.
 * None of these writes move the page's `updatedAt` (a ruler is view state, not content).
 */

const ownPageId = async (req: any, res: any): Promise<IStudyPage | null> => {
  if (!isOid(req.params.id)) {
    fail(res, 400, "INVALID_ID", "Invalid page id");
    return null;
  }
  const page = await StudyPage.findOne({ _id: req.params.id, userId: uid(req), deletedAt: null }, { rulers: 1, userId: 1 }).lean<IStudyPage>();
  if (!page) fail(res, 404, "NOT_FOUND", "Page not found");
  return page;
};

const pageParam = (res: any, raw: string): number | null => {
  try {
    return validatePage(/^\d+$/.test(raw) ? Number(raw) : NaN);
  } catch (e) {
    fail(res, 400, "INVALID", (e as Error).message);
    return null;
  }
};

/** `GET /pages/:id/ruler` → `{ rulers: { [page]: preset } }` */
export const getPageRulers = wrap(async (req, res) => {
  const page = await ownPageId(req, res);
  if (!page) return;
  res.json({ rulers: rulersDto(page.rulers) });
});

/** `PUT /pages/:id/ruler/:page` — the owner's own preset; `setBy` is forced to "user". */
export const putPageRuler = wrap(async (req, res) => {
  const n = pageParam(res, req.params.page);
  if (n === null) return;
  let fields;
  try {
    fields = parseRuler(req.body);
  } catch (e) {
    if (e instanceof RulerError) return fail(res, 400, e.code, e.message);
    throw e;
  }
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid page id");
  const preset = { ...fields, setBy: "user" as const, updatedAt: new Date() };
  const r = await StudyPage.updateOne({ _id: req.params.id, userId: uid(req), deletedAt: null }, { $set: { [`rulers.${n}`]: preset } }, { timestamps: false });
  if (!r.matchedCount) return fail(res, 404, "NOT_FOUND", "Page not found");
  res.json(rulerDto(preset));
});

/** `DELETE /pages/:id/ruler/:page` */
export const deletePageRuler = wrap(async (req, res) => {
  const n = pageParam(res, req.params.page);
  if (n === null) return;
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid page id");
  const r = await StudyPage.updateOne({ _id: req.params.id, userId: uid(req), deletedAt: null }, { $unset: { [`rulers.${n}`]: "" } }, { timestamps: false });
  if (!r.matchedCount) return fail(res, 404, "NOT_FOUND", "Page not found");
  res.status(204).end();
});
