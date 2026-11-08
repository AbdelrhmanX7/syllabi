import { NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyAdminCredentials } from "@/compat/auth";
import {
  AuthorizeParams,
  authenticateBearer,
  authenticateClient,
  authorizationServerMetadata,
  checkAuthorizeRequest,
  checkCsrfToken,
  createKey,
  deleteConnection,
  deleteKey,
  errorRedirect,
  exchangeCode,
  exchangeRefresh,
  isFullAdmin,
  issueCode,
  issuerUri,
  listConnections,
  listKeys,
  makeCsrfToken,
  McpKeyError,
  McpPrincipal,
  newCsrfNonce,
  NONCE_RE,
  OAuthError,
  one,
  protectedResourceMetadata,
  publicBase,
  registerClient,
  STUDY_SCOPE,
  CSRF_TTL_SEC,
} from "@/services/study/mcp-auth";
import { buildStudyMcpServer } from "@/services/study/mcp-tools";
import { logger } from "@/services/logger.service";
import { fail, isOid, uid, wrap } from "./study.controller";
import type { IStudyOAuthClient } from "@/models/study/mcp";

/**
 * Study remote MCP server (contract "MCP (remote, for Claude)", P6): key management (behind
 * the normal /study admin auth), the MCP endpoint, and the OAuth 2.1 authorization server
 * (public routes, mounted BEFORE the /study admin mount — see routes/study/mcp.ts).
 */

// ─── key management (admin JWT, /study mount) ───────────────────────────────────────────

export const listMcpKeys = wrap(async (req, res) => {
  res.json(await listKeys(uid(req)));
});

export const createMcpKey = wrap(async (req, res) => {
  try {
    res.status(201).json(await createKey(uid(req), req.body?.name));
  } catch (e) {
    if (e instanceof McpKeyError) return fail(res, e.status, e.code, e.message);
    throw e;
  }
});

export const deleteMcpKey = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid key id");
  if (!(await deleteKey(uid(req), req.params.id))) return fail(res, 404, "NOT_FOUND", "Key not found");
  res.status(204).end();
});

// ─── OAuth connections (admin JWT, /study mount) ────────────────────────────────────────

/** One entry per authorized client (grant), never per token. */
export const listMcpConnections = wrap(async (req, res) => {
  res.json(await listConnections(uid(req)));
});

/** Revokes every access + refresh token of that grant immediately. Another admin's grant → 404. */
export const deleteMcpConnection = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid connection id");
  if (!(await deleteConnection(uid(req), req.params.id))) return fail(res, 404, "NOT_FOUND", "Connection not found");
  res.status(204).end();
});

// ─── /study/mcp ─────────────────────────────────────────────────────────────────────────

/**
 * Where the 401 challenge points. Deliberately a path under /study, which nginx already routes
 * to the API: the root `/.well-known/oauth-protected-resource*` prefix belongs to mcp-db until
 * the exact-match location from the P6 report is added. The canonical RFC 9728 path-suffixed
 * URL serves the same document once that location exists.
 */
export const resourceMetadataUrl = (req: Request) => `${publicBase(req)}/study/.well-known/oauth-protected-resource`;

function challenge(req: Request, res: Response, error?: { code: string; description: string }) {
  const parts = [`Bearer realm="study"`, `resource_metadata="${resourceMetadataUrl(req)}"`, `scope="${STUDY_SCOPE}"`];
  if (error) parts.push(`error="${error.code}"`, `error_description="${error.description}"`);
  res.setHeader("WWW-Authenticate", parts.join(", "));
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
  res.status(401).json({ error: error?.code ?? "unauthorized", error_description: error?.description ?? "Bearer token required" });
}

export async function requireMcpAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const h = req.headers.authorization;
    if (!h || !/^Bearer\s+/i.test(h)) return challenge(req, res);
    const token = h.replace(/^Bearer\s+/i, "").trim();
    const principal = token ? await authenticateBearer(token, req) : null;
    if (!principal) return challenge(req, res, { code: "invalid_token", description: "The access token or API key is invalid, expired or revoked" });
    res.locals.mcpPrincipal = principal;
    logger.setUserContext({ userId: String(principal.userId), userRole: "Admin" });
    next();
  } catch (e) {
    await logger.error("study mcp auth failed", e as Error, {});
    if (!res.headersSent) res.status(500).json({ error: "server_error" });
  }
}

