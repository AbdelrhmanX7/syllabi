// One anonymous "the app was opened today" count for the owner (how many tablets actually use it).
// A random id made on first launch, nothing else: no account, name or email is sent. Once a day at most,
// never blocks anything, silently skipped offline or with no server.

import pkg from '../../package.json';
import { isTauriAndroid } from '@/lib/platform/runtime';

const ID_KEY = 'study_install_id';
const DAY_KEY = 'study_install_pinged';
const STATS_URL = 'https://api.syllabi.studio/stats/event';

function randomId(): string {
  const bytes = new Uint8Array(16);

  crypto.getRandomValues(bytes);

  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function pingAppOpen(): void {
  try {
    const today = new Date().toISOString().slice(0, 10);

    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
    if (localStorage.getItem(DAY_KEY) === today) return;
    let id = localStorage.getItem(ID_KEY);

    if (!id) {
      id = randomId();
      localStorage.setItem(ID_KEY, id);
    }
    void fetch(STATS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'app_open', id, version: pkg.version, platform: isTauriAndroid() ? 'android' : 'web' }),
    })
      .then((res) => {
        if (res.ok) localStorage.setItem(DAY_KEY, today);
      })
      .catch(() => undefined);
  } catch {
    // counting is best-effort
  }
}
