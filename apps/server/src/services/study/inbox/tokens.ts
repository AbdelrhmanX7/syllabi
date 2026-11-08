import { randomBytes } from "crypto";
import { Types } from "mongoose";
import { Admin } from "@/models/admin";
import { IStudyInboxToken, StudyInboxToken } from "@/models/study/inbox";
import { isStudyAccount, safeEqual, sha256Hex } from "@/services/study/mcp-auth";

/**
 * Drop tokens (`sk_drop_…`): a narrow credential the owner's phone uses to send files to his
 * Study inbox. It authorizes ONLY `POST /study/inbox` and `GET /study/drop` (routes/study/inbox.ts)
 * — adminVerification never sees one as valid (it only accepts a JWT signed with JWT_SECRET).
 *
 * Same storage rules as the MCP keys: random 32 bytes, shown once, stored as a sha256 hash plus a
 * short prefix for lookup; the hash compare is constant-time and never exits early.
 */

export const DROP_TOKEN_PREFIX = "sk_drop_";
export const DROP_TOKEN_RE = /^sk_drop_[A-Za-z0-9_-]{43}$/;
const LOOKUP_PREFIX_LEN = DROP_TOKEN_PREFIX.length + 8;
export const MAX_DROP_TOKENS_PER_USER = 20;
export const TOKEN_LAST_USED_THROTTLE_MS = 60 * 1000;
export const UPLOAD_LINK_TTL_MS = 15 * 60 * 1000;
/** Permanent (phone) tokens only — one-shot upload links are invisible to the list and the cap. */
const PERMANENT = { expiresAt: null } as const;

export class InboxTokenError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const tokenDto = (t: IStudyInboxToken) => ({
  id: String(t._id),
  label: t.label,
  prefix: t.prefix,
  createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : null,
  lastUsedAt: t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : null,
});

/** For log lines: never the whole token. */
export const redactToken = (token: string) => (token.startsWith(DROP_TOKEN_PREFIX) ? `${token.slice(0, LOOKUP_PREFIX_LEN)}…` : "[token]");

const newToken = () => `${DROP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

/** Creates a token; the plaintext is in the return value ONLY (never stored, never listed). */
export async function createDropToken(userId: Types.ObjectId, label: unknown) {
  const l = typeof label === "string" ? label.trim() : "";
  if (!l || l.length > 100) throw new InboxTokenError(400, "VALIDATION_ERROR", "label is required (max 100 chars)");
  if ((await StudyInboxToken.countDocuments({ userId, ...PERMANENT })) >= MAX_DROP_TOKENS_PER_USER)
    throw new InboxTokenError(400, "TOO_MANY_TOKENS", `At most ${MAX_DROP_TOKENS_PER_USER} drop tokens — revoke one first`);
  const token = newToken();
  const doc = await StudyInboxToken.create({ userId, label: l, prefix: token.slice(0, LOOKUP_PREFIX_LEN), tokenHash: sha256Hex(token) });
  const dto = tokenDto(doc.toObject() as IStudyInboxToken);
  return { id: dto.id, token, label: dto.label, createdAt: dto.createdAt };
}

export async function listDropTokens(userId: Types.ObjectId) {
  const rows = await StudyInboxToken.find({ userId, ...PERMANENT }, { tokenHash: 0 }).sort({ createdAt: -1, _id: -1 }).lean<IStudyInboxToken[]>();
  return rows.map(tokenDto);
}

/** Hard delete: the very next request with that token finds no row and gets a 401. */
export async function deleteDropToken(userId: Types.ObjectId, id: string) {
  const r = await StudyInboxToken.deleteOne({ _id: id, userId });
  return r.deletedCount === 1;
}

/**
 * A one-shot upload link: valid for 15 min and for ONE upload (claimed atomically when the upload
 * starts, released if it fails). note/classId/pageId are bound here, already validated by the caller.
 */
export async function createUploadLink(userId: Types.ObjectId, meta: { note: string | null; classId: Types.ObjectId | null; pageId?: Types.ObjectId | null }, now = Date.now()) {
  const token = newToken();
  const expiresAt = new Date(now + UPLOAD_LINK_TTL_MS);
  await StudyInboxToken.create({
    userId,
    label: "Upload link (MCP)",
    prefix: token.slice(0, LOOKUP_PREFIX_LEN),
    tokenHash: sha256Hex(token),
    expiresAt,
    note: meta.note,
    classId: meta.classId,
    pageId: meta.pageId ?? null,
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

export interface DropPrincipal {
  userId: Types.ObjectId;
  tokenId: Types.ObjectId;
  label: string;
  /** Set for a one-shot upload link: its bound meta. */
  oneShot: { note: string | null; classId: Types.ObjectId | null; pageId: Types.ObjectId | null } | null;
}

/**
 * Resolves a drop token to its owner. Null for a malformed, unknown or revoked token, or when the
 * owner is no longer a full admin (same rule as the /study mount).
 */
export async function authenticateDropToken(token: unknown): Promise<DropPrincipal | null> {
  if (typeof token !== "string" || !DROP_TOKEN_RE.test(token)) return null;
  const hash = sha256Hex(token);
  const candidates = await StudyInboxToken.find({ prefix: token.slice(0, LOOKUP_PREFIX_LEN) }, { userId: 1, tokenHash: 1, label: 1, lastUsedAt: 1, expiresAt: 1, consumedAt: 1, note: 1, classId: 1, pageId: 1 })
    .limit(10)
    .lean<IStudyInboxToken[]>();
  let hit: IStudyInboxToken | null = null;
  for (const c of candidates) if (safeEqual(c.tokenHash, hash)) hit = c; // no early exit
  if (!hit) return null;
  if (hit.expiresAt && (new Date(hit.expiresAt).getTime() <= Date.now() || hit.consumedAt)) return null;
  const owner = await Admin.findById(hit.userId).select("role isDisabled isVerified").lean<{ role?: string; isDisabled?: boolean; isVerified?: boolean }>();
  if (!isStudyAccount(owner)) return null;
  return { userId: hit.userId, tokenId: hit._id, label: hit.label, oneShot: hit.expiresAt ? { note: hit.note ?? null, classId: hit.classId ?? null, pageId: hit.pageId ?? null } : null };
}

/** Claims a one-shot link for this upload; false when another upload got it first or it expired meanwhile. */
export async function claimUploadLink(tokenId: Types.ObjectId, now = new Date()) {
  const r = await StudyInboxToken.updateOne({ _id: tokenId, expiresAt: { $gt: now }, consumedAt: null }, { $set: { consumedAt: now } });
  return r.modifiedCount === 1;
}

/** The upload failed after the claim: the link works again (until it expires). */
export async function releaseUploadLink(tokenId: Types.ObjectId) {
  await StudyInboxToken.updateOne({ _id: tokenId, expiresAt: { $ne: null } }, { $set: { consumedAt: null } }).catch(() => undefined);
}

/** Throttled lastUsedAt bump — called on a successful upload, not on every page view. */
export function touchDropToken(tokenId: Types.ObjectId, now = Date.now()) {
  void StudyInboxToken.updateOne(
    { _id: tokenId, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lt: new Date(now - TOKEN_LAST_USED_THROTTLE_MS) } }] },
    { $set: { lastUsedAt: new Date(now) } }
  ).catch(() => undefined);
}
