# Restore status: Bun 1.3.14 modules (Roadmap Phase 4)

A living ledger. **Every restore updates this file in the same commit:** delete the rows it
replaced, and add any new cut point it leaves. Plan and per-module notes: `docs/plan/restore-1.3.14.md`.

Regenerate the raw cut-point list with:

```sh
grep -rn bzrt src --include='*.zig' --include='*.cpp' --include='*.h' --include='*.ts' | grep -v '^src/rt/'
```

(168 lines at `ce9e006`.)

## Progress

| # | Module | Status | Notes |
|---|--------|--------|-------|
| 1 | Prep (this ledger, recipe, gates) | ✅ 2026-11-26 | `scripts/restore-module.ts`, `src/bun_core/restore_flags.zig` |
| 2 | `md` (`Bun.markdown`, `.md` loader) | ⏳ in progress | |
| 3 | `cli` core | | |
| 4 | `test_runner` | | |
| 5 | `js_parser_jsc` / `Bun.Transpiler` | | |
| 6 | `shell` | | |
| 7 | `libarchive`, `patch` | | |
| 8 | `install` | | |
| 9 | `css` | | |
| 10 | `bundler`, `standalone_graph`, `bake` | | |
| 11 | `napi`, `sql` | | |

## Restore recipe

```sh
U=/path/to/bun-v1.3.14   # git clone --depth 1 --branch bun-v1.3.14 --filter=blob:none https://github.com/oven-sh/bun.git
# 1. list what comes back: scripts/restore/<module>.files (dirs end in "/")
# 2. copy + pin + mechanical 0.16→0.17 codemod (+ its --report)
bun scripts/restore-module.ts --from=$U <module>        # add --force for files that exist here as stubs
git add scripts/restore/<module>.{files,lock} <copied paths> && git commit   # commit A: pristine-after-codemod
# 3. wire it in: un-comment the `bzrt-cut` lines from the tables below, delete the stubs
# 4. build (docs/build.md) and fix by hand; commit B is then the reviewable/replayable port patch
bun scripts/build.ts --profile=debug --cache-dir=build/cache
# 5. tests: the runner-style smoke test now, the upstream bun:test files once item 4 lands
```

Notes:
- `restore-module.ts` refuses anything but commit `0d9b296a` (= `bun-v1.3.14`), refuses a dirty upstream tree,
  pins the upstream bytes in `scripts/restore/<module>.lock` (sha256; later runs must match), and won't
  overwrite a file here that differs from upstream unless `--force`.
- **Cruller's `scripts/fix_zig016_*.py` are not part of the pipeline.** They are exact per-file replacements and
  every file they target is already in zun (checked: all 15 paths exist and are applied). For restored code,
  0.15→0.16 changes are done by hand; the library of worked examples is `diff $U/src/<f> src/<f>` for kept files,
  those scripts, and `docs/zig/migration-to-0.17.md`.
- Zig analyses lazily, so restored files nothing references are not checked. After wiring, make sure the module's
  entry points are reachable from the build (an `export`, a `BunObject` property, or a `comptime { _ = ...; }`).
- **Any file an imported file `@import`s must exist**, even in dead code (`docs/zig/probes/comptime-gate`).
  You cannot keep `@import("./shell/shell.zig")` behind a false flag while `src/shell` is absent.

## Gates (for the CLI restore and later)

`src/bun_core/restore_flags.zig` holds one `pub const <module> = false;` per module not yet restored, plus
`cliUnavailable("<what>")` (prints `error: '<what>' is not available in this zun build yet …`, exits 1).

```zig
.ShellCommand => if (comptime bun.restore_flags.shell)
    try ShellCommand.exec(ctx)               // may name bun.shell / ShellCommand even though they don't exist yet
else
    bun.restore_flags.cliUnavailable("zun exec"),
```

Rules:
1. The `comptime`-false branch is not analysed, so it may reference **decls** that don't exist (`bun.shell`);
   verified by `docs/zig/probes/comptime-gate/gate.zig`.
2. It may not reference **files** that don't exist. So in `cli.zig`, a command whose file isn't in the tree keeps
   its `const X = @import("./x_command.zig")` line commented as `// zun-gate(<module>): …` and the arm names it
   only inside the false branch. A command file that *is* copied in early must at least pass AstGen
   (syntax-level 0.17 changes such as `**` are handled by `fix_zig017.ts`), because imported files are parsed eagerly.
3. JS-facing APIs keep throwing a JS exception (`BunObject.cutFeatureCallback`), not exiting.
4. When a module lands: delete its flag and every `if (comptime bun.restore_flags.<m>)` in the same commit.
   The compiler then reports any call site that still mentions the flag.
