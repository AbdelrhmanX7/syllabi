/**
 * Minimal Canvas REST client for the study sync.
 *
 *  - Pagination follows the `Link: <…>; rel="next"` header, and only to the SAME origin.
 *  - At most `concurrency` requests in flight per client (default 4).
 *  - A 403 that Canvas uses for throttling (body "Rate Limit Exceeded", or
 *    `X-Rate-Limit-Remaining` at/near 0) and 429/5xx back off and retry; any other 4xx fails fast.
 *  - The bearer token is sent ONLY to the configured origin. File downloads follow redirects by
 *    hand so the token never leaks to the `canvas-user-content` / file-store hosts (the file url
 *    carries its own `verifier`).
 */

type FetchLike = typeof fetch;

export class CanvasApiError extends Error {
  constructor(public status: number, message: string, public code = status === 401 ? "CANVAS_UNAUTHORIZED" : "CANVAS_HTTP_ERROR") {
    super(message);
  }
}

export type CanvasClientOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
};

export function createLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    queue.shift()!();
  };
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      next();
    });
    try {
      return await fn();
    } finally {
      active--;
      next();
    }
  };
}

const parseNextLink = (link: string | null): string | null => {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1];
  }
  return null;
};

export class CanvasClient {
  readonly origin: string;
  private token: string;
  private fetchImpl: FetchLike;
  private limit: ReturnType<typeof createLimiter>;
  private sleep: (ms: number) => Promise<void>;
  private maxRetries: number;
  requestCount = 0;

  constructor(opts: CanvasClientOptions) {
    this.origin = new URL(opts.baseUrl).origin;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limit = createLimiter(opts.concurrency ?? 4);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 5;
  }

  private resolve(pathOrUrl: string): string {
    const url = new URL(pathOrUrl, this.origin);
    if (url.origin !== this.origin) throw new CanvasApiError(0, `Refusing off-origin Canvas URL ${url.origin}`, "CANVAS_OFF_ORIGIN");
    return url.toString();
  }

  private async request(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.limit(async () => {
        this.requestCount++;
        return this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" } });
      });
      if (res.ok) return res;
      // Header absent ≠ 0: `Number(null)` is 0 and would turn every permission 403 into a retry storm.
      const rawRemaining = res.headers.get("x-rate-limit-remaining");
      const remaining = rawRemaining === null || rawRemaining === "" ? NaN : Number(rawRemaining);
      let body = "";
      if (res.status === 403 || res.status === 429) body = await res.text().catch(() => "");
      const throttled =
        res.status === 429 ||
        (res.status === 403 && (/rate limit exceeded/i.test(body) || (Number.isFinite(remaining) && remaining <= 1)));
      const retryable = throttled || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      if (!body) body = await res.text().catch(() => "");
      let message = `Canvas ${res.status}`;
      try {
        const j = JSON.parse(body);
        message = j?.errors?.[0]?.message || j?.message || message;
      } catch {
        /* non-JSON */
      }
      throw new CanvasApiError(res.status, message, throttled ? "CANVAS_RATE_LIMITED" : undefined);
    }
  }

  async get<T = any>(path: string): Promise<T> {
    const res = await this.request(this.resolve(path));
    return (await res.json()) as T;
  }

  /** GET every page of a list endpoint. */
  async getAll<T = any>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = this.resolve(path);
    let pages = 0;
    while (url && pages++ < 200) {
      const res = await this.request(url);
      const body = await res.json();
      if (!Array.isArray(body)) throw new CanvasApiError(res.status, "Expected a list from Canvas");
      out.push(...(body as T[]));
      const next = parseNextLink(res.headers.get("link"));
      url = next ? this.resolve(next) : null;
    }
    return out;
  }

  /**
   * Download a Canvas file url (`…/files/:id/download?verifier=…`). Redirects are followed by
   * hand: the token goes to the Canvas origin only, never to the user-content / storage hosts.
   * Aborts when the body would exceed `maxBytes`.
   */
  async download(fileUrl: string, maxBytes: number): Promise<Buffer> {
    let url = new URL(fileUrl, this.origin);
    if (url.protocol !== "https:") throw new CanvasApiError(0, "Refusing non-https file url", "CANVAS_OFF_ORIGIN");
    for (let hop = 0; hop < 8; hop++) {
      const headers: Record<string, string> = url.origin === this.origin ? { Authorization: `Bearer ${this.token}` } : {};
      const res = await this.limit(() => this.fetchImpl(url.toString(), { headers, redirect: "manual" }));
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new CanvasApiError(res.status, "Redirect without location");
        url = new URL(loc, url);
        if (url.protocol !== "https:") throw new CanvasApiError(0, "Refusing non-https redirect", "CANVAS_OFF_ORIGIN");
        continue;
      }
      if (!res.ok) throw new CanvasApiError(res.status, `File download failed (${res.status})`, "CANVAS_FILE_DOWNLOAD_FAILED");
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > maxBytes) throw new CanvasApiError(413, "File too large", "FILE_TOO_LARGE");
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new CanvasApiError(413, "File too large", "FILE_TOO_LARGE");
      return buf;
    }
    throw new CanvasApiError(0, "Too many redirects", "CANVAS_FILE_DOWNLOAD_FAILED");
  }
}
