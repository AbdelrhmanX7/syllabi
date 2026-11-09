import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import studyRouter from "@/routes/study/router";
import studyDevUploadRouter from "@/routes/study/dev-upload";
import studyMcpPublicRouter from "@/routes/study/mcp";
import studyInboxPublicRouter from "@/routes/study/inbox";
import studyTelemetryRouter from "@/routes/study/telemetry";
import statsRouter from "@/routes/stats";
import { adminVerification, studyAccess } from "@/compat/auth";
import authRouter from "@/auth/router";
import accountsRouter from "@/auth/accounts-router";
import shareRouter from "@/routes/share";
import studyObjectProxyRouter from "@/routes/study/object-proxy";
import { LOCAL_STORAGE_DIR, LOCAL_STORAGE_MOUNT, useLocalStorage, useStorageProxy } from "@/compat/s3";
import { STUDY_BLOB_PATH, STUDY_CONVERT_PATH, STUDY_OWN_JSON_PARSER_PATH, STUDY_PDF_ASSET_PATH } from "@/services/study/storage";
import { httpDrain } from "@/services/http-drain";
import { logger } from "@/services/logger.service";

/**
 * The Syllabi API: the /study module plus the few public routes it needs.
 * Mount order matters and mirrors the original backend:
 *   1. local-storage upload stand-in (signed url, no JWT)
 *   2. MCP + OAuth server (own token auth)
 *   3. phone inbox (also accepts a drop token)
 *   4. perf telemetry (any signed-in session)
 *   5. /share (+ /study/share) sharing, signed in
 *   6. /study behind adminVerification + studyAccess (owner or user; data is scoped per account)
 */
export function createApp() {
  const app = express();
  app.use(httpDrain.middleware);
  app.set("trust proxy", process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : 1);

  // No allow-list: the app runs from a Tauri WebView / any origin and authenticates with a Bearer token.
  // With no `allowedHeaders`, cors reflects the preflight's requested headers.
  app.use(cors());

  // Routes that need the raw bytes (page blob, office convert) or a size-capped json parser of
  // their own (glyph bank, perf telemetry, ink classify) skip the app-wide parsers; those routers
  // mount their own, after auth.
  const appJsonParser = express.json({ limit: "10mb" });
  const appUrlencodedParser = express.urlencoded({ extended: true, limit: "10mb" });
  const hasOwnParser = (path: string) =>
    path.startsWith("/study/dev-upload/") ||
    STUDY_BLOB_PATH.test(path) ||
    STUDY_CONVERT_PATH.test(path) ||
    STUDY_PDF_ASSET_PATH.test(path) ||
    STUDY_OWN_JSON_PARSER_PATH.test(path);
  app.use((req, res, next) => (hasOwnParser(req.path) ? next() : appJsonParser(req, res, next)));
  app.use((req, res, next) => (hasOwnParser(req.path) ? next() : appUrlencodedParser(req, res, next)));

  // Liveness probe: never consults a dependency (the app treats a failure as "offline").
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  if (useLocalStorage()) {
    // Local storage driver: stored objects are served from disk, and presigned PUTs point at the dev-upload route.
    app.use(LOCAL_STORAGE_MOUNT, express.static(LOCAL_STORAGE_DIR, { fallthrough: false, index: false }));
    app.use(studyDevUploadRouter);
  } else if (useStorageProxy()) {
    // STORAGE_PROXY: the bucket is private/unreachable; signed reads and uploads go through this server.
    app.use(studyObjectProxyRouter);
    app.use(studyDevUploadRouter);
  }
  // Owner sign-in / first-run setup / current user (own credential checks, no JWT needed to log in).
  app.use("/admin", authRouter);
  // Accounts: register, email + password, magic link, Google, verify/reset, delete (docs/accounts.md).
  app.use("/auth", accountsRouter);
  app.use(studyMcpPublicRouter);
  app.use(studyInboxPublicRouter);
  app.use(studyTelemetryRouter);
  app.use(statsRouter);
  // Sharing (routes/share.ts): its own prefix, before /study so the study router never sees it.
  // Both paths: the app's transport puts every live route under /study.
  app.use(["/share", "/study/share"], adminVerification, studyAccess, shareRouter);
  app.use("/study", adminVerification, studyAccess, studyRouter);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status: number = typeof err?.status === "number" ? err.status : 500;
    logger.error("Unhandled Express error", err instanceof Error ? err : new Error(String(err))).catch(() => {});
    if (!res.headersSent) res.status(status).json({ message: status === 500 ? "Internal server error" : String(err?.message ?? "Error") });
  });

  return app;
}
