/**
 * Account settings read from env (see .env.example):
 *   REGISTRATION=open|closed   default closed: single-owner, no sign-up (first-run setup / env / CLI)
 *   APP_URL                    the web app's public URL; email links and the Google return point at it
 *   RESEND_API_KEY | SMTP_URL  outgoing mail (neither: links are written to the server log)
 *   MAIL_FROM                  sender address
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   "Continue with Google"
 *   PUBLIC_BASE_URL            this server's origin; Google's redirect_uri is <it>/auth/google/callback
 */
import { serverPublicBase } from "@/compat/s3";

export const registrationOpen = (): boolean => (process.env.REGISTRATION || "").trim().toLowerCase() === "open";

/** APP_URL without a trailing slash, or "" when unset. */
export const appUrl = (): string => (process.env.APP_URL || "").trim().replace(/\/+$/, "");

export const googleConfigured = (): boolean => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export const mailTransport = (): "resend" | "smtp" | "log" =>
  process.env.RESEND_API_KEY ? "resend" : process.env.SMTP_URL ? "smtp" : "log";

export const mailFrom = (): string => process.env.MAIL_FROM || "Syllabi <no-reply@localhost>";

export const googleRedirectUri = (): string => `${serverPublicBase()}/auth/google/callback`;

/** A link into the web app, e.g. appLink("/auth/verify/"). Falls back to this server's origin. */
export const appLink = (path: string): string => `${appUrl() || serverPublicBase()}${path}`;
