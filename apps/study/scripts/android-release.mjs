#!/usr/bin/env node
// Distributable Android build for Study.
//
//   node scripts/android-release.mjs                        signed release APK, arm64 (the tablet)
//   node scripts/android-release.mjs --target x86_64 --debug   emulator build
//   node scripts/android-release.mjs --no-frontend           reuse the existing out/ export
//   node scripts/android-release.mjs --from-commit <sha>     build a CLEAN checkout of <sha> (below)
//   STUDY_FEED_PREFIX=study/public node scripts/android-release.mjs   poll another update feed (CI public builds)
//
// What it does that a bare `tauri android build` does not (modelled on the whiteboard's script):
// - loads the release signing env from $SYLLABI_RELEASE_ENV (default ~/.android/syllabi-release.env,
//   mode 600, NEVER in the repo — see gen/android/app/build.gradle.kts for the keys) so gradle signs
//   the APK; without it the build still succeeds and emits `-unsigned`;
// - applies the size profile ONLY to this build through CARGO_PROFILE_RELEASE_* environment
//   overrides (strip, no debuginfo, opt-level 3, thin LTO);
// - points JAVA_HOME at a JDK with javac (/usr/lib/jvm on this machine is JRE-only) and fills in
//   ANDROID_HOME / NDK_HOME when the shell has not;
// - deletes its own previous gradle output first (gradle's incremental packager rewrites the zip in
//   place and leaves old entries' bytes behind);
// - archives the finished APK as android-dist/study-<version>-<sha>[-dirty]-<abi>-<type>.apk.
//
// `--from-commit <sha>`: a build reads the WORKING TREE, so on a shared checkout it silently picks
// up other people's uncommitted work. For anything that ships, this mode checks the commit out
// into a throwaway git worktree (<repo>/trees/study-android-release, detached), mirrors the
// installed node_modules into it, copies the gitignored gen/android build inputs over (never
// .env.local), builds THERE with its own cargo target dir (src-tauri/target-release-clean), archives
// into THIS tree's android-dist/ and removes the worktree.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveReleaseApiBaseUrl, scanExportForLeaks } from './lib/release-api.mjs';

const require = createRequire(import.meta.url);
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);

  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const target = option('--target', 'aarch64');
const debug = flag('--debug');
const skipFrontend = flag('--no-frontend');
const fromCommit = option('--from-commit', '');
const archiveDir = resolve(option('--archive-dir', join(appDir, 'android-dist')));

