#!/usr/bin/env node
// Publish a release APK to the public update feed the app polls (lib/platform/app-update.ts).
//
//   node scripts/publish-android.mjs                         newest clean signed arm64 release in android-dist/
//   node scripts/publish-android.mjs --apk <path>            a specific archived APK
//   node scripts/publish-android.mjs --notes "Faster sync"   shown in the in-app update banner
//   node scripts/publish-android.mjs --dry-run               every check, no upload
//   node scripts/publish-android.mjs --probe                 signed HEAD of latest.json: credentials + signing work
//   node scripts/publish-android.mjs --feed study/public     publish to another feed (public CI builds)
//
// Bucket syllabi-studio (Backblaze B2, S3 API, eu-central-003), keys under study/:
//   study/study-<version>-<sha>-arm64.apk   immutable
//   study/latest.json                       {app, version, versionCode, sha, url, sha256, size, publishedAt, notes?}
//   study/index.html                        the download page (style copied from the live page)
//
// Refuses: a -dirty / -unsigned / -debug archive; an APK apksigner does not verify; a package other
// than studio.syllabi.app; a versionCode not above the published one; a signing certificate that
// differs from the published APK's (an update signed by another key cannot install over the app).
// Order: APK upload → public fetch + sha256 check → latest.json + index.html, so the feed never
// points at bytes that are not there yet.
//
// Credentials: B2_RELEASES_KEY_ID / B2_RELEASES_APP_KEY from the environment, else from
// apps/study/.env.local (gitignored). Never printed.
// Signing is a dependency-free AWS SigV4 (no @aws-sdk in this repo).
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);

  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const PACKAGE = 'studio.syllabi.app';
const BUCKET = 'syllabi-studio';
const REGION = 'eu-central-003';
const ENDPOINT_HOST = `s3.${REGION}.backblazeb2.com`;
const PUBLIC_BASE = `https://${BUCKET}.${ENDPOINT_HOST}`;
// Feed key prefix: --feed <prefix> or STUDY_FEED_PREFIX, default `study`. Must match the prefix the
// APK was built with (android-release.mjs bakes STUDY_FEED_PREFIX into the app's update check).
const PREFIX = (option('--feed', '') || process.env.STUDY_FEED_PREFIX || 'study').trim().replace(/^\/+|\/+$/g, '');

if (!/^study(\/[a-z0-9-]+)*$/.test(PREFIX)) {
  console.error(`[publish-android] REFUSED — feed prefix "${PREFIX}" must be study or study/<name>`);
  process.exit(1);
}

const dryRun = flag('--dry-run');
// --replace-feed-app: allow replacing a feed published under a different bundle id (one-time id migration).
const replaceFeedApp = flag('--replace-feed-app');
const notes = option('--notes', '').trim();

const log = (message) => console.log(`[publish-android] ${message}`);
const fail = (message) => {
  console.error(`[publish-android] REFUSED — ${message}`);
  process.exit(1);
};

/* ------------------------------------------------------------------ credentials + SigV4 */

