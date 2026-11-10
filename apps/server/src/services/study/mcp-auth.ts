import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "crypto";
import { isStudyRole } from "@/auth/roles";
import type { Request } from "express";
import { Types } from "mongoose";
import { Admin } from "@/models/admin";
import { getJwtSecret } from "@/compat/auth";
import {
  IStudyMcpKey,
  IStudyOAuthClient,
  IStudyOAuthCode,
  IStudyOAuthGrant,
  IStudyOAuthToken,
  OAUTH_CLIENT_AUTH_METHODS,
  OAuthClientAuthMethod,
  StudyMcpKey,
  StudyOAuthClient,
  StudyOAuthCode,
  StudyOAuthGrant,
  StudyOAuthToken,
} from "@/models/study/mcp";

/**
 * Credentials for the Study remote MCP server (contract "MCP (remote, for Claude)", P6):
 * personal API keys (`sk_study_…`) and an OAuth 2.1 authorization server (authorization
 * code + PKCE S256 only, RFC 7591 dynamic registration, rotating refresh tokens).
 *
 * Every secret (key, client secret, code, token) is random, shown once, and stored as a
 * sha256 hash. All state is in Mongo — prod runs four API workers behind a round-robin
 * upstream, so nothing here may live in process memory.
 *
 * Public URLs (everything is under /study, so the host's root `/.well-known/oauth-*` and
 * `/oauth/*` paths stay free):
 *   resource (MCP)  <base>/study/mcp
 *   issuer          <base>/study
 */

export const STUDY_SCOPE = "study";
export const ACCESS_TOKEN_TTL_SEC = 3600;
/**
 * Refresh tokens are effectively valid until revoked: each refresh mints a new one with a fresh
 * 400-day horizon (sliding), so only a connection left unused for 400 days lapses.
 */
export const REFRESH_TOKEN_TTL_SEC = 400 * 24 * 3600;
/** A rotated refresh token stays usable this long (concurrent / retried refreshes); later reuse = replay. */
export const REFRESH_REUSE_GRACE_SEC = 60;
export const GRANT_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;
export const AUTH_CODE_TTL_SEC = 60;
export const CSRF_TTL_SEC = 15 * 60;
export const KEY_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;
export const MAX_KEYS_PER_USER = 20;

/** The only non-loopback redirect URIs a client may register (Claude's connector callbacks). */
export const CLAUDE_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

// ─── primitives ─────────────────────────────────────────────────────────────────────────

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const rand = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Constant-time string equality (length is not secret: both sides are fixed-length hashes). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const PKCE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** RFC 7636 S256: base64url(sha256(verifier)) === challenge. Plain is never accepted. */
export function verifyPkceS256(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !PKCE_RE.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return safeEqual(computed, challenge);
}

/** A single string query/body value; arrays (`?a=1&a=2`) and objects are rejected. */
export const one = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// ─── public URLs ────────────────────────────────────────────────────────────────────────

const HOST_RE = /^[A-Za-z0-9.\-]+(:\d{1,5})?$|^\[[0-9a-fA-F:.]+\](:\d{1,5})?$/;

/** `<proto>://<host>` of this request (`trust proxy` makes req.protocol honour nginx's X-Forwarded-Proto). */
export function publicBase(req: Request): string {
  const host = String(req.get("host") ?? "");
  const safeHost = HOST_RE.test(host) ? host.toLowerCase() : "localhost";
  return `${req.protocol === "https" ? "https" : "http"}://${safeHost}`;
}
export const resourceUri = (req: Request) => `${publicBase(req)}/study/mcp`;
export const issuerUri = (req: Request) => `${publicBase(req)}/study`;

