#!/usr/bin/env node
// Bump the app version everywhere it is declared (ship-public.mjs, .github/workflows/release.yml):
//
//   node scripts/bump-version.mjs patch|minor|major      prints the new version (X.Y.Z)
//   node scripts/bump-version.mjs --type patch|minor|major
//   node scripts/bump-version.mjs --version 0.2.5        exact version; must be X.Y.Z and above the current one
//   add --dry-run to print the new version without writing anything
//
// --type (or the bare word) and --version are mutually exclusive; with neither, nothing happens (usage error).
// Files: package.json, src-tauri/tauri.conf.json (Android versionName), src-tauri/Cargo.toml and the
// app's own [[package]] entry in src-tauri/Cargo.lock. versionCode is time-based (android-release.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = ['patch', 'minor', 'major'];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const USAGE = 'usage: bump-version.mjs patch|minor|major | --type patch|minor|major | --version X.Y.Z  [--dry-run]';

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);

  if (index < 0) return undefined;
  const value = args[index + 1];

  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value\n${USAGE}`);

  return value;
};
const dryRun = args.includes('--dry-run');
const exact = valueOf('--version');
const flagType = valueOf('--type');
const bareType = args.find((arg) => TYPES.includes(arg) && arg !== flagType);

if (flagType && bareType) fail(`give the bump type once\n${USAGE}`);
const type = flagType ?? bareType;

if (type && exact) fail(`--type and --version are mutually exclusive\n${USAGE}`);
if (!type && !exact) fail(USAGE);
if (type && !TYPES.includes(type)) fail(`--type must be patch, minor or major\n${USAGE}`);

const confPath = join(appDir, 'src-tauri', 'tauri.conf.json');
const current = JSON.parse(readFileSync(confPath, 'utf8')).version;
const match = SEMVER.exec(current ?? '');

if (!match) fail(`tauri.conf.json version "${current}" is not X.Y.Z`);

const parts = (m) => m.slice(1, 4).map(Number);
let next;

if (exact) {
  // No leading zeros (semver), so "0.02.5" can't sneak past as 0.2.5 in the comparison.
  const wanted = SEMVER.exec(exact);

  if (!wanted || wanted.slice(1, 4).some((part) => part.length > 1 && part.startsWith('0'))) {
    fail(`--version "${exact}" is not a valid X.Y.Z version`);
  }
  const [a, b] = [parts(wanted), parts(match)];
  const diff = a.map((n, i) => n - b[i]).find((d) => d !== 0) ?? 0;

  if (diff <= 0) fail(`--version ${exact} must be greater than the current version ${current}`);
  next = a.join('.');
} else {
  let [major, minor, patch] = parts(match);

  if (type === 'major') [major, minor, patch] = [major + 1, 0, 0];
  else if (type === 'minor') [minor, patch] = [minor + 1, 0];
  else patch += 1;
  next = `${major}.${minor}.${patch}`;
}

if (dryRun) {
  console.error(`${current} -> ${next} (dry run, nothing written)`);
  console.log(next);
  process.exit(0);
}

// Read and check every file first, then write, so a failure can't leave the version half-bumped.
const edits = [];
const edit = (path, pattern, replacement) => {
  const text = readFileSync(path, 'utf8');
  const updated = text.replace(pattern, replacement);

  if (updated === text) throw new Error(`no version to bump in ${path}`);
  edits.push([path, updated]);
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

for (const [path, text] of edits) writeFileSync(path, text);

console.log(next);