5. `md` was restored before the CLI, so the CLI restore needs no md gate (`run_command.zig` l.1290–1525, `.md`
   entry-point rendering, comes back with the CLI as is).

## Cut points by module (what each restore deletes or re-enables)

Line numbers are at the commit that last touched this table. "re-enable" = un-comment the `bzrt-cut` line.

### md (item 2)

| Where | What it was | Replaced by |
|-------|-------------|-------------|
| `src/bun.zig:260` | `// bzrt-cut: pub const md = …` | re-enable |
| `src/runtime/api/MarkdownObject.zig` (54-line stub, `bzrt` l.1,31) | throws "not available" | upstream file (1,292 lines) |
| `src/bundler/transpiler.zig:1157` | `.md` loaded as text | upstream `bun.md.renderToHtml` |

### cli (item 3)

| Where | What |
|-------|------|
| `src/main.zig:63` | minimal launcher instead of `bun.cli.Cli.start` |
| `src/bun.js.zig:34,139` | bunfig loading cut |
| `src/bun.js.zig:542,713` | minimal production loader; CLI option types kept locally |
| `src/bun.zig:179` | `ci` (`cli/ci_info.zig`) |
| `src/bun.zig:740` | `Bunfig` |
| `src/bun.zig:1215-1216` | `cli` + crash-handler stand-in struct |
| `src/bun.zig:1228` | `RunCommand` |
| `src/bun.zig:1493` | `upgrade_command.Version` |
| `src/bun.zig:3845-3846` | `Arguments` use (returns `false`) |
| `src/jsc/ConsoleObject.zig:172,3695,3800` | console depth from CLI |
| `src/jsc/VirtualMachine.zig:56` | `HotReload` from `options_types/Context.zig` |
| `src/jsc/rare_data.zig:936` | `EditorContext = struct {}` (`cli/open.zig`) |
| `src/runtime/api/BunObject.zig:527,1936` | `Bun.openInEditor` |
| `src/runtime/node/node_process.zig:2-38` | process title kept locally |
| `src/runtime/api/bun/process.zig:132,2909,2910` | `ProcessHandle`, `MultiRunProcessHandle` |
| `src/jsc/vm_exports_stub.zig:13-24` | `Bun__Node__ProcessNoDeprecation`, `…ThrowDeprecation`, `…UseSystemCA`, `Bun__githubURL` (real ones live in `cli/Arguments.zig` / `upgrade_command.zig`) |
| `src/jsc/vm_exports_stub.zig:42` | `Bun__Node__ZeroFillBuffers` (**verify** where upstream defines it before deleting) |

### test_runner (item 4)

| Where | What |
|-------|------|
| `src/jsc/jsc.zig:121-124` | `Jest`, `TestScope`, `Expect`, `Snapshot` |
| `src/runtime/api/BunObject.zig:24` | `jest` → `cutFeatureCallback` |
| `src/bun.zig:3263,3276` | fake timers in `getRoughTickCount*` |
| `src/jsc/JSValue.zig:2487`, `src/jsc/ConsoleObject.zig:3801` | `JestPrettyFormat` stand-ins |
| `src/runtime/api/bun/js_bun_spawn_bindings.zig:1028` | test timeout |
| `src/runtime/api/bun/process.zig:132,2911` | `TestWorkerHandle` |
| `src/bundler_jsc/analyze_jsc.zig:6` | `DiffFormatter` |
| `src/router/router.zig:1576,1688` | test fixtures |
| `src/jsc/bindings/bindings.cpp:308,310` | `expect.anything` / `expect.any` (upstream l.307–566) |
| `src/js/internal-for-testing.ts:1` | gutted; re-add blocks per module |
| `src/jsc/cut_bindings_stub.zig:40,44,48,68` | `Bun__Jest__createTestModuleObject`, `ExpectMatcherUtils_createSigleton`, `Expect_readFlagsAndProcessPromise`, `BunTest__shouldGenerateCodeCoverage` |
| `src/jsc/vm_exports_stub.zig:52,56` | `Bun__TestScope__Describe2__bunTestThen/Catch` |

### js_parser_jsc / Bun.Transpiler (item 5)

| Where | What |
|-------|------|
| `src/js_parser/ast/Expr.zig:150,3115` | `toJS` |
| `src/js_parser/ast/E.zig:71,140,496,508,540,1143` | `toJS` per node type |
| `src/runtime/api.zig` | `JSTranspiler` (file in tree, never compiled) |
| `src/jsc/bindings/BunObject.cpp` LUT, `BunObject+exports.h` | `Transpiler`, `registerMacro` rows |

