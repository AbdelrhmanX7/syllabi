// Android (Tauri 2 mobile) has no Node server: the app ships as a static export bundled into the APK.
const isAndroidBuild = process.env.ANDROID_BUILD === '1';
// The hosted web app (e.g. app.syllabi.studio) is the same static export, served by any static host.
const isWebExport = process.env.WEB_EXPORT === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  trailingSlash: true,
  // Workspace packages ship raw TypeScript (`main: src/index.ts`), so they have to be transpiled here.
  transpilePackages: ['@repo/auth', '@repo/ui', '@repo/utils', '@repo/whiteboard-core', '@repo/whiteboard-react'],
  // Static export for the APK: no server, no headers/rewrites/API routes. `NEXT_PUBLIC_ANDROID_BUILD`
  // lets client code tell this bundle apart at build time (see lib/platform/runtime.ts).
  ...(isAndroidBuild || isWebExport
    ? {
        output: 'export',
        images: { unoptimized: true },
        ...(isAndroidBuild ? { env: { NEXT_PUBLIC_ANDROID_BUILD: '1' } } : {}),
      }
    : {}),
};

module.exports = nextConfig;
