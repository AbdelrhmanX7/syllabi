/**
 * In-app update decisions — pure, no DOM, unit-tested (update-check.test.ts).
 *
 * The tablet's APK is sideloaded; scripts/publish-android.mjs publishes each release to a public
 * Backblaze bucket as `study/latest.json`. The app compares that feed's `versionCode` with the
 * installed build's (Android versionCode = minutes since 2026-01-01 UTC, strictly increasing).
 */

// Baked at build time by scripts/android-release.mjs from STUDY_FEED_PREFIX (public CI builds use
// `study/public/`); the native shell's feed URL (src-tauri/src/lib.rs) comes from the same variable.
const RELEASES_BASE =
  process.env.NEXT_PUBLIC_RELEASES_BASE || 'https://syllabi-studio.s3.eu-central-003.backblazeb2.com/study/';

export const UPDATE_FEED_URL = `${RELEASES_BASE}latest.json`;
export const DOWNLOAD_PAGE_URL = `${RELEASES_BASE}index.html`;
export const STUDY_PACKAGE = 'studio.syllabi.app';

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A resume re-checks only when the last check is older than this. */
export const RESUME_CHECK_GAP_MS = 15 * 60 * 1000;
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface ReleaseFeed {
  app: string;
  version: string;
  versionCode: number;
  sha: string;
  url: string;
  sha256: string;
  size: number;
  publishedAt: string;
  notes?: string;
}

export interface Snooze {
  versionCode: number;
  until: number;
}

/** The feed as published, or null when it is not a Study release this app may install. */
export function parseFeed(raw: unknown): ReleaseFeed | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const versionCode = Number(value.versionCode);

  if (value.app !== STUDY_PACKAGE) return null;
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) return null;
  if (typeof value.url !== 'string' || !value.url.startsWith(RELEASES_BASE) || !value.url.endsWith('.apk')) return null;
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)) return null;

  return {
    app: STUDY_PACKAGE,
    version: typeof value.version === 'string' ? value.version : '',
    versionCode,
    sha: typeof value.sha === 'string' ? value.sha : '',
    url: value.url,
    sha256: value.sha256.toLowerCase(),
    size: Number(value.size) || 0,
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : '',
    notes: typeof value.notes === 'string' && value.notes.trim() ? value.notes.trim() : undefined,
  };
}

/** Unknown installed build (dev server, plain browser) never offers an update. */
export function isUpdateAvailable(feed: ReleaseFeed | null, installedVersionCode: number | null): boolean {
  return (
    feed !== null &&
    installedVersionCode !== null &&
    installedVersionCode > 0 &&
    feed.versionCode > installedVersionCode
  );
}

/** "Later" hides the banner for 24 h — unless an even newer release than the snoozed one appears. */
export function isSnoozed(snooze: Snooze | null, feed: ReleaseFeed | null, now: number): boolean {
  if (!snooze || !feed) return false;

  return now < snooze.until && feed.versionCode <= snooze.versionCode;
}

export function snoozeFor(feed: ReleaseFeed, now: number): Snooze {
  return { versionCode: feed.versionCode, until: now + SNOOZE_MS };
}

export function parseSnooze(raw: string | null): Snooze | null {
  if (!raw) return null;

  try {
    const value = JSON.parse(raw) as Partial<Snooze>;

    return Number.isFinite(value.versionCode) && Number.isFinite(value.until)
      ? { versionCode: Number(value.versionCode), until: Number(value.until) }
      : null;
  } catch {
    return null;
  }
}

export function isCheckDue(lastChecked: number | null, now: number, gap: number = CHECK_INTERVAL_MS): boolean {
  return lastChecked === null || now - lastChecked >= gap || now < lastChecked;
}

/** "<version> · <sha>[-dirty] · <stamp>" → its parts; empty in dev. */
export function parseBuildStamp(stamp: string): { version: string; sha: string } {
  const [version = '', sha = ''] = stamp.split('·').map((part) => part.trim());

  return { version, sha };
}
