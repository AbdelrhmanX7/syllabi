#!/usr/bin/env node
// Google Play bundle for Study, built from a commit.
//
//   node scripts/build-play.mjs                         bundle of HEAD (arm64)
//   node scripts/build-play.mjs --from-commit <sha>     bundle of <sha>
//   node scripts/build-play.mjs --target aarch64,armv7,x86_64   more device types (each adds a native build)
//
// → android-dist/study-<version>-<sha>-play.aab, signed with the release keystore (the Play upload key).
//
// It runs `android-release.mjs --play --from-commit <sha>` (clean throwaway worktree, same signing env,
// same versionCode scheme as the sideloaded APK: minutes since 2026-01-01, so it only grows) with:
// - the public server baked in, like ship-public.mjs (STUDY_BUILD_API=https://api.syllabi.studio),
//   plus the usage-counts key from .env.release.local;
// - STUDY_STORE=play / NEXT_PUBLIC_STORE=play: no update check, banner, "Check for updates" or feed
//   fetch; the manifest drops REQUEST_INSTALL_PACKAGES, the update provider and USE_EXACT_ALARM.
//
// Heavy (a full Android build, ~20–30 min): run it alone, in the background. It uploads nothing.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_API = 'https://api.syllabi.studio';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);

  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const commit = option('--from-commit', 'HEAD');
const target = option('--target', 'aarch64');

const result = spawnSync(
  process.execPath,
  [join(appDir, 'scripts', 'android-release.mjs'), '--play', '--from-commit', commit, '--target', target],
  {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, STUDY_BUILD_API: PUBLIC_API, STUDY_STORE: 'play', NEXT_PUBLIC_STORE: 'play' },
  },
);

process.exit(result.status ?? 1);