export function authorizationServerMetadata(req: Request) {
  const issuer = issuerUri(req);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...OAUTH_CLIENT_AUTH_METHODS],
    scopes_supported: [STUDY_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata(req: Request) {
  return {
    resource: resourceUri(req),
    authorization_servers: [issuerUri(req)],
    bearer_methods_supported: ["header"],
    scopes_supported: [STUDY_SCOPE],
    resource_name: "Study",
  };
}

/** RFC 8707 resource comparison: scheme/host case-insensitive, a trailing slash ignored. */
export function sameResource(given: string, ours: string): boolean {
  try {
    const g = new URL(given);
    const o = new URL(ours);
    if (g.hash || g.search) return false;
    const norm = (u: URL) => `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
    return norm(g) === norm(o);
  } catch {
    return false;
  }
}

// ─── who may use the MCP ────────────────────────────────────────────────────────────────

type AccountFlags = { role?: string | null; isDisabled?: boolean; isVerified?: boolean } | null | undefined;

/** Same rule as the `/study` mount (adminVerification + studyAccess): enabled, owner or user. */
export const isStudyAccount = (a: AccountFlags) => !!a && a.isDisabled !== true && isStudyRole(a.role);

/**
 * Who may use the MCP (keys, OAuth): a study account whose email is verified, since MCP tools
 * can run the server's AI (same rule as the /study AI routes). Rows from before accounts have
 * no flag stored and count as verified.
 */
export const isFullAdmin = (a: AccountFlags) => isStudyAccount(a) && a!.isVerified !== false;

async function loadFullAdmin(userId: Types.ObjectId | string) {
  const a = await Admin.findById(userId).select("role isDisabled isVerified").lean<{ role?: string; isDisabled?: boolean; isVerified?: boolean }>();
  return isFullAdmin(a);
}

// ─── personal API keys ──────────────────────────────────────────────────────────────────

const KEY_RE = /^sk_study_[A-Za-z0-9_-]{43}$/;
const KEY_PREFIX_LEN = "sk_study_".length + 8;

export const keyDto = (k: IStudyMcpKey) => ({
  id: String(k._id),
  name: k.name,
  prefix: k.prefix,
  createdAt: k.createdAt ? new Date(k.createdAt).toISOString() : null,
  lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : null,
});

export class McpKeyError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Creates a key; the plaintext is in the return value ONLY (never stored, never listed). */
export async function createKey(userId: Types.ObjectId, name: unknown) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || n.length > 100) throw new McpKeyError(400, "VALIDATION_ERROR", "name is required (max 100 chars)");
  if ((await StudyMcpKey.countDocuments({ userId })) >= MAX_KEYS_PER_USER)
    throw new McpKeyError(400, "TOO_MANY_KEYS", `At most ${MAX_KEYS_PER_USER} keys — delete one first`);
  const key = `sk_study_${rand(32)}`;
  const doc = await StudyMcpKey.create({ userId, name: n, prefix: key.slice(0, KEY_PREFIX_LEN), keyHash: sha256Hex(key) });
  return { ...keyDto(doc.toObject() as IStudyMcpKey), key };
}

export async function listKeys(userId: Types.ObjectId) {
  const rows = await StudyMcpKey.find({ userId }, { keyHash: 0 }).sort({ createdAt: -1, _id: -1 }).lean<IStudyMcpKey[]>();
  return rows.map(keyDto);
}

export async function deleteKey(userId: Types.ObjectId, id: string) {
  const r = await StudyMcpKey.deleteOne({ _id: id, userId });
  return r.deletedCount === 1;
}

async function authenticateKey(key: string): Promise<{ userId: Types.ObjectId; keyId: Types.ObjectId } | null> {
  if (!KEY_RE.test(key)) return null;
  const hash = sha256Hex(key);
  const candidates = await StudyMcpKey.find({ prefix: key.slice(0, KEY_PREFIX_LEN) }, { userId: 1, keyHash: 1, lastUsedAt: 1 }).limit(10).lean<IStudyMcpKey[]>();
  let hit: IStudyMcpKey | null = null;
  for (const c of candidates) if (safeEqual(c.keyHash, hash)) hit = c; // no early exit
  if (!hit) return null;
  const now = Date.now();
  if (!hit.lastUsedAt || now - new Date(hit.lastUsedAt).getTime() > KEY_LAST_USED_THROTTLE_MS) {
    void StudyMcpKey.updateOne(
      { _id: hit._id, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lt: new Date(now - KEY_LAST_USED_THROTTLE_MS) } }] },
      { $set: { lastUsedAt: new Date(now) } }
    ).catch(() => undefined);
  }
  return { userId: hit.userId, keyId: hit._id };
}

// ─── bearer authentication for /study/mcp ───────────────────────────────────────────────

const ACCESS_RE = /^sat_[A-Za-z0-9_-]{43}$/;

export interface McpPrincipal {
  userId: Types.ObjectId;
  via: "key" | "oauth";
  /** The personal key used (via = key) — its name says which app it was made for. */
  keyId?: Types.ObjectId;
  /** The OAuth client (via = oauth) — its registered name / callbacks say which app it is. */
  clientId?: string;
}

/** A key or an unexpired, unrevoked access token issued for THIS resource, owned by a full admin. */
export async function authenticateBearer(token: string, req: Request, now = new Date()): Promise<McpPrincipal | null> {
  let principal: McpPrincipal | null = null;
  if (token.startsWith("sk_study_")) {
    const k = await authenticateKey(token);
    if (k) principal = { userId: k.userId, via: "key", keyId: k.keyId };
  } else if (ACCESS_RE.test(token)) {
    const row = await StudyOAuthToken.findOne({ tokenHash: sha256Hex(token), kind: "access" }).lean<IStudyOAuthToken>();
    if (row && !row.revokedAt && new Date(row.expiresAt) > now && sameResource(row.resource, resourceUri(req))) {
      if (!(await loadFullAdmin(row.userId))) return null;
      void touchGrant(row, now).catch(() => undefined);
      return { userId: row.userId, via: "oauth", clientId: row.clientId };
    }
  }
  if (!principal) return null;
  return (await loadFullAdmin(principal.userId)) ? principal : null;
}

/**
 * The name and callbacks of the app behind an MCP credential, for tagging what it creates (inbox
 * items). Looked up only when needed, never on the auth path. Nulls when the row is gone.
 */
export async function mcpClientIdentity(principal: McpPrincipal): Promise<{ name: string | null; redirectUris: string[] }> {
  if (principal.via === "key" && principal.keyId) {
    const key = await StudyMcpKey.findOne({ _id: principal.keyId, userId: principal.userId }, { name: 1 }).lean<IStudyMcpKey>();
    return { name: key?.name ?? null, redirectUris: [] };
  }
  if (principal.via === "oauth" && principal.clientId) {
    const client = await StudyOAuthClient.findOne({ clientId: principal.clientId }, { clientName: 1, redirectUris: 1 }).lean<IStudyOAuthClient>();
    return { name: client?.clientName || null, redirectUris: client?.redirectUris ?? [] };
  }
  return { name: null, redirectUris: [] };
}

// ─── dynamic client registration (RFC 7591) ─────────────────────────────────────────────

/** Claude's two callbacks, or a loopback http URI (local testing, e.g. the MCP inspector). */
export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 2000) return false;
  if (CLAUDE_REDIRECT_URIS.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (u.username || u.password || u.hash) return false;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export class OAuthError extends Error {
  constructor(public error: string, public description: string, public status = 400) {
    super(description);
  }
}

export async function registerClient(body: any) {
  const b = body && typeof body === "object" ? body : {};
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty array (max 10)");
  for (const u of uris)
    if (!isAllowedRedirectUri(u))
      throw new OAuthError("invalid_redirect_uri", `redirect_uri not allowed: only ${CLAUDE_REDIRECT_URIS.join(", ")} or http://localhost`);
  const method: string = b.token_endpoint_auth_method ?? "none";
  if (!(OAUTH_CLIENT_AUTH_METHODS as readonly string[]).includes(method))
    throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method must be one of ${OAUTH_CLIENT_AUTH_METHODS.join(", ")}`);
  if (b.grant_types !== undefined && (!Array.isArray(b.grant_types) || b.grant_types.some((g: unknown) => g !== "authorization_code" && g !== "refresh_token")))
    throw new OAuthError("invalid_client_metadata", "grant_types may only contain authorization_code and refresh_token");
  if (b.response_types !== undefined && (!Array.isArray(b.response_types) || b.response_types.some((r: unknown) => r !== "code")))
    throw new OAuthError("invalid_client_metadata", "response_types may only contain code");
  const clientName = typeof b.client_name === "string" ? b.client_name.trim().slice(0, 200) : "";

  const clientId = `sc_${rand(24)}`;
  const secret = method === "none" ? null : `scs_${rand(32)}`;
  const doc = await StudyOAuthClient.create({
    clientId,
    clientSecretHash: secret ? sha256Hex(secret) : null,
    clientName,
    redirectUris: [...new Set(uris as string[])],
    tokenEndpointAuthMethod: method as OAuthClientAuthMethod,
  });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(new Date(doc.createdAt).getTime() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: clientName,
    redirect_uris: doc.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
    scope: STUDY_SCOPE,
  };
}

// ─── authorize ──────────────────────────────────────────────────────────────────────────

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
  resource: string;
}

export type AuthorizeCheck =
  | { ok: true; client: IStudyOAuthClient; params: AuthorizeParams }
  /** Nothing about the request can be trusted enough to redirect: show an error page. */
  | { ok: false; kind: "page"; message: string }
  /** client + redirect_uri are valid: report the error to the client by redirect (RFC 6749 §4.1.2.1). */
  | { ok: false; kind: "redirect"; redirectUri: string; error: string; description: string; state: string };

/**
 * Validates an authorize request (GET query or POST form) in RFC order: client_id and an
 * EXACTLY registered redirect_uri first (failures never redirect), then response_type, PKCE
 * (S256 only — a missing method means `plain`, which is refused) and resource.
 */
export async function checkAuthorizeRequest(src: Record<string, unknown>, req: Request): Promise<AuthorizeCheck> {
  const clientId = one(src.client_id);
  const redirectUri = one(src.redirect_uri);
  if (!clientId) return { ok: false, kind: "page", message: "Missing client_id." };
  const client = await StudyOAuthClient.findOne({ clientId }).lean<IStudyOAuthClient>();
  if (!client) return { ok: false, kind: "page", message: "Unknown client_id." };
  if (!redirectUri || !client.redirectUris.some((u) => u === redirectUri))
    return { ok: false, kind: "page", message: "redirect_uri does not match a registered redirect URI." };

  const state = one(src.state) ?? "";
  const bad = (error: string, description: string): AuthorizeCheck => ({ ok: false, kind: "redirect", redirectUri, error, description, state });
  if (state.length > 2000) return bad("invalid_request", "state is too long");
  if (one(src.response_type) !== "code") return bad("unsupported_response_type", "response_type must be code");
  const challenge = one(src.code_challenge);
  if (!challenge) return bad("invalid_request", "code_challenge is required (PKCE)");
  if (one(src.code_challenge_method) !== "S256") return bad("invalid_request", "code_challenge_method must be S256");
  if (!/^[A-Za-z0-9\-_]{43}$/.test(challenge)) return bad("invalid_request", "code_challenge must be a base64url S256 challenge");
  const ours = resourceUri(req);
  const resource = one(src.resource);
  if (src.resource !== undefined && src.resource !== "" && (!resource || !sameResource(resource, ours)))
    return bad("invalid_target", `resource must be ${ours}`);
  const scope = one(src.scope);
  if (scope && !scope.split(/\s+/).filter(Boolean).every((s) => s === STUDY_SCOPE))
    return bad("invalid_scope", `the only scope is ${STUDY_SCOPE}`);
  return { ok: true, client, params: { clientId, redirectUri, state, codeChallenge: challenge, scope: STUDY_SCOPE, resource: ours } };
}

export function errorRedirect(redirectUri: string, error: string, description: string, state: string, issuer: string) {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", issuer);
  return u.toString();
}

// CSRF for the consent form: HMAC over (issued-at, browser nonce cookie, every authorize
// parameter). Stateless across workers, bound to this browser, and it also pins the
// parameters — a form whose hidden fields were edited after rendering fails the check.
function csrfKey(): Buffer {
  const secret = getJwtSecret();
  if (!secret) throw new Error("JWT_SECRET is not set");
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), "study-oauth-csrf-v1", 32));
}
const csrfMac = (ts: number, nonce: string, p: AuthorizeParams) =>
  createHmac("sha256", csrfKey())
    .update(JSON.stringify([ts, nonce, p.clientId, p.redirectUri, p.codeChallenge, p.state, p.scope, p.resource]))
    .digest("base64url");

export const NONCE_RE = /^[A-Za-z0-9_-]{32}$/;
export const newCsrfNonce = () => rand(24);
export function makeCsrfToken(nonce: string, p: AuthorizeParams, now = Date.now()) {
  const ts = Math.floor(now / 1000);
  return `${ts}.${csrfMac(ts, nonce, p)}`;
}
export function checkCsrfToken(token: unknown, nonce: string | undefined, p: AuthorizeParams, now = Date.now()): boolean {
  if (typeof token !== "string" || !nonce || !NONCE_RE.test(nonce)) return false;
  const m = token.match(/^(\d{1,12})\.([A-Za-z0-9_-]{43})$/);
  if (!m) return false;
  const ts = Number(m[1]);
  const age = Math.floor(now / 1000) - ts;
  if (age < 0 || age > CSRF_TTL_SEC) return false;
  return safeEqual(m[2], csrfMac(ts, nonce, p));
}

/** Credentials checked, admin is a full admin: mint a single-use 60 s code. */
export async function issueCode(userId: Types.ObjectId, p: AuthorizeParams, now = new Date()) {
  const code = rand(32);
  await StudyOAuthCode.create({
    codeHash: sha256Hex(code),
    clientId: p.clientId,
    userId,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    scope: p.scope,
    resource: p.resource,
    expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_SEC * 1000),
  });
  return code;
}

// ─── token endpoint ─────────────────────────────────────────────────────────────────────

/** client_secret_basic (Authorization header) or client_secret_post / public client_id in the body. */
export async function authenticateClient(req: Request): Promise<IStudyOAuthClient> {
  let id = one(req.body?.client_id);
  let secret = one(req.body?.client_secret);
  const auth = req.headers.authorization;
  if (auth && /^basic /i.test(auth)) {
    const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) throw new OAuthError("invalid_client", "malformed Basic credentials", 401);
    let hid: string;
    let hsecret: string;
    try {
      hid = decodeURIComponent(decoded.slice(0, sep));
      hsecret = decodeURIComponent(decoded.slice(sep + 1));
    } catch {
      throw new OAuthError("invalid_client", "malformed Basic credentials", 401);
    }
    if (id && id !== hid) throw new OAuthError("invalid_request", "client_id in body and header differ");
    id = hid;
    secret = hsecret;
  }
  if (!id) throw new OAuthError("invalid_client", "client_id is required", 401);
  const client = await StudyOAuthClient.findOne({ clientId: id }).lean<IStudyOAuthClient>();
  if (!client) throw new OAuthError("invalid_client", "unknown client", 401);
  // A public client has no secret; PKCE is its proof. A presented secret is ignored, so a
  // connector that caches registration output can never lock itself out (the mcp-db lesson).
  if (client.tokenEndpointAuthMethod !== "none") {
    if (!secret || !client.clientSecretHash || !safeEqual(sha256Hex(secret), client.clientSecretHash))
      throw new OAuthError("invalid_client", "client authentication failed", 401);
  }
  return client;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface Pair {
  access: string;
  refresh: string;
}
interface ChainBase {
  clientId: string;
  userId: Types.ObjectId;
  scope: string;
  resource: string;
  familyId: Types.ObjectId;
}

const newPair = (): Pair => ({ access: `sat_${rand(32)}`, refresh: `srt_${rand(32)}` });
const chainBase = (r: ChainBase): ChainBase => ({ clientId: r.clientId, userId: r.userId, scope: r.scope, resource: r.resource, familyId: r.familyId });
const tokenResponse = (p: Pair, scope: string): TokenResponse => ({
  access_token: p.access,
  token_type: "Bearer",
  expires_in: ACCESS_TOKEN_TTL_SEC,
  refresh_token: p.refresh,
  scope,
});

/** Stores the pair's HASHES. A refresh token always gets a fresh 400-day horizon (sliding expiry). */
async function insertPair(base: ChainBase, p: Pair, now: Date) {
  const [access, refresh] = await StudyOAuthToken.insertMany([
    { ...base, kind: "access", tokenHash: sha256Hex(p.access), expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SEC * 1000) },
    { ...base, kind: "refresh", tokenHash: sha256Hex(p.refresh), expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SEC * 1000) },
  ]);
  return { accessId: access._id as Types.ObjectId, refreshId: refresh._id as Types.ObjectId };
}

// The successor pair of a rotated refresh token, sealed under a key derived from the PARENT
// token's plaintext. The parent is stored only as a hash, so a DB read alone can never open it;
// only a caller presenting the parent token (= someone who could have refreshed anyway) can.
const sealKey = (parentToken: string) =>
  Buffer.from(hkdfSync("sha256", Buffer.from(parentToken, "utf8"), Buffer.alloc(0), "study-refresh-successor-v1", 32));

export function sealPair(parentToken: string, p: Pair): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sealKey(parentToken), iv);
  const ct = Buffer.concat([c.update(JSON.stringify([p.access, p.refresh]), "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${ct.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
}

export function openPair(parentToken: string, sealed: string): Pair | null {
  try {
    const [v, iv, ct, tag] = sealed.split(".");
    if (v !== "v1" || !iv || !ct || !tag) return null;
    const d = createDecipheriv("aes-256-gcm", sealKey(parentToken), Buffer.from(iv, "base64url"), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, "base64url"));
    const [access, refresh] = JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8"));
    return typeof access === "string" && typeof refresh === "string" ? { access, refresh } : null;
  } catch {
    return null;
  }
}

// ─── grants (connections) ───────────────────────────────────────────────────────────────

/** Revokes a grant: the grant row (if materialised) and every access + refresh token in it. */
export async function revokeFamily(familyId: Types.ObjectId, now = new Date()) {
  await StudyOAuthGrant.updateOne({ _id: familyId, revokedAt: null }, { $set: { revokedAt: now } });
  await StudyOAuthToken.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: now } });
}

const isDupKey = (e: unknown) => (e as { code?: number })?.code === 11000;

/**
 * Throttled `lastUsedAt` bump in ONE round trip that also materialises a legacy grant (a chain
 * issued before grants existed): a fresh grant fails the filter, the upsert then collides on
 * `_id` (E11000) and that collision IS the "nothing to do" answer.
 */
export async function touchGrant(row: ChainBase & { createdAt?: Date }, now = new Date()) {
  try {
    await StudyOAuthGrant.updateOne(
      { _id: row.familyId, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lt: new Date(now.getTime() - GRANT_LAST_USED_THROTTLE_MS) } }] },
      {
        $set: { lastUsedAt: now },
        $setOnInsert: { userId: row.userId, clientId: row.clientId, scope: row.scope, resource: row.resource, revokedAt: null, createdAt: row.createdAt ?? now },
      },
      { upsert: true }
    );
  } catch (e) {
    if (!isDupKey(e)) throw e;
  }
}

/** `GET /study/mcp/connections`: one entry per live grant (a live refresh chain), never per token. */
export async function listConnections(userId: Types.ObjectId, now = new Date()) {
  const live = (await StudyOAuthToken.distinct("familyId", {
    userId,
    kind: "refresh",
    rotatedAt: null,
    revokedAt: null,
    expiresAt: { $gt: now },
  })) as Types.ObjectId[];
  if (!live.length) return []; // a real answer: no chain is live

  // Lazily materialise chains issued before grants existed (each chain = its own grant).
  const have = new Set((await StudyOAuthGrant.find({ _id: { $in: live } }, { _id: 1 }).lean()).map((g) => String(g._id)));
  const missing = live.filter((f) => !have.has(String(f)));
  if (missing.length) {
    const chains = await StudyOAuthToken.aggregate<{ _id: Types.ObjectId; clientId: string; scope: string; resource: string; createdAt: Date; lastAt: Date }>([
      { $match: { familyId: { $in: missing }, userId } },
      { $sort: { createdAt: 1 } },
      { $group: { _id: "$familyId", clientId: { $first: "$clientId" }, scope: { $first: "$scope" }, resource: { $first: "$resource" }, createdAt: { $first: "$createdAt" }, lastAt: { $last: "$createdAt" } } },
    ]);
    for (const c of chains) {
      await StudyOAuthGrant.updateOne(
        { _id: c._id },
        { $setOnInsert: { userId, clientId: c.clientId, scope: c.scope, resource: c.resource, createdAt: c.createdAt, lastUsedAt: c.lastAt, revokedAt: null } },
        { upsert: true }
      ).catch((e) => {
        if (!isDupKey(e)) throw e;
      });
    }
  }

  const grants = await StudyOAuthGrant.find({ _id: { $in: live }, userId, revokedAt: null }).sort({ createdAt: -1, _id: -1 }).lean<IStudyOAuthGrant[]>();
  const clientIds = [...new Set(grants.map((g) => g.clientId))];
  const names = new Map(
    (await StudyOAuthClient.find({ clientId: { $in: clientIds } }, { clientId: 1, clientName: 1 }).lean<IStudyOAuthClient[]>()).map((c) => [c.clientId, c.clientName])
  );
  return grants.map((g) => ({
    id: String(g._id),
    clientName: names.get(g.clientId) || null,
    clientId: g.clientId,
    createdAt: new Date(g.createdAt).toISOString(),
    lastUsedAt: g.lastUsedAt ? new Date(g.lastUsedAt).toISOString() : null,
    scopes: (g.scope || "").split(/\s+/).filter(Boolean),
  }));
}

/** `DELETE /study/mcp/connections/:id`. false = not this admin's grant (→ 404). */
export async function deleteConnection(userId: Types.ObjectId, id: string, now = new Date()) {
  const familyId = new Types.ObjectId(id);
  const grant = await StudyOAuthGrant.findById(familyId, { userId: 1 }).lean<IStudyOAuthGrant>();
  if (grant) {
    if (String(grant.userId) !== String(userId)) return false;
  } else if (!(await StudyOAuthToken.exists({ familyId, userId }))) {
    return false; // legacy chain (no grant row yet): ownership comes from its tokens
  }
  await revokeFamily(familyId, now);
  return true;
}

// ─── token grants ───────────────────────────────────────────────────────────────────────

const invalidGrant = (d: string) => new OAuthError("invalid_grant", d);

function checkTokenResource(req: Request, stored: string) {
  const r = req.body?.resource;
  if (r === undefined || r === "") return;
  const s = one(r);
  if (!s || !sameResource(s, stored)) throw new OAuthError("invalid_target", "resource does not match the authorization");
}

/** authorization_code grant. The code is consumed ATOMICALLY before anything else is checked. */
export async function exchangeCode(req: Request, client: IStudyOAuthClient, now = new Date()): Promise<TokenResponse> {
  const code = one(req.body?.code);
  if (!code) throw new OAuthError("invalid_request", "code is required");
  const codeHash = sha256Hex(code);
  const row = await StudyOAuthCode.findOneAndUpdate({ codeHash, usedAt: null }, { $set: { usedAt: now } }).lean<IStudyOAuthCode>();
  if (!row) {
    // Replay of a used code: revoke everything that code produced (RFC 6749 §4.1.2).
    const used = await StudyOAuthCode.findOneAndUpdate({ codeHash, usedAt: { $ne: null } }, { $set: { replayedAt: now } }).lean<IStudyOAuthCode>();
    if (used) await revokeFamily(used._id, now);
    throw invalidGrant("authorization code is invalid, expired or already used");
  }
  if (row.clientId !== client.clientId) throw invalidGrant("authorization code was issued to another client");
  if (new Date(row.expiresAt) <= now) throw invalidGrant("authorization code expired");
  if (one(req.body?.redirect_uri) !== row.redirectUri) throw invalidGrant("redirect_uri does not match the authorization request");
  if (!verifyPkceS256(req.body?.code_verifier, row.codeChallenge)) throw invalidGrant("PKCE verification failed");
  checkTokenResource(req, row.resource);
  if (!(await loadFullAdmin(row.userId))) throw invalidGrant("the authorizing account can no longer use Study");

  const base: ChainBase = { clientId: row.clientId, userId: row.userId, scope: row.scope, resource: row.resource, familyId: row._id };
  await StudyOAuthGrant.create({ _id: row._id, userId: row.userId, clientId: row.clientId, scope: row.scope, resource: row.resource, createdAt: now, lastUsedAt: now, revokedAt: null });
  const pair = newPair();
  await insertPair(base, pair, now);
  // A replay that raced this exchange (it ran before the tokens existed) left a mark: honour it.
  const after = await StudyOAuthCode.findById(row._id, { replayedAt: 1 }).lean<IStudyOAuthCode>();
  if (after?.replayedAt) {
    await revokeFamily(row._id, now);
    throw invalidGrant("authorization code was used twice");
  }
  return tokenResponse(pair, row.scope);
}

const REFRESH_INVALID = "refresh token is invalid, expired or already used";

/**
 * refresh_token grant with race-safe rotation.
 *
 * Exactly one caller can flip a live refresh token's `rotatedAt` null → now (findOneAndUpdate
 * guard). The winner's new pair is written BEFORE that flip and sealed onto the parent in the
 * same atomic update, so any duplicate refresh of the parent — concurrent, or a retry within
 * REFRESH_REUSE_GRACE_SEC — receives the SAME pair: one chain, never two divergent live ones.
 * A reuse after the window is a replay (theft signal) and revokes the whole grant.
 */
export async function exchangeRefresh(req: Request, client: IStudyOAuthClient, now = new Date()): Promise<TokenResponse> {
  const token = one(req.body?.refresh_token);
  if (!token) throw new OAuthError("invalid_request", "refresh_token is required");
  const row = await StudyOAuthToken.findOne({ tokenHash: sha256Hex(token), kind: "refresh" }).lean<IStudyOAuthToken>();
  if (!row || row.revokedAt) throw invalidGrant(REFRESH_INVALID);
  if (row.clientId !== client.clientId) {
    if (!row.rotatedAt) await revokeFamily(row.familyId, now);
    throw invalidGrant("refresh token was issued to another client");
  }
  if (row.rotatedAt) return reuseRotated(row, token, now);
  if (new Date(row.expiresAt) <= now) throw invalidGrant("refresh token expired");
  checkTokenResource(req, row.resource);
  if (!(await loadFullAdmin(row.userId))) {
    await revokeFamily(row.familyId, now);
    throw invalidGrant("the authorizing account can no longer use Study");
  }

  const pair = newPair();
  const ids = await insertPair(chainBase(row), pair, now);
  const won = await StudyOAuthToken.findOneAndUpdate(
    { _id: row._id, rotatedAt: null, revokedAt: null },
    { $set: { rotatedAt: now, successorId: ids.refreshId, successorSealed: sealPair(token, pair) } },
    { projection: { _id: 1 } }
  ).lean();
  if (!won) {
    // Lost the race: drop our never-shown pair and take the winner's.
    await StudyOAuthToken.deleteMany({ _id: { $in: [ids.accessId, ids.refreshId] } });
    const fresh = await StudyOAuthToken.findById(row._id).lean<IStudyOAuthToken>();
    if (!fresh || fresh.revokedAt || !fresh.rotatedAt) throw invalidGrant(REFRESH_INVALID);
    return reuseRotated(fresh, token, now);
  }
  // A connection revoked while we minted (its updateMany may have missed our new rows): honour it.
  const grant = await StudyOAuthGrant.findById(row.familyId, { revokedAt: 1 }).lean<IStudyOAuthGrant>();
  if (grant?.revokedAt) {
    await revokeFamily(row.familyId, now);
    throw invalidGrant("this connection was revoked");
  }
  // Sealed successors past the grace window can never be opened legitimately again.
  await StudyOAuthToken.updateMany(
    { familyId: row.familyId, successorSealed: { $ne: null }, rotatedAt: { $lt: new Date(now.getTime() - REFRESH_REUSE_GRACE_SEC * 1000) } },
    { $set: { successorSealed: null } }
  );
  await touchGrant(row, now);
  return tokenResponse(pair, row.scope);
}

/**
 * A rotated refresh token presented again. Within the grace window: the chain's current pair
 * (following successors, since the duplicate may land after the successor itself rotated).
 * After it: replay → revoke the grant.
 */
async function reuseRotated(row: IStudyOAuthToken, token: string, now: Date): Promise<TokenResponse> {
  if (now.getTime() - new Date(row.rotatedAt!).getTime() > REFRESH_REUSE_GRACE_SEC * 1000) {
    await revokeFamily(row.familyId, now);
    throw invalidGrant(REFRESH_INVALID);
  }
  if (!(await loadFullAdmin(row.userId))) {
    await revokeFamily(row.familyId, now);
    throw invalidGrant("the authorizing account can no longer use Study");
  }
  let cur = row;
  let secret = token;
  for (let hop = 0; hop < 20; hop++) {
    if (!cur.successorId || !cur.successorSealed) break;
    const pair = openPair(secret, cur.successorSealed);
    if (!pair) break;
    const next = await StudyOAuthToken.findOne({ _id: cur.successorId, kind: "refresh" }).lean<IStudyOAuthToken>();
    if (!next || next.revokedAt || !safeEqual(next.tokenHash, sha256Hex(pair.refresh))) break;
    if (!next.rotatedAt) return tokenResponse(pair, next.scope);
    cur = next;
    secret = pair.refresh;
  }
  throw invalidGrant(REFRESH_INVALID);
}
