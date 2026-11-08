// The account this device's offline data belongs to. A 401 (or an expired token offline) clears the
// session token without signing out; the saved cache and the queued work must still belong to that
// same account, so the last signed-in id is remembered here. Sign-out forgets it; a different account
// signing in replaces it.
import { readSessionUserId } from '@/lib/auth';

const OWNER_KEY = 'study_offline_owner';

export function offlineOwner(): string | null {
  const live = readSessionUserId();

  if (typeof window === 'undefined') return live;
  try {
    if (live) {
      if (window.localStorage.getItem(OWNER_KEY) !== live) window.localStorage.setItem(OWNER_KEY, live);

      return live;
    }

    return window.localStorage.getItem(OWNER_KEY);
  } catch {
    return live;
  }
}

export function forgetOfflineOwner(): void {
  try {
    window.localStorage.removeItem(OWNER_KEY);
  } catch {
    // nothing stored
  }
}
