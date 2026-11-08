/**
 * Email-link and OAuth-state tokens: pure helpers (no database), so they can be unit tested.
 *
 * A token is 32 random bytes (base64url) handed to the user once, in a link. Only its sha256
 * hash is stored (models/auth-token.ts), with a kind, an expiry and a `usedAt` stamp, so a
 * leaked database row cannot be turned back into a working link and every link works once.
 */
import { createHash, randomBytes } from "crypto";

export type AuthTokenKind = "verify" | "magic" | "reset" | "google_state";

/** Lifetimes from docs/accounts.md (verify 48 h, magic link 15 min, reset 1 h); OAuth state 10 min. */
export const TOKEN_TTL_MS: Record<AuthTokenKind, number> = {
  verify: 48 * 60 * 60 * 1000,
  magic: 15 * 60 * 1000,
  reset: 60 * 60 * 1000,
  google_state: 10 * 60 * 1000,
};

/** base64url of 32 random bytes = 43 characters. */
export const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function tokenExpiry(kind: AuthTokenKind, now: Date = new Date()): Date {
  return new Date(now.getTime() + TOKEN_TTL_MS[kind]);
}

/** Whether a stored token row can still be consumed. */
export function isTokenUsable(
  row: { kind: string; expiresAt: Date | string; usedAt?: Date | string | null } | null | undefined,
  kind: AuthTokenKind,
  now: Date = new Date()
): boolean {
  if (!row || row.kind !== kind || row.usedAt) return false;
  return new Date(row.expiresAt).getTime() > now.getTime();
}

/** A PKCE S256 challenge for a code verifier (RFC 7636). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