### shell (item 6)

| Where | What |
|-------|------|
| `src/bun.zig:259` | `shell` |
| `src/runtime/api.zig:61` | `Shell` |
| `src/runtime/api/BunObject.zig:16-17,215-217,223,1931` | `createParsedShellScript`, `createShellInterpreter`, `$`, `braces` |
| `src/bun.js.zig:141` | `.sh` entry points |
| `src/aio/posix_event_loop.zig:141,190,371` | `ShellBufferedWriter`, `ShellStaticPipeWriter` |
| `src/runtime/node/node_fs.zig:446,449` | `ShellAsyncCpTask` |
| `src/runtime/api/bun/process.zig:109` | `ShellSubprocess` |
| `src/jsc/Task.zig:11,66,121` | `Shell*Task`, `YesTask` |

### libarchive + patch (item 7)

| Where | What |
|-------|------|
| `src/bun.zig:296` | `libarchive` |
| `src/runtime/api.zig:51` | `Archive` |
| `src/runtime/webcore/Blob.zig:1658,5101` | Archive |
| `src/runtime/api/BunObject.zig:1131` | `Bun.Archive` → `undefined` |
| `src/jsc/Task.zig:8,121,530` | `Archive*Task` |
| `src/bun.zig:250` | `patch` |

### install (item 8)

| Where | What |
|-------|------|
| `src/bun.zig:1226-1227,3852` | `install`, `PackageManager`, `ConfigVersion` |
| `src/bundler/transpiler.zig:91` | `getPackageManager` |
| `src/resolver/package_json.zig:2159,2160,2167,2186,2190,2192` | npm metadata stubs |
| `src/resolver/resolver.zig:4275,4276,4309,4326` | npm resolution type stubs |
| `src/jsc/VirtualMachine.zig:749,4049` | package manager |
| `src/jsc/AsyncModule.zig:479`, `src/jsc/ModuleLoader.zig:441` | npm-on-import |
| `src/ini/ini.zig:577` | `IniTestingAPIs` |
| `src/runtime/api/bun/process.zig:109,2927` | `LifecycleScriptSubprocess`, `SecurityScanSubprocess` |
| `src/aio/posix_event_loop.zig:376` | `SecurityScanStaticPipeWriter` |

### css (item 9)

| Where | What |
|-------|------|
| `src/bun.zig:253-254` | `css`, `SmallList` |
| `src/runtime/api/BunObject.zig:14,208-211` | `Bun.color` → `cutFeatureCallback` |

### bundler, standalone_graph, bake (item 10)

| Where | What |
|-------|------|
| `src/bun.zig:1863-1866` | `bundle_v2`, `BundleV2`, `ParseTask` (`Loader` kept from `options.zig`) |
| `src/js_parser/ast/ImportScanner.zig:431` | bundler v2 |
| `src/jsc/Task.zig:11,389` | `DeferredBatchTask` |
| `src/options_types/CompileTarget.zig:495-496`, `src/options_types/schema.zig:1980` | `fromJS` helpers |
| `src/logger/logger.zig:1283-1284` | `js_lexer` range |
| `src/bun.zig:1956`, `src/bun.js.zig:440`, `src/resolver/resolver.zig:814`, `src/runtime/node/node_fs.zig:5872`, `src/sourcemap/Mapping.zig:270` | standalone module graph |
| `src/bun.zig:3817-3818` | `macho`, `pe` |
| `src/js_parser/ast/Parser.zig:1,59` | `bun.bake.Framework` stand-in |
| `src/jsc/cut_bindings_stub.zig:34` | `Bake__bundleNewRouteJSFunctionImpl` |
| `src/jsc/cut_bindings_stub.zig:74-92` | `JSBundlerPlugin__addError/onDefer/onLoadAsync/onResolveAsync`, `OnBeforeParsePlugin__isDone`, `OnBeforeParseResult__reset` |
| `src/jsc/vm_exports_stub.zig:24,28,32` | `BakeProdResolve`, `BakeProdLoad`, `Bake__getNewRouteParamsJSFunctionImpl` |
| `src/jsc/vm_exports_stub.zig:44,48` | `BunServe__onResolvePlugins/onRejectPlugins` |
| `src/jsc/bindings/BunObject.cpp` LUT | `build`, `embeddedFiles` |

### napi, sql (item 11)

