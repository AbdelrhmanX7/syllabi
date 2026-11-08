export {};

declare global {
  namespace Express {
    interface Request {
      /** The signed-in account's id (set by compat/auth.ts). Same value as `adminId`. */
      userId?: string | null;
      isAdmin?: boolean;
      adminId?: string;
      /** The account's role from the database: "owner"/"admin" (owner) or "user"; see auth/roles.ts. */
      adminRole?: string;
      /** Whether the account's email is verified (AI routes need it). Set by adminVerification. */
      emailVerified?: boolean;
      /** Whether this account may use the AI features (owner, or premium). Set by adminVerification. */
      aiEnabled?: boolean;
      /** Whose models the account's AI runs on (auth/ai-access.ts). Set by adminVerification. */
      aiRoute?: "premium" | "claude";
    }
  }
}
