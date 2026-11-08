import mongoose, { Schema, Types } from "mongoose";

/**
 * Remote MCP server for Claude (contract "MCP (remote, for Claude)", P6). Every credential is
 * stored as a sha256 HASH only — a DB read never yields a usable key, code or token.
 * services/study/mcp-auth.ts is the only writer.
 */

// ─── personal API keys (`sk_study_…`) ───────────────────────────────────────────────────

export interface IStudyMcpKey {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  /** First chars of the key (`sk_study_XXXXXXXX`) — shown in lists, and the lookup index. */
  prefix: string;
  /** sha256 hex of the whole key. */
  keyHash: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

const StudyMcpKeySchema = new Schema<IStudyMcpKey>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, maxlength: 100 },
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
StudyMcpKeySchema.index({ keyHash: 1 }, { unique: true });
StudyMcpKeySchema.index({ prefix: 1 });
StudyMcpKeySchema.index({ userId: 1, createdAt: -1 });

export const StudyMcpKey = mongoose.model<IStudyMcpKey>("StudyMcpKey", StudyMcpKeySchema, "study_mcp_keys");

// ─── OAuth clients (RFC 7591 dynamic registration) ──────────────────────────────────────

export const OAUTH_CLIENT_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
export type OAuthClientAuthMethod = (typeof OAUTH_CLIENT_AUTH_METHODS)[number];

export interface IStudyOAuthClient {
  _id: Types.ObjectId;
  clientId: string;
  /** sha256 hex; null for public (`none`) clients. */
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: OAuthClientAuthMethod;
  createdAt: Date;
}

