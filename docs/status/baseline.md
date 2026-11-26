# Baseline status (Phase 1, Zig 0.16)

Date: 2026-11-26. Built from `bootstrap` (cruller `f7002b1` merged, with its two "zig 17"
commits reverted). How to build: `docs/build.md`.

## Build

| Item | Result |
|------|--------|
| `bun scripts/build.ts --profile=debug --cache-dir=build/cache` | ✅ links `build/debug/bun-debug` (737 MB, ASAN, assertions, logs) in 3 min 04 s cold |
| Build's own smoke edge (`bun-debug --revision`) | ✅ `1.3.14-debug+<sha>` |
| `bun-debug --version` | `1.3.14-debug` |
| Release build | not tried (needs nightly Rust for lol-html per `problem.md`) |
| `zig build --build-file build016.zig check` | not run (it would write to `~/.bun/build-cache`, see `docs/build.md`) |

## Tests (`scripts/runner.node.mjs`, debug binary)

```sh
node scripts/runner.node.mjs --quiet --exec-path $PWD/build/debug/bun-debug js/node/test/parallel/<test>.js
```

| Test | Result |
|------|--------|
| `test-bzrt-runtime-smoke.js` (`Bun.serve` + `curl` via `Bun.spawn` + built-in `fetch`) | ✅ pass, **only with `llvm-symbolizer` available** (see below) |
| `test-path-basename.js` | ✅ pass |
| `test-path-dirname.js` | ✅ pass |
| `test-path-extname.js` | ✅ pass |
| `test-path-join.js` | ✅ pass |

**The leak-check trap.** Without a symbolizer the smoke test fails every time (5/5) with:

```
SUMMARY: AddressSanitizer: 11492 byte(s) leaked in 154 allocation(s).
[1/3] test/js/node/test/parallel/test-bzrt-runtime-smoke.js - SIGABRT
```

With `ASAN_SYMBOLIZER_PATH` (or `vendor/llvm-21.1.8/bin` on PATH) it passes every time (5/5).
The runner turns on LeakSanitizer with `test/leaksan.supp`, whose rules match function names,
so they only work on symbolized stacks. With `print_suppressions=1` all leaked bytes are known ones:

```
Suppressions used:
  count      bytes template
      2        144 jsc.JSGlobalObject.JSGlobalObject.create
    151       7692 Zig__GlobalObject__create
      3       3800 uws_create_app
```

## Ad-hoc checks

All run as `BUN_DEBUG_QUIET_LOGS=1 build/debug/bun-debug <file>`.

| Script | Result |
|--------|--------|
| `hello.js`: `console.log(typeof Bun, Bun.version)` | ✅ `hello js object 1.3.14-debug` |
| `serve.js`: `Bun.serve({port:0})` + `await fetch(...)` + `server.stop()` | ✅ `status 200 body ok /ping` |
| `hello.ts`: interface, type annotations, `enum` | ✅ `hello zun x2 2` (also via `bun-debug run hello.ts`) |
| `.js` entry, `require("./lib.ts")` | ✅ `cjs->ts 3` |
| `.ts` entry, `await import("./lib.ts")` | ✅ `ts dyn->ts 3` |
| `.js` entry, `await import("./libj.js")` | ✅ |
| **any entry with a static `import`** (`.js`, `.mjs`, `.ts`; local file or `node:path`) | ❌ **crash** |
| `await import("./mid.ts")` where `mid.ts` itself has a static `import` | ❌ same crash |

### Answer: does running `.ts` directly work?

**Yes, transpile-on-load works.** Types, interfaces and enums are stripped or lowered, and `.ts`
files loaded through `require()` or `import()` are transpiled too. Cruller's README ("no on-the-fly
transpilation") is out of date: the entry source goes through `bun_js.runSourceWithHook` → `Run.boot`
as an eval script, and modules go through `ModuleLoader.transpileSourceCode` → `js_parser`.

**But any ESM static `import` statement crashes the debug build**, whatever the file type:

```
AddressSanitizer: SEGV on unknown address ... rax = 0xaaaaaaaaaaaaaaaa
SUMMARY: AddressSanitizer: SEGV src/js_parser/ast/P.zig:2777:49 in
  js_parser.ast.P.NewParser_(true,.react,false).processImportStatement
    #6 bundler.cache.JavaScript.parse              src/bundler/cache.zig:248
    #7 bundler.transpiler.Transpiler.parseMaybeReturnFileOnlyAllowSharedBuffer  src/bundler/transpiler.zig:937
    #9 jsc.ModuleLoader.transpileSourceCode        src/jsc/ModuleLoader.zig:228
```

Cause: `src/bundler/transpiler.zig:932` sets `opts.macro_context = undefined;`. The parser then
calls `p.options.macro_context.getRemap(...)` (`P.zig:2777`) for every import. `0xaa…` is how Zig
fills `undefined` memory in debug builds. Upstream Bun 1.3.14 has
`opts.macro_context = &transpiler.macro_context.?;` there; cruller changed it in its "0 errors"
commit (`3d5c916`). The fix is probably that one line. **Not fixed in Phase 1** so the baseline stays
"cruller as-is". In cruller's release build `undefined` isn't filled with `0xaa`, so ESM may *happen*
to work there, which explains why `problem.md` reports ESM entrypoints as working. It's still undefined behaviour.

