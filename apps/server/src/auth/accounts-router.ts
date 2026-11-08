/**
 * Accounts API, mounted at /auth (JSON). The contract is docs/accounts.md, "Server API":
 *
 *   GET    /auth/config                  {registration, google, magicLink, emailVerification}
 *   POST   /auth/register                {name?, email, password} -> 201 {token, user}; sends a verify email
 *   POST   /auth/login                   {email, password} -> {token, user}; 400 {message} on bad credentials
 *   POST   /auth/verify-email            {token} -> {token, user}
 *   POST   /auth/resend-verification     (Bearer) -> {message}
 *   POST   /auth/magic-link              {email, redirect?} -> always 200 {message}
 *   POST   /auth/magic-link/consume      {token} -> {token, user}; creates the account when registration is open
 *   POST   /auth/forgot-password         {email} -> always 200 {message}
 *   POST   /auth/reset-password          {token, password} -> {token, user}
 *   GET    /auth/google/start?redirect=  302 to Google (server-side code flow, PKCE, stored single-use state)
 *   GET    /auth/google/callback         302 to <redirect>#token=<jwt> (or #error=<code>)
 *   GET    /auth/me                      (Bearer) {user}
 *   POST   /auth/me/password             (Bearer) {currentPassword?, newPassword} -> {message}
 *   DELETE /auth/me                      (Bearer) {password?} -> deletes the account, its data and files
 *
 * The session token is the same 30-day HS256 JWT as /admin/login (compat/auth.ts signSessionToken).
 * REGISTRATION=closed (default) refuses every way of creating an account here; the owner is still
 * made by first-run setup, env or the CLI (auth/owner.ts). Magic link and forgot password never
 * reveal whether an account exists: they answer the same way and send mail in the background.
 */
