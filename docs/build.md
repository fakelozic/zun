# Building zun

What actually worked on the dev machine on 2026-11-26. Since Phase 2 the tree builds with **Zig 0.17.1**
(the global `zig`), and no longer with 0.16. Results: `docs/status/zig-017.md` (0.17) and
`docs/status/baseline.md` (the 0.16 baseline, kept for history).

## TL;DR

```sh
# one-time toolchain setup (all project-local, no sudo, nothing global changed)
# Zig 0.17.1 is the machine's global default (mise); nothing to install for Zig.
mkdir -p vendor/llvm-dl vendor/llvm-21.1.8
curl -L -o vendor/llvm-dl/LLVM-21.1.8-Linux-X64.tar.xz \
  https://github.com/llvm/llvm-project/releases/download/llvmorg-21.1.8/LLVM-21.1.8-Linux-X64.tar.xz
tar -xJf vendor/llvm-dl/LLVM-21.1.8-Linux-X64.tar.xz -C vendor/llvm-21.1.8 --strip-components=1
rm vendor/llvm-dl/LLVM-21.1.8-Linux-X64.tar.xz
mkdir -p vendor/perl5-dl && cd vendor/perl5-dl && \
  curl -LO https://cpan.metacpan.org/authors/id/P/PJ/PJACKLAM/bignum-0.67.tar.gz && \
  echo "1c9a824ab323e3e58d9808011c10ad27589dba1202806278215012ca7f522875  bignum-0.67.tar.gz" | sha256sum -c && \
  tar xzf bignum-0.67.tar.gz && mkdir -p ../perl5 && cp -r bignum-0.67/lib/* ../perl5/ && cd ../..

# every build
export PATH=$PWD/vendor/llvm-21.1.8/bin:$PATH        # clang/lld/llvm-ar 21.1.8 (+ llvm-symbolizer for ASAN)
export BUN_ZIG_PATH=$(mise where zig@0.17.1)          # vanilla Zig 0.17.1 instead of oven-sh/zig
export PERL5LIB=$PWD/vendor/perl5                     # `use bigint` for src/codegen/create_hash_table
export BUN_INSTALL_CACHE_DIR=$PWD/build/cache/bun-install   # keep `bun install` out of ~/.bun
bun scripts/build.ts --profile=debug --cache-dir=build/cache
# → build/debug/zun-debug   (same as `bun run build:debug`, plus the --cache-dir override)
```

`vendor/` and `build/` are gitignored. Always pass `--cache-dir=build/cache`: without it the
build cache defaults to `~/.zun/build-cache` (`$ZUN_INSTALL/build-cache`; `scripts/build/config.ts`,
`cacheDir`). Before Phase 3 it defaulted to `~/.bun/build-cache`, the real Bun's directory.

## Toolchain

