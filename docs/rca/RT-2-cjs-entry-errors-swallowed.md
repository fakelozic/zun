# RT-2: an uncaught throw in a CommonJS entry exits 0 with no output

- **Status:** fixed in the commit that adds this file (`security: RT-2 …`), together with RT-1.
- **Severity:** high, security-relevant. A CJS app that crashes during startup looked like a clean exit to its
  supervisor, and every CJS gate test could pass while its assertions failed.
- **Found by / date:** T4.1 (md restore), reproduced by the integration owner, 2026-11-26 at `c98d508`. RCA by SEC2.

## Symptom

```sh
$ printf 'const assert = require("assert");\nassert.strictEqual(1, 2);\n' > t.js
$ BUN_DEBUG_QUIET_LOGS=1 build/debug/zun-debug t.js; echo "exit=$?"
exit=0          # nothing on stdout or stderr
```

Measured on the unfixed launcher (2026-11-26):

| Entry | Result |
|---|---|
| `module.exports = 1; throw new Error("z")` | exit 0, no output |
| `console.log("before"); …; throw …; console.log("after")` (CJS) | prints `before`, exit 0 |
| same with `process.on("uncaughtException", …)` | handler **not** called, exit 0 |
| CJS + `Promise.reject(new Error())` | reported, exit 1 |
| CJS + `setTimeout(() => { throw … })` | reported, exit 1 |
| CJS + `process.exitCode = 3` / `process.exit(4)` | exit 3 / 4 |
| `throw new Error("plain")` (no `require`/`module`, so parsed as ESM) | reported, exit 1 |

So only a **synchronous throw while the CJS entry body runs** was lost, and it was lost before any JS-visible handler.
Side effects of the same launcher path: `__filename` was `<dir>/[eval]` (so `path.extname(__filename) === ""`),
`import.meta.dir` lacked the cwd for a relative entry, and `process.argv` was `[execPath]` only.

## Root cause

Two things combined: a latent engine-binding bug inherited from Bun 1.3.14, and a cruller launcher change that routed
every entry file onto the code path with that bug.

**1. The exception is discarded by `JSC::evaluate`'s 3-argument overload** (inherited from Bun 1.3.14).

- `src/jsc/bindings/JSCommonJSModule.cpp:164` (before the fix), in `evaluateCommonJSModuleOnce`, eval-entry branch:
  ```cpp
  JSValue result = JSC::evaluate(globalObject, code, jsUndefined());
  RETURN_IF_EXCEPTION(scope, false);
  ```
- WebKit `Completion.h:55-58` (prebuilt `5488984d`, `build/cache/webkit-*/include/JavaScriptCore/Completion.h`): the
  3-arg overload is an inline wrapper that passes a **local, discarded** `NakedPtr<Exception> unused` to the 4-arg one.
- WebKit `Source/JavaScriptCore/runtime/Completion.cpp:147-150` (oven-sh/WebKit@5488984d):
  ```cpp
  if (scope.exception()) [[unlikely]] {
      returnedException = scope.exception();
      scope.clearException();
      return jsUndefined();
  }
  ```
  The exception is moved into `unused` and **cleared from the VM**. The following `RETURN_IF_EXCEPTION` sees no
  exception, `Bun__VM__setEntryPointEvalResultCJS(undefined)` records a normal completion, the module "succeeds", and
  `Run.start` (`src/bun.js.zig`) never sees a rejected entry promise, so `uncaughtException`, the error printer and
  `exit_code = 1` are all skipped. The run ends normally with exit code 0.
- The same overload is used at `JSCommonJSModule.cpp:173` for the normal (non-eval) path, but there it only evaluates
  the `(function (exports, require, module, __filename, __dirname) { … })` wrapper expression, which never throws for
  transpiled code. The body runs later through `JSC::call`, which propagates exceptions. That is why the bug only
  showed on the eval-entry branch.
