/**
 * Single seam for authentication. Everything in the study module that needs to know
 * "who is calling" goes through here, so a different auth scheme (e.g. real single-user
 * auth) only has to replace this file.
 *
 * Sessions are HS256 Bearer JWTs {_id, role: "admin"} signed with JWT_SECRET (30 days by
 * default, JWT_EXPIRES_IN overrides). `_id` is the Admin row id; the row must exist and be
 * enabled. The JWT `role` is always "admin" because the app checks exactly that client-side;
 * it is NOT the account's role. The real role (owner | user, auth/roles.ts) is read from the
 * database on every request. The /study mount admits both roles (studyAccess); server
 * management stays owner-only (fullAdminOnly). Routes: auth/router.ts (/admin, older app
 * builds) and auth/accounts-router.ts (/auth); the first owner is seeded by auth/owner.ts.
 */
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { Types } from "mongoose";
import { Admin } from "@/models/admin";
import { logger } from "@/services/logger.service";
import { isOwnerRole, isStudyRole } from "@/auth/roles";

/** Secret for session JWTs and for everything derived from it (token encryption, dev upload HMAC). */
export function getJwtSecret(): string | undefined {
  return process.env.JWT_SECRET || process.env.SECRET_KEY || undefined;
}

const bearer = (req: Request) => req.headers.authorization?.replace("Bearer ", "") ?? "";

/** The account id in a valid session token, or null. Does not touch the database. */
export function readSessionUserId(req: Request): string | null {
  const secret = getJwtSecret();
  if (!secret) return null;
  try {
    const decoded: any = jwt.verify(bearer(req), secret, { algorithms: ["HS256"] });
    const id = String(decoded?._id ?? "");
    return Types.ObjectId.isValid(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Sign a session token for an account id. The app checks `exp` and `role === "admin"` client-side,
 * so every account (owner or user) gets role "admin" in the JWT for now; never trust it server-side,
 * the account's real role comes from the database (adminVerification sets req.adminRole).
 */
export function signSessionToken(
  userId: string,
  expiresIn: jwt.SignOptions["expiresIn"] = (process.env.JWT_EXPIRES_IN || "30d") as jwt.SignOptions["expiresIn"]
): string {
  const secret = getJwtSecret();
  if (!secret) throw new Error("JWT_SECRET is not set");
  return jwt.sign({ _id: userId, role: "admin" }, secret, { algorithm: "HS256", expiresIn });
}

/** Same contract as the original backend's admin middleware: 401 on a bad/missing token or account. */
export const adminVerification = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = readSessionUserId(req);
    if (!adminId) throw new Error("Invalid session");
    const admin = await Admin.findById(adminId).select("role isDisabled isVerified").lean();
    if (!admin) throw new Error("Account not found");
    if (admin.isDisabled) throw new Error("Account disabled");
    req.adminId = adminId;
    req.userId = adminId;
    req.isAdmin = true;
    req.adminRole = admin.role ?? "admin";
    // Rows from before accounts have no flag stored: verified.
    req.emailVerified = admin.isVerified !== false;
    logger.setUserContext({ userId: adminId, userRole: "Admin" });
    next();
  } catch (error: any) {
    res.status(401).send(error?.message);
  }
};

/** Only the owner role passes (server management). */
export const fullAdminOnly = (req: Request, res: Response, next: NextFunction) => {
  if (!isOwnerRole(req.adminRole)) {
    return res.status(403).json({ message: "You do not have access to this resource" });
  }
  next();
};

/** Any study account (owner or user) passes: the /study mount. Data is scoped by req.userId. */
export const studyAccess = (req: Request, res: Response, next: NextFunction) => {
  if (!isStudyRole(req.adminRole)) {
    return res.status(403).json({ message: "You do not have access to this resource" });
  }
  next();
};

/** A real bcrypt hash (same cost as stored ones) compared against when no account matches,
 * so the response time does not reveal whether the identifier exists. Made on first use. */
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hash(randomBytes(16).toString("hex"), 12));

/**
 * Compare a password with a stored hash. An account with no password (Google / magic link only)
 * never matches, and costs the same bcrypt time as a real comparison.
 */
export async function passwordMatches(password: unknown, hash: string | null | undefined): Promise<boolean> {
  if (typeof password !== "string" || !password) return false;
  if (!hash) {
    await bcrypt.compare(password, await getDummyHash());
    return false;
  }
  return bcrypt.compare(password, hash);
}

/**
 * Check a login (POST /admin/login and the MCP OAuth consent page). `identifier` is the
 * account email (the primary login); a legacy account that has only a phone number still
 * matches on it. Returns the account or null; never says which part
 * was wrong. An unverified email still signs in (only AI routes need verification).
 * `allowBypass` is accepted for signature compatibility and ignored.
 */
export const verifyAdminCredentials = async (
  identifier: unknown,
  password: unknown,
  _req: Request,
  _opts: { allowBypass?: boolean } = {}
) => {
  if (typeof identifier !== "string" || typeof password !== "string" || !identifier || !password) return null;
  const id = identifier.trim();
  const admin = await Admin.findOne(id.includes("@") ? { email: id.toLowerCase() } : { phoneNumber: id }).select("+password");
  if (!admin) {
    await bcrypt.compare(password, await getDummyHash());
    return null;
  }
  if (!(await passwordMatches(password, admin.password))) return null;
  if (admin.isDisabled) return null;
  return admin;
};