| Tool | Version used | Where from | Why |
|------|--------------|------------|-----|
| Zig | **0.17.1** (0.16.0 until Phase 2) | global mise install, passed via `BUN_ZIG_PATH` | zun targets vanilla 0.17. Without `BUN_ZIG_PATH` the build downloads Oven's patched Zig (`ZIG_COMMIT` in `scripts/build/zig.ts`), which is wrong for this tree. Zig 0.17.1 bundles LLVM 22; the Zig object links fine with lld 21 (non-LTO) |
| LLVM / clang / lld | **21.1.8** | official LLVM release tarball in `vendor/llvm-21.1.8` (11 GB unpacked, 2 GB download) | `scripts/build/tools.ts` requires clang `>=21.1.0 <21.1.99`. Fedora 45 ships clang 23; its `clang21`/`lld21`/`llvm21` packages would work too but need sudo |
| Perl `bigint` pragma | bignum 0.67 (pure Perl) | CPAN tarball in `vendor/perl5` | `src/codegen/create_hash_table` does `use bigint`. Fedora package `perl-bigint` (sudo) is the alternative. Math::BigInt 2.005 itself is already installed |
| bun | 1.4.5 (`~/.bun/bin/bun`, the owner's install, used read-only) | existing | runs `scripts/build.ts` and ~20 codegen scripts, `bun install` for codegen deps |
| cargo / rustc | 1.100.0 stable (mise) | existing | builds `lol-html`. Debug is fine on stable; `problem.md` says release needs `RUSTUP_TOOLCHAIN=nightly` (`-Zbuild-std`), not tried yet |
| cmake 4.3.0, ninja 1.13.2, ccache 4.13.6, git, curl, unzip, xz | system | existing | |
| node 26 | mise | existing | only for `scripts/runner.node.mjs` (tests) |

## What the build does (the pipeline)

`scripts/build.ts` **configures** (≈0.2 s: finds tools, resolves the `debug` profile, writes
`build/debug/build.ninja`), then runs **ninja**. 1,225 edges for a debug build:

1. **Fetch deps** into `vendor/<name>` (GitHub archives at pinned commits, patches applied):
   boringssl, brotli, c-ares, zlib-ng, zstd, libdeflate, libarchive, mimalloc, sqlite, tinycc,
   highway, lsquic/lsqpack/lshpack, picohttpparser, libjpeg-turbo/libspng/libwebp, hdrhistogram, lol-html.
2. **Prebuilt downloads** into the cache: WebKit/JSC (`webkit-<hash>-debug-asan`, 1.9 GB) and Node headers.
3. **Codegen** (`bun` running `src/codegen/*.ts` and the Perl hash-table generator): `.classes.ts` →
   C++/Zig bindings, bundled JS builtins (`src/js/**`), `*.lut.h` lookup tables, `cpp.zig`, `ErrorCode.zig`, …
   into `build/debug/codegen/`. Runs `bun install` first for its npm deps (esbuild, peechy, …).
4. **Zig**: one `zig build obj` (root `build.zig`, root module `src/main.zig`) → `build/debug/bun-zig.o`.
5. **C/C++**: deps and `src/jsc/bindings/**` compiled with clang 21 (ASAN on in `debug`), via ccache.
6. **cargo** builds lol-html.
7. **Link** with lld → `build/debug/zun-debug`, then a smoke edge runs `zun-debug --revision`
   (prints e.g. `zun 0.1.0-debug+71ad28751 (bun-compat 1.3.14)`). Release builds produce `zun-profile` and a
   stripped `zun`; the ninja phony target is `zun` (was `bun`). Internal artifacts keep Bun's names (`bun-zig.o`, `libbun-*.a`).

## Zig 0.17 notes

- `zig build` in 0.17 has no `--global-cache-dir` or `--zig-lib-dir`. `scripts/build/zig.ts` relies on
  `ZIG_GLOBAL_CACHE_DIR` (set by the ninja rule) and the stdlib next to the compiler.
- `-Doptimize` uses 0.17's names (`debug`, `safe`, `fast`, `small`); the old `Debug`/`ReleaseFast` still parse.
- `build.zig` still uses `b.addTranslateC` (deprecated in 0.17, not removed). The `translate_c` package is an open item.
- **Configure cache ignores `--build-file`.** `zig build --build-file build016.zig check` with the same
  `--cache-dir` as `build.zig` reuses `build.zig`'s configuration (wrong steps). Give each build file its own
  `--cache-dir`. Probe: `docs/zig/probes/build-file-cache/run.sh`.
- Codemod for code restored from 1.3.14: `docs/zig/migration-to-0.17.md`.
- Fast iteration on Zig errors: run the `zig build obj …` command from `build/debug/build.ninja` (the `args`
  line of the `bun-zig.o` edge) by hand with a fixed `-Dsha`, so commits don't force a full re-analysis, and add
  `--error-style minimal -freference-trace=4`.

## Measurements (12 cores, 15 GB RAM, NVMe)

| What | Result |
|------|--------|
| Cold debug build (empty ccache and zig cache, deps not yet fetched) | **3 min 04 s** wall (1,211 s user) |
| …of which `zig build obj` → `bun-zig.o` | 169 s (the critical path) |
| …WebKit prebuilt download + extract | 67 s (in parallel) |
| Rebuild after only a new git commit | 70 s (see the `-Dsha` gotcha below) |
| **Zig 0.17.1:** `zig build obj` after a new `-Dsha` (full re-analysis) | 67 s wall, 4.5 GB peak RSS |
| **Zig 0.17.1:** full debug build in a fresh build dir (deps fetched, ccache warm) | 2 min 06 s |
| `build/debug/zun-debug` (was `bun-debug` before Phase 3) | 737 MB (debug info + ASAN, not stripped) |
| `build/` total | 5.8 GB (`build/debug` 2.5 GB, `build/cache` 3.2 GB: WebKit 1.9 GB, ccache 1.3 GB) |
| `vendor/` | 11.4 GB (LLVM 11 GB, fetched dep sources 366 MB) |
| `node_modules/` | 117 MB |

## Gotchas

- **cruller HEAD did not build on 0.16.** Its last two commits ("zig 17", `1874356`, `f7002b1`)
  had started moving `build.zig` and `src/unicode/uucode_lib/build.zig` to 0.17 APIs
  (`.fast`, `.debug`, `b.root.joinString`, `dupeSentinel`). `bootstrap` reverts them (`ee9f2f3`); Phase 2 redoes the port.
- **`~/.bun` was the default for two caches.** The build cache (now `~/.zun/build-cache`; `--cache-dir` still overrides) and
  `bun install`'s package cache (`BUN_INSTALL_CACHE_DIR` fixes it). The very first (failed) run
  here was started without `BUN_INSTALL_CACHE_DIR`, so `bun install` may have added packages to
  `~/.bun/install/cache` once. Harmless, but use the env var from now on.
- **`scripts/build/tools.ts` looks for bun in `~/.bun/bin` first.** Read-only use, fine.
- **Every commit forces a Zig rebuild.** The git SHA is passed as `-Dsha` to `zig build obj`, so a new
  HEAD changes the build options module and recompiles `bun-zig.o` (~60 s). With several agents
  committing to the same branch, expect this on most builds.
- **LSan needs a symbolizer.** The `debug` profile has ASAN on, and `scripts/runner.node.mjs` enables
  leak checking with `test/leaksan.supp`. Those suppressions match *function names*, so without
  `llvm-symbolizer` on PATH (Fedora's clang 23 doesn't put one there) known JSC/uWS leaks aren't
  suppressed and tests abort with SIGABRT. Having `vendor/llvm-21.1.8/bin` on PATH (or
  `ASAN_SYMBOLIZER_PATH=$PWD/vendor/llvm-21.1.8/bin/llvm-symbolizer`) fixes it.
- **Debug binary prints `[sys]`/`[fs]` logs.** Set `BUN_DEBUG_QUIET_LOGS=1` when running it by hand.
- `zig build --build-file build016.zig check` (from `problem.md`) shells out to
  `bun scripts/build.ts --build-dir=build --target=codegen`. Until Phase 2 that ran **without** `--cache-dir`
  (so it would have used `~/.bun/build-cache`); it now passes `--cache-dir=build/cache`. Not run yet.

## Running tests

```sh
export PATH=$PWD/vendor/llvm-21.1.8/bin:$PATH   # for llvm-symbolizer (LSan suppressions)
node scripts/runner.node.mjs --quiet --exec-path $PWD/build/debug/zun-debug \
  js/node/test/parallel/test-bzrt-runtime-smoke.js
```

`--exec-path` defaults to `zun` on `PATH` (it was `bun`, which would have run the owner's real Bun).
Old `build/debug/bun-debug` binaries from before Phase 3 are stale; delete them if you like.

A passing test prints only its name and `End`; a failing one prints the output and a red status
(`SIGABRT`, `fail`, …). The runner exits 1 on failure and 0 on success.