## `src/rt` entanglement map

`src/rt/` (18 files, 2.8k lines) splits into two groups.

**A. Production path (used by `bun-debug` today, 10 files):** `monolith.zig`, `engine_selector.zig`,
`jsc_engine.zig`, `contract.zig`, `direct.zig`, `direct_host.zig`, `host_http.zig`, `http_wire.zig`,
`vm_bridge.zig`, `server_dispatch.zig`.

**B. Multi-engine experiments (not linked into the binary, 8 files):** `quickjs_engine.zig`,
`qjs_api.zig`, `v8_engine.zig`, `v8_api.zig`, `quickjs_engine_tests.zig`, `v8_engine_tests.zig`,
`tests.zig`, `ssr_run.zig`. Plus the top-level `ssr-run/` directory (JS benchmark scripts only).

### Who uses it from outside `src/rt`

| File | Uses | What for |
|------|------|----------|
| `src/main.zig:133` | `bun.rt.monolith.Runtime` (= `RuntimeFor(.jsc)`) | **the process entry**: `main()` builds the runtime, `loadEntryPath(argv[1])`, `run()` |
| `src/bun.zig:1845-1858` | `pub const rt = struct { … }` | re-exports all 12 non-test modules as `bun.rt.*` |
| `src/runtime/webcore/fetch/FetchTasklet.zig` (14 refs) | `bun.rt.http_wire`, `bun.rt.vm_bridge`, `bun.rt.contract` | **every `fetch()`** is encoded with `http_wire` and sent over `vm_bridge` to `direct_host`, whose `host_http.Manager` runs the HTTP request. It panics with "runtime host bridge is not installed" if there's no bridge |
| `src/jsc/event_loop.zig:447-504,722` | `rt/vm_bridge.zig` | the JS event loop polls the bridge (`pollCurrent`) and registers a waker (`setCurrentWaker`) |

Nothing in `scripts/build/**` (ninja side) refers to `src/rt` or `ssr-run`.

### `zig build` targets (`build.zig`)

| Step | Uses `src/rt`? | Notes |
|------|----------------|-------|
| `obj` (what ninja calls) | indirectly, via `src/main.zig` | only group A gets analysed. `engine_selector.Implementation(.jsc)` is the only instance, so the QuickJS/V8 files are never compiled into `bun-zig.o` (Zig analyses lazily) |
| `check` | indirectly | `check_root.zig` does `refAllDecls(@import("bun"))`, which reaches `bun.rt.quickjs_engine` / `v8_engine` declarations (externs only, no linking) |
| `rt-test` | directly: `tests.zig`, `quickjs_engine_tests.zig`, `v8_engine_tests.zig` | needs sibling checkouts `../qjs` and `../v8` (not in this repo), plus a hard-coded `/usr/lib/gcc/x86_64-pc-linux-gnu/16/libstdc++.so` |
| `ssr-run`, `ssr-install` | directly: `ssr_run.zig` | same external deps as above |

These steps only build when you ask for them, so the missing `../qjs`/`../v8` don't break `obj`.

### What removal would take

1. **Drop QuickJS/V8 only (small, safe, matches the roadmap's Phase 1 step 2):** delete group B and `ssr-run/`.
   In `build.zig`, delete `qjs_wrapper_dir`, `v8_wrapper_dir`, `qjsTargetTriple`, `linkQjsForTest`, `linkV8ForTest`,
   the QuickJS/V8 test artifacts and the `ssr-run`/`ssr-install` steps (`rt-test` can keep `tests.zig`, which only imports
   `contract`, `vm_bridge`, `http_wire`). In `engine_selector.zig`, drop `.quickjs`/`.v8`. In `src/bun.zig`, drop the
   `quickjs_engine`/`v8_engine` lines. Then rebuild and rerun the five tests. `parked/rt-engines` already keeps the full version.
2. **Remove `src/rt` completely (large, belongs with the CLI restore in Phase 4):** `main.zig` must start JSC directly
   (upstream's `src/cli` → `bun_js.Run.boot`), and `FetchTasklet.zig` plus `event_loop.zig` must go back to upstream 1.3.14's
   direct `HTTPThread` path instead of the host bridge. That's a behaviour change in `fetch()`, so it needs the fetch tests
   (and the smoke test) as a gate. Useful history: the host/engine wiring in `main.zig`,
   `event_loop.zig` and `FetchTasklet.zig` all arrived in one cruller commit, `1a78c80` ("proxy interface +
   quckjs integration (mvp)", 2026-08-26). Its parent `6bd0bbb` shows those files before `src/rt` existed,
   and upstream 1.3.14's `FetchTasklet.zig` drives `http.AsyncHTTP` on the `HTTPThread` directly.
