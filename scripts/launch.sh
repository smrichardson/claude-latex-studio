#!/bin/bash
# Launch LaTeX · Claude Studio: ensure the server is up, then open a chromeless
# app window. Used both standalone (double-click) and by the generated .app.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
PORT=4319

# Finder/.app launches start with a minimal PATH — add the usual node/TeX spots.
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin:/usr/bin:/bin"
command -v node >/dev/null 2>&1 || { osascript -e 'display alert "node not found" message "Install Node and ensure it is on PATH."'; exit 1; }

# Optional config: ~/.latex-claude-studio.env can set STUDIO_PROJECT / STUDIO_MAIN
# to open a specific project folder (so the dock app isn't pinned to ./project).
if [ -f "$HOME/.latex-claude-studio.env" ]; then
  set -a
  . "$HOME/.latex-claude-studio.env"
  set +a
fi

cd "$APP_DIR"

# Build the frontend once if it has not been built.
[ -f dist/index.html ] || npm run build

# Start the server if it is not already serving. nohup so it outlives this
# launcher (and the app window), keeping your work and a warm server around.
if ! curl -s -o /dev/null "http://localhost:$PORT/api/papers"; then
  nohup node server.mjs >/tmp/latex-claude-studio.log 2>&1 &
  for _ in $(seq 1 40); do
    curl -s -o /dev/null "http://localhost:$PORT/api/papers" && break
    sleep 0.25
  done
fi

# Open a standalone (no tabs / no address bar) app window in its own profile,
# so it shows up as its own window rather than a tab in your main browser.
open -na "Google Chrome" --args \
  --app="http://localhost:$PORT" \
  --user-data-dir="$HOME/.latex-claude-studio-chrome"
