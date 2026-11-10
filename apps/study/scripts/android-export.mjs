#!/usr/bin/env node
// The Android frontend export — tauri.conf.json's `beforeBuildCommand`, also runnable standalone:
// `node scripts/android-export.mjs`.
//
// A script rather than a bare `next build` for two reasons (both learned the hard way on the whiteboard):
// 1. The shipped backend URL is pinned in `process.env` here (see scripts/lib/release-api.mjs).
//    Left to the .env files, `.env.local`'s LAN address outranks `.env.production` and gets baked
//    into the APK.
// 2. The result is CHECKED before the APK is assembled: any dev/LAN backend string in the exported
//    JavaScript fails the build, so a regression can never reach the tablet silently.
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveReleaseAnalyticsEnv, resolveReleaseApiBaseUrl, scanExportForLeaks } from './lib/release-api.mjs';

const require = createRequire(import.meta.url);
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiBaseUrl = resolveReleaseApiBaseUrl(appDir);
const analyticsEnv = resolveReleaseAnalyticsEnv(appDir);

console.log(`[android-export] Baking NEXT_PUBLIC_API = ${apiBaseUrl}`);
console.log(`[android-export] Usage counts ${analyticsEnv.NEXT_PUBLIC_POSTHOG_KEY ? 'on' : 'off (no key)'}`);

// Fonts the shared UI stylesheet references (packages/ui/fonts → public/font), same as `predev`.
execSync('sh ../../packages/ui/scripts/copy-fonts.sh', { cwd: appDir, stdio: 'inherit' });

// Resolve Next's CLI explicitly (no npx, no shim, hoisting independent). `--webpack`: the board
// engine's pdf.js/fabric bits are built the same way in every app of this repo.
const nextBin = join(dirname(require.resolve('next/package.json')), 'dist', 'bin', 'next');

execSync(`node "${nextBin}" build --webpack`, {
  cwd: appDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    ANDROID_BUILD: '1',
    NEXT_PUBLIC_API: apiBaseUrl,
    ...analyticsEnv,
    NODE_ENV: 'production',
  },
});

/* ------------------------------------------------------------------ post-export assertion */

const outNext = join(appDir, 'out', '_next');
const scan = scanExportForLeaks({ appDir, outNext, apiBaseUrl });

if (!scan.ok) {
  console.error(
    `[android-export] FAILED — the export does not carry the intended backend cleanly (${scan.offenders.length} finding(s)):`,
  );
  for (const { file, value } of scan.offenders.slice(0, 10)) console.error(`  ${value}  ←  ${file}`);
  process.exit(1);
}

console.log(
  `[android-export] OK — out/ carries NEXT_PUBLIC_API = ${apiBaseUrl}; none of ${scan.forbidden.length} dev .env value(s) and no private backend on :5000 in ${outNext}`,
);
