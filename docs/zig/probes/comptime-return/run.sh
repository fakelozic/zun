#!/bin/sh
# Zig 0.17.1: `return` inside `comptime { }` in a runtime-called fn is a compile error;
# `return comptime <expr>;` works. Run from the repo root or anywhere.
set -e
cd "$(dirname "$0")"
zig test good.zig
if out=$(zig test bad.zig 2>&1); then
  echo "changed: bad.zig compiles now"; exit 1
fi
case "$out" in
  *"function called at runtime cannot return value at comptime"*) echo "ok: bad.zig rejected as expected" ;;
  *) echo "unexpected error: $out"; exit 1 ;;
esac
