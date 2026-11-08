import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateRawToken, hashToken, isTokenUsable, pkceChallenge, RAW_TOKEN_RE, tokenExpiry, TOKEN_TTL_MS } from "../src/auth/tokens";
import { isAllowedRedirect, withFragment, withQueryToken } from "../src/auth/redirect";
import { AuthInputError, normaliseEmail, validateLogin, validatePassword, validateRegister } from "../src/auth/validate";
import { isOwnerRole, isStudyRole, publicRole } from "../src/auth/roles";

test("tokens: 32 random bytes, base64url, unique", () => {
  const a = generateRawToken();
  const b = generateRawToken();
  assert.match(a, RAW_TOKEN_RE);
  assert.equal(Buffer.from(a, "base64url").length, 32);
  assert.notEqual(a, b);
});

test("tokens: stored as sha256 hex, never the raw value", () => {
  const raw = generateRawToken();
  const h = hashToken(raw);
  assert.equal(h, createHash("sha256").update(raw).digest("hex"));
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, raw);
});

test("tokens: lifetimes match the spec", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert.equal(tokenExpiry("verify", now).getTime() - now.getTime(), 48 * 3600_000);
  assert.equal(tokenExpiry("magic", now).getTime() - now.getTime(), 15 * 60_000);
  assert.equal(tokenExpiry("reset", now).getTime() - now.getTime(), 3600_000);
  assert.equal(TOKEN_TTL_MS.google_state, 10 * 60_000);
});

test("tokens: usable only once, before expiry, for the right kind", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const row = { kind: "reset", expiresAt: tokenExpiry("reset", now), usedAt: null };
  assert.equal(isTokenUsable(row, "reset", now), true);
  assert.equal(isTokenUsable(row, "magic", now), false);
  assert.equal(isTokenUsable({ ...row, usedAt: now }, "reset", now), false);
  assert.equal(isTokenUsable(row, "reset", new Date(now.getTime() + 3600_000)), false);
  assert.equal(isTokenUsable(null, "reset", now), false);
});

test("pkce: S256 challenge = base64url(sha256(verifier))", () => {
  const v = generateRawToken();
  assert.equal(pkceChallenge(v), createHash("sha256").update(v).digest("base64url"));
  assert.match(pkceChallenge(v), /^[A-Za-z0-9_-]{43}$/);
});

test("redirect allow-list: APP_URL origin and the app scheme only", () => {
  const app = "https://app.syllabi.studio";
  assert.equal(isAllowedRedirect("https://app.syllabi.studio/auth/callback/", app), true);
  assert.equal(isAllowedRedirect("https://app.syllabi.studio", app + "/"), true);
  assert.equal(isAllowedRedirect("studio.syllabi.app://auth", app), true);
  assert.equal(isAllowedRedirect("studio.syllabi.app:auth", app), false);
  assert.equal(isAllowedRedirect("https://app.syllabi.studio.evil.com/", app), false);
  assert.equal(isAllowedRedirect("https://evil.com/?https://app.syllabi.studio", app), false);
  assert.equal(isAllowedRedirect("http://app.syllabi.studio/", app), false);
  assert.equal(isAllowedRedirect("https://app.syllabi.studio:8443/", app), false);
  assert.equal(isAllowedRedirect("https://user@app.syllabi.studio/", app), false);
  assert.equal(isAllowedRedirect("javascript:alert(1)", app), false);
  assert.equal(isAllowedRedirect("//evil.com", app), false);
  assert.equal(isAllowedRedirect("https://app.syllabi.studio/", ""), false);
  assert.equal(isAllowedRedirect(undefined, app), false);
});

test("redirect helpers: token in the query for links, session in the fragment", () => {
  assert.equal(withQueryToken("https://a.b/auth/magic/", "x"), "https://a.b/auth/magic/?token=x");
  assert.equal(withQueryToken("https://a.b/m?x=1#f", "t"), "https://a.b/m?x=1&token=t#f");
  assert.equal(withFragment("studio.syllabi.app://auth#old", { token: "j" }), "studio.syllabi.app://auth#token=j");
});

test("register validation", () => {
  assert.deepEqual(validateRegister({ email: " Me@Example.COM ", password: "longenough" }), {
    name: "me",
    email: "me@example.com",
    password: "longenough",
  });
  assert.equal(validateRegister({ name: "  Sam ", email: "s@x.io", password: "12345678" }).name, "Sam");
  assert.throws(() => validateRegister({ email: "nope", password: "12345678" }), AuthInputError);
  assert.throws(() => validateRegister({ email: "", password: "12345678" }), AuthInputError);
  assert.throws(() => validateRegister({ email: "a@b.co", password: "short" }), AuthInputError);
  assert.throws(() => validateRegister({ email: "a@b.co", password: "x".repeat(73) }), AuthInputError);
  assert.throws(() => validateRegister(null), AuthInputError);
  assert.equal(validatePassword("x".repeat(72)).length, 72);
  // 72 is a byte limit (bcrypt): 37 two-byte characters are 74 bytes.
  assert.throws(() => validatePassword("é".repeat(37)), AuthInputError);
});

test("login validation", () => {
  assert.deepEqual(validateLogin({ email: "A@B.co", password: "p" }), { email: "a@b.co", password: "p" });
  assert.equal(validateLogin({ email: "a@b.co" }), null);
  assert.equal(validateLogin({ email: "bad", password: "p" }), null);
  assert.equal(validateLogin({ email: "a@b.co", password: "x".repeat(73) }), null);
  assert.equal(normaliseEmail(42), "");
});

test("roles: legacy admin and missing role are owner", () => {
  assert.equal(isOwnerRole("admin"), true);
  assert.equal(isOwnerRole(undefined), true);
  assert.equal(isOwnerRole("owner"), true);
  assert.equal(isOwnerRole("user"), false);
  assert.equal(isStudyRole("user"), true);
  assert.equal(isStudyRole("teacher"), false);
  assert.equal(publicRole("admin"), "owner");
  assert.equal(publicRole("user"), "user");
});
