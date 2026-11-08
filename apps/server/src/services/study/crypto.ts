import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";
import { getJwtSecret } from "@/compat/auth";

/**
 * At-rest encryption for the Canvas personal access token.
 *
 * No new env var on purpose (owner rule: env = existing secrets only). The 32-byte key is
 * DERIVED from the JWT secret (`JWT_SECRET`) with HKDF-SHA256 under a purpose-bound `info`, so it is
 * never the JWT secret itself and cannot be reused for anything else. Rotating JWT_SECRET
 * makes stored tokens unreadable — the sync then reports CANVAS_TOKEN_UNREADABLE and the
 * owner re-saves the token.
 *
 * Blob format: `v1.<iv>.<tag>.<ciphertext>` (base64url), AES-256-GCM with a 12-byte iv.
 */
const INFO = "study-canvas-token-v1";

function deriveKey(secret: string | undefined): Buffer {
  if (!secret) throw new Error("JWT_SECRET is not set");
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), INFO, 32));
}

export function encryptToken(plain: string, secret = getJwtSecret()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

/** Throws on a wrong key or a tampered blob (GCM auth tag mismatch). */
export function decryptToken(blob: string, secret = getJwtSecret()): string {
  const [v, iv, tag, ct] = String(blob).split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("Unrecognised token blob");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
