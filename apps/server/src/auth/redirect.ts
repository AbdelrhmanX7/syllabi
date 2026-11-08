/**
 * Where a sign-in flow may send the browser back to (Google callback, magic links). Pure, so it
 * can be unit tested. Allowed: a URL on the APP_URL origin (exact origin match), or the Android
 * app's deep-link scheme `studio.syllabi.app://`. Anything else is refused, so a crafted link
 * cannot hand a session token to another site.
 */
export const APP_SCHEME = "studio.syllabi.app:";

export function isAllowedRedirect(redirect: unknown, appUrl: string | undefined | null): boolean {
  if (typeof redirect !== "string" || !redirect || redirect.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return false;
  }
  if (url.protocol === APP_SCHEME) return redirect.startsWith(`${APP_SCHEME}//`);
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  if (!appUrl) return false;
  try {
    return url.origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

/** Append `?token=` (or `&token=`) to a link base, keeping any fragment last. */
export function withQueryToken(base: string, token: string): string {
  const hashAt = base.indexOf("#");
  const head = hashAt >= 0 ? base.slice(0, hashAt) : base;
  const tail = hashAt >= 0 ? base.slice(hashAt) : "";
  return `${head}${head.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}${tail}`;
}

/** Replace any fragment with `#key=value&…` (the session token goes in the fragment, never the query). */
export function withFragment(base: string, params: Record<string, string>): string {
  const head = base.split("#")[0];
  return `${head}#${new URLSearchParams(params).toString()}`;
}
