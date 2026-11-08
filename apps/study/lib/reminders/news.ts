// Messages from the Syllabi team to everyone: a small JSON file on the website, read when the app opens
// or comes back. Each new message shows once as a notification. No push service involved.
//   { "messages": [{ "id": "2026-11-08-a", "title": "…", "body": "…", "url": "/optional/path", "until": "ISO" }] }

export const NEWS_URL = 'https://syllabi.studio/feed/news.json';
const TIMEOUT_MS = 5000;

export interface NewsMessage {
  id: string;
  title: string;
  body: string;
  url?: string;
}

/** Feed JSON → messages still to show: valid, not expired, not shown before, at most 3. */
export function newsToShow(feed: unknown, seen: readonly string[], now: number): NewsMessage[] {
  const list = feed && typeof feed === 'object' ? (feed as { messages?: unknown }).messages : null;

  if (!Array.isArray(list)) return [];
  const out: NewsMessage[] = [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;

    if (typeof m.id !== 'string' || !m.id || typeof m.title !== 'string' || !m.title.trim()) continue;
    if (seen.includes(m.id)) continue;
    if (typeof m.until === 'string') {
      const until = Date.parse(m.until);

      if (Number.isFinite(until) && until < now) continue;
    }
    // Only in-app paths: a tap must never navigate the app somewhere else.
    const url = typeof m.url === 'string' && m.url.startsWith('/') && !m.url.startsWith('//') ? m.url : undefined;

    out.push({
      id: m.id,
      title: m.title.trim().slice(0, 80),
      body: typeof m.body === 'string' ? m.body.trim().slice(0, 240) : '',
      url,
    });
  }

  return out.slice(0, 3);
}

/** The feed, or null on any failure (offline, timeout, bad JSON). AbortSignal.timeout needs Chrome 103, so a timer. */
export async function fetchNews(): Promise<unknown> {
  if (typeof fetch !== 'function') return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;

  try {
    const res = await fetch(NEWS_URL, { cache: 'no-store', signal: controller?.signal });

    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
