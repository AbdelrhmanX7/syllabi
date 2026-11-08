/**
 * Input validation for the /auth endpoints. Pure (no database), so it can be unit tested.
 * Every function throws AuthInputError with a user-facing message, or returns normalised values.
 */
export const MIN_PASSWORD = 8;
/** bcrypt only reads the first 72 bytes; longer passwords are refused instead of silently cut. */
export const MAX_PASSWORD = 72;
const MAX_NAME = 80;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthInputError extends Error {}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Lower-cased, trimmed email, or "" when it is not a plausible address. */
export function normaliseEmail(value: unknown): string {
  const email = str(value).toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : "";
}

export function requireEmail(value: unknown): string {
  if (!str(value)) throw new AuthInputError("Give an email address.");
  const email = normaliseEmail(value);
  if (!email) throw new AuthInputError("That email address is not valid.");
  return email;
}

export function validatePassword(value: unknown, label = "The password"): string {
  if (typeof value !== "string" || value.length < MIN_PASSWORD) {
    throw new AuthInputError(`${label} must be at least ${MIN_PASSWORD} characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_PASSWORD) throw new AuthInputError(`${label} must be at most ${MAX_PASSWORD} characters.`);
  return value;
}

export function validateRegister(body: unknown): { name: string; email: string; password: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = requireEmail(b.email);
  const password = validatePassword(b.password);
  const name = str(b.name).slice(0, MAX_NAME) || email.split("@")[0];
  return { name, email, password };
}

/** Login only checks shape; whether the credentials are right is the caller's job. */
export function validateLogin(body: unknown): { email: string; password: string } | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = normaliseEmail(b.email);
  const password = typeof b.password === "string" ? b.password : "";
  if (!email || !password || Buffer.byteLength(password, "utf8") > MAX_PASSWORD) return null;
  return { email, password };
}
