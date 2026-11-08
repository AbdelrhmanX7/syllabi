/**
 * Premium = the AI features are on for an account (auth/verified.ts gates every AI route on it).
 * There are no payments: the owner turns it on by hand, through /admin/premium (auth/router.ts) or
 * the CLI (auth/premium-cli.ts). The owner role always has AI, whatever its flag says.
 */
import { Admin } from "@/models/admin";
import { isOwnerRole, OWNER_ROLE_FILTER } from "@/auth/roles";

export class PremiumError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface PremiumAccount {
  _id: string;
  email: string | null;
  name: string | null;
  role: "owner" | "user";
  /** The owner: always has AI, cannot be removed. */
  owner: boolean;
}

const dto = (a: { _id: unknown; email?: string | null; name?: string | null; role?: string | null }): PremiumAccount => ({
  _id: String(a._id),
  email: a.email ?? null,
  name: a.name ?? null,
  role: isOwnerRole(a.role) ? "owner" : "user",
  owner: isOwnerRole(a.role),
});

/** The owner(s) first, then every account with `premium: true`, by email. */
export async function listPremium(): Promise<PremiumAccount[]> {
  const rows = await Admin.find({ $or: [{ premium: true }, OWNER_ROLE_FILTER] })
    .select("email name role")
    .sort({ email: 1 })
    .lean();
  return rows.map(dto).sort((a, b) => Number(b.owner) - Number(a.owner));
}

const normEmail = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** Turn AI on or off for the account with this email. */
export async function setPremium(email: unknown, on: boolean): Promise<PremiumAccount> {
  const e = normEmail(email);
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new PremiumError(400, "VALIDATION_ERROR", "Enter a valid email address.");
  const row = await Admin.findOne({ email: e }).select("email name role").lean();
  if (!row) throw new PremiumError(404, "NOT_FOUND", "No account uses that email.");
  if (!on && isOwnerRole(row.role)) throw new PremiumError(400, "OWNER_ALWAYS_PREMIUM", "The owner always has AI.");
  await Admin.updateOne({ _id: row._id }, { $set: { premium: on } });
  return dto(row);
}
