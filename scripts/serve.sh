#!/bin/bash
# Run the studio server in the foreground (for a launchd KeepAlive agent).
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin:/usr/bin:/bin"
[ -f "$HOME/.latex-claude-studio.env" ] && { set -a; . "$HOME/.latex-claude-studio.env"; set +a; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"
[ -f dist/index.html ] || npm run build
exec node server.mjs