const git = (cwd, ...gitArgs) => {
  const result = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(' ')} failed: ${result.stderr?.trim()}`);
  }

  return result.stdout.trim();
};

const log = (message) => console.log(`[android-release] ${message}`);

/* ------------------------------------------------------------------ clean-checkout mode */

if (fromCommit) {
  const sha = git(appDir, 'rev-parse', '--verify', `${fromCommit}^{commit}`);
  const short = sha.slice(0, 10);
  const mainRoot = dirname(resolve(appDir, git(appDir, 'rev-parse', '--git-common-dir')));
  const thisRoot = git(appDir, 'rev-parse', '--show-toplevel');
  const appRel = relative(thisRoot, appDir);
  const worktree = join(mainRoot, 'trees', 'study-android-release');

  if (existsSync(worktree)) {
    log(`removing stale worktree ${worktree}`);
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: appDir, stdio: 'inherit' });
    rmSync(worktree, { recursive: true, force: true });
  }

  log(`checking out ${sha} into ${worktree}`);
  git(appDir, 'worktree', 'add', '--detach', worktree, sha);

  try {
    // Mirror every node_modules dir (root, apps/*, packages/*) entry by entry. Third-party packages
    // link to the installed copy; WORKSPACE packages are re-pointed into the worktree so webpack never
    // compiles other people's uncommitted `packages/*` source.
    const insideWorkspace = (realPath) =>
      realPath.startsWith(`${thisRoot}/`) && !realPath.startsWith(`${thisRoot}/node_modules/`) && !realPath.includes('/node_modules/');
    const mirrorEntry = (source, destination) => {
      let real = source;

      try {
        real = realpathSync(source);
      } catch {
        return;
      }

      symlinkSync(insideWorkspace(real) ? join(worktree, relative(thisRoot, real)) : real, destination, 'dir');
    };
    const mirrorNodeModules = (dir) => {
      const source = join(thisRoot, dir, 'node_modules');
      const destination = join(worktree, dir, 'node_modules');

      if (!existsSync(source) || existsSync(destination) || !existsSync(join(worktree, dir))) return;

      mkdirSync(destination);

      for (const entry of readdirSync(source, { withFileTypes: true })) {
        const from = join(source, entry.name);
        const to = join(destination, entry.name);

        if (entry.name.startsWith('@') && entry.isDirectory() && !entry.isSymbolicLink()) {
          mkdirSync(to);
          for (const scoped of readdirSync(from)) mirrorEntry(join(from, scoped), join(to, scoped));
        } else {
          mirrorEntry(from, to);
        }
      }
    };

    mirrorNodeModules('.');
    for (const group of ['apps', 'packages', 'tools']) {
      const groupDir = join(thisRoot, group);

      if (!existsSync(groupDir)) continue;

      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (entry.isDirectory()) mirrorNodeModules(join(group, entry.name));
      }
    }

    // Gitignored build INPUTS under gen/android that a clean checkout lacks (wry's generated Kotlin
    // sources, tauri.properties, tauri.build.gradle.kts, proguard-tauri.pro, assets/tauri.conf.json).
    // Caches and outputs stay out. Never .env.local.
    const genDir = join(appDir, 'src-tauri', 'gen', 'android');
    const skip = /^(build\/|\.gradle\/|\.idea\/|logs\/|app\/build\/|app\/\.cxx\/|app\/src\/main\/jniLibs\/|buildSrc\/build\/|buildSrc\/\.gradle\/|local\.properties$|key\.properties$|keystore\.properties$)/;
    const ignoredInputs = spawnSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '.'], {
      cwd: genDir,
      encoding: 'utf8',
    }).stdout.split('\n').filter((line) => line && !skip.test(line));

    for (const relPath of ignoredInputs) {
      const from = join(genDir, relPath);
      const to = join(worktree, appRel, 'src-tauri', 'gen', 'android', relPath);

      if (!statSync(from).isFile()) continue;

      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
    log(`copied ${ignoredInputs.length} gitignored build input(s) into the worktree`);

    const passThrough = args.filter((value, index) => {
      const previous = args[index - 1];

      return (
        !['--from-commit', '--archive-dir', '--no-frontend'].includes(value) &&
        !['--from-commit', '--archive-dir'].includes(previous)
      );
    });
    const inner = spawnSync(
      process.execPath,
      [join(worktree, appRel, 'scripts', 'android-release.mjs'), ...passThrough, '--archive-dir', archiveDir],
      {
        cwd: join(worktree, appRel),
        stdio: 'inherit',
        env: {
          ...process.env,
          // A target dir of its OWN: build-script outputs record absolute paths into the worktree.
          CARGO_TARGET_DIR: join(appDir, 'src-tauri', 'target-release-clean'),
        },
      },
    );

    if (inner.status !== 0) {
      process.exitCode = inner.status ?? 1;
      console.error(`[android-release] FAILED — clean build of ${short} exited ${inner.status ?? 'by signal'}; NOTHING archived`);
    }
  } finally {
    log(`removing worktree ${worktree}`);
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: appDir, stdio: 'inherit' });
    rmSync(worktree, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: appDir });
  }

  process.exit(process.exitCode ?? 0);
}

/* ------------------------------------------------------------------ the build itself */

const home = homedir();
const env = { ...process.env };

env.ANDROID_HOME ||= join(home, 'Android', 'Sdk');
env.NDK_HOME ||= join(env.ANDROID_HOME, 'ndk', '27.2.12479018');
env.ANDROID_NDK_HOME ||= env.NDK_HOME;
if (!env.JAVA_HOME || !existsSync(join(env.JAVA_HOME, 'bin', 'javac'))) {
  env.JAVA_HOME = join(home, 'tools', 'jdk-21');
}
env.PATH = [join(env.JAVA_HOME, 'bin'), join(env.ANDROID_HOME, 'platform-tools'), env.PATH].join(':');

if (!debug) {
  // Release signing env: KEY=value lines, no export keyword, no quotes. Never printed.
  const envFile = env.SYLLABI_RELEASE_ENV || join(home, '.android', 'syllabi-release.env');

  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);

      if (match) env[match[1]] = match[2];
    }
  } else {
    console.warn(`[android-release] ${envFile} not found — the APK will be UNSIGNED`);
  }

  env.CARGO_PROFILE_RELEASE_STRIP = 'true';
  env.CARGO_PROFILE_RELEASE_DEBUG = 'false';
  env.CARGO_PROFILE_RELEASE_OPT_LEVEL = '3';
  env.CARGO_PROFILE_RELEASE_LTO = 'thin';
  env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16';
}

