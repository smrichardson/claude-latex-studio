#!/bin/bash
# Generate "LaTeX Claude Studio.app" — an AppleScript app (handled natively by
# macOS LaunchServices) that runs scripts/launch.sh from this checkout.
# Usage: scripts/make-macos-app.sh [destination-dir]   (default: repo root)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
DEST="${1:-$APP_DIR}"
APP_NAME="LaTeX Claude Studio"
BUNDLE="$DEST/$APP_NAME.app"

rm -rf "$BUNDLE"

# AppleScript apps launch reliably from Finder/Dock and run a shell command via
# `do shell script`. We point it at launch.sh (single source of truth).
TMP_SCPT="$(mktemp -t lcs).applescript"
cat > "$TMP_SCPT" <<APPLE
do shell script "'$APP_DIR/scripts/launch.sh' >/tmp/latex-claude-studio.launch.log 2>&1"
APPLE

osacompile -o "$BUNDLE" "$TMP_SCPT"
rm -f "$TMP_SCPT"

# Apply the ∫ app icon (built from public/icon-512.png).
ICON_SRC="$APP_DIR/public/icon-512.png"
if [ -f "$ICON_SRC" ] && command -v iconutil >/dev/null 2>&1; then
  ISET="$(mktemp -d)/icon.iconset"; mkdir -p "$ISET"
  for s in 16 32 64 128 256 512; do
    sips -z "$s" "$s" "$ICON_SRC" --out "$ISET/icon_${s}x${s}.png" >/dev/null 2>&1
    sips -z "$((s * 2))" "$((s * 2))" "$ICON_SRC" --out "$ISET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ISET" -o "$BUNDLE/Contents/Resources/applet.icns" 2>/dev/null
fi

echo "Created: $BUNDLE"
echo "Drag it to your Dock (or Applications), then click to launch."
