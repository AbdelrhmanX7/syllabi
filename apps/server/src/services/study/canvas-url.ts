/**
 * SSRF guard for the user-supplied Canvas base URL. The server makes authenticated requests
 * to this origin on a cron, so it must never be steerable at an internal host: only
 * `https://<sub>.instructure.com` with no credentials and the default port is accepted.
 * Returns the normalised origin (no path, no trailing slash).
 */
export class CanvasUrlError extends Error {
  code = "CANVAS_URL_INVALID";
}

export function normaliseCanvasBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new CanvasUrlError("baseUrl is required");
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new CanvasUrlError("baseUrl is not a valid URL");
  }
  if (u.protocol !== "https:") throw new CanvasUrlError("baseUrl must use https");
  if (u.username || u.password) throw new CanvasUrlError("baseUrl must not contain credentials");
  if (u.port && u.port !== "443") throw new CanvasUrlError("baseUrl must use the default port");
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.instructure\.com$/.test(host)) {
    throw new CanvasUrlError("baseUrl must be an *.instructure.com host");
  }
  return `https://${host}`;
}