/** Stateless Streamable HTTP: a fresh server + transport per POST, JSON responses. */
export async function mcpPost(req: Request, res: Response) {
  const principal = res.locals.mcpPrincipal as McpPrincipal;
  const server = buildStudyMcpServer(String(principal.userId), { publicBase: publicBase(req) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  // The SDK answers protocol-level rejections (unsupported MCP-Protocol-Version, malformed
  // JSON-RPC, …) itself and reports them ONLY here — without this they leave no trace but a
  // bare 400 in the nginx log. See the note on the first-request 400 in the P6 report.
  transport.onerror = (e) => {
    const body = req.body as { method?: unknown } | { method?: unknown }[] | undefined;
    const methods = (Array.isArray(body) ? body : [body]).map((m) => (m && typeof m.method === "string" ? m.method : null));
    void logger.warn("study mcp transport rejected a request", {
      reason: e?.message,
      protocolVersion: req.get("mcp-protocol-version") ?? null,
      methods,
      userAgent: req.get("user-agent") ?? null,
    });
  };
  res.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    await logger.error("study mcp request failed", e as Error, {});
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
}

export function mcpMethodNotAllowed(_req: Request, res: Response) {
  res.setHeader("Allow", "POST");
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless (POST only)" }, id: null });
}

// ─── discovery ──────────────────────────────────────────────────────────────────────────

export function getProtectedResourceMetadata(req: Request, res: Response) {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(protectedResourceMetadata(req));
}

export function getAuthorizationServerMetadata(req: Request, res: Response) {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(authorizationServerMetadata(req));
}

// ─── OAuth helpers ──────────────────────────────────────────────────────────────────────

const noStore = (res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
};

function oauthError(res: Response, e: OAuthError) {
  noStore(res);
  if (e.status === 401) res.setHeader("WWW-Authenticate", 'Basic realm="study"');
  res.status(e.status).json({ error: e.error, error_description: e.description });
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"'`=]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;", "=": "&#61;" })[c]!);

