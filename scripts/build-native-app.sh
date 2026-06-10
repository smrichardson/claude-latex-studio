#!/bin/bash
# Build the native macOS app (Swift + WKWebView) and install it.
# Usage: scripts/build-native-app.sh [destination-dir]   (default: /Applications)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$SCRIPT_DIR")"
DEST="${1:-/Applications}"
APP_NAME="LaTeX Claude Studio"
BUNDLE="$DEST/$APP_NAME.app"
BUILD="$(mktemp -d)"

command -v swiftc >/dev/null || { echo "swiftc not found (install Xcode Command Line Tools)"; exit 1; }

# Bake the server-start script path into the binary.
cat > "$BUILD/Config.swift" <<EOF
let serveScriptPath = "$REPO/scripts/serve.sh"
EOF

mkdir -p "$BUILD/$APP_NAME.app/Contents/MacOS" "$BUILD/$APP_NAME.app/Contents/Resources"

echo "Compiling…"
swiftc -O "$BUILD/Config.swift" "$REPO/native/main.swift" \
  -o "$BUILD/$APP_NAME.app/Contents/MacOS/studio" \
  -framework Cocoa -framework WebKit

# Icon: public/icon-512.png → studio.icns
ISET="$BUILD/icon.iconset"; mkdir -p "$ISET"
for s in 16 32 64 128 256 512; do
  sips -z "$s" "$s" "$REPO/public/icon-512.png" --out "$ISET/icon_${s}x${s}.png" >/dev/null
  sips -z "$((s * 2))" "$((s * 2))" "$REPO/public/icon-512.png" --out "$ISET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ISET" -o "$BUILD/$APP_NAME.app/Contents/Resources/studio.icns"

cat > "$BUILD/$APP_NAME.app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>LaTeX Claude Studio</string>
  <key>CFBundleDisplayName</key><string>LaTeX Claude Studio</string>
  <key>CFBundleIdentifier</key><string>com.latexclaudestudio.native</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>studio</string>
  <key>CFBundleIconFile</key><string>studio</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

codesign --force -s - "$BUILD/$APP_NAME.app" 2>/dev/null || true

rm -rf "$BUNDLE"
mv "$BUILD/$APP_NAME.app" "$BUNDLE"
rm -rf "$BUILD"
echo "Installed: $BUNDLE"
