import { Schema, model, models, Model, Document } from "mongoose";

/**
 * An account. One server holds many: the owner (runs the server) and, when REGISTRATION=open,
 * registered users. Study data is scoped by `userId` = this row's id everywhere.
 *
 * Role: "owner" or "user". The legacy value "admin" (and a missing role on older rows) means
 * owner; see auth/roles.ts. Defaults stay `role: "admin"` / `isVerified: true` so rows written
 * before accounts existed keep meaning "verified owner"; every sign-up path sets
 * `role: "user"` and its own `isVerified` explicitly.
 *
 * `password` is optional: an account made through Google or a magic link may have none.
 */
export type AdminRole = string;
export type AuthProvider = "password" | "google" | "magic";

export interface IAdmin extends Document {
  name?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  password?: string | null;
  role: AdminRole;
  isVerified: boolean;
  isDisabled: boolean;
  /** Sign-in methods this account has used. Older rows have none stored (then: password). */
  providers?: AuthProvider[];
  /** Google account id (`sub`), when linked. */
  googleId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const AdminSchema = new Schema<IAdmin>(
  {
    name: { type: String, default: null },
    // No `default: null`: a sparse unique index still indexes explicit nulls, so a second
    // account without an email would collide. Absent fields are skipped by the index.
    email: { type: String, lowercase: true, trim: true, index: { unique: true, sparse: true } },
    phoneNumber: { type: String, trim: true, index: { unique: true, sparse: true } },
    password: { type: String, select: false },
    role: { type: String, default: "admin" },
    isVerified: { type: Boolean, default: true },
    isDisabled: { type: Boolean, default: false },
    providers: { type: [String], default: undefined },
    googleId: { type: String, index: { unique: true, sparse: true } },
  },
  { timestamps: true }
);

export const Admin: Model<IAdmin> = (models.Admin as Model<IAdmin>) ?? model<IAdmin>("Admin", AdminSchema);
