#!/usr/bin/env bash
# Negative controls for the test gate (security known issue RT-2).
#
# Proves that `scripts/runner.node.mjs` reports a failing test as FAIL (and a passing one as PASS)
# for both CommonJS and ESM entry files. Before the RT-2 fix, zun exited 0 with no output when a
# CommonJS entry threw, so every CJS gate test could pass falsely. Run this after any change to the
# launcher (src/main.zig, src/rt/*, src/bun.js.zig) and before trusting gate results.
#
# Fixtures live in test/zun/negative-control/*.fixture.* so that a normal runner invocation never
# picks them up (the runner only treats `*.test.*` files and files under js/node/test/parallel/ as
# tests). Each one is staged under test/js/node/test/parallel/ under a unique name for the duration
# of its run, and removed again on exit.
#
# Usage: scripts/zun-negative-controls.sh [path/to/zun-debug]
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
zun=${1:-$repo/build/debug/zun-debug}
fixtures=$repo/test/zun/negative-control
stage_dir=$repo/test/js/node/test/parallel
staged=()
cleanup() { for f in "${staged[@]}"; do rm -f -- "$f"; done; }
trap cleanup EXIT

[ -x "$zun" ] || { echo "zun binary not found: $zun" >&2; exit 2; }

failures=0
for fixture in "$fixtures"/*.fixture.*; do
  name=$(basename "$fixture")
  case "$name" in
    *.fail.fixture.*) expect=fail ;;
    *.pass.fixture.*) expect=pass ;;
    *) echo "unknown fixture kind: $name" >&2; exit 2 ;;
  esac
  ext=${name##*.}
  stem=${name%%.*}
  target=$stage_dir/test-zun-negctl-$stem-$$.$ext
  cp -- "$fixture" "$target"
  staged+=("$target")

  # 1. Direct: exit code and stderr of the binary itself.
  set +e
  err=$(cd "$repo" && BUN_DEBUG_QUIET_LOGS=1 "$zun" "$target" 2>&1 >/dev/null)
  direct_rc=$?
  # 2. Through the real test runner.
  out=$(cd "$repo" && node scripts/runner.node.mjs --quiet --exec-path "$zun" \
    "js/node/test/parallel/$(basename "$target")" 2>&1)
  runner_rc=$?
  set -e

  ok=1
  if [ "$expect" = fail ]; then
    [ "$direct_rc" -ne 0 ] || { echo "  direct: exit 0, expected non-zero"; ok=0; }
    # The error must be printed, not swallowed (debug builds also print resolver
    # "DEBUG:" lines, so look for an error line specifically).
    grep -qE '(AssertionError|^error:|Error:)' <<<"$err" || { echo "  direct: no error printed on stderr"; ok=0; }
    [ "$runner_rc" -ne 0 ] || { echo "  runner: exit 0, expected the runner to report FAIL"; ok=0; }
  else
    [ "$direct_rc" -eq 0 ] || { echo "  direct: exit $direct_rc, expected 0"; echo "$err" | sed 's/^/    /'; ok=0; }
    [ "$runner_rc" -eq 0 ] || { echo "  runner: exit $runner_rc, expected PASS"; echo "$out" | sed 's/^/    /' | tail -20; ok=0; }
  fi

  if [ "$ok" = 1 ]; then
    echo "ok   $name (expected $expect; direct exit $direct_rc, runner exit $runner_rc)"
  else
    echo "FAIL $name (expected $expect; direct exit $direct_rc, runner exit $runner_rc)"
    failures=$((failures + 1))
  fi
done

if [ "$failures" -ne 0 ]; then
  echo "$failures negative-control check(s) failed: gate results cannot be trusted." >&2
  exit 1
fi
echo "all negative controls behave as expected"
