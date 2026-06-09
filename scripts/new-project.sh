#!/bin/bash
# Scaffold a clean studio project folder you can point the studio at.
# Usage: scripts/new-project.sh <path-to-new-project>
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$SCRIPT_DIR")"
DEST="${1:?usage: scripts/new-project.sh <path-to-new-project>}"

mkdir -p "$DEST/papers" "$DEST/figures"
[ -f "$DEST/main.tex" ]       || cp "$REPO/project/main.tex" "$DEST/main.tex"
[ -f "$DEST/references.bib" ] || cp "$REPO/project/references.bib" "$DEST/references.bib"

cat <<MSG
Created project: $DEST
  main.tex        your writeup (edit the title/author)
  references.bib  bibliography
  papers/         drop source PDFs here (subfolders allowed, e.g. papers/readings/)
  figures/        images for \\includegraphics

Run it:
  STUDIO_PROJECT="$DEST" npm start      # then open http://localhost:4319
  (override the main file with STUDIO_MAIN="writeup.tex")
MSG
