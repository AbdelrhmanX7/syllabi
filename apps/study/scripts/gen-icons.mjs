#!/usr/bin/env node
// Study's launcher icon, splash and web favicons — one flat mark (open notebook + spark on the app's
// accent blue) rendered with sharp from the SVG in `assets/`. Run after changing the mark:
//
//   node scripts/gen-icons.mjs
//
// Writes: Android mipmaps (legacy square + round, adaptive foreground) for every density, the
// adaptive-icon XML + background colour, the pre-WebView splash drawable, the Tauri bundle icons and
// the PWA/favicon set under public/. Everything it writes is committed; this script is the source.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(appDir, 'assets');
const res = join(appDir, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');

/** Tailwind `st-accent` (rgb 37 99 235). */
const BACKGROUND = '#2563EB';

const markSvg = readFileSync(join(assets, 'icon-mark.svg'), 'utf8');
// The mark's own <svg> wrapper is dropped so it can be placed inside other canvases.
const markInner = markSvg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

/** Adaptive-icon foreground: 108dp canvas, the mark inside the 66dp safe zone (transparent). */
const foregroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">${markInner}</svg>`;

/** Legacy launcher / bundle icon: rounded square, the mark scaled up (no safe-zone need). */
const squareSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <rect width="108" height="108" rx="22" fill="${BACKGROUND}"/>
  <g transform="translate(54 54) scale(1.22) translate(-54 -54)">${markInner}</g>
</svg>`;

/** Legacy round launcher icon. */
const roundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <circle cx="54" cy="54" r="54" fill="${BACKGROUND}"/>
  <g transform="translate(54 54) scale(1.12) translate(-54 -54)">${markInner}</g>
</svg>`;

const render = (svg, size) => sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toBuffer();

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};

/* ------------------------------------------------------------------ Android mipmaps */

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

for (const [density, scale] of Object.entries(DENSITIES)) {
  const dir = join(res, `mipmap-${density}`);

  write(join(dir, 'ic_launcher.png'), await render(squareSvg, Math.round(48 * scale)));
  write(join(dir, 'ic_launcher_round.png'), await render(roundSvg, Math.round(48 * scale)));
  write(join(dir, 'ic_launcher_foreground.png'), await render(foregroundSvg, Math.round(108 * scale)));
}

// Adaptive icon (API 26+): the system masks a flat colour background + our foreground bitmap.
write(
  join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`,
);
write(join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), readFileSync(join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml')));
write(
  join(res, 'values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BACKGROUND}</color>
</resources>
`,
);

// The whiteboard's vector drawables (copied with the gradle project) are superseded by the mipmaps.
rmSync(join(res, 'drawable', 'ic_launcher_background.xml'), { force: true });
rmSync(join(res, 'drawable-v24', 'ic_launcher_foreground.xml'), { force: true });

/* ------------------------------------------------------------------ splash */

// What the window shows between launch and the WebView's first paint: the accent colour with the
// mark centred (`android:windowBackground` on the theme). API 31+ draws its own splash from the
// same colour + icon (values-v31/themes.xml).
write(
  join(res, 'drawable', 'splash.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/ic_launcher_background" />
    <item android:gravity="center">
        <bitmap android:src="@mipmap/ic_launcher_foreground" android:gravity="center" />
    </item>
</layer-list>
`,
);

const baseTheme = (extra) => `<resources xmlns:tools="http://schemas.android.com/tools">
    <!-- Base application theme. -->
    <style name="Theme.study" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <!-- Shown until the WebView paints: the launcher mark on the accent colour (drawable/splash.xml). -->
        <item name="android:windowBackground">@drawable/splash</item>
${extra}    </style>
</resources>
`;

write(join(res, 'values', 'themes.xml'), baseTheme(''));
write(join(res, 'values-night', 'themes.xml'), baseTheme(''));
write(
  join(res, 'values-v31', 'themes.xml'),
  baseTheme(`        <!-- Android 12+ system splash: same colour and mark as the launcher icon. -->
        <item name="android:windowSplashScreenBackground">@color/ic_launcher_background</item>
        <item name="android:windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>
`),
);

/* ------------------------------------------------------------------ Tauri bundle icons */

const tauriIcons = join(appDir, 'src-tauri', 'icons');

write(join(tauriIcons, '32x32.png'), await render(squareSvg, 32));
write(join(tauriIcons, '128x128.png'), await render(squareSvg, 128));
write(join(tauriIcons, '128x128@2x.png'), await render(squareSvg, 256));
write(join(tauriIcons, 'icon.png'), await render(squareSvg, 512));

/** ICO container with PNG-encoded entries (what Windows and browsers read; no BMP conversion). */
async function buildIco(sizes) {
  const entries = await Promise.all(sizes.map((size) => render(squareSvg, size)));
  const header = Buffer.alloc(6);

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;

  entries.forEach((png, index) => {
    const size = sizes[index];
    const at = index * 16;

    dir.writeUInt8(size >= 256 ? 0 : size, at);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...entries]);
}

write(join(tauriIcons, 'icon.ico'), await buildIco([16, 32, 48, 256]));

/* ------------------------------------------------------------------ web */

const pub = join(appDir, 'public');

write(join(pub, 'favicon-16x16.png'), await render(squareSvg, 16));
write(join(pub, 'favicon-32x32.png'), await render(squareSvg, 32));
write(join(pub, 'apple-touch-icon.png'), await render(squareSvg, 180));
write(join(pub, 'android-chrome-192x192.png'), await render(squareSvg, 192));
write(join(pub, 'android-chrome-512x512.png'), await render(squareSvg, 512));
write(join(pub, 'favicon.ico'), await buildIco([16, 32, 48]));

console.log('[gen-icons] wrote Android mipmaps + adaptive icon + splash, Tauri icons, public favicons');
