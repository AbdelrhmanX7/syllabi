/**
 * The owner account: the one that runs the server. With REGISTRATION=closed (the default) it is
 * the only account; with REGISTRATION=open other people register `user` accounts through /auth
 * (auth/accounts-router.ts), each with its own study data.
 *
 * The first owner is created one of three ways, whichever comes first:
 *   1. from env at boot (ADMIN_EMAIL + ADMIN_PASSWORD), see ensureOwnerFromEnv;
 *   2. the first-run setup endpoint (POST /admin/setup), see auth/router.ts;
 *   3. the CLI (`pnpm owner create`), see auth/cli.ts.
 * The env values only ever CREATE the account; they are never re-applied on later boots,
 * so changing the password in the app (or via the CLI) is not undone by a restart.
 */
import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { Admin, IAdmin } from "@/models/admin";
import { isAiAccount, OWNER_ROLE_FILTER } from "@/auth/roles";
import { claudeRouteOn } from "@/auth/ai-access";

/**
 * The first owner gets a fixed id, so two racing setup requests (or setup racing the env seed)
 * collide on the primary key instead of both creating an account.
 */
export const FIRST_OWNER_ID = new Types.ObjectId("000000000000000000000001");

export const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_ROUNDS = 12;

export interface OwnerInput {
  name?: unknown;
  email?: unknown;
  phoneNumber?: unknown;
  password?: unknown;
}

export class OwnerInputError extends Error {}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Validate and normalise owner fields. Throws OwnerInputError with a user-facing message. */
export function normaliseOwnerInput(input: OwnerInput) {
  const name = str(input.name) || "Owner";
  const email = str(input.email).toLowerCase();
  const phoneNumber = str(input.phoneNumber);
  const password = typeof input.password === "string" ? input.password : "";

  if (!email) throw new OwnerInputError("Give an email to sign in with.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new OwnerInputError("That email address is not valid.");
  if (phoneNumber && !/^\+?[0-9][0-9 ()-]{3,30}$/.test(phoneNumber)) {
    throw new OwnerInputError("That phone number is not valid (digits, spaces, + ( ) - only).");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new OwnerInputError(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 72) throw new OwnerInputError("The password must be at most 72 characters.");

  return { name, email, phoneNumber: phoneNumber || undefined, password };
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);

/** Whether an owner exists. Registered `user` accounts do not count, so setup still works on an open server. */
export async function ownerExists(): Promise<boolean> {
  return (await Admin.exists(OWNER_ROLE_FILTER)) !== null;
}

/**
 * Create the first owner. Returns null when an account already exists (including when a
 * concurrent request won the race), so callers can answer "already set up".
 */
export async function createFirstOwner(input: OwnerInput): Promise<IAdmin | null> {
  const fields = normaliseOwnerInput(input);
  if (await ownerExists()) return null;
  try {
    return await Admin.create({
      _id: FIRST_OWNER_ID,
      name: fields.name,
      email: fields.email,
      ...(fields.phoneNumber ? { phoneNumber: fields.phoneNumber } : {}),
      password: await hashPassword(fields.password),
      // "admin" is the legacy name of the owner role (auth/roles.ts); kept so older servers still read it.
      role: "admin",
      isVerified: true,
      isDisabled: false,
      providers: ["password"],
    });
  } catch (error: any) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

/** True when the env carries enough to seed the owner. */
export function envOwnerConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_EMAIL);
}

/**
 * Boot-time seed: create the owner from ADMIN_* env when no account exists yet.
 * Never throws: a bad env value is logged and the server still starts (setup/CLI remain).
 */
export async function ensureOwnerFromEnv(log: (message: string) => void = console.log): Promise<void> {
  try {
    if (await ownerExists()) return;
    if (!envOwnerConfigured()) {
      log(
        "[auth] No owner account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD, " +
          "run `pnpm owner create`, or use POST /admin/setup (see SETUP_TOKEN)."
      );
      return;
    }
    const created = await createFirstOwner({
      name: process.env.ADMIN_NAME,
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    });
    if (created) log(`[auth] Created the owner account from ADMIN_* env (${created.email}).`);
  } catch (error: any) {
    log(`[auth] Could not create the owner account from env: ${error?.message ?? error}`);
  }
}

/** The account as returned to the app: everything except the password hash. */
export function publicUser(admin: IAdmin | Record<string, any>) {
  const plain: Record<string, any> = typeof (admin as any).toObject === "function" ? (admin as any).toObject() : { ...admin };
  delete plain.password;
  delete plain.googleId;
  delete plain.__v;
  const role = plain.role ?? "admin";
  // `premium` is the effective value: the owner always has the AI features, and everyone does while
  // Claude AI is open (auth/ai-access.ts). `voiceAi` = voice / image AI, premium accounts only.
  const premiumAi = isAiAccount(role, plain.premium);
  return { ...plain, _id: String(plain._id), role, premium: premiumAi || claudeRouteOn(), voiceAi: premiumAi };
}