- This code is byte-identical to `bun-v1.3.14` (diffed). Bun fixed it upstream by **1.4.5** (same file, ~l.235-245,
  comment: "The 3-arg JSC::evaluate overload catches the exception into a discarded NakedPtr … the process would exit
  0 silently"), for both call sites. So upstream Bun 1.3.14's `bun -e` / `bun -p` had the same bug for CJS input.

**2. cruller's launcher sent every entry file down the eval-entry branch.**

- cruller commit `1a78c80` ("proxy interface + quckjs integration (mvp)", Alex Storm, 2026-08-26) replaced
  `bun_js.runEntryFile(entry_path)` in `src/main.zig` with `rt.monolith.Runtime`, whose JSC engine
  (`src/rt/jsc_engine.zig`) read the file and called `bun_js.runSourceWithHook(source, name)`. That function is Bun's
  `-e` machinery: it sets `ctx.runtime_options.eval.script` and the entry `<dirname(name)>/[eval]`
  (`src/bun.js.zig`, `runSourceWithHook`). In eval mode the transpiler drops the CJS wrapper
  (`remove_cjs_module_wrapper = is_main and eval_source != null`, `src/jsc/ModuleLoader.zig:208`) and
  `Bun__VM__specifierIsEvalEntryPoint` routes the module to the buggy branch above. It also explains `__filename =
  [eval]` (the C++ sets `__filename` to the eval specifier) and the missing `process.argv[1]`
  (`node_process.zig` skips a main ending in `/[eval]`), and `ctx.passthrough` was never set.
- Why the change was made: the rt boundary was designed so "the engine never opens `filename`" (comment on
  `runSource`): the host passed bytes to an engine that might be QuickJS or V8. zun dropped QuickJS/V8 in Phase 2,
  so that reason no longer applies to the JSC engine.

## Why it wasn't caught

- **The gate tests could not fail.** 5 of the 7 gate tests were CJS. Their failing assertions threw synchronously
  during the entry body, which is exactly the swallowed case, so they reported PASS regardless. No test ever proved
  that the runner reports a failing test as FAIL (no negative control).
- `test-path-extname` and `test-path-basename` really did fail (`__filename` was `[eval]`), and were reported as passing.
- Smoke tests checked "exit 0 and `End`" only; zun's own `test-zun-*` tests were the first written as ESM, which is how
  T4.1 noticed the difference.
- The underlying binding bug is in upstream 1.3.14's eval path, which Bun's own tests mostly drive with ESM-shaped
  or non-throwing snippets.

## Fix

1. **Cause (binding):** `src/jsc/bindings/JSCommonJSModule.cpp`, both `JSC::evaluate` calls now use the out-param
   overload and rethrow (`scope.throwException(globalObject, returnedException.get())`), exactly as Bun 1.4.5 does.
   This makes the exception reach `Run.start` on the eval path itself. Verified on a diagnostic build that still used
   the eval launcher: the CJS throw printed the error and exited 1, `uncaughtException` handlers fired, and
   `require("./missing")` errors were reported (a sync throw in the body, so the same mechanism swallowed them before;
   not re-measured on the unfixed binary).
2. **Cause (launcher):** a file entry is no longer run as eval source. `src/rt/jsc_engine.zig` calls
   `bun_js.runEntryFile(path, passthrough, hook)` (`src/bun.js.zig`), which is what `bun file.js` does: absolute
   entry path, real `__filename` / `import.meta.*`, and `ctx.passthrough` → `process.argv.slice(2)`.
   `src/main.zig` passes everything after the entry path as script arguments (`zun file.js a b`, `zun run file.js a b`).
   The rt `monolith` now sends only the path across the boundary (an empty source buffer), since the engine reads the
   file itself. The server-dispatch hook is unchanged (`source_loaded_hook`, called from `Run.start`).
3. Unrelated but found in the same code: RT-1 (`Bun__Node__ZeroFillBuffers` stubbed as a function, see `known-issues.md`):
   now `export var … : bool = false`, as upstream. `nm` shows `b Bun__Node__ZeroFillBuffers` (data) instead of code.

(1) alone fixes the exit code; (2) alone hides it for file entries but would leave `zun -e` broken once the CLI is
restored. Both are needed.

## Regression test

- `scripts/zun-negative-controls.sh` with fixtures in `test/zun/negative-control/`: 5 must-fail fixtures (CJS sync
  assert, CJS async rejection, CJS timer throw, ESM sync assert, ESM TLA rejection) and 2 must-pass fixtures that also
  check `__filename`, `import.meta.dir/path`, `process.argv[1]` and `require.main`. Each is checked directly (exit code
  and an error on stderr) **and** through `scripts/runner.node.mjs` (runner exit code). On the unfixed binary the CJS
  sync-assert fixture exits 0 (measured with the same snippet), so the script fails there. The async-rejection and timer
  fixtures were already reported before the fix (Symptom table); they guard the other exit paths. After the fix all 7 behave.
- The 8 gate tests pass, and `test-path-extname` / `test-path-basename` now pass for the right reason.

## Sibling search

How: grep for every `JSC::evaluate(`, `evaluateWithScopeExtension(`, `profiledEvaluate(` in `src/` and `packages/`;
read the launcher path (`src/main.zig`, `src/rt/*.zig`, `src/bun.js.zig` `Run.boot/start`, `loadEntryPoint`) for
`catch {}` / `catch return` on JS calls; then ran each exit path on the fixed binary.

| Place | Finding | State |
|---|---|---|
| `JSCommonJSModule.cpp` eval-entry `JSC::evaluate` (3-arg) | the bug | **fixed** |
| `JSCommonJSModule.cpp` wrapper `JSC::evaluate` (3-arg) | same pattern; would turn a wrapper failure into a misleading TypeError | **fixed** (as 1.4.5) |
| `NodeVMScript.cpp:348,412`, `NodeVM.cpp:1176,1220`, `bindings.cpp:6142`, `napi.cpp:2668` | use the out-param and rethrow / return a status | fine |
| `src/rt/server_dispatch.zig:59` + `jsc_engine.zig` `callHandler` | a throw in `globalThis.__crullerHandle` becomes `error.JSError` → `sendError(-2)`; the exception is neither reported nor cleared. `sourceLoaded` also does `get(…) catch return`. And if a script defines `__crullerHandle`, `sourceLoaded` busy-loops before the event loop runs. Dormant: nothing in zun sends `server_request` commands (the SSR host was QuickJS/V8-era) | **open**, RT-4 in `known-issues.md`; remove with `src/rt` in the CLI restore |
| `src/bun.js.zig` `eval_and_print` branch: `result.then2(…) catch {}` and `Bun__onRejectEntryPointResult` exits with the current `exit_code` (0) after printing a rejected `-p` result at log level | upstream 1.3.14 code; reachable only with `-p`, which the launcher doesn't expose yet | **open**, check when `-e/-p` come back with the CLI restore (item 3) |
| `src/main.zig` exit path | `Run.start` always ends in `vm.globalExit()` (`noreturn`, uses `exit_handler.exit_code`); the `Global.exit(0)` after `runtime.run()` is reached only if boot fails before that, and boot errors `panic` | fine |
| Runtime checks on the fixed binary | `require` of a throwing `.cjs` (CJS and ESM importer) → 1; CJS syntax error → 1; throw in `exit` / `beforeExit` handler → 1; `queueMicrotask` throw → 1; `process.exitCode = 7` → 7; `worker_threads` worker throw → 1; ESM rejection / TLA → 1; `Promise.reject(42)` → 1 | fine |
| Web `Worker` | every `new Worker(...)`, even one that succeeds, prints an ASAN `CHECK failed: asan_thread.cpp:369 kCurrentStackFrameMagic` at thread teardown in the ASAN debug build; main exits 0. Not related to RT-2 (worker code untouched), not investigated yet | **open**, RT-3 in `known-issues.md` |

## Lessons

- **Every gate needs a negative control.** A test suite that has never been seen to fail proves nothing. Run
  `scripts/zun-negative-controls.sh` after any change to the launcher or the runner.
- **Know your engine API's error contract.** In JSC, `JSC::evaluate(global, code, thisValue)` *swallows* exceptions;
  only the overload with `NakedPtr<Exception>&` reports them. Grep for the 3-arg form when restoring C++ from 1.3.14.
- **Diff against the next stable release when something looks like an engine-binding bug.** Bun 1.4.5 had already
  fixed it, with a comment describing exactly this symptom.
- A "temporary" architectural shim (bytes-in, eval-mode entry) changed observable semantics (`__filename`, argv, error
  path). When a shim's reason goes away (QuickJS/V8 dropped in Phase 2), re-check what it costs.
