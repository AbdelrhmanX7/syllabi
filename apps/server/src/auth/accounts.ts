/**
 * Account service behind /auth (auth/accounts-router.ts): the public user shape, single-use
 * email/OAuth tokens and account deletion. See docs/accounts.md.
 */
import { Types } from "mongoose";
import { Admin, AuthProvider, IAdmin } from "@/models/admin";
import { AuthToken, IAuthToken } from "@/models/auth-token";
// Registers every study model, so the deletion sweep below sees all of them.
import "@/models/study";
import "@/models/study/conversation";
import "@/models/study/page-read";
import { studyModels } from "@/services/study/index-maintenance";
import { deleteUserObjects } from "@/services/study/storage";
import { AuthTokenKind, generateRawToken, hashToken, RAW_TOKEN_RE, tokenExpiry } from "@/auth/tokens";
import { OWNER_ROLE_FILTER, isAiAccount, isOwnerRole, publicRole } from "@/auth/roles";
import { claudeRouteOn } from "@/auth/ai-access";
import { logger } from "@/services/logger.service";
import { deleteSharesOf } from "@/services/share/access";

/** `user` in every /auth response. */
export function publicAccount(admin: IAdmin | Record<string, any>) {
  const a: Record<string, any> = typeof (admin as any).toObject === "function" ? (admin as any).toObject() : admin;
  return {
    _id: String(a._id),
    name: a.name ?? null,
    email: a.email ?? null,
    role: publicRole(a.role),
    isVerified: a.isVerified !== false,
    /** AI features on: the owner always, premium accounts, and everyone while Claude AI is open (auth/ai-access.ts). */
    premium: isAiAccount(a.role, a.premium) || claudeRouteOn(),
    /** Voice (speech to text) and image AI: premium accounts only. */
    voiceAi: isAiAccount(a.role, a.premium),
    providers: accountProviders(a),
    createdAt: a.createdAt ?? null,
  };
}

/** Stored providers; older rows have none stored, and they all signed in with a password. */
export function accountProviders(a: { providers?: string[] | null }): AuthProvider[] {
  return a.providers?.length ? (a.providers as AuthProvider[]) : ["password"];
}

// ─── tokens ─────────────────────────────────────────────────────────────────────────────

export async function issueToken(
  kind: AuthTokenKind,
  fields: { userId?: Types.ObjectId | string | null; email?: string | null; redirect?: string | null; codeVerifier?: string | null }
): Promise<string> {
  const raw = generateRawToken();
  await AuthToken.create({
    tokenHash: hashToken(raw),
    kind,
    userId: fields.userId ? new Types.ObjectId(String(fields.userId)) : null,
    email: fields.email ?? null,
    redirect: fields.redirect ?? null,
    codeVerifier: fields.codeVerifier ?? null,
    expiresAt: tokenExpiry(kind),
  });
  return raw;
}

/** Use a token once: atomically marks it used. Null when unknown, expired, used or the wrong kind. */
export async function consumeToken(kind: AuthTokenKind, raw: unknown): Promise<IAuthToken | null> {
  if (typeof raw !== "string" || !RAW_TOKEN_RE.test(raw)) return null;
  const now = new Date();
  return AuthToken.findOneAndUpdate(
    { tokenHash: hashToken(raw), kind, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true }
  ).lean<IAuthToken>();
}

/** Older unused links of one kind stop working when a new one is sent (or the password changes). */
export async function revokeTokens(userId: Types.ObjectId | string, kinds: AuthTokenKind[]): Promise<void> {
  await AuthToken.deleteMany({ userId: new Types.ObjectId(String(userId)), kind: { $in: kinds }, usedAt: null });
}

// ─── deletion ───────────────────────────────────────────────────────────────────────────

/** Whether deleting this account would leave the server without an owner. */
export async function isLastOwner(admin: { _id: unknown; role?: string | null }): Promise<boolean> {
  if (!isOwnerRole(admin.role)) return false;
  const others = await Admin.countDocuments({ ...OWNER_ROLE_FILTER, _id: { $ne: admin._id }, isDisabled: { $ne: true } });
  return others === 0;
}

/**
 * Delete an account and everything it owns: stored files, every study_* row keyed by it, its
 * auth tokens, then the account row itself (last, so a failure part-way can simply be retried).
 *
 * Each model is filtered on the field it actually has (`userId`, or `user` for perf rows). A
 * model with neither is skipped: with strictQuery a filter on an unknown path is DROPPED,
 * which would turn the delete into "delete everything".
 */
export async function deleteAccount(userId: string): Promise<void> {
  const id = new Types.ObjectId(userId);
  const account = await Admin.findById(id, { email: 1 }).lean<{ email?: string | null }>();
  // Shares are keyed by ownerId (not swept below): drop the user's shares and every grant naming them.
  await deleteSharesOf(userId, account?.email ?? null);
  await deleteUserObjects(userId);
  for (const model of studyModels()) {
    const field = model.schema.path("userId") ? "userId" : model.schema.path("user") ? "user" : null;
    if (!field) continue;
    await model.deleteMany({ [field]: id });
  }
  await AuthToken.deleteMany({ userId: id });
  await Admin.deleteOne({ _id: id });
  logger.info(`Account ${userId} deleted with its data`).catch(() => {});
}