let cached = null;
const credentials = () => {
  if (cached) return cached;
  let keyId = process.env.B2_RELEASES_KEY_ID;
  let secret = process.env.B2_RELEASES_APP_KEY;
  const envFile = join(appDir, '.env.local');

  if ((!keyId || !secret) && existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const match = line.match(/^\s*(B2_RELEASES_KEY_ID|B2_RELEASES_APP_KEY)\s*=\s*(.*)$/);

      if (!match) continue;
      const value = match[2].trim().replace(/^["']|["']$/g, '');

      if (match[1] === 'B2_RELEASES_KEY_ID') keyId ||= value;
      else secret ||= value;
    }
  }

  if (!keyId || !secret) fail(`no B2_RELEASES_KEY_ID / B2_RELEASES_APP_KEY in the environment or ${envFile}`);

  cached = { keyId, secret };

  return cached;
};

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const hex = (data) => createHash('sha256').update(data).digest('hex');
const encodeKey = (key) =>
  key
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');

/** One path-style S3 request signed with SigV4 (host + x-amz-* headers signed). */
async function s3(method, key, body = Buffer.alloc(0), headers = {}) {
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = hex(body);
  const path = `/${BUCKET}/${encodeKey(key)}`;
  const signed = { host: ENDPOINT_HOST, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signedNames = Object.keys(signed).sort();
  const canonical = [
    method,
    path,
    '',
    signedNames.map((name) => `${name}:${signed[name]}\n`).join(''),
    signedNames.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials().secret}`, day), REGION), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const response = await fetch(`https://${ENDPOINT_HOST}${path}`, {
    method,
    body: method === 'PUT' ? body : undefined,
    headers: {
      ...headers,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${credentials().keyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');

    throw new Error(`${method} ${key} → HTTP ${response.status} ${text.match(/<Code>([^<]+)/)?.[1] ?? ''}`.trim());
  }

  return response;
}

if (flag('--probe')) {
  // Credentials + signing check without writing anything: a signed HEAD of the live feed.
  try {
    await s3('HEAD', `${PREFIX}/latest.json`);
    log('signed HEAD ok — credentials and SigV4 work');
  } catch (error) {
    // 404 = authenticated fine, nothing published yet (fresh bucket).
    if (!String(error.message).includes('HTTP 404')) throw error;
    log('signed HEAD ok (404: no feed published yet) — credentials and SigV4 work');
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ the APK */

const archiveDir = join(appDir, 'android-dist');
const pickNewest = () => {
  if (!existsSync(archiveDir)) return '';
  const candidates = readdirSync(archiveDir)
    .filter((name) => /^study-.+-arm64-release\.apk$/.test(name) && !/-dirty-|-unsigned/.test(name))
    .map((name) => join(archiveDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  return candidates[0] ?? '';
};
const apkPath = resolve(option('--apk', '') || pickNewest());

if (!apkPath || !existsSync(apkPath)) fail('no APK (pass --apk, or build one with scripts/android-release.mjs)');

const apkName = basename(apkPath);

if (/-dirty/.test(apkName)) fail(`${apkName} was built from a dirty tree — rebuild with --from-commit`);
if (/-unsigned/.test(apkName)) fail(`${apkName} is unsigned`);
if (/-debug/.test(apkName)) fail(`${apkName} is a debug build`);

const nameMatch = apkName.match(/^study-(.+?)-([0-9a-f]{7,40})-arm64-release\.apk$/);

if (!nameMatch) fail(`${apkName} is not an android-release.mjs archive name (study-<version>-<sha>-arm64-release.apk)`);

const [, fileVersion, sha] = nameMatch;

/* ------------------------------------------------------------------ build-tools checks */

const sdk = process.env.ANDROID_HOME || join(homedir(), 'Android', 'Sdk');
const buildToolsRoot = join(sdk, 'build-tools');
const buildTools = existsSync(buildToolsRoot)
  ? readdirSync(buildToolsRoot)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((version) => join(buildToolsRoot, version))
      .reverse()
      .find((dir) => existsSync(join(dir, 'apksigner')) && existsSync(join(dir, 'aapt2')))
  : undefined;

if (!buildTools) fail(`no Android build-tools with apksigner + aapt2 under ${buildToolsRoot}`);

const javaHome =
  process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, 'bin', 'java'))
    ? process.env.JAVA_HOME
    : join(homedir(), 'tools', 'jdk-21');
const toolEnv = { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}:${process.env.PATH}` };
const run = (command, commandArgs) => spawnSync(command, commandArgs, { encoding: 'utf8', env: toolEnv });

const certDigest = (path) => {
  const result = run(join(buildTools, 'apksigner'), ['verify', '--print-certs', path]);

  if (result.status !== 0) return null;

  return result.stdout.match(/certificate SHA-256 digest: ([0-9a-f]{64})/)?.[1] ?? null;
};

const localCert = certDigest(apkPath);

if (!localCert) fail(`apksigner does not verify ${apkName}`);

const badging = run(join(buildTools, 'aapt2'), ['dump', 'badging', apkPath]);

if (badging.status !== 0) fail(`aapt2 cannot read ${apkName}: ${badging.stderr.trim()}`);

const packageLine = badging.stdout.split('\n').find((line) => line.startsWith('package:')) ?? '';
const packageName = packageLine.match(/name='([^']+)'/)?.[1];
const versionCode = Number(packageLine.match(/versionCode='(\d+)'/)?.[1]);
const version = packageLine.match(/versionName='([^']+)'/)?.[1] ?? fileVersion;

if (packageName !== PACKAGE) fail(`package is ${packageName}, expected ${PACKAGE}`);
if (!Number.isSafeInteger(versionCode) || versionCode <= 0) fail('no versionCode in the APK');

/* ------------------------------------------------------------------ against what is published */

// A slow link drops long downloads mid-body («terminated»): retry the whole read a few times.
const fetchBytes = async (url, attempts = 4) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });

      return { status: response.status, bytes: response.ok ? Buffer.from(await response.arrayBuffer()) : null };
    } catch (error) {
      if (attempt >= attempts) throw error;
      log(`download interrupted (${error.message}) — retry ${attempt}/${attempts - 1}`);
      await new Promise((done) => setTimeout(done, 5_000 * attempt));
    }
  }
};

const current = await fetchBytes(`${PUBLIC_BASE}/${PREFIX}/latest.json`);
let published = null;

if (current.bytes) {
  published = JSON.parse(current.bytes.toString('utf8'));
  if (published.app !== PACKAGE && !replaceFeedApp) fail(`the live latest.json is for ${published.app}`);
  if (versionCode <= Number(published.versionCode)) {
    fail(`versionCode ${versionCode} is not above the published ${published.versionCode} (${published.sha})`);
  }
} else if (current.status !== 404) {
  fail(`cannot read the live latest.json (HTTP ${current.status})`);
}

if (published?.url) {
  const live = await fetchBytes(published.url);

  if (live.bytes) {
    const scratch = mkdtempSync(join(tmpdir(), 'study-publish-'));
    const livePath = join(scratch, 'live.apk');

    writeFileSync(livePath, live.bytes);
    const liveCert = certDigest(livePath);

    rmSync(scratch, { recursive: true, force: true });
    if (liveCert && liveCert !== localCert) {
      fail('the signing certificate differs from the published APK — it would not install over the app');
    }
    log(`signing certificate matches the published ${published.sha}`);
  }
}

const apk = readFileSync(apkPath);
const sha256 = createHash('sha256').update(apk).digest('hex');
const apkKey = `${PREFIX}/study-${version}-${sha}-arm64.apk`;
const latest = {
  app: PACKAGE,
  version,
  versionCode,
  sha,
  url: `${PUBLIC_BASE}/${apkKey}`,
  sha256,
  size: apk.length,
  publishedAt: new Date().toISOString(),
  ...(notes ? { notes } : {}),
};

log(`${apkName}: ${PACKAGE} ${version} versionCode ${versionCode} (published ${published?.versionCode ?? 'none'})`);
log(`sha256 ${sha256}, ${(apk.length / 1048576).toFixed(1)} MB`);
log(`feed ${PUBLIC_BASE}/${PREFIX}/latest.json`);

/* ------------------------------------------------------------------ the download page */

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const FALLBACK_STYLE =
  'body{font-family:system-ui,sans-serif;background:#f4f4f5;color:#18181b;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}.c{background:#fff;border-radius:16px;padding:28px;max-width:420px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,.08)}a.b{display:block;text-align:center;background:#2563eb;color:#fff;padding:14px;border-radius:10px;text-decoration:none;font-weight:600;margin:18px 0}p{color:#52525b;font-size:.9rem;line-height:1.5}';
const livePage = await fetchBytes(`${PUBLIC_BASE}/${PREFIX}/index.html`);
const style = livePage.bytes?.toString('utf8').match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? FALLBACK_STYLE;
const html =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Study — download</title><style>${style}</style></head><body><div class="c"><h1>Study</h1>` +
  `<p>Version ${escapeHtml(version)} · build ${escapeHtml(sha)} · ${(apk.length / 1048576).toFixed(1)} MB · ${latest.publishedAt.slice(0, 10)}</p>` +
  (notes ? `<p>${escapeHtml(notes)}</p>` : '') +
  `<a class="b" href="${escapeHtml(latest.url)}">Download for Android</a>` +
  `<p>Open the downloaded file and allow installing from this source if asked. Updates install over the existing app — your data stays.</p>` +
  `</div></body></html>`;

if (dryRun) {
  log('dry run — nothing uploaded. latest.json would be:');
  console.log(JSON.stringify(latest, null, 2));
  process.exit(0);
}

/* ------------------------------------------------------------------ upload */

log(`uploading ${apkKey}`);
await s3('PUT', apkKey, apk, {
  'Content-Type': 'application/vnd.android.package-archive',
  'Cache-Control': 'public, max-age=31536000, immutable',
});

const check = await fetchBytes(latest.url);

if (!check.bytes || hex(check.bytes) !== sha256) {
  fail(`the public ${latest.url} does not serve the uploaded bytes (HTTP ${check.status}) — latest.json NOT updated`);
}
log('public APK fetch verified (sha256 matches)');

await s3('PUT', `${PREFIX}/latest.json`, Buffer.from(JSON.stringify(latest, null, 2)), {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache, max-age=0',
});
await s3('PUT', `${PREFIX}/index.html`, Buffer.from(html), {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-cache, max-age=0',
});

const feedCheck = await fetchBytes(`${PUBLIC_BASE}/${PREFIX}/latest.json`);

if (!feedCheck.bytes || JSON.parse(feedCheck.bytes.toString('utf8')).versionCode !== versionCode) {
  fail('latest.json did not read back with the new versionCode');
}

log(`published ${version} (${sha}) versionCode ${versionCode}`);
log(`page ${PUBLIC_BASE}/${PREFIX}/index.html`);
