#!/bin/sh
# Zig 0.17.1: the configure cache is keyed without the --build-file path, so two
# build files sharing one --cache-dir see each other's configuration.
# Prints "BUG reproduced" on 0.17.1, "fixed" once Zig keys the cache on the build file.
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
zig build -l --cache-dir "$tmp/c" >/dev/null
out=$(zig build --build-file other.zig -l --cache-dir "$tmp/c")
rm -rf "$tmp"
case "$out" in
  *from-other-zig*) echo "fixed: other.zig got its own configuration" ;;
  *from-build-zig*) echo "BUG reproduced: --build-file other.zig listed build.zig's steps" ;;
  *) echo "unexpected: $out"; exit 1 ;;
esac
