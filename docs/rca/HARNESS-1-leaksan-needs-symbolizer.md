# HARNESS-1: gate results depended on whether the caller's PATH had llvm-symbolizer

- **Status:** fixed (`scripts/runner.node.mjs`, this commit)
- **Severity:** Medium (test-harness integrity: false failures, and agents blaming code changes for them)
- **Found by / date:** integration owner, 2026-11-27, while gating `prep/supply-chain`

## Symptom
`test-bzrt-runtime-smoke.js`, `test-zun-identity.js`, `test-zun-tls-blocked-spki.mjs` and `test-zun-fetch-tls-options.mjs`
failed with `SIGABRT` / exit 134 and a LeakSanitizer report ("11492 byte(s) leaked in 154 allocation(s)") whose frames were
unsymbolized (`zun-debug+0x…`). The *same* binary (`build/snap-0a5b26b`) had passed the same gate a few hours earlier.
Running the binary by hand, even with the runner's exact environment and arguments, never reproduced it.
The H5 agent hit the same thing and worked around it with `ASAN_OPTIONS=detect_leaks=0` for its own runs.

## Root cause
When leak validation is on (`!isCI`, test not in `test/no-validate-leaksan.txt`), the runner sets
`LSAN_OPTIONS=…:suppressions=test/leaksan.supp`. Entries there are **function names** (`leak:uws_create_app`, …), and
LeakSanitizer can only match them after symbolizing the stack, which needs `llvm-symbolizer`. The runner never said where
that was, so ASAN looked on `PATH`. The earlier gate runs were in the same shell as the build, whose `PATH` started with
`vendor/llvm-21.1.8/bin`; this run was in a fresh shell without it. No symbolizer → no names → no suppression matches → the
known, suppressed leaks (e.g. the `uWS::TemplatedApp` from `Bun.serve` → `uws_create_app`) are reported → `abort_on_error=1`.
My manual repros happened to have the symbolizer reachable (`ASAN_SYMBOLIZER_PATH` set), which is why they passed.
Inherited from upstream's runner (Bun CI images always have llvm-symbolizer on PATH); not a zun code change.

## Why our tests didn't catch it
The negative controls check that failures are reported, not that passing tests are independent of the caller's
environment.

## Fix
`asanSymbolizer()` in the runner resolves the symbolizer (`ASAN_SYMBOLIZER_PATH`, else the pinned `vendor/llvm-21.1.8`,
else `PATH`) and passes it explicitly as `ASAN_SYMBOLIZER_PATH` whenever leak validation is on. If none exists it throws
with a clear message, so the suppression list can never silently stop working.

Verified: gate 13/13 with `PATH=<node>:/usr/bin:/bin` (no LLVM on PATH); with the vendor symbolizer moved away and none on
PATH, the runner stops with the error instead of reporting leaks.

## Sibling search
- `scripts/zun-negative-controls.sh` runs through the runner, so it is covered.
- `test/leaksan.supp` is unchanged since `a1c009d`, and uses zun's module paths (`runtime.server.server…`), so its names match
  zun's symbols. Entries for modules zun renamed may be stale; re-check when a suppressed leak shows up symbolized.
- Agents' briefs: snapshot runs outside the runner don't enable leak checks, so their results were unaffected.
