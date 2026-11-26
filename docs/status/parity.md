# Parity dashboard

How much of **Bun 1.3.14's own test suite** (`test/`, as kept by cruller) passes on zun.
Harness: `scripts/parity.ts`. Machine-readable copy of this run: `docs/status/parity.json`
(one line per test, so later runs can be diffed with `--compare`).

| | |
|---|---|
| Date | 2026-11-26 (run started 14:17 UTC, 24 min wall, 6 jobs, 60 s per-test timeout) |
| Binary | `build/debug/bun-debug` (ASAN debug), snapshot copied before Phase 3's rename |
| Revision | `1.3.14-debug+4444d0855` |
| Target | Bun **1.3.14** test suite (locked) |
| Runner semantics | same as `scripts/runner.node.mjs` node-test branch: `<bin> run --config=bunfig.node-test.toml <abs path>`, same env, LSan + exception-check validation on, exit status decides |

> [!WARNING]
> **The CJS pass numbers are not trustworthy yet.** With this launcher, a synchronous top-level throw in an
> entry file that uses `require()` **exits 0 and prints nothing** (verified: `assert.strictEqual(1, 2)` and
> `throw new Error()` after a `require` both exit 0; ESM, plain throws without `require`, throws in callbacks,
> unhandled rejections and `process.exitCode` all behave). 2,190 of the 2,287 runnable tests are CJS. The
> harness runs negative controls before every run and reports CJS passes as **UNRELIABLE** until the controls fail
> as they should. **Failures, timeouts and crashes are real** (the bug only hides failures). Re-run with the
> one-liner in [Reproduce](#reproduce) after the launcher fix or the CLI restore (Phase 4 item 3).

## Totals

| Test files | Runnable (node-style) | Pass (verified) | Exited 0, unreliable (CJS) | Fail | Timeout | Crash | Blocked |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 4,066 | 2,287 | **23** (all ESM) | 1,998 (87.4%) | 120 | 26 | 120 | 1,779 |

- **Upper bound** for node-style tests: 2,021 / 2,287 (88.4%) exited 0. The real pass rate is somewhere below that.
- **Hard floor:** 266 node-style tests (11.6%) fail, time out or crash, whatever happens with the launcher bug.
- 30 of the exit-0 runs printed a sanitizer or panic report and still exited 0. Bun's runner counts them as passes, and so do we
  (17 are a child process's `panic: Failed to load runtime entrypoint`, 12 are the Worker ASAN `CHECK failed` below, 1 ASAN).
- 0 tests skipped through `test/expectations.txt`.

Controls (run with the same spawn path as the tests):

| Control | Kind | Must | Exit | OK |
|---|---|---|---:|---|
| `assert.strictEqual(1,2)` after `require('assert')` | CJS | fail | 0 | ❌ |
| `throw new Error()` after `require('path')` | CJS | fail | 0 | ❌ |
| `assert.strictEqual(1,2)` after `import` | ESM | fail | 1 | ✅ |
| passing CJS / passing ESM | both | pass | 0 / 0 | ✅ |

By module kind: CJS ran 2,190 (0 verified, 1,998 unreliable, 118 fail, 26 timeout, 48 crash);
ESM ran 97 (23 pass, 2 fail, 72 crash, all 72 of them the `bun:test` import below).

## Blocked (1,779 files)

Everything outside the node-style suites runs through `bun test`, so **all of it waits for the test runner**
(Phase 4 item 4). 1,548 of these 1,741 files import `bun:test` or `harness` directly, and 38 node-style tests need `bun test`
too (they use `node:test`). The second column says what *else* the file needs once the runner is back. This is a
static, heuristic scan (`blockerRules` in `scripts/parity.ts`) of the file's path and source, so counts are approximate.

| Needs (besides the test runner) | Files |
|---|---:|
| nothing else | **949** |
| `install` (package manager; incl. `js/third_party`, `integration`) | 265 |
| `cli` (spawns `zun` with subcommands/flags: run, hot, watch, init, `-e`, …) | 222 |
| `bundler` (`Bun.build`, `itBundled`, `--compile`, macros) | 158 |
| `shell` (`Bun.$`) | 91 |
| `napi` | 71 |
| `bun:internal-for-testing` (gutted to 2 lines) | 55 |
| `sql` | 33 |
| `transpiler` (`Bun.Transpiler`) | 31 |
| `bake` | 24 |
| `css` | 22 |
| `md` (`Bun.markdown`) | 8 |

(A file can need several modules; the full breakdown by combination is in `summary.md` of each run.)

Blocked files by area: `js/bun` 409, `regression` 385, `js/node` 268, `cli` 150, `js/web` 144, `js/third_party` 120,
`bundler` 89, `napi` 60, `bake` 24, `js/sql` 23, `integration` 20, `js/deno` 16, `js/valkey` 14, other 13.

## Per area (node-style suites)

Area = Node module from the file name (`test-<module>-…`); `other` = names that don't map to one module.
"Exited 0" is PASS + UNRELIABLE, i.e. an upper bound.

| Area | Files | Pass (verified) | Exited 0 (unreliable) | Fail | Timeout | Crash | Blocked | Exited 0 of ran |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| node/fs | 217 | 5 | 187 | 18 | 2 | 1 | 4 | 90% |
| node/http | 216 | 0 | 196 | 3 | 16 | 1 | 0 | 91% |
| node/stream | 196 | 2 | 191 | 2 | 0 | 1 | 0 | 98% |
| node/other | 188 | 2 | 143 | 27 | 1 | 4 | 11 | 82% |
| node/http2 | 167 | 0 | 161 | 3 | 3 | 0 | 0 | 96% |
| node/net | 118 | 0 | 108 | 7 | 0 | 1 | 2 | 93% |
| node/crypto | 108 | 0 | 106 | 0 | 0 | 2 | 0 | 98% |
| node/child_process | 91 | 1 | 60 | 10 | 0 | 19 | 1 | 68% |
| node/tls | 87 | 0 | 85 | 1 | 0 | 1 | 0 | 98% |
| node/vm | 75 | 9 | 63 | 3 | 0 | 0 | 0 | 96% |
| **bun/test/parallel (http)** | 69 | 1 | 0 | 0 | 0 | 68 | 0 | 1% |
| node/dgram | 68 | 0 | 66 | 1 | 0 | 0 | 1 | 99% |
| node/buffer | 64 | 0 | 63 | 0 | 0 | 0 | 1 | 100% |
| node/process | 59 | 0 | 50 | 3 | 0 | 5 | 1 | 86% |
| node/timers | 58 | 0 | 56 | 2 | 0 | 0 | 0 | 97% |
| **node/worker_threads** | 57 | 0 | 28 | 19 | 0 | 10 | 0 | 49% |
| node/zlib | 57 | 0 | 53 | 4 | 0 | 0 | 0 | 93% |
| node/cluster | 54 | 0 | 47 | 5 | 1 | 1 | 0 | 87% |
| node/module | 46 | 0 | 44 | 0 | 0 | 0 | 2 | 100% |
| node/events | 39 | 0 | 38 | 0 | 0 | 0 | 1 | 100% |
| node/url | 38 | 0 | 35 | 1 | 0 | 0 | 2 | 97% |
| node/web | 28 | 1 | 22 | 2 | 0 | 0 | 3 | 92% |
| node/util | 24 | 1 | 21 | 2 | 0 | 0 | 0 | 92% |
| node/dns | 23 | 0 | 21 | 2 | 0 | 0 | 0 | 91% |
| node/https | 22 | 0 | 19 | 1 | 2 | 0 | 0 | 86% |
| node/readline | 19 | 1 | 18 | 0 | 0 | 0 | 0 | 100% |
| node/async_hooks | 18 | 0 | 17 | 0 | 0 | 1 | 0 | 94% |
| node/diagnostics_channel | 17 | 0 | 16 | 1 | 0 | 0 | 0 | 94% |
| node/path | 16 | 0 | 16 | 0 | 0 | 0 | 0 | 100% |
| node/assert | 15 | 0 | 6 | 0 | 0 | 0 | 9 | 100% |
| node/console | 14 | 0 | 14 | 0 | 0 | 0 | 0 | 100% |
| node/sea | 9 | 0 | 9 | 0 | 0 | 0 | 0 | 100% |
| node/repl | 5 | 0 | 3 | 2 | 0 | 0 | 0 | 60% |
| node/os, v8, globals | 15 | 0 | 13 | 1 | 1 | 0 | 0 | 87% |
| bun/test/parallel (docker) | 4 | 0 | 0 | 0 | 0 | 4 | 0 | 0% |
| 8 small areas (domain, inspector, querystring, internals, string_decoder, tty, perf_hooks, punycode) | 24 | 0 | 23 | 0 | 0 | 1 | 0 | 96% |

## Failure clusters (266 failing node-style runs)

Each failure gets one cause from `causeOf()` in the harness (patterns written after reading failures by hand).
"likely" means the test source matches the pattern, but the failing output doesn't prove it.

| # | Tests | Cause | Diagnosis | Fixed by |
|---|---:|---|---|---|
| 1 | **121** | **Launcher** (6 sub-clusters, below) | `src/main.zig` is cruller's minimal launcher: it takes `argv[1]` (or the arg after `run`) as the entry file, ignores every flag, drops the script's own arguments and runs the entry as an eval script | CLI restore (Phase 4 item 3, `R2`), or a small launcher fix first |
| 1a | 40 | entry runs as `[eval]` | `__filename` is `<dir>/[eval]`, so `fs.open(__filename)`, `new Worker(__filename)` and `fork(__filename)` hit ENOENT / `ModuleNotFound resolving "…/[eval]"` | ″ |
| 1b | 38 | flags / `-e` / `-p` not parsed | children spawned as `execPath -e …`, `--expose-gc file`, `--inspect …` → `panic: Failed to load runtime entrypoint: FileNotFound` (exit 132) | ″ |
| 1c | 14 | `globalThis.gc` missing | `process.argv` is `[execPath]` only, so Bun's `test/js/node/test/common/index.js:121` (`process.argv.length === 2`) never installs its `--expose-gc` shim | ″ |
| 1d | 12 | test re-spawns itself (`argv[2] === 'child'`) | script args are dropped, so the child runs the parent branch again | ″ |
| 1e | 11 | `// Flags:` not applied | the same `common/index.js` block is what re-spawns tests with their `// Flags:` (`--unhandled-rejections=…`, `--no-warnings`, …); without `argv[1]` it is skipped. 8 of the 11 are `test-promise(s)-unhandled-*` tests | ″ |
| 1f | 6 | spawns `execPath` with node flags | same as 1b, but the child's output isn't visible in the parent's | ″ |
| 2 | **72** | **`bun:test` import** | every `test/js/bun/test/parallel/*.ts` imports `harness`, which imports `bun:test`; with the test runner cut, the import dies with UBSan `member call on null pointer of type 'JSC::JSCell'` (`JSCJSValueCell.h:117`) | test runner (Phase 4 item 4) |
| 3 | **26** | **timeouts** (21 in http/https/http2 client tests) | **cruller's `fetch` does not stream.** A response only resolves once the body is complete: `fetch()` of a `Bun.serve` stream that sends one chunk and stays open returns nothing until the server's 10 s idle timeout, then fails with `FetchHostFailure`; a `node:http` client never sees `data` for a partial response (Node prints it at once). `fetch` goes through `src/rt` (`FetchTasklet` → `vm_bridge` → `direct_host`/`host_http`) instead of upstream's `HTTPThread`. So `res.destroy()`, client timeouts, `finished()` and aborts on in-flight responses all hang | remove `src/rt` from the fetch path (`docs/status/baseline.md`, "What removal would take", item 2) |
| 4 | **11** (+12 exit-0, flaky) | **Worker ASAN** | Worker-thread tests: ASAN catches a bad `memcpy` in libpas (`pas_segregated_size_directory_local_allocator_size_for_config`), then its own report crashes (`CHECK failed: asan_thread.cpp:369 … kCurrentStackFrameMagic`). Same with `detect_stack_use_after_return=0`. Timing-dependent: Worker tests flip between runs (and 12 tests printed the report but still exited 0) | **open**, needs investigation (cruller C++ change? JSC/ASAN interplay on Worker stacks?) |
| 5 | 33 | behaviour differs | zlib `kMaxLength` `RangeError` not thrown (3 tests), dns/net results (`test-dns`, `test-dns-resolveany`, `test-net-dns-lookup`, IPv6 link-local; possibly sandbox networking), child_process exit codes / `stdout` flush (6), `cluster` `modulePath` undefined (2, probably launcher), stdio redirected to a file (3), `fs` errors (4), `vm`/`os` getter errors in a child (2, child uses `-e`) | case by case; re-check after the launcher fix |
| 6 | 2 | JSC exception-check validation | `test-next-tick` (`this` in a `nextTick` callback is `globalThis`: the entry is not run as a strict-mode CJS module, see 1a), `test-fs-mkdir-rmdir` | launcher + case by case |
| 7 | 1 | `DEBUG: Resolving …` on stderr | cruller un-gated a debug print: `src/resolver/resolver.zig:658` prints on every resolve in debug builds. Upstream 1.3.14 prints it only with a resolve breakpoint flag (`if (Environment.show_crash_trace and bun.cli.debug_flags.hasResolveBreakpoint(import_path))`). It shows up in every child's stderr, so any test that checks child stderr fails on debug builds | one-line fix: put the print back under the breakpoint condition |

Per-test signatures, outputs and causes are in `results.json` of the run (scratch, not committed).

## What to restore first (by tests unblocked)

1. **Fix the launcher before trusting any number** (can come before the full CLI restore): run the entry as a real
   CJS/ESM module with its real path, make CJS top-level throws fail the process, pass script args through to
   `process.argv`, and parse at least `-e`/`-p`/`--expose-gc`/`--no-warnings`/`--unhandled-rejections`. This turns the
   1,998 unreliable passes into real numbers and should fix most of cluster 1 (~121 failures). The full **CLI restore**
   (R2) does all of this and also covers the 222 bun:test files that spawn `zun` with subcommands.
2. **Test runner (R3):** unblocks **949 files outright** and is a prerequisite for all 1,779 blocked files. It also fixes the 72
   `bun/test/parallel` crashes. This is still the biggest single lever, as the roadmap says.
3. **Put `fetch` back on upstream's `HTTPThread` path** (drop the `src/rt` host bridge): fixes ~21 http-client timeouts
   and is very likely behind more of the 949 test-runner-only files (`js/web/fetch` 57, `js/bun/http` 46, `js/node/http` 24).
4. **Then, by blocked-file count:** `install` (265, mostly `js/third_party` + `cli/install`) → `bundler` (158) → `shell` (91; but 70+
   files only use `Bun.$` for setup, so it unblocks cheaply) → `napi` (71) → `internal-for-testing` blocks (55, restore with each module).
5. Cheap fixes: the `DEBUG: Resolving` print (cluster 7); investigate the Worker ASAN report (cluster 4).

## Reproduce

All commands run from the repo root. `bun` here is only the script runner (`node scripts/parity.ts` works too).
`llvm-symbolizer` must be on `PATH`, or the LSan suppressions don't match and leak checks fail (`docs/build.md`).

```sh
export PATH=$PWD/vendor/llvm-21.1.8/bin:$PATH

# Full run (≈25 min on 12 cores; writes build/parity/<date>/{summary.md,parity.json,results.json})
bun scripts/parity.ts --exec-path build/debug/zun-debug --jobs 6

# Re-run after the launcher fix / CLI restore, diffed against this dashboard (one line)
bun scripts/parity.ts --exec-path build/debug/zun-debug --jobs 6 --compare docs/status/parity.json

# Quick look: stratified ~100-test sample (≈2 min), or one area
bun scripts/parity.ts --exec-path build/debug/zun-debug --sample 100
bun scripts/parity.ts --exec-path build/debug/zun-debug --filter 'js/node/test/parallel/test-http-*'

# Classify only (no binary run except the controls): blocked / runnable counts
bun scripts/parity.ts --list

# Recompute causes/clusters from a stored run without re-running tests
bun scripts/parity.ts --reclassify build/parity/<date>/results.json --exec-path <same binary> --out /tmp/x
```

To update this dashboard: run the full command, copy `build/parity/<date>/parity.json` to `docs/status/parity.json`, and
update the tables above from that run's `summary.md`.

The numbers above came from: `parity.ts --jobs 6 --exec-path <snapshot of build/debug/bun-debug>`, then `--reclassify`
with the final harness (the classification rules changed during the run; the raw outcomes did not).

## Harness notes and caveats

- **Differences from `runner.node.mjs`, on purpose:** `HOME`/`XDG_*`/`BUN_INSTALL` point to a throwaway dir and a `bun`
  shim pointing at the tested binary is first on `PATH`, so tests can never reach the owner's real Bun or `~/.bun`.
  Each pool slot gets its own `TEST_THREAD_ID`, because node's `test/common/tmpdir.js` uses `test/js/node/test/.tmp.<id>`.
  The first run here had all 6 jobs sharing `.tmp.0`, which broke about 10 `fs` tests at random. A timeout kills the
  whole process group.
- **Run-to-run noise:** comparing the two full runs, the `fs` tests that flipped were the shared-tmpdir bug (fixed); the
  Worker ASAN crash (cluster 4) still flips with timing. Treat ±5 tests between runs as noise until that is fixed.
- The ASAN debug build is slow (≈1 s per test at 6 jobs). A release build would allow a shorter timeout, but leak and
  exception-check validation only run on ASAN builds.
- Module kind (CJS/ESM): `.mjs`/`.cjs` by extension, otherwise the nearest `package.json` `type`, otherwise ESM syntax.
  `test/js/bun/test/package.json` says `"type": "module"`.