const StudyOAuthClientSchema = new Schema<IStudyOAuthClient>(
  {
    clientId: { type: String, required: true },
    clientSecretHash: { type: String, default: null },
    clientName: { type: String, default: "" },
    redirectUris: { type: [String], required: true },
    tokenEndpointAuthMethod: { type: String, enum: OAUTH_CLIENT_AUTH_METHODS, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
StudyOAuthClientSchema.index({ clientId: 1 }, { unique: true });

export const StudyOAuthClient = mongoose.model<IStudyOAuthClient>("StudyOAuthClient", StudyOAuthClientSchema, "study_oauth_clients");

// ─── authorization codes ────────────────────────────────────────────────────────────────

export interface IStudyOAuthCode {
  _id: Types.ObjectId;
  codeHash: string;
  clientId: string;
  userId: Types.ObjectId;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  /** Valid until (60 s). The row itself lives ~10 min longer so a replay is still recognised. */
  expiresAt: Date;
  /** Set atomically on the first exchange; a second exchange sees it and revokes the grant. */
  usedAt: Date | null;
  /** Set when a used code is presented again; an exchange racing that replay then revokes. */
  replayedAt: Date | null;
  createdAt: Date;
}

/** How long a used/expired code row is kept after `expiresAt` for replay detection. */
export const OAUTH_CODE_RETAIN_SEC = 600;

const StudyOAuthCodeSchema = new Schema<IStudyOAuthCode>(
  {
    codeHash: { type: String, required: true },
    clientId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    scope: { type: String, default: "" },
    resource: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    replayedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
StudyOAuthCodeSchema.index({ codeHash: 1 }, { unique: true });
StudyOAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: OAUTH_CODE_RETAIN_SEC });

export const StudyOAuthCode = mongoose.model<IStudyOAuthCode>("StudyOAuthCode", StudyOAuthCodeSchema, "study_oauth_codes");

// ─── grants (one per authorized client/consent = one "connection") ─────────────────────

/**
 * One row per authorization: what `GET /study/mcp/connections` lists and DELETE revokes.
 * `_id` IS the token `familyId` (the authorization code's id), so a grant needs no new field
 * on the tokens. Grants that predate this collection are materialised lazily (on token use,
 * on refresh, or when the list is read) from their live refresh chain.
 */
export interface IStudyOAuthGrant {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  clientId: string;
  scope: string;
  resource: string;
  /** Throttled: bumped on access-token use and on refresh. */
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const StudyOAuthGrantSchema = new Schema<IStudyOAuthGrant>({
  userId: { type: Schema.Types.ObjectId, required: true },
  clientId: { type: String, required: true },
  scope: { type: String, default: "" },
  resource: { type: String, default: "" },
  lastUsedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  // Not `timestamps`: a lazily materialised legacy grant carries its chain's ORIGINAL time.
  createdAt: { type: Date, required: true },
});
StudyOAuthGrantSchema.index({ userId: 1, createdAt: -1 });

export const StudyOAuthGrant = mongoose.model<IStudyOAuthGrant>("StudyOAuthGrant", StudyOAuthGrantSchema, "study_oauth_grants");

// ─── access + refresh tokens ────────────────────────────────────────────────────────────

export interface IStudyOAuthToken {
  _id: Types.ObjectId;
  kind: "access" | "refresh";
  tokenHash: string;
  clientId: string;
  userId: Types.ObjectId;
  scope: string;
  resource: string;
  /** The grant id (StudyOAuthGrant._id = the code's id). Replay of a code/refresh revokes it. */
  familyId: Types.ObjectId;
  /** Access: issue + 1 h. Refresh: issue + 400 days — every refresh mints a fresh one, so an active chain never expires. */
  expiresAt: Date;
  /** Refresh only: set atomically when exchanged. A reuse within the grace window gets the successor pair; after it = replay. */
  rotatedAt: Date | null;
  /** Refresh only: the refresh row minted when this one rotated. */
  successorId: Types.ObjectId | null;
  /**
   * Refresh only: the successor pair, AES-256-GCM sealed under a key derived from THIS token's
   * plaintext (which is never stored) — so a DB read alone yields nothing usable. Lets a
   * concurrent duplicate refresh receive the SAME pair instead of forking the chain. Cleared
   * once the grace window is long past.
   */
  successorSealed: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const StudyOAuthTokenSchema = new Schema<IStudyOAuthToken>(
  {
    kind: { type: String, enum: ["access", "refresh"], required: true },
    tokenHash: { type: String, required: true },
    clientId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    scope: { type: String, default: "" },
    resource: { type: String, required: true },
    familyId: { type: Schema.Types.ObjectId, required: true },
    expiresAt: { type: Date, required: true },
    rotatedAt: { type: Date, default: null },
    successorId: { type: Schema.Types.ObjectId, default: null },
    successorSealed: { type: String, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
StudyOAuthTokenSchema.index({ tokenHash: 1 }, { unique: true });
StudyOAuthTokenSchema.index({ familyId: 1 });
StudyOAuthTokenSchema.index({ userId: 1, kind: 1 });
// Expired rows go away on their own; validity is ALWAYS re-checked against `expiresAt` too,
// because the TTL monitor only runs once a minute. Safe for live connections: a refresh row's
// `expiresAt` is 400 days out and every refresh mints a new one (sliding), so only a chain
// left unused for 400 days — or an access token past its hour — is ever collected.
StudyOAuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const StudyOAuthToken = mongoose.model<IStudyOAuthToken>("StudyOAuthToken", StudyOAuthTokenSchema, "study_oauth_tokens");

// ─── MCP quizzes (start_quiz / answer_quiz) ─────────────────────────────────────────────

export interface IStudyMcpQuiz {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  topic: string | null;
  questionIds: Types.ObjectId[];
  answers: { questionId: Types.ObjectId; result: "right" | "wrong" | "partial" }[];
  expiresAt: Date;
  createdAt: Date;
}

const StudyMcpQuizSchema = new Schema<IStudyMcpQuiz>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    topic: { type: String, default: null },
    questionIds: { type: [Schema.Types.ObjectId], required: true },
    answers: {
      type: [new Schema({ questionId: Schema.Types.ObjectId, result: { type: String, enum: ["right", "wrong", "partial"] } }, { _id: false })],
      default: [],
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
StudyMcpQuizSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const StudyMcpQuiz = mongoose.model<IStudyMcpQuiz>("StudyMcpQuiz", StudyMcpQuizSchema, "study_mcp_quizzes");
