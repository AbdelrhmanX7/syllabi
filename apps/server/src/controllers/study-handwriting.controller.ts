import { Request, Response } from "express";
import { StudyGlyphBank } from "@/models/study/glyph-bank";
import { fail, uid, wrap } from "@/controllers/study.controller";

/**
 * Handwriting glyph bank — GET/PUT /study/handwriting/bank (owner-only, study mount).
 *
 * Optimistic concurrency on `version`; the ETag is `"<version>"`.
 *   - no bank + no If-Match → create (a concurrent create loses on the unique userId → 412)
 *   - bank exists + no If-Match → 428 PRECONDITION_REQUIRED (never a blind overwrite)
 *   - If-Match ≠ current version (or no bank to match) → 412
 */
export const GLYPH_BANK_MAX_BYTES = 2 * 1024 * 1024;

const etagOf = (version: number) => `"${version}"`;

/** `"3"`, `W/"3"`, `3` → 3; `*` → "*"; anything else → null (never matches). */
export const parseIfMatch = (raw: string | undefined): number | "*" | null | undefined => {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === "*") return "*";
  const m = /^(?:W\/)?"?(\d{1,15})"?$/.exec(v);
  return m ? Number(m[1]) : null;
};

const reply = (res: Response, status: number, doc: { version: number }, extra: object = {}) => {
  res.setHeader("ETag", etagOf(doc.version));
  return res.status(status).json({ version: doc.version, etag: etagOf(doc.version), ...extra });
};

export const getGlyphBank = wrap(async (req: Request, res: Response) => {
  const doc = await StudyGlyphBank.findOne({ userId: uid(req) }).lean();
  if (!doc) return fail(res, 404, "NOT_FOUND", "No glyph bank yet");
  return reply(res, 200, doc, { bank: JSON.parse(doc.bank) });
});

export const putGlyphBank = wrap(async (req: Request, res: Response) => {
  const bank = req.body?.bank;
  if (bank === undefined || bank === null || typeof bank !== "object") {
    return fail(res, 400, "VALIDATION", "Body must be { bank: <object|array> }");
  }
  const json = JSON.stringify(bank);
  const bytes = Buffer.byteLength(json);
  if (bytes > GLYPH_BANK_MAX_BYTES) return fail(res, 413, "PAYLOAD_TOO_LARGE", "Glyph bank exceeds 2 MB");

  const userId = uid(req);
  const ifMatch = parseIfMatch(req.get("If-Match"));

  if (ifMatch === undefined) {
    if (await StudyGlyphBank.exists({ userId })) {
      return fail(res, 428, "PRECONDITION_REQUIRED", "If-Match is required to update an existing glyph bank");
    }
    try {
      const doc = await StudyGlyphBank.create({ userId, version: 1, bank: json, bytes });
      return reply(res, 200, doc);
    } catch (e: any) {
      if (e?.code === 11000) return fail(res, 412, "PRECONDITION_FAILED", "Glyph bank was created concurrently");
      throw e;
    }
  }
  if (ifMatch === null) return fail(res, 412, "PRECONDITION_FAILED", "If-Match does not match the current version");

  const filter = ifMatch === "*" ? { userId } : { userId, version: ifMatch };
  const doc = await StudyGlyphBank.findOneAndUpdate(filter, { $set: { bank: json, bytes }, $inc: { version: 1 } }, { new: true }).lean();
  if (!doc) return fail(res, 412, "PRECONDITION_FAILED", "If-Match does not match the current version");
  return reply(res, 200, doc);
});
