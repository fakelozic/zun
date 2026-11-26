#!/bin/sh
# zun probe: CLI-restore gating rules on zig 0.17.1 (see docs/zig/lessons.md, 2026-11-26 "gating a missing command").
set -e
cd "$(dirname "$0")"
Z=${ZIG:-zig}
$Z run ok.zig 2>&1 | grep -q gated && echo "ok.zig: gated (PASS)"
if $Z build-exe bad.zig 2>&1 | grep -q "use of undeclared identifier 'bootBunShell'"; then
  echo "bad.zig: undeclared identifier rejected even in a comptime-false branch (PASS)"
else
  echo "bad.zig: unexpected result (FAIL)"; exit 1
fi
