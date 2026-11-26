# SC-4: two compiler acquisition paths bypassed sha256 verification

- **Status:** fixed (this commit)
- **Severity:** medium, security-relevant (supply chain: a swapped compiler compromises every object it builds)
- **Found by / date:** security review `docs/security/review-2026-11-26-sol.md` (SC-4), confirmed 2026-11-26

## Symptom
1. `docs/build.md` LLVM setup ran `… | sha256sum -c` and `tar -xJf …` as separate lines. Pasted into an ordinary
   (non `set -e`) shell, a mismatching archive prints `FAILED` and is extracted and used anyway.
2. Without `BUN_ZIG_PATH`, `emitZig` emitted a `zig_fetch` edge. `fetchZig()` returned "up to date" whenever
   `vendor/zig/.zig-commit` matched the commit string, with no check of the tree or archive. An existing (pre-pinning
   or planted) `vendor/zig` was used as the compiler. A fresh download did fail closed (unpinned URL).

## Root cause
1. The verify step was added in `eaca93d` as one more line in front of an existing `tar` line, not chained to it.
   The adjacent Perl block already used `&&`.
2. `eaca93d` made `downloadWithRetry` require a pin but left the inherited `fetchZig` cache short-circuit
   (from Bun's build system, where the compiler is the oven-sh fork) untouched; the stamp is a version marker, not an
   integrity check. zun never uses this path (it builds with vanilla Zig via `BUN_ZIG_PATH`), so it stayed unexamined.

## Why it wasn't caught
The supply-chain checks were exercised only through `clone-picohttpparser` (the dep fetch rule). There was no test of
the Zig edge without `BUN_ZIG_PATH`, and the doc block is not executed by anything.

## Fix
1. The LLVM block is one `&&` chain (`mkdir && curl -f && sha256sum -c && tar && rm`): extraction only runs after a
   successful check. `sha256sum -c` is the last command of its pipeline, so its status is the pipeline's status.
2. The auto-Zig path is removed, not patched: `emitZig` asserts `BUN_ZIG_PATH` is set (hint points at
   `docs/build.md`), and `fetchZig`, the `zig_fetch` rule and the `fetch-cli.ts zig` kind are deleted. There is no
   compiler download left to verify, on either the cached or the fresh path. The documented build already sets
   `BUN_ZIG_PATH`, so it is unaffected.

## Regression test
Script tests (scratch, not in-tree): `emitZig` with `BUN_ZIG_PATH` unset throws `BUN_ZIG_PATH is not set`; with a
valid layout it emits the `zig-compiler` phony; with a missing dir it throws `no zig executable`. The LLVM chain was run
against a local `.tar.xz` with the right hash (extracts) and a wrong one (exit 1, nothing extracted).

## Sibling search
`grep -n "sha256sum -c" docs/ scripts/`: only the LLVM and Perl blocks; Perl was already chained.
`zigDownloadUrl` is still used by the legacy `scripts/prefetch-deps.ts` (SC-3, listed in `supply-chain.md` as legacy).
`musl.Containerfile` downloads Zig directly (SC-5, listed as unsupported for production).

## Lessons
A verification step is only real if what follows is conditional on it. Doc snippets that verify must be one `&&` chain.
