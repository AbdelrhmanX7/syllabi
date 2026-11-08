#!/bin/sh
# Copy shared font files from packages/ui/fonts/ to the calling app's public/font/
# Usage: Called as a prebuild/predev script from each app's package.json

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FONTS_DIR="$SCRIPT_DIR/../fonts"
TARGET_DIR="$(pwd)/public/font"

mkdir -p "$TARGET_DIR"
# Only woff2 is shipped to browsers — modern browsers fetch nothing else.
cp "$FONTS_DIR"/IBMPlexSansArabic-*.woff2 "$TARGET_DIR/" 2>/dev/null
# The board's handwriting font ("Explain on my page" notes, used by packages/whiteboard-react) — Aref Ruqaa, SIL OFL.
cp "$FONTS_DIR"/ArefRuqaa-* "$TARGET_DIR/" 2>/dev/null
echo "Fonts copied to $TARGET_DIR"