const CSRF_COOKIE = "study_oauth_csrf";

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function pageHeaders(res: Response, redirectUri?: string) {
  noStore(res);
  let formTarget = "";
  if (redirectUri) {
    try {
      formTarget = ` ${new URL(redirectUri).origin}`;
    } catch {
      /* ignore */
    }
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // form-action must allow the post-consent redirect target too (browsers apply it to redirects).
  res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTarget}; frame-ancestors 'none'; base-uri 'none'`);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

const STYLE = `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f4f5;color:#18181b;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border-radius:14px;padding:28px;max-width:400px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin:0 0 6px}p{color:#52525b;font-size:.9rem;line-height:1.45}label{display:block;font-size:.8rem;color:#52525b;margin:12px 0 4px}
input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d4d4d8;border-radius:8px;font-size:1rem}
.row{display:flex;gap:8px;margin-top:18px}button{flex:1;padding:10px;border-radius:8px;border:0;font-size:.95rem;font-weight:600;cursor:pointer}
.approve{background:#18181b;color:#fff}.deny{background:#e4e4e7;color:#18181b}.err{background:#fee2e2;color:#991b1b;padding:10px;border-radius:8px;font-size:.85rem}
code{background:#f4f4f5;padding:1px 4px;border-radius:4px;word-break:break-all}`;

function errorPage(res: Response, status: number, message: string) {
  pageHeaders(res);
  res.status(status).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Study — authorization error</title><style>${STYLE}</style></head><body><div class="card"><h1>Can't authorize</h1><p class="err">${esc(message)}</p></div></body></html>`);
}

function consentPage(req: Request, res: Response, client: IStudyOAuthClient, p: AuthorizeParams, opts: { status?: number; error?: string } = {}) {
  let nonce = readCookie(req, CSRF_COOKIE);
  if (!nonce || !NONCE_RE.test(nonce)) nonce = newCsrfNonce();
  const secure = req.protocol === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${CSRF_COOKIE}=${nonce}; Path=/study/oauth; HttpOnly; SameSite=Strict; Max-Age=${CSRF_TTL_SEC}${secure}`);
  const csrf = makeCsrfToken(nonce, p);
  let host = p.redirectUri;
  try {
    host = new URL(p.redirectUri).host;
  } catch {
    /* keep raw */
  }
  const hidden = (n: string, v: string) => `<input type="hidden" name="${n}" value="${esc(v)}">`;
  pageHeaders(res, p.redirectUri);
  res.status(opts.status ?? 200).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Study — authorize</title><style>${STYLE}</style></head><body><div class="card">
<h1>Connect to Study</h1>
<p><strong>${esc(client.clientName || "An application")}</strong> wants full access to your Study data (classes, notes, question bank). After you approve, you will be sent to <code>${esc(host)}</code>.</p>
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
<form method="POST" action="/study/oauth/authorize" autocomplete="on">
${hidden("client_id", p.clientId)}${hidden("redirect_uri", p.redirectUri)}${hidden("state", p.state)}${hidden("response_type", "code")}${hidden("code_challenge", p.codeChallenge)}${hidden("code_challenge_method", "S256")}${hidden("scope", p.scope)}${hidden("resource", p.resource)}${hidden("csrf", csrf)}
<label for="email">Email</label><input type="email" id="email" name="email" autocomplete="username" required>
<label for="pw">Password</label><input type="password" id="pw" name="password" autocomplete="current-password" required>
<div class="row"><button class="deny" type="submit" name="action" value="deny" formnovalidate>Deny</button><button class="approve" type="submit" name="action" value="approve">Approve</button></div>
</form>
<p style="font-size:.75rem;margin-top:16px">Only a full admin account can authorize.</p>
</div></body></html>`);
}

// ─── OAuth endpoints ────────────────────────────────────────────────────────────────────

export async function postRegister(req: Request, res: Response) {
  try {
    noStore(res);
    res.status(201).json(await registerClient(req.body));
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(res, e);
    await logger.error("study oauth register failed", e as Error, {});
    res.status(500).json({ error: "server_error" });
  }
}

export async function getAuthorize(req: Request, res: Response) {
  try {
    const check = await checkAuthorizeRequest(req.query as Record<string, unknown>, req);
    if (!check.ok) {
      if (check.kind === "page") return errorPage(res, 400, check.message);
      return res.redirect(302, errorRedirect(check.redirectUri, check.error, check.description, check.state, issuerUri(req)));
    }
    consentPage(req, res, check.client, check.params);
  } catch (e) {
    await logger.error("study oauth authorize failed", e as Error, {});
    errorPage(res, 500, "Something went wrong.");
  }
}

export async function postAuthorize(req: Request, res: Response) {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const check = await checkAuthorizeRequest(body, req);
    if (!check.ok) {
      if (check.kind === "page") return errorPage(res, 400, check.message);
      return res.redirect(302, errorRedirect(check.redirectUri, check.error, check.description, check.state, issuerUri(req)));
    }
    const { client, params } = check;
    if (!checkCsrfToken(body.csrf, readCookie(req, CSRF_COOKIE), params))
      return consentPage(req, res, client, params, { status: 403, error: "This form expired or was not opened in this browser. Please try again." });
    if (one(body.action) === "deny")
      return res.redirect(302, errorRedirect(params.redirectUri, "access_denied", "The owner denied access", params.state, issuerUri(req)));

    const admin = await verifyAdminCredentials(body.email ?? body.phoneNumber, body.password, req, { allowBypass: false });
    if (!admin) return consentPage(req, res, client, params, { status: 401, error: "Wrong email or password." });
    if (!isFullAdmin(admin)) return consentPage(req, res, client, params, { status: 403, error: "Confirm your email address in the Syllabi app first, then authorize again." });

    const code = await issueCode(admin._id, params);
    const u = new URL(params.redirectUri);
    u.searchParams.set("code", code);
    if (params.state) u.searchParams.set("state", params.state);
    u.searchParams.set("iss", issuerUri(req));
    noStore(res);
    res.redirect(302, u.toString());
  } catch (e) {
    await logger.error("study oauth authorize failed", e as Error, {});
    errorPage(res, 500, "Something went wrong.");
  }
}

export async function postToken(req: Request, res: Response) {
  try {
    const client = await authenticateClient(req);
    const grant = one(req.body?.grant_type);
    let out;
    if (grant === "authorization_code") out = await exchangeCode(req, client);
    else if (grant === "refresh_token") out = await exchangeRefresh(req, client);
    else throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    noStore(res);
    res.json(out);
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(res, e);
    await logger.error("study oauth token failed", e as Error, {});
    noStore(res);
    res.status(500).json({ error: "server_error" });
  }
}
