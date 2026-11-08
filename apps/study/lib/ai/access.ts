/**
 * Whether the AI parts of the app show. The server turns AI on per account ("premium", picked by
 * the server owner; the owner always has it) and answers 403 AI_NOT_ENABLED otherwise.
 *
 * Fail open on purpose: AI is hidden ONLY when the server says `premium: false`. Demo mode (the
 * fake AI costs nothing), signed out, a server older than the flag (no `premium`, or no `/auth`
 * at all) and the owner all keep it.
 */
export interface AiAccountLike {
  role?: string | null;
  premium?: boolean | null;
  /** Voice (speech to text) AI. Newer servers send it; AI can be on while voice is not. */
  voiceAi?: boolean | null;
}

export interface AiAccessInput {
  /** No server, or the mock forced on in Settings. */
  demo: boolean;
  signedIn: boolean;
  /** `/auth/me`: undefined while loading or failed, null on a server without `/auth`. */
  account: AiAccountLike | null | undefined;
  /** The user saved at sign-in, used until `/auth/me` answers (no flicker). */
  stored?: AiAccountLike | null;
}

const isOwnerRole = (role: string | null | undefined) => role === 'owner' || role === 'admin';

export function aiEnabledFrom({ demo, signedIn, account, stored }: AiAccessInput): boolean {
  if (demo || !signedIn) return true;
  const user = account === undefined ? stored : account;

  if (!user) return true;
  if (isOwnerRole(user.role)) return true;

  return user.premium !== false;
}

/**
 * Whether the voice parts show (dictation, transcribing a recording again). Same fail-open rules;
 * a server that sends `voiceAi` decides, an older one falls back to `premium`.
 */
export function voiceAiEnabledFrom({ demo, signedIn, account, stored }: AiAccessInput): boolean {
  if (demo || !signedIn) return true;
  const user = account === undefined ? stored : account;

  if (!user) return true;
  if (isOwnerRole(user.role)) return true;
  if (typeof user.voiceAi === 'boolean') return user.voiceAi;

  return user.premium !== false;
}
