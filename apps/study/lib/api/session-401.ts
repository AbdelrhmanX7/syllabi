import { isValidAdminToken } from '@/lib/auth';

/**
 * Messages the server sends when the session itself is gone (bad/expired token, account removed or
 * disabled). Both backends answer EVERY failure inside their auth check with a 401 — a database
 * hiccup included — so a 401 alone is not proof the session is dead.
 */
const DEAD_SESSION = /invalid signature|jwt (malformed|expired|must be provided)|invalid (token|session)|account (not found|disabled)|حساب غير موجود/i;

/** True when a 401 really means "sign in again"; false for a one-off server error on a good token. */
export function isSessionDead(token: string | null, message: string): boolean {
  if (!isValidAdminToken(token)) return true;

  return DEAD_SESSION.test(message);
}
