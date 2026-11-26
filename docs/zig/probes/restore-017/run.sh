#!/bin/sh
# Zig 0.17.1 (verified 2026-11-26), found while restoring src/md from Bun 1.3.14:
# 1. `#name` private fields (Oven's Zig fork) don't parse in vanilla Zig: "expected type expression, found 'invalid token'";
# 2. `std.ArrayList(T) = .{}` fails: "missing struct field: items"; use `.empty` (also for @memset of an array of lists).
# good.zig shows the replacements that scripts/fix_zig017.ts (private-field, arraylist-empty) produces.
set -e
cd "$(dirname "$0")"
zig test good.zig
check() {
  if out=$(zig test "$1" 2>&1); then echo "changed: $1 compiles now"; exit 1; fi
  case "$out" in
    *"$2"*) echo "ok: $1 rejected ($2)" ;;
    *) echo "unexpected error in $1: $out"; exit 1 ;;
  esac
}
check private_field.zig "expected type expression, found 'invalid token'"
check arraylist_braces.zig "missing struct field: items"
