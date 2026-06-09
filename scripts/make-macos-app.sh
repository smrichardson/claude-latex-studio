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

echo "Created: $BUNDLE"
echo "Drag it to your Dock (or Applications), then click to launch."