const apkRoot = join(appDir, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk');
const abiDir = { aarch64: 'arm64', armv7: 'arm', i686: 'x86', x86_64: 'x86_64' }[target] ?? target;
const built = join(apkRoot, abiDir, debug ? 'debug' : 'release');

rmSync(built, { recursive: true, force: true });

/* ------------------------------------------------------------------ build identity */

// - NEXT_PUBLIC_BUILD_STAMP ("<version> · <sha>[-dirty] · <yyyyMMdd-HHmm>") is rendered in Settings;
// - NEXT_PUBLIC_VERSION_CODE feeds the in-app updater (lib/platform/app-update.ts);
// - Android versionCode = minutes since 2026-01-01 UTC: strictly increasing, so an install is always an update.
const sha = git(appDir, 'rev-parse', '--short', 'HEAD');
const dirty = git(appDir, 'status', '--porcelain', '--untracked-files=no', '--', '.', '../../packages') ? '-dirty' : '';
const version = JSON.parse(readFileSync(join(appDir, 'src-tauri', 'tauri.conf.json'), 'utf8')).version ?? '0';
const now = new Date();
const pad = (value) => String(value).padStart(2, '0');
const stampTime = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
const buildStamp = `${version} · ${sha}${dirty} · ${stampTime}`;
const versionCode = Math.floor((now.getTime() - Date.UTC(2026, 0, 1)) / 60_000);

// Update feed: STUDY_FEED_PREFIX (bucket key prefix, default `study`) is baked into BOTH the native
// shell (STUDY_UPDATE_FEED_URL, read by option_env! in src-tauri/src/lib.rs) and the page
// (NEXT_PUBLIC_RELEASES_BASE, lib/platform/update-check.ts). Public CI builds use `study/public` so
// they never read (or overwrite, via publish-android --feed) the default feed. Unset = defaults.
const feedPrefix = (env.STUDY_FEED_PREFIX ?? '').trim().replace(/^\/+|\/+$/g, '');

if (feedPrefix && feedPrefix !== 'study') {
  const releasesBase = `https://syllabi-studio.s3.eu-central-003.backblazeb2.com/${feedPrefix}/`;

  env.NEXT_PUBLIC_RELEASES_BASE = releasesBase;
  env.STUDY_UPDATE_FEED_URL = `${releasesBase}latest.json`;
  log(`update feed ${env.STUDY_UPDATE_FEED_URL}`);
}

env.NEXT_PUBLIC_BUILD_STAMP = buildStamp;
// The in-app updater's fallback for the installed versionCode (the activity reports the real one).
env.NEXT_PUBLIC_VERSION_CODE = String(versionCode);
log(`build stamp "${buildStamp}", versionCode ${versionCode}`);

const configOverride = { bundle: { android: { versionCode } } };

if (skipFrontend) configOverride.build = { beforeBuildCommand: '' };

const tauriArgs = ['android', 'build', '--apk', '--split-per-abi', '--target', target, '--config', JSON.stringify(configOverride)];

if (debug) tauriArgs.push('--debug');

// The CLI's entry script, wherever the workspace hoisted it (no shim, no npx).
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js');
const result = spawnSync(process.execPath, [tauriCli, ...tauriArgs], { cwd: appDir, env, stdio: 'inherit' });

if (result.status !== 0) {
  console.error(`[android-release] FAILED — tauri android build exited ${result.status ?? 'by signal'}; NOTHING archived`);
  process.exit(result.status ?? 1);
}

/* ------------------------------------------------------------------ shipped-API assertion */

const apiBaseUrl = resolveReleaseApiBaseUrl(appDir);
const outNext = join(appDir, 'out', '_next');
const scan = existsSync(outNext) ? scanExportForLeaks({ appDir, outNext, apiBaseUrl }) : { ok: false, offenders: [{ file: outNext, value: 'no export found' }] };

if (!scan.ok) {
  console.error(`[android-release] FAILED — the export behind this APK does not carry the intended backend cleanly; NOTHING archived`);
  for (const { file, value } of scan.offenders.slice(0, 10)) console.error(`  ${value}  ←  ${file}`);
  process.exit(1);
}

log(`baked API ${apiBaseUrl} — verified in out/`);

/* ------------------------------------------------------------------ archive */

mkdirSync(archiveDir, { recursive: true });

for (const entry of readdirSync(built)) {
  if (!entry.endsWith('.apk')) continue;

  const source = join(built, entry);
  const unsigned = entry.includes('unsigned') ? '-unsigned' : '';
  const archived = join(archiveDir, `study-${version}-${sha}${dirty}-${abiDir}-${debug ? 'debug' : 'release'}${unsigned}.apk`);

  copyFileSync(source, archived);
  log(`built   ${source}  ${(statSync(source).size / 1048576).toFixed(1)} MB`);
  log(`archive ${archived}  (HEAD ${sha}${dirty}, versionCode ${versionCode}, stamp "${buildStamp}", API ${apiBaseUrl})`);
}
