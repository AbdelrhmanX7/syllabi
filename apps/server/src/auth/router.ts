/**
 * Owner sign-in for older app builds, mounted at /admin (any account can sign in here; newer
 * builds use /auth, auth/accounts-router.ts) (the app's axios base is the backend root, so the login
 * page posts to `${backend}/admin/login`). The contract matches what apps/study expects:
 *
 *   POST /admin/login        {email, password} -> {message, token, user}
 *                            The email is the login. `phoneNumber` is still accepted as the
 *                            field name (the app's login request sends it) and carries the email.
 *                            Bad credentials -> 400 {message}.
 *   GET  /admin/me           (Bearer) -> {user}
 *   POST /admin/me/password  (Bearer) {currentPassword, newPassword} -> {message}
 *   GET  /admin/setup        -> {needsSetup, setupTokenRequired}
 *   POST /admin/setup        {name?, email, password, setupToken?} -> {message, token, user}
 *                            Only while no account exists. Needs SETUP_TOKEN when that is set,
 *                            otherwise only answers requests from this machine (loopback socket).
 *
 * The token is a 30-day HS256 JWT {_id, role: "admin"} signed with JWT_SECRET; the app checks
 * `exp` and `role` client-side and sends it as `Authorization: Bearer <token>`.
 * There is no refresh endpoint: the app has no refresh flow and simply signs in again.
 */
import { Router, Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import { adminVerification, passwordMatches, signSessionToken, verifyAdminCredentials } from "@/compat/auth";
import { Admin } from "@/models/admin";
import {
  createFirstOwner,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  OwnerInputError,
  ownerExists,
  publicUser,
} from "@/auth/owner";
import { memoryRateLimit } from "@/auth/rate-limit";

const router = Router();

const credentialLimit = memoryRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many sign-in attempts. Try again in a few minutes.",
});

function sessionResponse(admin: Parameters<typeof publicUser>[0], message: string) {
  const user = publicUser(admin);
  return { message, token: signSessionToken(user._id), user };
}

router.post("/login", credentialLimit, async (req: Request, res: Response) => {
  try {
    const { phoneNumber, email, password } = req.body ?? {};
    const admin = await verifyAdminCredentials(email ?? phoneNumber, password, req);
    if (!admin) return res.status(400).json({ message: "Incorrect email or password." });
    res.json(sessionResponse(admin, "Logged in successfully"));
  } catch (error: any) {
    res.status(500).json({ message: error?.message ?? "Sign-in failed" });
  }
});

router.get("/me", adminVerification, async (req: Request, res: Response) => {
  const admin = await Admin.findById(req.adminId).lean();
  if (!admin) return res.status(401).json({ message: "Account not found" });
  res.json({ user: publicUser(admin) });
});

router.post("/me/password", credentialLimit, adminVerification, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > 72) {
    return res.status(400).json({ message: `The new password must be ${MIN_PASSWORD_LENGTH}-72 characters.` });
  }
  const admin = await Admin.findById(req.adminId).select("+password");
  if (!admin || !(await passwordMatches(currentPassword, admin.password))) {
    return res.status(400).json({ message: "The current password is wrong." });
  }
  admin.password = await hashPassword(newPassword);
  await admin.save();
  res.json({ message: "Password changed" });
});

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function setupAllowed(req: Request): boolean {
  const expected = process.env.SETUP_TOKEN;
  if (expected) {
    const given = String(req.get("x-setup-token") ?? req.body?.setupToken ?? "");
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  // No token configured: only the machine the server runs on may claim it. The raw socket
  // address is used (not req.ip), so a forwarded header cannot fake it; behind a proxy or
  // in a container this is never loopback, which means SETUP_TOKEN is required there.
  return LOOPBACK.has(req.socket.remoteAddress ?? "");
}

router.get("/setup", async (_req: Request, res: Response) => {
  res.json({ needsSetup: !(await ownerExists()), setupTokenRequired: Boolean(process.env.SETUP_TOKEN) });
});

router.post("/setup", credentialLimit, async (req: Request, res: Response) => {
  try {
    if (await ownerExists()) return res.status(409).json({ message: "This server already has an owner account." });
    if (!setupAllowed(req)) {
      return res.status(403).json({
        message: process.env.SETUP_TOKEN
          ? "Wrong setup token."
          : "Set SETUP_TOKEN on the server to create the owner remotely, or run `pnpm owner create`.",
      });
    }
    const admin = await createFirstOwner(req.body ?? {});
    if (!admin) return res.status(409).json({ message: "This server already has an owner account." });
    res.status(201).json(sessionResponse(admin, "Owner account created"));
  } catch (error: any) {
    if (error instanceof OwnerInputError) return res.status(400).json({ message: error.message });
    res.status(500).json({ message: error?.message ?? "Setup failed" });
  }
});

export default router;