import { Router, Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import { adminVerification, passwordMatches, signSessionToken, verifyAdminCredentials } from "@/compat/auth";
import { Admin, AuthProvider, IAdmin } from "@/models/admin";
import { hashPassword } from "@/auth/owner";
import { bodyEmailKey, ipKey, memoryRateLimit } from "@/auth/rate-limit";
import { AuthInputError, normaliseEmail, validateLogin, validatePassword, validateRegister } from "@/auth/validate";
import { isAllowedRedirect, withFragment, withQueryToken } from "@/auth/redirect";
import { generateRawToken, pkceChallenge } from "@/auth/tokens";
import { accountProviders, consumeToken, deleteAccount, isLastOwner, issueToken, publicAccount, revokeTokens } from "@/auth/accounts";
import { appLink, appUrl, googleConfigured, googleRedirectUri, mailTransport, registrationOpen } from "@/auth/config";
import { magicLinkMail, resetPasswordMail, sendMailInBackground, verifyEmailMail } from "@/auth/mail";
import { logger } from "@/services/logger.service";

const router = Router();

const MIN = 60 * 1000;
const ipLimit = (max: number, windowMs = 15 * MIN) =>
  memoryRateLimit({ windowMs, max, message: "Too many attempts. Try again in a few minutes.", key: ipKey });
const emailLimit = (max: number, windowMs = 15 * MIN) =>
  memoryRateLimit({ windowMs, max, message: "Too many attempts for this email. Try again later.", key: bodyEmailKey });

const loginIp = ipLimit(20);
const loginEmail = emailLimit(10);
const registerIp = ipLimit(10, 60 * MIN);
const registerEmail = emailLimit(3, 60 * MIN);
const linkIp = ipLimit(10);
const linkEmail = emailLimit(3, 15 * MIN);
const consumeIp = ipLimit(30);
const accountIp = ipLimit(20);
const resendUser = memoryRateLimit({
  windowMs: 60 * MIN,
  max: 5,
  message: "Too many emails sent. Try again later.",
  key: (req) => (req.userId ? `u:${req.userId}` : null),
});

const LINK_INVALID = "This link is invalid or has expired. Ask for a new one.";
const CHECK_INBOX = "If that email can sign in here, a link is on its way. Check your inbox.";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch((error) => {
    if (error instanceof AuthInputError) return res.status(400).json({ message: error.message });
    next(error);
  });

const session = (admin: IAdmin | Record<string, any>) => {
  const user = publicAccount(admin);
  return { token: signSessionToken(user._id), user };
};

const withProvider = (admin: { providers?: string[] | null }, provider: AuthProvider): AuthProvider[] => {
  // Rows from before accounts have no list stored; keep what they implied (a password) when they had one.
  const current = admin.providers?.length ? (admin.providers as AuthProvider[]) : [];
  return current.includes(provider) ? current : [...current, provider];
};

const findByEmail = (email: string) => Admin.findOne({ email });

/** Mail a fresh verification link (older ones stop working). */
async function sendVerification(admin: IAdmin): Promise<void> {
  if (!admin.email) return;
  await revokeTokens(admin._id as Types.ObjectId, ["verify"]);
  const raw = await issueToken("verify", { userId: admin._id as Types.ObjectId, email: admin.email });
  sendMailInBackground(verifyEmailMail(admin.email, withQueryToken(appLink("/auth/verify/"), raw)));
}

/**
 * An outside proof of the email (magic link, Google) arrived for an account whose email was never
 * verified. Whoever registered it may not own the address, so their password is dropped: the
 * proven owner keeps the account and can set a password themselves.
 */
function claimUnverified(admin: IAdmin): void {
  if (admin.isVerified === false) {
    admin.password = undefined;
    admin.providers = (admin.providers ?? []).filter((p) => p !== "password");
  }
  admin.isVerified = true;
}

/** Create a `user` account whose email is already proven (magic link / Google). Survives a race. */
async function createProvenAccount(email: string, fields: { name?: string | null; provider: AuthProvider; googleId?: string }) {
  try {
    return await Admin.create({
      name: (fields.name || "").trim().slice(0, 80) || email.split("@")[0],
      email,
      role: "user",
      isVerified: true,
      isDisabled: false,
      providers: [fields.provider],
      ...(fields.googleId ? { googleId: fields.googleId } : {}),
    });
  } catch (error: any) {
    if (error?.code === 11000) return findByEmail(email);
    throw error;
  }
}

// ─── config ─────────────────────────────────────────────────────────────────────────────

router.get("/config", (_req, res) => {
  // Without a mail transport, links only reach the server log; offer them outside production (dev).
  const mail = mailTransport() !== "log" || process.env.NODE_ENV !== "production";
  res.json({
    registration: registrationOpen() ? "open" : "closed",
    google: googleConfigured(),
    magicLink: mail,
    emailVerification: mail,
  });
});

// ─── email + password ───────────────────────────────────────────────────────────────────

router.post(
  "/register",
  registerIp,
  registerEmail,
  wrap(async (req, res) => {
    if (!registrationOpen()) return res.status(403).json({ message: "This server does not accept new accounts." });
    const { name, email, password } = validateRegister(req.body);
    if (await Admin.exists({ email })) {
      return res.status(409).json({ message: "An account with this email already exists. Sign in or reset the password." });
    }
    let admin: IAdmin;
    try {
      admin = await Admin.create({
        name,
        email,
        password: await hashPassword(password),
        role: "user",
        isVerified: false,
        isDisabled: false,
        providers: ["password"],
      });
    } catch (error: any) {
      if (error?.code === 11000) return res.status(409).json({ message: "An account with this email already exists. Sign in or reset the password." });
      throw error;
    }
    await sendVerification(admin);
    res.status(201).json(session(admin));
  })
);

router.post(
  "/login",
  loginIp,
  loginEmail,
  wrap(async (req, res) => {
    const input = validateLogin(req.body);
    const admin = input ? await verifyAdminCredentials(input.email, input.password, req) : null;
    if (!admin) return res.status(400).json({ message: "Incorrect email or password." });
    res.json(session(admin));
  })
);

router.post(
  "/verify-email",
  consumeIp,
  wrap(async (req, res) => {
    const row = await consumeToken("verify", req.body?.token);
    const admin = row?.userId ? await Admin.findById(row.userId) : null;
    if (!row || !admin || admin.isDisabled || (row.email && admin.email !== row.email)) {
      return res.status(400).json({ message: LINK_INVALID });
    }
    if (admin.isVerified === false) {
      admin.isVerified = true;
      await admin.save();
    }
    res.json(session(admin));
  })
);

router.post(
  "/resend-verification",
  accountIp,
  adminVerification,
  resendUser,
  wrap(async (req, res) => {
    const admin = await Admin.findById(req.userId);
    if (!admin) return res.status(401).json({ message: "Account not found" });
    if (admin.isVerified !== false) return res.json({ message: "Your email is already confirmed." });
    if (!admin.email) return res.status(400).json({ message: "This account has no email address." });
    await sendVerification(admin);
    res.json({ message: "A new confirmation link is on its way." });
  })
);

// ─── magic link ─────────────────────────────────────────────────────────────────────────

router.post("/magic-link", linkIp, linkEmail, (req, res) => {
  const email = normaliseEmail(req.body?.email);
  const redirect = isAllowedRedirect(req.body?.redirect, appUrl()) ? String(req.body.redirect) : null;
  // Answer first, work after: the response (and its timing) is the same whether or not the account exists.
  res.json({ message: CHECK_INBOX });
  if (!email) return;
  (async () => {
    const admin = await Admin.findOne({ email }).select("_id isDisabled").lean();
    if (admin?.isDisabled) return;
    if (!admin && !registrationOpen()) return;
    if (admin) await revokeTokens(admin._id, ["magic"]);
    const raw = await issueToken("magic", { userId: admin?._id ?? null, email, redirect });
    // The email always opens the web app's /auth/magic/ page; `redirect` (where to go after) comes back from consume.
    sendMailInBackground(magicLinkMail(email, withQueryToken(appLink("/auth/magic/"), raw)));
  })().catch((error) => logger.error("Magic link failed", error instanceof Error ? error : new Error(String(error))).catch(() => {}));
});

router.post(
  "/magic-link/consume",
  consumeIp,
  wrap(async (req, res) => {
    const row = await consumeToken("magic", req.body?.token);
    if (!row?.email) return res.status(400).json({ message: LINK_INVALID });
    let admin = row.userId ? await Admin.findById(row.userId).select("+password") : await findByEmail(row.email).select("+password");
    if (!admin) {
      if (row.userId || !registrationOpen()) return res.status(400).json({ message: LINK_INVALID });
      admin = await createProvenAccount(row.email, { provider: "magic" });
      if (!admin) return res.status(400).json({ message: LINK_INVALID });
    }
    if (admin.isDisabled || admin.email !== row.email) return res.status(400).json({ message: LINK_INVALID });
    claimUnverified(admin);
    admin.providers = withProvider({ providers: accountProviders(admin).filter((p) => p !== "password" || admin!.password) }, "magic");
    await admin.save();
    res.json({ ...session(admin), redirect: row.redirect ?? null });
  })
);

// ─── password reset ─────────────────────────────────────────────────────────────────────

router.post("/forgot-password", linkIp, linkEmail, (req, res) => {
  const email = normaliseEmail(req.body?.email);
  res.json({ message: "If that email has an account, a reset link is on its way. Check your inbox." });
  if (!email) return;
  (async () => {
    const admin = await Admin.findOne({ email }).select("_id isDisabled").lean();
    if (!admin || admin.isDisabled) return;
    await revokeTokens(admin._id, ["reset"]);
    const raw = await issueToken("reset", { userId: admin._id, email });
    sendMailInBackground(resetPasswordMail(email, withQueryToken(appLink("/auth/reset/"), raw)));
  })().catch((error) => logger.error("Password reset email failed", error instanceof Error ? error : new Error(String(error))).catch(() => {}));
});

router.post(
  "/reset-password",
  consumeIp,
  wrap(async (req, res) => {
    // Check the new password first, so a too-short one does not burn the link.
    const password = validatePassword(req.body?.password);
    const row = await consumeToken("reset", req.body?.token);
    const admin = row?.userId ? await Admin.findById(row.userId).select("+password") : null;
    if (!row || !admin || admin.isDisabled || (row.email && admin.email !== row.email)) {
      return res.status(400).json({ message: LINK_INVALID });
    }
    admin.password = await hashPassword(password);
    admin.isVerified = true; // the link proved the email
    admin.providers = withProvider({ providers: accountProviders(admin) }, "password");
    await admin.save();
    await revokeTokens(admin._id as Types.ObjectId, ["reset", "magic"]);
    res.json(session(admin));
  })
);

// ─── Google (server-side OAuth code flow) ───────────────────────────────────────────────

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

router.get(
  "/google/start",
  linkIp,
  wrap(async (req, res) => {
    if (!googleConfigured()) return res.status(404).json({ message: "Google sign-in is not set up on this server." });
    const redirect = typeof req.query.redirect === "string" && req.query.redirect ? req.query.redirect : appLink("/auth/callback/");
    if (!isAllowedRedirect(redirect, appUrl())) {
      return res.status(400).json({ message: "That return address is not allowed. Set APP_URL on the server." });
    }
    const codeVerifier = generateRawToken();
    const state = await issueToken("google_state", { redirect, codeVerifier });
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID as string,
      redirect_uri: googleRedirectUri(),
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: pkceChallenge(codeVerifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    res.redirect(302, `${GOOGLE_AUTH}?${params.toString()}`);
  })
);

interface GoogleClaims {
  sub: string;
  email: string;
  name?: string;
}

/** Exchange the code at Google's token endpoint and read the id_token it returns directly over TLS. */
async function googleIdentity(code: string, codeVerifier: string): Promise<GoogleClaims | null> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID as string,
      client_secret: process.env.GOOGLE_CLIENT_SECRET as string,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const body: any = await res.json().catch(() => null);
  const idToken = typeof body?.id_token === "string" ? body.id_token : "";
  const part = idToken.split(".")[1];
  if (!part) return null;
  let claims: any;
  try {
    claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  // Received straight from Google's token endpoint over TLS, so the signature need not be re-checked
  // (OpenID Connect Core 3.1.3.7); the audience, issuer, expiry and email proof still are.
  if (claims?.aud !== process.env.GOOGLE_CLIENT_ID || !GOOGLE_ISSUERS.has(claims?.iss)) return null;
  if (typeof claims?.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
  const email = normaliseEmail(claims?.email);
  if (!claims?.sub || !email || (claims.email_verified !== true && claims.email_verified !== "true")) return null;
  return { sub: String(claims.sub), email, name: typeof claims.name === "string" ? claims.name : undefined };
}

router.get(
  "/google/callback",
  consumeIp,
  wrap(async (req, res) => {
    const row = await consumeToken("google_state", req.query.state);
    if (!row?.redirect || !row.codeVerifier || !isAllowedRedirect(row.redirect, appUrl())) {
      return res.status(400).type("text/plain").send("This sign-in attempt expired or was already used. Start again from the app.");
    }
    const back = (params: Record<string, string>) => res.redirect(302, withFragment(row.redirect as string, params));
    if (typeof req.query.error === "string") return back({ error: req.query.error === "access_denied" ? "access_denied" : "google_error" });
    if (typeof req.query.code !== "string" || !req.query.code) return back({ error: "google_error" });

    const identity = await googleIdentity(req.query.code, row.codeVerifier).catch(() => null);
    if (!identity) return back({ error: "google_error" });

    let admin = (await Admin.findOne({ googleId: identity.sub }).select("+password")) ?? (await findByEmail(identity.email).select("+password"));
    if (!admin) {
      if (!registrationOpen()) return back({ error: "registration_closed" });
      admin = await createProvenAccount(identity.email, { name: identity.name, provider: "google", googleId: identity.sub });
      if (!admin) return back({ error: "google_error" });
    }
    if (admin.isDisabled) return back({ error: "account_disabled" });
    if (admin.googleId && admin.googleId !== identity.sub) return back({ error: "google_account_mismatch" });
    claimUnverified(admin);
    admin.googleId = identity.sub;
    admin.providers = withProvider({ providers: accountProviders(admin).filter((p) => p !== "password" || admin!.password) }, "google");
    await admin.save();
    back({ token: signSessionToken(String(admin._id)) });
  })
);

// ─── the signed-in account ──────────────────────────────────────────────────────────────

router.get(
  "/me",
  adminVerification,
  wrap(async (req, res) => {
    const admin = await Admin.findById(req.userId).lean();
    if (!admin) return res.status(401).json({ message: "Account not found" });
    res.json({ user: publicAccount(admin) });
  })
);

router.post(
  "/me/password",
  accountIp,
  adminVerification,
  wrap(async (req, res) => {
    const newPassword = validatePassword(req.body?.newPassword, "The new password");
    const admin = await Admin.findById(req.userId).select("+password");
    if (!admin) return res.status(401).json({ message: "Account not found" });
    // An account with no password yet (Google / magic link only) may set one without a current password.
    if (admin.password && !(await passwordMatches(req.body?.currentPassword, admin.password))) {
      return res.status(400).json({ message: "The current password is wrong." });
    }
    admin.password = await hashPassword(newPassword);
    admin.providers = withProvider({ providers: accountProviders(admin) }, "password");
    await admin.save();
    await revokeTokens(admin._id as Types.ObjectId, ["reset"]);
    res.json({ message: "Password changed" });
  })
);

router.delete(
  "/me",
  accountIp,
  adminVerification,
  wrap(async (req, res) => {
    const admin = await Admin.findById(req.userId).select("+password");
    if (!admin) return res.status(401).json({ message: "Account not found" });
    if (admin.password && !(await passwordMatches(req.body?.password, admin.password))) {
      return res.status(400).json({ message: "The password is wrong." });
    }
    if (await isLastOwner(admin)) {
      return res.status(409).json({ message: "This is the server's only owner account, so it cannot be deleted." });
    }
    await deleteAccount(String(admin._id));
    res.json({ message: "Your account and all its data were deleted." });
  })
);

export default router;
