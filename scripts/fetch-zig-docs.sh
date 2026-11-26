#!/usr/bin/env bash
# Re-download the upstream Zig docs into docs/zig/upstream/ as greppable Markdown.
# Usage: scripts/fetch-zig-docs.sh [langref-version]   (default: 0.17.1)
# Needs: curl, html2text (python html2text).
set -euo pipefail

LANGREF_VERSION="${1:-0.17.1}"
RELEASE_NOTES=(0.15.1 0.16.0 0.17.0)

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/docs/zig/upstream"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"

fetch() { # url name
  curl -sfL -o "$tmp/$2.html" "$1"
  html2text --body-width=0 "$tmp/$2.html" > "$out/$2.md"
  echo "wrote docs/zig/upstream/$2.md ($(wc -l < "$out/$2.md") lines)"
}

fetch "https://ziglang.org/documentation/$LANGREF_VERSION/" "langref-$LANGREF_VERSION"
for v in "${RELEASE_NOTES[@]}"; do
  fetch "https://ziglang.org/download/$v/release-notes.html" "release-notes-$v"
done
