/**
 * The one place that decides who may read or write a shared resource. Study routes check plain
 * ownership today; phase 2 (editors, live co-editing) moves them onto `canAccess`, so the rule for
 * "owner, or a grant with a strong enough role" lives here only.
 */
import { Types } from "mongoose";
import { IShare, Share, ShareFork, ShareResourceType, ShareRole } from "@/models/share";
import { loadOwned, OwnedResource, ResourceRef } from "@/services/share/resources";
import { RAW_TOKEN_RE } from "@/auth/tokens";

export interface Caller {
  userId: Types.ObjectId;
  /** Only a VERIFIED email matches grants: anyone can register an unverified account with any address. */
  email: string | null;
  emailVerified: boolean;
}

export type AccessMode = "read" | "write";

const ROLE_RANK: Record<ShareRole, number> = { viewer: 1, editor: 2 };
const modeRank = (mode: AccessMode) => (mode === "write" ? ROLE_RANK.editor : ROLE_RANK.viewer);

/** The grant on `share` that names the caller (by account, or by verified email), or null. */
export function callerGrant(share: Pick<IShare, "grants">, caller: Caller) {
  return (
    share.grants.find(
      (g) =>
        (g.userId && String(g.userId) === String(caller.userId)) ||
        (caller.emailVerified && caller.email && g.email === caller.email.toLowerCase())
    ) ?? null
  );
}

/** Mongo filter for shares that grant the caller something (by account or verified email). */
export function grantedToFilter(caller: Caller) {
  const or: Record<string, unknown>[] = [{ "grants.userId": caller.userId }];
  if (caller.emailVerified && caller.email) or.push({ "grants.email": caller.email.toLowerCase() });
  return { $or: or, ownerId: { $ne: caller.userId } };
}

/** First match by verified email: pin the grant to the account, so later email changes don't move it. */
export async function bindEmailGrants(caller: Caller): Promise<void> {
  if (!caller.emailVerified || !caller.email) return;
  await Share.updateMany(
    { grants: { $elemMatch: { email: caller.email.toLowerCase(), userId: null } }, ownerId: { $ne: caller.userId } },
    { $set: { "grants.$[g].userId": caller.userId } },
    { arrayFilters: [{ "g.email": caller.email.toLowerCase(), "g.userId": null }] }
  );
}

/**
 * Whether the caller may read / write this resource: the owner always; otherwise a share of it whose
 * grant (or, with `linkToken`, link) has a strong enough role. Phase 1 grants are all "viewer", so
 * "write" is owner-only in practice.
 */
export async function canAccess(
  caller: Caller,
  ref: ResourceRef & { ownerId?: Types.ObjectId },
  mode: AccessMode,
  linkToken?: string | null
): Promise<boolean> {
  const ownerId = ref.ownerId ?? caller.userId;
  if (String(ownerId) === String(caller.userId)) return Boolean(await loadOwned(ref, caller.userId));
  const share = await Share.findOne({ ownerId, resourceType: ref.resourceType, resourceId: ref.resourceId, topic: ref.topic ?? null }).lean<IShare>();
  if (!share) return false;
  const grant = callerGrant(share, caller);
  const roles: ShareRole[] = [];
  if (grant) roles.push(grant.role);
  if (linkToken && share.link && share.link.token === linkToken) roles.push(share.link.role);
  if (!roles.some((r) => ROLE_RANK[r] >= modeRank(mode))) return false;
  return Boolean(await loadOwned(ref, ownerId));
}

export const SHARE_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * `idOrToken` from /share/view and /share/fork: a 24-hex share id (grant or owner) or a 43-char link
 * token (anyone signed in who has the link). The two forms never overlap. Returns the share and the
 * live resource, or null for "not found" (never says which check failed).
 */
export async function resolveShared(
  idOrToken: unknown,
  caller: Caller,
  mode: AccessMode = "read"
): Promise<{ share: IShare; resource: OwnedResource; via: "owner" | "grant" | "link" } | null> {
  if (typeof idOrToken !== "string") return null;
  let share: IShare | null = null;
  let via: "owner" | "grant" | "link" | null = null;
  if (SHARE_ID_RE.test(idOrToken)) {
    share = await Share.findById(idOrToken).lean<IShare>();
    if (!share) return null;
    if (String(share.ownerId) === String(caller.userId)) via = "owner";
    else {
      const grant = callerGrant(share, caller);
      if (grant && ROLE_RANK[grant.role] >= modeRank(mode)) via = "grant";
    }
  } else if (RAW_TOKEN_RE.test(idOrToken)) {
    share = await Share.findOne({ "link.token": idOrToken }).lean<IShare>();
    if (share?.link && ROLE_RANK[share.link.role] >= modeRank(mode)) via = String(share.ownerId) === String(caller.userId) ? "owner" : "link";
  }
  if (!share || !via) return null;
  const resource = await loadOwned({ resourceType: share.resourceType, resourceId: share.resourceId, topic: share.topic }, share.ownerId);
  if (!resource) return null;
  return { share, resource, via };
}

/** Account deletion: shares the user owns go, and every grant naming them is removed. */
export async function deleteSharesOf(userId: string, email: string | null): Promise<void> {
  const id = new Types.ObjectId(userId);
  await Share.deleteMany({ ownerId: id });
  await Share.updateMany({ "grants.userId": id }, { $pull: { grants: { userId: id } } });
  if (email) await Share.updateMany({ "grants.email": email.toLowerCase() }, { $pull: { grants: { email: email.toLowerCase() } } });
  await ShareFork.deleteMany({ userId: id });
}

export type { ShareResourceType };
