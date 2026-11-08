import { fail, uid, wrap } from "@/controllers/study.controller";
import { getOrSeedProfile, parseProfilePatch, patchProfile, profileDto } from "@/services/study/drawing-profile";

/** `GET /study/drawing-profile` — the owner's profile (seeded with the defaults on first read). */
export const getDrawingProfile = wrap(async (req, res) => {
  res.json(profileDto(await getOrSeedProfile(uid(req))));
});

/** `PATCH /study/drawing-profile` — partial update; a `calibration` change stamps `calibration.updatedAt`. */
export const patchDrawingProfile = wrap(async (req, res) => {
  const parsed = parseProfilePatch(req.body);
  if ("error" in parsed) return fail(res, 400, "VALIDATION_ERROR", parsed.error);
  res.json(profileDto(await patchProfile(uid(req), parsed.set)));
});
