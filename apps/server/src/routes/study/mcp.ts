import express from "express";
import { makeRateLimiter } from "@/middleware/rate-limit";
import {
  getAuthorizationServerMetadata,
  getAuthorize,
  getProtectedResourceMetadata,
  mcpMethodNotAllowed,
  mcpPost,
  postAuthorize,
  postRegister,
  postToken,
  requireMcpAuth,
} from "@/controllers/study-mcp.controller";

/**
 * Study remote MCP server + its OAuth 2.1 authorization server (P6). PUBLIC router: mounted
 * in routes/index.ts BEFORE the `/study` admin mount, because these requests carry an MCP
 * credential (key / OAuth token) or none at all — never an admin JWT. Paths are absolute.
 * Key management (`/study/mcp/keys`) stays behind the admin mount (routes/study/router.ts);
 * the exact `/study/mcp` path below never matches `/study/mcp/keys`.
 *
 * The issuer is `<base>/study` and every OAuth endpoint is under `/study/oauth`, so the
 * server's root `/.well-known/oauth-*` and `/oauth/*` stay free for anything else on the host. Discovery documents are served at every location a spec-compliant
 * client may try (RFC 9728 path suffix, RFC 8414 path insertion, OIDC insertion + append).
 */
const router = express.Router();

const byIp = (req: express.Request) => req.ip || req.socket.remoteAddress || "unknown";
const tokenLimiter = makeRateLimiter({ windowSec: 60, max: 30, keyPrefix: "study-oauth-token", keyFn: byIp });
const registerLimiter = makeRateLimiter({ windowSec: 3600, max: 20, keyPrefix: "study-oauth-register", keyFn: byIp });
const loginLimiter = makeRateLimiter({ windowSec: 900, max: 20, keyPrefix: "study-oauth-login", keyFn: byIp });

// MCP endpoint (Streamable HTTP, stateless).
router.post("/study/mcp", requireMcpAuth, mcpPost);
router.get("/study/mcp", mcpMethodNotAllowed);
router.delete("/study/mcp", mcpMethodNotAllowed);

// RFC 9728 protected-resource metadata: the 401 challenge's target, and the canonical
// path-suffixed location (reachable once nginx routes it here — see the P6 report).
router.get("/study/.well-known/oauth-protected-resource", getProtectedResourceMetadata);
router.get("/.well-known/oauth-protected-resource/study/mcp", getProtectedResourceMetadata);

// RFC 8414 authorization-server metadata for issuer `<base>/study`.
router.get("/.well-known/oauth-authorization-server/study", getAuthorizationServerMetadata);
router.get("/.well-known/openid-configuration/study", getAuthorizationServerMetadata);
router.get("/study/.well-known/openid-configuration", getAuthorizationServerMetadata);
router.get("/study/.well-known/oauth-authorization-server", getAuthorizationServerMetadata);

// OAuth 2.1 endpoints.
router.post("/study/oauth/register", registerLimiter, postRegister);
router.get("/study/oauth/authorize", getAuthorize);
router.post("/study/oauth/authorize", loginLimiter, postAuthorize);
router.post("/study/oauth/token", tokenLimiter, postToken);

export default router;
