#!/usr/bin/env node
// Ship a tested build to everyone, with one version number everywhere.
//
//   node scripts/ship-public.mjs --notes "What's new, in plain words" [--type patch|minor|major] [--skip-web]
//
// Two channels:
//   test    every change: `android-release.mjs` + `publish-android.mjs` (default feed `study`). Only the
//           owner's tablets poll that feed, so they get each build early. No version bump.
//   public  this script, once the owner has tested a batch and gives the go-ahead:
//             1. bump the version (bump-version.mjs), commit "Release vX.Y.Z", tag vX.Y.Z, push
//             2. build the public APK (hosted server, public feed) from that commit
//             3. publish it to the public feed (`study/public`)
//             4. create the GitHub Release vX.Y.Z with that APK and the notes (since the previous tag)
//             5. build + publish the test-channel APK from the same commit, so the owner's tablets
//                show the same version
//             6. deploy the web app (unless --skip-web)
//
// Heavy (two Android builds): run it alone, in the background. Needs a clean, pushed master.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(appDir, '..', '..');
const distDir = join(appDir, 'android-dist');
const PUBLIC_API = 'https://api.syllabi.studio';
const PUBLIC_FEED = 'study/public';
const DOWNLOAD_PAGE = 'https://syllabi.studio/download';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);

  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const type = option('--type', 'patch');
const notes = option('--notes', '').trim();
const skipWeb = args.includes('--skip-web');

const log = (message) => console.log(`[ship-public] ${message}`);
const fail = (message) => {
  console.error(`[ship-public] ${message}`);
  process.exit(1);
};
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: repoDir, encoding: 'utf8' }).trim();
const run = (command, commandArgs, env = {}) => {
  log(`$ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { cwd: appDir, stdio: 'inherit', env: { ...process.env, ...env } });

  if (result.status !== 0) fail(`${command} ${commandArgs[0] ?? ''} failed (exit ${result.status})`);
};

if (!['patch', 'minor', 'major'].includes(type)) fail('--type must be patch, minor or major');
if (!notes) fail('--notes is required: say what changed, in plain words');
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'master') fail('run it on master');
if (git('status', '--porcelain', '--untracked-files=no')) fail('the working tree has uncommitted changes');
git('fetch', '-q', 'origin', 'master');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/master')) fail('master is not in sync with origin/master');

const previousTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*');

/* 1. version */
const version = execFileSync('node', [join(appDir, 'scripts', 'bump-version.mjs'), type], { encoding: 'utf8' }).trim();
const tag = `v${version}`;

git('add', 'apps/study/package.json', 'apps/study/src-tauri/tauri.conf.json', 'apps/study/src-tauri/Cargo.toml', 'apps/study/src-tauri/Cargo.lock');
git('commit', '-q', '-m', `Release ${version}`);
git('tag', '-a', tag, '-m', `Syllabi ${version}`);
git('push', '-q', 'origin', 'master', tag);
const sha = git('rev-parse', '--short', 'HEAD');

log(`${previousTag} → ${tag} at ${sha}`);

const archiveFor = () => {
  const name = readdirSync(distDir).find((file) => file.startsWith(`study-${version}-${sha}-`) && file.endsWith('-release.apk'));

  if (!name) fail(`no archived APK for ${version} ${sha} in android-dist`);

  return join(distDir, name);
};

/* 2–3. public build + public feed */
run('node', ['scripts/android-release.mjs', '--from-commit', sha], { STUDY_BUILD_API: PUBLIC_API, STUDY_FEED_PREFIX: PUBLIC_FEED });
// publish-android only accepts android-release archive names; the GitHub asset gets a friendly copy.
run('node', ['scripts/publish-android.mjs', '--apk', archiveFor(), '--feed', PUBLIC_FEED, '--notes', notes]);
const publicApk = join(distDir, `syllabi-${version}.apk`);

copyFileSync(archiveFor(), publicApk);

/* 4. GitHub Release */
const sha256 = execFileSync('sha256sum', [publicApk], { encoding: 'utf8' }).split(/\s+/)[0];
const body =
  `## What's new\n${notes}\n\n` +
  `**Download:** ${DOWNLOAD_PAGE}\n\n` +
  `**File fingerprint (SHA-256):** \`${sha256}\`\n\n` +
  `Changes since ${previousTag}: https://github.com/AbdelrhmanX7/syllabi/compare/${previousTag}...${tag}\n`;
const bodyFile = join(distDir, `release-notes-${version}.md`);

writeFileSync(bodyFile, body);
run('gh', ['release', 'create', tag, publicApk, '--title', `Syllabi ${version}`, '--notes-file', bodyFile, '--verify-tag', '--latest']);

/* 5. test channel on the same version */
run('node', ['scripts/android-release.mjs', '--from-commit', sha]);
run('node', ['scripts/publish-android.mjs', '--apk', archiveFor(), '--notes', notes]);

/* 6. web */
if (!skipWeb && existsSync(join(appDir, 'scripts', 'deploy-web.sh'))) {
  run('sh', ['scripts/deploy-web.sh'], { API: PUBLIC_API, TARGET: process.env.WEB_TARGET ?? 'prod:/var/www/syllabi-app' });
}

log(`shipped ${tag} (${sha}) to everyone`);
