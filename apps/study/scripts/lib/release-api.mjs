// The backend URL every SHIPPED build talks to — decided by the build scripts, never by a .env file.
//
// Next loads `.env.local` in every environment except test, at HIGHER precedence than
// `.env.production`, so a developer's LAN address (`http://192.168.x.x:5000`) wins in a release
// build unless the value is pinned in `process.env`, which outranks every file. The whiteboard shipped
// that way more than once. scripts/android-export.mjs takes the URL from here, and
// `scanExportForLeaks` is how a build proves it.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The server a release build bakes in: `STUDY_BUILD_API` from the process environment, else the
 * `STUDY_BUILD_API=` line of the gitignored `.env.release.local` (read here and pinned into
 * process.env, so Next's own .env loading never decides it). Empty → the APK ships without a server
 * and starts in demo mode; the user points it at their self-hosted server in Settings.
 */
export function resolveReleaseApiBaseUrl(appDir = process.cwd()) {
  if (process.env.STUDY_BUILD_API !== undefined) return process.env.STUDY_BUILD_API.trim();
  const file = join(appDir, '.env.release.local');

  if (!existsSync(file)) return '';
  const match = readFileSync(file, 'utf8').match(/^\s*STUDY_BUILD_API\s*=\s*"?([^"\s#]*)"?/m);

  return match ? match[1].trim() : '';
}

/**
 * The usage-counts project a release build bakes in (`NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST`):
 * from the process environment, else the same-named lines of `.env.release.local`, same as
 * `STUDY_BUILD_API`. Empty key → the build sends nothing. Returned as env entries to pin.
 */
export function resolveReleaseAnalyticsEnv(appDir = process.cwd()) {
  const file = join(appDir, '.env.release.local');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const read = (name) => {
    if (process.env[name] !== undefined) return process.env[name].trim();
    const match = text.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\s#]*)"?`, 'm'));

    return match ? match[1].trim() : '';
  };

  return { NEXT_PUBLIC_POSTHOG_KEY: read('NEXT_PUBLIC_POSTHOG_KEY'), NEXT_PUBLIC_POSTHOG_HOST: read('NEXT_PUBLIC_POSTHOG_HOST') };
}

// A private-range host on the backend's dev port — the shape of a leaked `.env.local`.
// Deliberately NOT every private IP: the camera settings legitimately ship LAN placeholders such
// as `http://192.168.1.90:8080` (lib/camera-settings.ts, lib/ccapi-server.ts), and lib/auth.ts
// carries a `http://localhost:5000` code fallback that is unreachable once the API is pinned.
const PRIVATE_BACKEND_PATTERN =
  /https?:\/\/(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):5000\b/;

// The .env files Next would have read ahead of .env.production in a release build.
const DEV_ENV_FILES = ['.env.local', '.env.development', '.env.development.local'];

/** Every URL-looking `NEXT_PUBLIC_*` value a dev .env file would have inlined — the exact strings
 *  that must be absent from a shipped export (unless one happens to equal the intended URL). */
export function devEnvValues(appDir, intended) {
  const values = new Set();

  for (const name of DEV_ENV_FILES) {
    const file = join(appDir, name);

    if (!existsSync(file)) continue;

    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*NEXT_PUBLIC_[A-Z0-9_]+\s*=\s*"?([^"\s#]+)"?/);

      // The usage-counts host is a public service, not a dev backend.
      if (/^\s*NEXT_PUBLIC_POSTHOG_/.test(line)) continue;
      if (match && /:\/\/|:\d{2,5}\b/.test(match[1]) && match[1] !== intended) values.add(match[1]);
    }
  }

  return [...values];
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);

    return entry.isDirectory() ? walk(full) : /\.(js|mjs|json|html|txt)$/.test(entry.name) ? [full] : [];
  });

/**
 * Check an exported `out/_next` for a leaked dev backend and for the intended one.
 * Returns `{ ok, offenders: [{ file, value }], intendedFound, forbidden }`; a caller fails the
 * build on `!ok` and prints `offenders`.
 */
export function scanExportForLeaks({ appDir, outNext, apiBaseUrl }) {
  const forbidden = devEnvValues(appDir, apiBaseUrl);
  const offenders = [];
  let intendedFound = apiBaseUrl === '';

  for (const file of walk(outNext)) {
    if (statSync(file).size > 32 * 1024 * 1024) continue;

    const text = readFileSync(file, 'utf8');

    for (const value of forbidden) {
      if (text.includes(value)) offenders.push({ file, value });
    }

    const generic = text.match(PRIVATE_BACKEND_PATTERN);

    if (generic) offenders.push({ file, value: generic[0] });
    if (!intendedFound && text.includes(apiBaseUrl)) intendedFound = true;
  }

  if (!intendedFound) offenders.push({ file: outNext, value: `intended NEXT_PUBLIC_API "${apiBaseUrl}" not found in the export` });

  return { ok: offenders.length === 0, offenders, intendedFound, forbidden };
}
