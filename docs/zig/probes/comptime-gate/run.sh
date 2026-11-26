#!/bin/sh
# Zig 0.17.1 (verified 2026-11-26):
# 1. a `comptime`-false branch is not analysed and may name a missing decl (gate.zig passes);
# 2. but every `@import("file.zig")` in a loaded file must exist, even in a dead branch
#    or in a function nobody calls ("unable to load ... FileNotFound").
# So restore gates must test a flag and name `bun.<module>`, never `@import` a missing path.
set -e
cd "$(dirname "$0")"
zig test gate.zig
for f in missing_import.zig missing_import_unused_fn.zig; do
  if out=$(zig test "$f" 2>&1); then echo "changed: $f compiles now"; exit 1; fi
  case "$out" in
    *"unable to load"*"FileNotFound"*) echo "ok: $f rejected (missing import is eager)" ;;
    *) echo "unexpected error in $f: $out"; exit 1 ;;
  esac
done
