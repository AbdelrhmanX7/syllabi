#!/bin/sh
# Build the static web app and upload it to a host over SSH (rsync).
# Usage: API=https://api.example.com TARGET=user@host:/var/www/syllabi-app sh scripts/deploy-web.sh
set -eu
cd "$(dirname "$0")/.."
: "${API:?set API to the server URL}"
: "${TARGET:?set TARGET to user@host:/path}"
sh ../../packages/ui/scripts/copy-fonts.sh
# Usage counts key/host: from the environment, else .env.release.local (same as the Android build).
read_release_var() {
  if [ -f .env.release.local ]; then
    sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\{0,1\}\([^\"[:space:]#]*\).*/\1/p" .env.release.local | head -n 1
  fi
  return 0
}
NEXT_PUBLIC_POSTHOG_KEY="${NEXT_PUBLIC_POSTHOG_KEY-$(read_release_var NEXT_PUBLIC_POSTHOG_KEY)}"
NEXT_PUBLIC_POSTHOG_HOST="${NEXT_PUBLIC_POSTHOG_HOST-$(read_release_var NEXT_PUBLIC_POSTHOG_HOST)}"
export NEXT_PUBLIC_POSTHOG_KEY NEXT_PUBLIC_POSTHOG_HOST
WEB_EXPORT=1 NEXT_PUBLIC_API="$API" NEXT_PUBLIC_DEFAULT_API="$API" \
  NEXT_PUBLIC_BUILD_STAMP="$(git rev-parse --short HEAD)" ./node_modules/.bin/next build --webpack
printf '{"sha":"%s"}\n' "$(git rev-parse --short HEAD)" > out/version.json
rsync -az --delete out/ "$TARGET/"
echo "Deployed $(git rev-parse --short HEAD) to $TARGET"