| Where | What |
|-------|------|
| `src/jsc/napi_stub.zig` (whole file) | `napi_internal_register_cleanup_zig`, `napi_internal_suppress_crash_on_abort_if_desired`, `napi_internal_enqueue_finalizer`, `napi_create_string_latin1/utf16/utf8` |
| `src/runtime/api.zig:67`, `src/jsc/JSGlobalObject.zig:699,1053` | `napi` |
| `src/jsc/Task.zig:40,71,149,393,467` | `napi_async_work`, `ThreadSafeFunction`, `NapiFinalizerTask` |
| `src/runtime/api.zig:58-59` | `Postgres`, `MySQL` |
| `src/runtime/socket/uws_handlers.zig:279,281,318` | postgres / mysql sockets |
| `src/jsc/bindings/BunObject.cpp:316,322` | `bun:sql` getters → `jsUndefined()` |

### Not a module restore (keep, or Phase 7 platform work)

| Where | Why it stays |
|-------|--------------|
| `src/bun.zig:190,207`, `src/sys/sys.zig:14-18`, `src/sys/PosixStat.zig:139`, `src/sys/fd.zig:713,718`, `src/watcher/Watcher.zig:150,798`, `src/uws/uws.zig:22`, `src/runtime/socket/socket.zig:37`, `src/runtime/node.zig:7`, `src/errno/linux_errno.zig:167` | Linux-only (Phase 7) |
| `src/bun_core/bzrt_compat.zig`, `src/meta/meta.zig:348` | Zig 0.16/0.17 compat helpers |
| `src/bun.zig:2044` | `Stat` on Linux |
| `src/jsc/btjs.zig:1` | JSC stack dumper (debug only) |
| `src/jsc/bindings/BunProcess.cpp:239` | lolhtml note |
| `src/resolver/resolver.zig:662` | opt-in debug break |
| `src/runtime/api/JSONCObject.zig:22` | `Bun.JSONC.parse` throws; **unassigned**: check upstream (`src/interchange`?) before item 5 |

## Code in the tree that was never compiled

Zig only analyses what is referenced, so a file can sit in `src/` for two Zig upgrades without ever being
type-checked (plan finding 3). When a restore starts referencing one of these, treat it as **unported**
1.3.14 code. Heuristic list (2026-11-26): `.zig` files that no `@import` in `src/` or `build/debug/codegen/`
and no `$zig(...)` in `src/**/*.ts` names. "identical" = still byte-identical to `bun-v1.3.14`.

| File | Lines | Identical | Comes back with |
|------|------:|:---------:|-----------------|
| `src/runtime/api/JSBundler.zig` | 2,050 | yes | item 5 (`BuildArtifact`) or 10 |
| `src/runtime/api/JSTranspiler.zig` | 1,228 | | item 5 |
| `src/runtime/server/HTMLBundle.zig` | 539 | yes | item 10 |
| `src/bake/bake.zig` | 1,008 | | item 10 |
| `src/bake/DevServer/*` (`IncrementalGraph` 2,075, `SourceMapStore` 567 identical, `ErrorReportRequest`, `DirectoryWatchStore`, `HmrSocket`, `HotReloadEvent`, `memory_cost`, `SerializedFailure`, `WatcherAtomics`, `RouteBundle`, `Assets` identical, `PackedMap` identical) | ~5,000 | some | item 10 |
| `src/runtime/api/standalone_graph_jsc.zig` | 40 | yes | item 10 |
| `src/options_types/CommandTag.zig` | 185 | yes | item 3 |
| `src/sys/walker_skippable.zig` | 199 | yes | item 8 (install) |
| `src/collections/StaticHashMap.zig` | 781 | | check |
| `src/runtime/node/os/constants.zig`, `src/runtime/node/node_error_binding.zig` | 297, 25 | yes | check (may be reached by codegen in a way this scan misses) |
| `src/jsc/fmt_jsc.zig`, `src/jsc/codegen.zig`, `src/jsc/bindgen_test.zig`, `src/jsc/static_export.zig`, `src/bun_core/result.zig`, `src/bun_core/util.zig`, `src/aio/stub_event_loop.zig`, `src/jsc_stub.zig` | small | mostly | check |
| `src/main_test.zig`, `src/unit_test.zig`, `src/codegen_embed_debug.zig`, `src/unicode/uucode/*` | small | | build/test roots, not dead |

The scan misses files that `build.zig` registers as named modules (`src/aio/posix_event_loop.zig` = `@import("async")` and
`src/zlib_sys/posix.zig` = `@import("zlib-internal")`, `build.zig:91-93`: both compiled, both left out). Verify a row before relying on it.
Beyond the unreferenced files, **byte-identical but referenced** files (372 files, 141k lines) are fine: they were compiled.

