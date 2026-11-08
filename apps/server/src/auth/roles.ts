/**
 * Account roles. `owner` runs the server; the legacy `admin` value (and a missing role, which
 * older rows have) means owner too. `user` is a registered account. Both may use /study; only
 * the owner reaches server-management routes. Pure, no imports.
 */
export type AccountRole = "owner" | "user";

export const isOwnerRole = (role: string | null | undefined): boolean => (role ?? "admin") === "admin" || role === "owner";

/** AI features: the owner always, anyone else only when the owner turned `premium` on. */
export const isAiAccount = (role: string | null | undefined, premium: unknown): boolean => isOwnerRole(role) || premium === true;

/** Roles allowed on the /study API (and the MCP / phone inbox that act on study data). */
export const isStudyRole = (role: string | null | undefined): boolean => isOwnerRole(role) || role === "user";

/** The role as the API reports it. */
export const publicRole = (role: string | null | undefined): AccountRole => (isOwnerRole(role) ? "owner" : "user");

/** Mongo filter for owner rows (legacy rows may have no role at all). */
export const OWNER_ROLE_FILTER = { $or: [{ role: { $in: ["admin", "owner"] } }, { role: { $exists: false } }, { role: null }] };
