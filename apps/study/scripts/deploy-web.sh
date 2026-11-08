#!/bin/sh
# Build the static web app and upload it to a host over SSH (rsync).
# Usage: API=https://api.example.com TARGET=user@host:/var/www/syllabi-app sh scripts/deploy-web.sh
set -eu
cd "$(dirname "$0")/.."
: "${API:?set API to the server URL}"
: "${TARGET:?set TARGET to user@host:/path}"
sh ../../packages/ui/scripts/copy-fonts.sh
WEB_EXPORT=1 NEXT_PUBLIC_API="$API" NEXT_PUBLIC_DEFAULT_API="$API" \
  NEXT_PUBLIC_BUILD_STAMP="$(git rev-parse --short HEAD)" ./node_modules/.bin/next build --webpack
printf '{"sha":"%s"}\n' "$(git rev-parse --short HEAD)" > out/version.json
rsync -az --delete out/ "$TARGET/"
echo "Deployed $(git rev-parse --short HEAD) to $TARGET"
