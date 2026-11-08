#!/usr/bin/env node
// Bump the app version everywhere it is declared (the Release workflow, .github/workflows/release.yml):
//
//   node scripts/bump-version.mjs patch|minor|major      prints the new version (X.Y.Z)
//
// Files: package.json, src-tauri/tauri.conf.json (Android versionName), src-tauri/Cargo.toml and the
// app's own [[package]] entry in src-tauri/Cargo.lock. versionCode is time-based (android-release.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const type = process.argv[2];

if (!['patch', 'minor', 'major'].includes(type)) {
  console.error('usage: bump-version.mjs patch|minor|major');
  process.exit(1);
}

const confPath = join(appDir, 'src-tauri', 'tauri.conf.json');
const current = JSON.parse(readFileSync(confPath, 'utf8')).version;
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current ?? '');

if (!match) {
  console.error(`tauri.conf.json version "${current}" is not X.Y.Z`);
  process.exit(1);
}

let [major, minor, patch] = match.slice(1).map(Number);

if (type === 'major') [major, minor, patch] = [major + 1, 0, 0];
else if (type === 'minor') [minor, patch] = [minor + 1, 0];
else patch += 1;

const next = `${major}.${minor}.${patch}`;
const edit = (path, pattern, replacement) => {
  const text = readFileSync(path, 'utf8');
  const updated = text.replace(pattern, replacement);

  if (updated === text) throw new Error(`no version to bump in ${path}`);
  writeFileSync(path, updated);
};

// Text edits (not JSON round-trips) so formatting stays byte-identical apart from the version.
edit(join(appDir, 'package.json'), /("version":\s*")[^"]+(")/, `$1${next}$2`);
edit(confPath, /("version":\s*")[^"]+(")/, `$1${next}$2`);

const cargoToml = join(appDir, 'src-tauri', 'Cargo.toml');
const crate = /^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m.exec(readFileSync(cargoToml, 'utf8'))?.[1];

if (!crate) throw new Error('no [package] name in Cargo.toml');
edit(cargoToml, /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${next}$2`);
// Only this crate's lock entry: other crates may share the same version string.
edit(
  join(appDir, 'src-tauri', 'Cargo.lock'),
  new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")[^"]+(")`),
  `$1${next}$2`,
);

console.log(next);
