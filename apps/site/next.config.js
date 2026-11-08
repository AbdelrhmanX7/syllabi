// syllabi.studio landing page: a static export. It borrows the study app's design tokens and its
// designed primitives (apps/study/components/ui/primitives.tsx) so the site and the app look the same.
/** @type {import('next').NextConfig} */
module.exports = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  transpilePackages: ['@repo/ui'],
  experimental: { externalDir: true },
};
