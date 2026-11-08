import { Schema, model, models, Model, Types } from "mongoose";
import type { AuthTokenKind } from "@/auth/tokens";

/**
 * Single-use tokens behind email links (verify, magic, reset) and Google sign-in state.
 * Only the sha256 of the token is stored. `userId` is null for a magic link sent to an email
 * with no account yet (the account is created when the link is used, if registration is open).
 * Expired rows are removed by the TTL index.
 */
export interface IAuthToken {
  _id: Types.ObjectId;
  tokenHash: string;
  kind: AuthTokenKind;
  userId?: Types.ObjectId | null;
  email?: string | null;
  /** Allow-listed return URL (magic link base, Google return). */
  redirect?: string | null;
  /** PKCE code verifier for the Google flow. */
  codeVerifier?: string | null;
  expiresAt: Date;
  usedAt?: Date | null;
  createdAt: Date;
}

const AuthTokenSchema = new Schema<IAuthToken>(
  {
    tokenHash: { type: String, required: true, unique: true },
    kind: { type: String, required: true, enum: ["verify", "magic", "reset", "google_state"] },
    userId: { type: Schema.Types.ObjectId, default: null, index: true },
    email: { type: String, default: null },
    redirect: { type: String, default: null },
    codeVerifier: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthToken: Model<IAuthToken> =
  (models.AuthToken as Model<IAuthToken>) ?? model<IAuthToken>("AuthToken", AuthTokenSchema, "auth_tokens");
