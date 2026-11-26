# Plan: restoring the Bun 1.3.14 modules that cruller removed (T5)

Written 2026-11-26 (research only, no code changed). Audience: the agent that implements
Phase 4 (`T4.x` in `docs/GAP.md`). Read `docs/GAP.md` § "How to implement each kind of gap"
and `docs/zig/migration-to-0.17.md` first. This file adds the per-module facts.

## Conventions used below

- `U/` = Bun `bun-v1.3.14` source tree. `C/` = cruller at `f7002b1` (= zun's starting point).
  On the research machine they were at
  `/tmp/claude-1000/-home-fak3--t3-projects-zun/3a9c125c-95f7-4c52-9ccb-06a99348ef65/scratchpad/{bun-1.3.14,cruller}`.
  Re-clone with the commands in `AGENTS.md` if that scratchpad is gone.
- "Lines" = `wc -l` of `*.zig` in the directory. "Code lines" = same, minus blank lines and
  lines that are only a `//` comment (counted with a throwaway script; see Appendix A).
- Grep counts skip comment-only lines. They are **estimates of edit sites**, not exact error counts.
- **UNVERIFIED** marks anything I inferred but did not prove by building or running.
- `bzrt-cut` / `bzrt:` are the comment tags cruller left at every cut point
  (`grep -rn bzrt C/src` → 168 lines outside `src/rt/`). That list is the to-do list for re-wiring.

---

## 1. Findings that change how the restore should be done

1. **Upstream 1.3.14 is already on the Zig 0.15 language.** It has 0 non-comment
   `usingnamespace` (`grep -rn usingnamespace U/src --include='*.zig' | grep -v //` → 0),
   139 files use `std.Io.Writer`, and it already formats with `{f}` (e.g. `U/src/cli/cli.zig`
   `debug("argv: [{f}]", ...)` right after line 616). So the 0.15 list in
   `docs/zig/migration-to-0.17.md` ("Earlier changes") is mostly done upstream. The real work is
   **0.16 (std.Io, std.fs/std.time/std.Thread removals, `@Type`) + 0.17 (the table)**.
   Since T2 ports zun to 0.17 *before* Phase 4, restored code should go straight from 0.15 to
   whatever helpers T2 ends up with, skipping cruller's 0.16-only shims where T2 replaced them.

2. **Cruller's 0.16 port of kept code was light.** Lines added by cruller in files that exist in
   both trees (`diff U/src/f C/src/f | grep -c '^>'`, summed): `runtime` 915 over 124k lines,
   `jsc` 220/35k, `js_parser` 99/43k, `sys` 187/8.1k, `resolver` 84/9.7k, `collections` 93/6.4k.
   That is under 1% of lines for most dirs. Expect the restored modules to need roughly
   1–3% of lines touched, concentrated in file-system, time and thread code (counts in § 4).

3. **"Kept in tree" does not mean "ported".** 471 of cruller's `.zig` files (200k lines) are
   byte-identical to 1.3.14. Several of those are no longer referenced, so Zig's lazy analysis
   never compiled them on 0.16, and they must be treated as unported code when they come back
   into use. The important ones:
   - `runtime/api/JSBundler.zig` (2,050 lines) and `runtime/api/JSTranspiler.zig` (1,228):
     identical to upstream, and their `pub const` entries were removed from `C/src/runtime/api.zig`
     (diff shows lines 57–58 and 47 of `U/src/runtime/api.zig` deleted).
   - `runtime/server/HTMLBundle.zig` (539), `bake/production.zig` (1,074), the whole
     `bake/DevServer/` folder (12 files, e.g. `SourceMapStore.zig` 567, `IncrementalGraph.zig`),
     `bundler_jsc/PluginRunner.zig`, `output_file_jsc.zig`, `options_jsc.zig`.
   - **UNVERIFIED** that each is unanalyzed. Cruller's semantic check only does
     `std.testing.refAllDecls(@import("bun"))` (`C/check_root.zig:5-7`), which touches the
     top-level decls of `bun.zig`, not everything below them.

4. **Cruller's stubs must be deleted as modules come back,** or the link fails with duplicate
   symbols. C++ calls into Zig through exported functions, and cruller satisfied those with stubs:
   - `C/src/jsc/cut_bindings_stub.zig`: `Bake__bundleNewRouteJSFunctionImpl` (l.34),
     `Bun__Jest__createTestModuleObject` (l.40), `ExpectMatcherUtils_createSigleton` (l.44),
     `Expect_readFlagsAndProcessPromise` (l.48), `BunTest__shouldGenerateCodeCoverage` (l.68),
     `JSBundlerPlugin__*` (l.74–82), `OnBeforeParse*` (l.88–92).
   - `C/src/jsc/vm_exports_stub.zig`: `BakeProdResolve`, `BakeProdLoad`,
     `Bake__getNewRouteParamsJSFunctionImpl`, `BunServe__onResolvePlugins`/`onRejectPlugins`,
     `Bun__TestScope__Describe2__bunTestThen/Catch` (l.24–56).
   - `C/src/jsc/napi_stub.zig`: `napi_internal_*` and `napi_create_string_*` stand-ins (header
     comment l.1–7 explains why).
   - JS-facing stubs: `C/src/runtime/api/BunObject.zig:14-24` (`color`, `createParsedShellScript`,
     `createShellInterpreter`, `jest` → `cutFeatureCallback`), l.208–223, 527, 1131;
     `C/src/runtime/api/MarkdownObject.zig` (54 lines, throws; upstream is 1,292);
     `C/src/runtime/api/JSONCObject.zig:22`.
   - Type stubs: `C/src/resolver/package_json.zig:2186-2192`, `C/src/resolver/resolver.zig:4309-4326`,
     `C/src/jsc/AsyncModule.zig:515`, `C/src/jsc/JSValue.zig:2487` and
     `C/src/jsc/ConsoleObject.zig:3801` (`JestPrettyFormat = struct {}`), `C/src/jsc/rare_data.zig:936`,
     `C/src/bun.zig:1196-1205` (`cli_compat`), `C/src/bun.zig:1935-1945` (fake `StandaloneModuleGraph`),
     `C/src/js_parser/ast/Parser.zig:1,59` (stand-in for `bun.bake.Framework`).

5. **Codegen picks restored files up automatically.** `*.classes.ts` are globbed from
   `src/**/*.classes.ts` (`C/scripts/glob-sources.ts:43-45`) and `.bind.ts` files are scanned by
   bindgen (`C/scripts/build/codegen.ts:846-848`). `C/scripts/build/codegen.ts` differs from
   upstream only by an added `emitCodegenEmbed` step (diff lines 290, 413-432), and `C/src/codegen/`
   differs only in `bake-codegen.ts`, the added `generate-codegen-embed.ts` and the removed
   `process_windows_translate_c.zig` (`diff -rq`). So restoring a module means copying its
   `.classes.ts`/`.bind.ts` back, not changing codegen. New `.bind.ts` files need a reconfigure
   (comment at `codegen.ts:846-848`).

6. **Most C++ was kept; a few files were edited.** Deleted C++: `ShellBindings.cpp` (32 lines),
   the macOS/Windows files, and `src/napi/*.h` (4 headers, 929 lines). Edited:
   `bindings.cpp` (upstream l.307–566, the `expect.anything`/`expect.any`/… asymmetric-matcher
   code, replaced by `// bzrt-cut` at `C/.../bindings.cpp:308-310`), `BunObject.cpp`
   (`bun:sql` getters → `jsUndefined()` at l.316–323; LUT rows `Transpiler`, `embeddedFiles`,
   `build`, `registerMacro` removed), `BunObject+exports.h` (same 3 macros), `napi.cpp` (22 lines,
   signatures changed to `node_api_basic_env`/`node_api_basic_finalize` because it now compiles
   against the nodejs-headers copy of `node_api.h`), `ZigGlobalObject.cpp` (88 changed lines,
   mostly `LazyProperty<JSC::JSGlobalObject,…>` → `LazyProperty<Zig::GlobalObject,…>`; the cause
   is **UNVERIFIED**, it doesn't look feature-related). Kept and ready: `JSMockFunction.cpp`,
   `JSBundlerPlugin.cpp`, `BundlerMetafile.cpp`, `SQLClient.cpp`, `InspectorTestReporterAgent.cpp`,
   all `napi*.cpp`, `InternalForTesting.cpp`, `JSCTestingHelpers.cpp`.

7. **Removed JS builtins:** `src/js/bun/sql.ts` (1,077 lines), `src/js/internal/sql/mysql.ts` (1,150),
   `src/js/internal/sql/postgres.ts` (1,385), `src/js/node/path.win32.ts`, and
   `src/js/internal-for-testing.ts` was cut from 307 lines to 2 (`C/src/js/internal-for-testing.ts:1`:
   "gutted — pulled in removed subsystems"). **69 test files import `bun:internal-for-testing`**
   (`grep -rl bun:internal-for-testing C/test | wc -l`), so it must be restored piece by piece:
   each block references one module's Zig through `$newZigFunction(...)` (shell.zig l.41–64,
   css_internals.zig l.89–96, patch.zig l.20–22, install's npm/dependency/hosted_git_info/pack_command
   l.113–163, upgrade_command.zig l.108). Restore each block together with its module.

8. **Native deps are all still built.** `C/scripts/build/deps/` still has `libarchive.ts`,
   `nodejs-headers.ts`, `tinycc.ts`, etc., and `diff U/scripts/build/deps/index.ts C/scripts/build/deps/index.ts`
   is empty. Only the Zig bindings are missing.

9. **Almost every upstream test needs `bun:test`.** `C/test/harness.ts:10` imports
   `bun:test`, and 1,492 of 1,790 `*.test.*` files in `C/test` import it directly. Before the test
   runner is back, only Node-style tests (`C/test/js/node/test/parallel/`, 2,209 files, of which
   3 mention `bun:test`) and hand-written smoke scripts run, through `scripts/runner.node.mjs`
   (`C/problem.md:13-24` lists the ones that pass). **Restoring `test_runner` early is the single
   biggest unlock**, which agrees with `ROADMAP.md`.

10. **Tests exist in cruller.** `C/test/` is 1.3.14's `test/` with only 6 files deleted over cruller's
    history (`git log --diff-filter=D -- test`) plus a few added in commit `6bd0bbb`. No sparse
    checkout of 1.3.14's tests was needed. **UNVERIFIED** that every other file is byte-identical.

## 2. Is TypeScript transpile-on-load wired in cruller? Yes, in the source

- `C/src/jsc/ModuleLoader.zig:79` handles `.js, .jsx, .ts, .tsx, …`, and l.225–233 call
  `jsc_vm.transpiler.parseMaybeReturnFileOnly(...)` with `return_file_only` false unless
  `FetchFlags` is `print_source*` (`ModuleLoader.zig:1192-1200`). The normal path uses `.transpile`.
- Cruller's first commit replaced the parser with a stub that always returned `error.ParseError`.
  Commit **`a2ab295` "recovery parser"** (2026-07-16) deleted that stub from
  `src/bundler/transpiler.zig` (now `const js_parser = bun.js_parser;`) and restored
  `src/js_parser/parser.zig` (+1,277 lines).
- So `README.md:17,225` ("no bundler/transpiler", "no on-the-fly transpilation") are out of date.
- What's still cut on that path: the `.md` loader is treated as text (`C/src/bundler/transpiler.zig:1154`),
  auto-install on import (`C/src/jsc/ModuleLoader.zig:441`, `AsyncModule.zig:515`), bunfig
  (`C/src/bun.js.zig:34,139`), and `.sh` entry points (`bun.js.zig:141`).
- **UNVERIFIED at runtime.** T1 still has to build and run a `.ts` file. Once Bun.Transpiler is back
  (R4 below), `C/test/bundler/transpiler/transpiler.test.js` is the parser conformance gate.
- Side note for T1: `C/src/main.zig:133` takes its launcher from `_bun.rt.monolith.Runtime`
  (`C/src/bun.zig:1857` → `src/rt/monolith.zig`). Parking `src/rt/` breaks `main.zig` unless T1
  points it back at `bun_js.runEntryFile` (`C/src/bun.js.zig:543-578`). Restoring the CLI replaces
  this launcher with `bun.cli.Cli.start` (upstream `U/src/main.zig:66`).

---

## 3. Dependency graph and restore order

How it was measured: for each upstream module, count `@import` paths into other `src/<dir>` plus
`bun.<name>` references mapped through `U/src/bun.zig`'s `pub const X = @import("./dir/…")`
lines (script in Appendix A). `*` = removed by cruller, `~` = shrunk by cruller.
Only the edges that matter for ordering are listed. Kept dirs (`bun_core`, `sys`, `paths`,
`resolver`, `js_parser`, `logger`, `http`, `semver`, `ini`, `glob`, `which`, `dotenv`, …) are
available already.

| Module | Removed/shrunk modules it needs (refs) |
|--------|----------------------------------------|
| `cli` | install* (15 imports + 27 refs), bundler~ (34), md* (8), shell* (6), standalone_graph* (4), libarchive* (4), bake~ (3), test_runner* (1) |
| `test_runner` | cli* (3+5: `cli/test_command.zig`, `bun.cli.Command.TestOptions` at `U/src/test_runner/jest.zig:100`) |
| `install` | cli* (28), install_jsc* (11), patch* (4), libarchive* (2), bundler~ (3) |
| `install_jsc` | install |
| `libarchive` → `libarchive_sys` | none removed |
| `patch` ↔ `patch_jsc` | none removed |
| `shell` + `shell_parser` | cli* (5: `bun.cli.Command.Context` at `U/src/shell/interpreter.zig:251,903`) |
| `bundler` (full) | **css*** (108), bake~ (15), md* (2), cli* (2), install (1), watcher~ |
| `bundler_jsc` (full) | standalone_graph* (9), test_runner* (1) |
| `css` | bundler~: only `bun.bundle_v2.Ref` (12), `.Index` (2), `.MangledProps` (1), `.cheapPrefixNormalizer` (1), plus `bun.ImportRecord` (kept). `Ref`/`Index` are just `bun.ast.Ref`/`bun.ast.Index` (`U/src/bundler/bundle_v2.zig:4437,4461`) |
| `css_jsc` | css |
| `standalone_graph` | bundler~ (8), exe_format~ (5: `bun.macho`, `bun.pe`, `bun.elf` at `U/src/standalone_graph/StandaloneModuleGraph.zig:791,839,884`) |
| `napi` | none removed (threading, runtime, collections) |
| `sql` ↔ `sql_jsc` | none removed (boringssl, sha_hmac, uws, base64) |
| `md` | none removed (bun_core, sys, base64, url, paths) |
| `js_parser_jsc` | none removed (resolver, js_parser, dotenv) |
| `bake` DevServer | bundler (BundleV2, Chunk, ContentHasher used by `bake/DevServer/*.zig`), css, watcher |

Two notes on cycles:
- `cli` is a hub: `U/src/cli/cli.zig:67-95` imports every command, and its dispatch switch
  (`cli.zig:622-848`) calls each `XCommand.exec`. Zig only analyzes what is reachable, but the
  switch makes every command reachable. **Restore the CLI with explicit gates:** keep each
  not-yet-restored arm in the switch but route it to one "not available in this zun build yet"
  function, guarded by `comptime` feature flags in one file (suggested `src/bun_core/restore_flags.zig`,
  a new file). Remove each gate when its module lands. `bunfig.zig` also needs a gate around its
  `[install]` section (`U/src/cli/bunfig.zig:819,831,1303` use `bun.install.*`), and
  `run_command.zig` around `bun.shell` (l.235–251, `--shell=bun` scripts) and `bun.md` (l.1290–1525,
  rendering a `.md` entry point).
- `install` ↔ `cli`: package-manager commands live in `src/cli/*_command.zig`, the engine in
  `src/install`. They come back together in R6.

### Recommended order

Each step ends at a checkpoint (`ROADMAP.md`). Steps R4, R5 and R7 move things relative to
`ROADMAP.md` Phase 4. **Flag this for the owner at the next checkpoint**; the reasons are given.

| Step | What | Why here |
|------|------|----------|
| **R0** | Prep: a per-module semantic-check root, a stub ledger, test-driver plumbing (§ 6) | Restored files must be analyzed even when unreachable, and stubs must be tracked |
| **R1** | `md` + `MarkdownObject.zig` + the `.md` loader | Leaf, 8.7k code lines, few migrations. Removes one CLI gate and brings back `Bun.markdown` |
| **R2** | `cli` core: `cli.zig`, `Arguments.zig`, `bunfig.zig` (install part gated), `run_command.zig`, `exec`/`init`/`repl`/`help`/`--version`/`--revision`, `filter_run`, `multi_run`, `ci_info`, `open.zig` | ROADMAP item 1. Everything else is reached through it |
| **R3** | `test_runner` + `cli/test_command.zig` + `cli/test/**` + `jest.classes.ts` + `FakeTimersConfig.bindv2.ts` + bindings.cpp matchers | ROADMAP item 2. Unlocks 1,492 test files |
| **R4** | `js_parser_jsc` + `Bun.Transpiler` (+ macros) | Small (~2k lines incl. JSTranspiler.zig). Brings back `transpiler.test.js`, the gate for the parser that TS-on-load uses. 17 test files use `Bun.Transpiler` |
| **R5** | `shell` + `shell_parser` (`Bun.$`, `bun exec`, `--shell=bun`) | **Moved before install.** 70 test files use `Bun.$`/`` $` `` for setup, install has no shell dependency, and shell is half install's size |
| **R6** | `libarchive_sys`, `libarchive`, `Archive` API → `patch`+`patch_jsc` → `install`+`install_jsc` + the cli package-manager commands | ROADMAP item 3. Leaves first |
| **R7** | `css`+`css_jsc` (standalone first) → `bundler` full + `bundler_jsc` missing files + `Bun.build`/`registerMacro`/`embeddedFiles` + `HTMLBundle` → `standalone_graph` + `exe_format` macho/pe → `bake` DevServer | ROADMAP item 5. css can compile before bundler with a 4-line alias shim |
| **R8** | `napi` and `sql`/`sql_jsc` (independent; can start any time after R3) | `napi` tests need `zun install` + node-gyp (R6). `sql` needs Docker for most tests |
| (T10) | `sys/windows`, `errno/{darwin,freebsd,windows}`, `watcher/WindowsWatcher.zig`, Windows/macOS C++ | Platform work, not Phase 4 |

---

## 4. Migration load per module (grep estimates on `U/src/<mod>`)

Patterns and what they mean on 0.17 (checked against the installed std at
`~/.local/share/mise/installs/zig/0.17.1/lib/std`):
- `std.fs.*` other than `path`/`max_path_bytes`/`max_name_bytes`/`base64_*`: **compile error**.
  0.17's `fs.zig` only exports those (lines 6–16). Use `std.Io.Dir`/`std.Io.File` plus an `io`,
  or (better) `bun.sys`.
- `std.time.Timer`/`Instant`/`nanoTimestamp`/`milliTimestamp`/`timestamp`: **compile error**
  (0.17 `time.zig` only has constants and `epoch`). Cruller used `bun.compat.{Timer,nanoTimestamp,milliTimestamp,timestamp}`
  (`C/src/bun_core/bzrt_compat.zig:19,252-264`).
- `std.posix.{ftruncate,getcwd,linkat,rename,symlink,symlinkZ,unlinkat,linkatZ,renameatZ,symlinkat,unlinkatZ,mkdiratZ,SEEK_*,isatty,inotify_init1}`:
  not in 0.17 `posix.zig` (checked one by one with `grep "^pub (const|fn|var) <name>"`).
- Managed `std.AutoArrayHashMap(`/`StringArrayHashMap(`/`ArrayHashMap(`: gone in 0.17 (`std.zig:39-44`
  only has deprecated unmanaged aliases). Use `bun.StringArrayHashMap` etc. (cruller routes them
  through `bun.compat.ArrayHashMapManaged`, `C/src/bun.zig:1125-1129`).
- `std.Thread.Mutex/Condition/Pool/RwLock`: not in 0.17 `Thread.zig`. Bun mostly uses `bun.Mutex`
  and `bun.ThreadPool`, so hits are few.
- `@Type(`: removed in 0.16. Cruller added `bun.meta.ReifyStruct`/`ReifyUnion` (`C/src/meta/meta.zig:348+`),
  used e.g. in `C/src/collections/multi_array_list.zig:35,609`. **These helpers read
  `@typeInfo(..).fields`, which changes again in 0.17**, so use whatever T2 turns them into.
- 0.17 table items as in `docs/zig/migration-to-0.17.md`.

| Module | Code lines | std.fs ✗ | posix ✗ | std.time ✗ | managed maps | `@Type` | `@bitCast` (audit) | `@hasDecl` (audit) | stackFallback | allocPrint (depr.) | other |
|--------|-----------:|---------:|--------:|-----------:|-------------:|--------:|---------:|---------:|----:|----:|------|
| cli | 29,477 | 93 | 18 | 26 | 7 | 0 | 1 | 1 | 5 | 71 | `std.process.` 16, `std.os.` 52 (mostly `std.os.linux`/`windows`), `** n` 4 |
| test_runner | 14,632 | 5 | 0 | 4 | 3 | 2 | 3 | 0 | 5 | 1 | `typeInfo.fields` 1, `builtin.os` 9, `std.Thread.RwLock` 1 |
| install | 42,734 | 120 | 9 | 23 | 23 | 2 | 43 | 0 | 17 | 48 | `typeInfo.fields` 5, `** n` 8 |
| install_jsc | 507 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 1 | |
| libarchive(+_sys) | 1,770 | 10 | 5 | 0 | 1 | 0 | 0 | 2 | 0 | 0 | |
| patch(+_jsc) | 1,248 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | `typeInfo.fields` 1 |
| shell | 16,961 | 1 | 0 | 2 | 1 | 6 | 7 | 5 | 7 | 22 | `typeInfo.fields` 7, `std.builtin.` 6, `** n` 5 |
| shell_parser | 614 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 2 | 1 | |
| bundler (all) | 23,986 | 26 | 0 | 1 | 27 | 0 | 3 | 0 | 13 | 42 | `std.fifo`/BoundedArray 4 |
| bundler_jsc (all) | 1,114 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 9 | |
| css | 58,169 | 0 | 0 | 0 | 1 | 0 | 19 | **983** | 3 | 4 | `typeInfo.fields` 33 |
| css_jsc | 681 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 0 | |
| standalone_graph | 1,220 | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | |
| napi | 2,207 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | `std.Thread.*` 2 |
| sql | 3,796 | 4 | 0 | 0 | 0 | 0 | 12 | 5 | 0 | 0 | BoundedArray/fifo 3, `** n` 11 |
| sql_jsc | 8,193 | 0 | 0 | 0 | 0 | 1 | 26 | 0 | 3 | 5 | `** n` 7 |
| md | 8,653 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | `std.posix.` 5 (all exist), `** n` 4 |
| js_parser_jsc | 626 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | |
| bake (all) | 10,102 | 6 | 0 | 9 | 0 | 3 | 22 | 2 | 27 | 4 | BoundedArray/fifo 2 |

(Column "std.time ✗" counts calls to the removed functions/types. Counts for `std.fs`/`posix`
were computed per name. `@bitCast`/`@hasDecl` are "audit" items: they compile but may change meaning.)

**Biggest single risk: `css` and `@hasDecl`.** 983 `@hasDecl` uses (948 in the generated
`properties/properties_generated.zig`). The common names are `toCss` (208),
`deepClone` (208), `parse` (207) and `eql` (207), i.e. the generic derive code checks whether a type
has a method. In 0.17 `@hasDecl` only sees `pub` decls (`docs/zig/cheatsheet-0.17.md:142`). The css
tree also has **non-pub** declarations with checked names: `parse` 24, `sign` 11, `deepClone`/`eql`/`format`
1 each (`grep -rhE "^\s*(fn|const|var) <name>\b" U/src/css`). Wherever such a type goes through a
`@hasDecl` check, behaviour changes silently. Audit: make those decls `pub`, or switch the check
to `@hasField`/an explicit marker. **UNVERIFIED** which of the 24+11 are actually reached by a check.

---

## 5. Per-module plans

Size = `wc -l` of `*.zig` (code lines in § 4). Effort is a rough guess for one agent with
the 0.17 baseline already green: S ≈ 1 session, M ≈ 2–4, L ≈ 1–2 weeks, XL > 2 weeks.

### R1. `md` (Markdown): 10,546 lines, 16 files

- (a) Powers `Bun.markdown` (`U/src/runtime/api/MarkdownObject.zig`, 1,292 lines; cruller's is a
  54-line stub, `C/.../MarkdownObject.zig:1,31`), the `.md` import loader
  (`C/src/bundler/transpiler.zig:1154`, now "treat .md as .txt"), and `bun file.md` terminal
  rendering in `run_command.zig:1290-1525`.
- (b) Needs only kept modules. Re-enable `C/src/bun.zig:258` (`pub const md = …`).
- (c) No `.classes.ts`. MarkdownObject is a plain BunObject property. No C++.
- (d) Few migrations (§ 4). The `std.posix` calls it uses still exist.
- (e) Tests: `C/test/js/bun/md/*.test.ts` (6 files: `md-spec`, `gfm-compat`, `md-edge-cases`,
  `md-heading-ids`, `md-react`, `md-render-callback`). They need `bun:test`, so gate them after R3.
  Before that, smoke-test with a plain script that calls `Bun.markdown` and compares against
  `spec.txt` in the same folder.
- (f) Low risk, **S**.

### R2. `cli`: 36,801 lines, 58 files

- (a) Every subcommand. Biggest files: `pack_command` 2,849, `create_command` 2,460, `test_command` 2,276,
  `run_command` 2,204, `update_interactive_command` 2,062, `repl` 2,058, `Arguments` 1,744,
  `publish_command` 1,551, `cli.zig` 1,493, `bunfig` 1,305. Also bunfig loading, which cruller cut from
  the runtime (`C/src/bun.js.zig:34,139`), `--hot`/`--watch`, `--filter`, `bunx`, `repl`, `init`,
  `create`, `upgrade`, `completions`, `exec`, crash-handler CLI info (`C/src/bun.zig:1196`).
- (b) See § 3. In R2, restore only the parts that need nothing missing and gate the rest.
  Also restore `src/cli/ci_info.zig` (`C/src/bun.zig:177`), `Bunfig` (`:743`), `RunCommand` (`:1208`),
  `upgrade_command.Version` (`:1467`), `Arguments` use in `bun.zig:3821`, `ConsoleObject.zig:172,3695,3800`
  (console depth from the CLI), `node_process.zig:2-38` (process title), `VirtualMachine.zig:56`,
  `rare_data.zig:936` (`open.zig` editor), `BunObject.zig:527,1936` (`Bun.openInEditor`),
  `process.zig:132,2909-2911` (`MultiRunProcessHandle`, `ProcessHandle`).
  `options_types/Context.zig` already holds `ContextData` (`C/src/options_types/Context.zig:1-8`), so
  `bun.js.zig:693-703` can alias the real `cli.Command` again.
- (c) No `.classes.ts`. No C++ removed. Codegen: none. `main.zig` goes back to `_bun.cli.Cli.start`.
- (d) Largest file-system load of any module: `std.fs` 93 (`cwd` 27, `openDirAbsolute` 22, `Dir` 21,
  `File` 8, `deleteTreeAbsolute` 4), `std.time.nanoTimestamp` 20, `std.time.Instant` 8,
  missing posix 18. Worked example: `C/src/resolver/fs.zig` vs `U/src/resolver/fs.zig`
  (`std.fs.Dir` → `std.Io.Dir`, `std.fs.openFileAbsoluteZ(...)` → `std.Io.Dir.openFileAbsolute(bun.compat.io(), ...)`,
  `handle.close(bun.compat.io())`). Note that `bun.compat.io()` returns `std.Options.debug_io`
  (`C/src/bun_core/bzrt_compat.zig:5-7`), a stop-gap, so follow T2's replacement. Prefer `bun.sys`
  (already ported) over `std.Io.Dir` where upstream used `std.fs` only to open a dir.
  The Windows-only branches (`std.os.windows`, `install.ps1`) can stay behind `Environment.isWindows`,
  but `C/src/bun.zig:188` made `bun.windows` a stub struct, so code that names Windows types even in
  dead branches may need `if (comptime Environment.isWindows)` guards.
- (e) Tests (spawn the binary): `C/test/cli/run/` (42), `cli/hot` (3), `cli/watch` (2), `cli/init` (1),
  `cli/create` (1), `cli/inspect` (4), `cli/env` (2), `cli/bun.test.ts`, `cli/bunfig-test-options.test.ts`,
  `cli/console-depth.test.ts`, `cli/install/bun-run*.test.ts` (3). All import `bun:test` through
  `harness.ts`. Before R3, use the driver trick in § 6 or the Node runner with smoke scripts.
- (f) Medium risk (gating is design work, and bunfig parsing touches many options). **L**.

### R3. `test_runner`: 17,998 lines, 92 files (+ `cli/test_command.zig` 2,276 + `cli/test/**`)

- (a) `bun test`, `bun:test` (`describe/test/expect`, mocks, spies, snapshots, fake timers, coverage,
  reporters incl. JUnit, `--parallel`/sharding through `cli/test/parallel/*`), `expect.any/anything`.
- (b) Needs `cli` (R2). Re-wire `C/src/jsc/jsc.zig:121-124` (`Jest`, `TestScope`, `Expect`, `Snapshot`),
  `BunObject.zig:24` (`jest`), `C/src/bun.zig:3239,3252` (fake timers in `getRoughTickCount*`),
  `JSValue.zig:2487`, `ConsoleObject.zig:3801` (`JestPrettyFormat`), `js_bun_spawn_bindings.zig:1028`
  (test timeout), `process.zig:132,2911` (`TestWorkerHandle`), `bundler_jsc/analyze_jsc.zig:6`
  (`DiffFormatter`), `router.zig:1576,1688` (test fixtures).
- (c) Restore `U/src/test_runner/jest.classes.ts` (19 classes: `Expect`, `ExpectAny`, …, `DoneCallback`,
  `ScopeFunctions`) and `U/src/test_runner/timers/FakeTimersConfig.bindv2.ts`. C++: restore
  `U/src/jsc/bindings/bindings.cpp` l.307–566 (asymmetric matchers, which use `JSExpectAnything`/`JSExpectAny` from the
  generated classes). `JSMockFunction.cpp`, `InspectorTestReporterAgent.cpp`, `IsolatedModuleCache.cpp`
  were kept. Delete stubs `cut_bindings_stub.zig:40,44,48,68` and `vm_exports_stub.zig:52,56`.
- (d) Light: `@Type` 2, `typeInfo.fields` 1, `builtin.os` 9, `std.time.milliTimestamp` 4, `std.Thread.RwLock` 1,
  `mem.indexOf` 15 (deprecated alias only: 0.17 `mem.zig:1482` keeps `indexOf = find`).
- (e) Tests: `C/test/js/bun/test/` (75 test files: expect, mock, snapshot, fake-timers, concurrent, …)
  and `C/test/cli/test/` (16: coverage, shard, retry, randomize, parallel, …). Bootstrap: run
  `bun-test.test.ts` and `expect.test.js` first. If `bun:test` itself is broken, check it with plain
  scripts that call `Bun.jest(...)` (exposed through `BunObject.zig:24`), using `node:assert`.
- (f) Medium risk (C++ ⇄ Zig ABI for matchers, snapshot formatting). **L**.

### R4. `js_parser_jsc` + `Bun.Transpiler`: 754 lines + `JSTranspiler.zig` 1,228

- (a) `Bun.Transpiler` (transform/scan/scanImports), macros (`Expr.toJS` turns macro results into JS
  values), `Bun.registerMacro`.
- (b) Needs only kept modules. Re-enable the `toJS` decls cut at `C/src/js_parser/ast/Expr.zig:150,3115` and
  `ast/E.zig:71,140,496,508,540,1143`, plus `runtime/api.zig` `JSTranspiler`, and `BunObject.zig`
  `Transpiler`/`registerMacro`.
- (c) The `Transpiler` class lives in **`U/src/runtime/api/JSBundler.classes.ts`** (`name: "Transpiler"` at l.5)
  together with `BuildArtifact` (l.32). Restoring the file brings `BuildArtifact` back too, and that needs
  `JSBundler.zig`'s `BuildArtifact` (`U/src/runtime/api.zig:47`). Either restore `JSBundler.zig` in R4
  (it is still in tree, unported), or temporarily split the classes file and add `BuildArtifact` in R7.
  C++: add back the `Transpiler` row in `BunObject.cpp`'s LUT and `macro(Transpiler)`/`macro(registerMacro)` in
  `BunObject+exports.h`.
- (d) `JSTranspiler.zig` is byte-identical to upstream and was never ported (finding 3). The module itself has
  1 managed map.
- (e) `C/test/bundler/transpiler/transpiler.test.js` (+ snapshot) and `transpiler-stack-overflow.test.ts`,
  `C/test/js/bun/transpiler/*.test.ts` (4), `C/test/cli/run/transpiler-cache.test.ts`. This is also the
  best gate for TS-on-load.
- (f) Low to medium risk. **S–M**.

### R5. `shell` + `shell_parser`: 21,405 + 740 lines, 46 files

- (a) `Bun.$`, `bun exec`, `bun run --shell=bun`, `Bun.braces` (`BunObject.zig:223,1931`), the shell's
  builtins (cp/mv/rm/ls/…).
- (b) Needs `cli` (`bun.cli.Command.Context`). Re-wire: `C/src/bun.zig:257`, `runtime/api.zig:61`,
  `BunObject.zig:16-17,215-217`, `bun.js.zig:141` (`.sh` entry points), `aio/posix_event_loop.zig:141,190,371`
  (`ShellBufferedWriter`, `ShellStaticPipeWriter`), `runtime/node/node_fs.zig:446-449` (`ShellAsyncCpTask = NewAsyncCpTask(true)`),
  `process.zig:109` (`ShellSubprocess`), `jsc/Task.zig:11,66,121` (`Shell*Task`, `shell.*.YesTask`).
- (c) Restore `U/src/runtime/api/Shell.classes.ts` (`ShellInterpreter`) and `ParsedShellScript.classes.ts`,
  and `U/src/jsc/bindings/ShellBindings.cpp` (32 lines). JS side `C/src/js/builtins/shell.ts` was kept.
  Re-add `internal-for-testing.ts` l.41–64 (`shell.zig` lex/parse helpers used by `lex.test.ts`/`parse.test.ts`).
- (d) `@Type` 6, `typeInfo.fields` 7, `@hasDecl` 5, `@bitCast` 7, stackFallback 7, `std.builtin.` 6. Few fs calls
  (the shell goes through `bun.sys`).
- (e) `C/test/js/bun/shell/` (38 test files + `commands/`). Also indirectly the 70 test files that use `$`.
- (f) Medium risk (async state machine, many `@Type`/reflection sites). **M–L**.

### R6a. `libarchive_sys` + `libarchive` (+ `Bun.Archive`): 1,506 + 688 lines (+ `Archive.zig` 1,146)

- (a) Tarball extraction for install, `bun create`/`upgrade`, `Bun.Archive`.
- (b) Kept deps only. Re-wire `C/src/bun.zig:294`, `runtime/api.zig:51`, `Blob.zig:1658,5101`,
  `BunObject.zig:1131`, `jsc/Task.zig:8,121,530` (`Archive*Task`).
- (c) Restore `U/src/runtime/api/Archive.classes.ts` + `Archive.zig`. The C library is still built
  (`C/scripts/build/deps/libarchive.ts`).
- (d) `std.fs` 10, missing `std.posix.mkdiratZ`/`SEEK_*` 5, `@hasDecl` 2.
- (e) `C/test/js/bun/archive.test.ts`, `archive-extract-leak-repro.ts`,
  `C/test/cli/install/bun-install-streaming-extract.test.ts`, `bun-install-tarball-integrity.test.ts`.
- (f) Low risk, **S**.

### R6b. `patch` + `patch_jsc`: 1,434 + 147 lines

- (a) `bun patch`/`patch-commit`, applying `patchedDependencies` during install.
- (b) Kept deps only (`sys`, `runtime`). Re-wire `C/src/bun.zig:248`.
- (c) No classes. Re-add `internal-for-testing.ts` l.20–22.
- (d) `mem.indexOf` 6 (alias only), `std.process.` 2, stackFallback 1, `typeInfo.fields` 1.
- (e) `C/test/js/bun/patch/patch.test.ts`, `C/test/cli/install/bun-patch.test.ts`, `bun-install-patch.test.ts`.
- (f) Low risk, **S**.

### R6c. `install` + `install_jsc` (+ cli package-manager commands): 53,634 + 632 lines

- (a) `install/add/remove/update/link/unlink/outdated/audit/why/info/publish/pack/pm *`, `bunx`, lockfile
  (`bun.lock` + `bun.lockb`), workspaces, lifecycle scripts, security scanner, `--production`, global cache,
  npm-on-import auto-install, `bun.lock` reading in the resolver.
- (b) Needs `cli`, `libarchive`, `patch`, `ini`, `semver`. Re-wire `C/src/bun.zig:1206-1207,3828`
  (`install`, `PackageManager`, `ConfigVersion`), `resolver/package_json.zig:2159-2192`,
  `resolver/resolver.zig:4275-4326`, `jsc/VirtualMachine.zig:749,4049`, `jsc/AsyncModule.zig:515`,
  `jsc/ModuleLoader.zig:441`, `bundler/transpiler.zig:91`, `ini/ini.zig:577` (`IniTestingAPIs`),
  `process.zig:109,2927` (`LifecycleScriptSubprocess`, `SecurityScanSubprocess`),
  `aio/posix_event_loop.zig:376` (`SecurityScanStaticPipeWriter`). Lift the bunfig `[install]` gate from R2.
  `C/src/install/PackageManager/scanner-entry.ts` is all that's left of `src/install` in cruller; keep it.
- (c) No `.classes.ts` (install_jsc uses plain host functions). Re-add `internal-for-testing.ts` l.108–163
  (npm, dependency, hosted_git_info, pack_command, install_binding, upgrade_command). No C++ removed.
- (d) The heaviest migration: `std.fs` 120 (`Dir` 75, `cwd` 35), `std.time` 23 (`Timer` 9, `nanoTimestamp` 6),
  managed maps 23, `@bitCast` 43, stackFallback 17, missing posix 9 (`linkatZ`, `renameatZ`, `symlinkat`, `unlinkat(Z)`, `ftruncate`).
  Look for an already-ported `bun.sys` equivalent first (`bun.sys.renameat`, `bun.sys.symlinkat`, …,
  **UNVERIFIED** that each one exists).
- (e) `C/test/cli/install/` (71 test files: `bun-install*.test.ts`, `bun-add`, `bun-remove`, `bun-update*`,
  `bun-lock*`, `bun-pm*`, `bun-publish`, `bun-pack`, `bun-link`, `bun-audit`, `bun-info`, `bun-why`,
  `bun-security-scanner-*`, …). 16 use the Verdaccio registry fixture (`C/test/cli/install/registry/verdaccio.yaml`)
  and 16 a `dummy.registry`. Plus `C/test/js/bun/ini/ini.test.ts`. Network-free subsets first.
- (f) High risk (size, file-system-heavy code, concurrency, lockfile binary format). **XL**.

### R7a. `css` + `css_jsc`: 71,888 + 792 lines, 97 files

- (a) CSS parsing/minifying/bundling (a lightningcss port), CSS modules, `Bun.color` (`BunObject.zig:14`),
  the `.css` loader, `SmallList` (`C/src/bun.zig:251-252`).
- (b) Only bundler types: point `bun.bundle_v2.Ref/Index` at `bun.ast.Ref/Index` and move `MangledProps`
  (`U/src/bundler/bundle_v2.zig:47`, a `std.AutoArrayHashMapUnmanaged(Ref, []const u8)`) and
  `cheapPrefixNormalizer` (`:4284`) somewhere kept, so css compiles before the full bundler.
- (c) No `.classes.ts`. `css_jsc` exports test helpers through `internal-for-testing.ts` l.89–96 (`css_internals.zig`).
- (d) Low on API churn, high on reflection: `@hasDecl` 983 (see § 4 risk), `typeInfo.fields` 33, `@bitCast` 19.
  948 of the 983 `@hasDecl` uses are in `U/src/css/properties/properties_generated.zig`, which is generated by
  `U/src/css/properties/generate_properties.ts`. Fix the generator, then regenerate; don't hand-edit the output.
  The rest are in `generics.zig` (16), `css_parser.zig` (10) and `values/color.zig` (3).
- (e) `C/test/js/bun/css/` (`css.test.ts`, `color.test.ts`, `css-fuzz.test.ts`, `doesnt_crash.test.ts`,
  `small-list-grow.test.ts`), `C/test/bundler/css/`, `bundler_html.test.ts` (CSS in HTML).
- (f) Medium-high risk (silent `@hasDecl` changes). **L** (big but mechanical).

### R7b. `bundler` (full) + `bundler_jsc`: 30,995 lines (cruller has 7,305) + 1,321 (has 668)

- (a) `bun build`, `Bun.build`, plugins (`onLoad`/`onResolve`/`onBeforeParse`), macros at bundle time,
  code splitting, minifier, metafile, HTML entry points, `HTMLBundle` routes in `Bun.serve`, `--compile` (with R7c).
- (b) Needs `css`, `md` (2), `cli` (2), `install` (1), `bake` (15). Missing files: `bundle_v2.zig`, `LinkerContext.zig`,
  `LinkerGraph.zig`, `ParseTask.zig`, `ThreadPool.zig`, `BundleThread.zig`, `Chunk.zig`, `Graph.zig`, `HTMLScanner.zig`,
  `barrel_imports.zig`, `AstBuilder.zig`, `ServerComponentParseTask.zig`, … and all of `linker_context/` (25 files),
  plus `bundler_jsc/JSBundleCompletionTask.zig` (555 lines) and `source_map_mode_jsc.zig`. Re-wire
  `C/src/bun.zig:1837-1840`, `js_parser/ast/ImportScanner.zig:431`, `jsc/Task.zig:11,389` (`DeferredBatchTask`),
  `options_types/CompileTarget.zig:495-496`, `options_types/schema.zig:1980`, `runtime/api.zig` `JSBundler`/`BuildArtifact`/`HTMLBundle`.
  Cruller removed the server side with scripts. **Read them as reverse patches**: `C/scripts/strip_compiler_api.py`,
  `strip_bake_server.py`, `strip_devserver_residue.py`, `finish_devserver_residue.py`
  (each lists exact `old → new` text). `strip_package_standalone.py` ("Remove npm-on-import and standalone-compiler
  residue") belongs to R6c and R7c. `server.zig` lost 662 lines and `ServerConfig.zig` 104.
- (c) Restore `JSBundler.classes.ts` (if not done in R4). C++: `BunObject.cpp` LUT `build`, `embeddedFiles`,
  `registerMacro`. `JSBundlerPlugin.cpp`/`BundlerMetafile.cpp` were kept. Delete stubs `cut_bindings_stub.zig:74-92`,
  `vm_exports_stub.zig:44,48`.
- (d) `std.fs` 26, managed maps 27, stackFallback 13, BoundedArray/`std.fifo` 4, allocPrint 42. Also port the
  still-identical `JSBundler.zig`, `HTMLBundle.zig`, `PluginRunner.zig`, `output_file_jsc.zig` (finding 3).
- (e) `C/test/bundler/` (89 test files, `expectBundled` harness in `bundler/expectBundled.ts`), `C/test/js/bun/plugin/` (2),
  `bundler_plugin*.test.ts`, `bundler_html*.test.ts`.
- (f) High risk (multi-threaded parse/link pipeline). **XL**.

### R7c. `standalone_graph` + `exe_format` macho/pe: 1,548 + 1,369 lines

- (a) `bun build --compile` (all targets: macho/pe are needed even on Linux, for cross-compiling),
  `Bun.embeddedFiles`, running a compiled binary (`U/src/cli/cli.zig:554-614`, `fromExecutable`).
- (b) Needs bundler and exe_format. Re-wire `C/src/bun.zig:1932-1945` (replace the fake struct), `3793-3794`
  (`macho`, `pe`), `resolver.zig:814`, `node_fs.zig:5872` (`StandaloneModuleGraph.stat`),
  `sourcemap/Mapping.zig:270`, `bun.js.zig:441`, `ModuleLoader.zig:1203` (`Bun__resolveEmbeddedNodeFile`).
- (c) No classes. `runtime/api/standalone_graph_jsc.zig` (40 lines) is still in tree. Windows resource editing
  (`rescle*.cpp`) is T10.
- (d) Small: `std.fs` 1, `std.posix` 3, `@bitCast` 1.
- (e) `C/test/bundler/bundler_compile*.test.ts`, `bun-build-compile*.test.ts`, `compile-*.test.ts`, `standalone.test.ts`.
- (f) Medium risk (binary layout). **M**.

### R7d. `bake` DevServer: `DevServer.zig` 4,783 lines (+ 12 unported files in `bake/DevServer/`)

- (a) `Bun.serve({ development: { hmr } })` / the Bake dev server, HMR, framework router.
- (b) Needs bundler, css, watcher. Re-wire `js_parser/ast/Parser.zig:1,59` (`bun.bake.Framework` stand-in).
- (c) Restore `U/src/bake/bake.bind.ts` and `DevServer.bind.ts` (bindgen). `C/src/codegen/bake-codegen.ts` differs
  from upstream; diff it before relying on it. Delete stubs `cut_bindings_stub.zig:34`, `vm_exports_stub.zig:24-32`.
- (d) stackFallback 27, `@bitCast` 22, `std.time.Timer` 7, `@Type` 3.
- (e) `C/test/bake/` (24 test files).
- (f) Medium-high risk. **L**. Optional for parity order; can follow R8.

### R8a. `napi`: 2,554 lines (1 file) + 4 headers (929 lines)

- (a) N-API native addons (`require("x.node")`, `process.dlopen`), the `napi` side of `bun:ffi`
  (`C/scripts/strip_ffi_napi.py` removed `Bun__thisFFIModuleNapiEnv` from `ffi.zig` and `src/js/bun/ffi.ts`).
- (b) Kept deps only. Re-wire `runtime/api.zig:67`, `jsc/JSGlobalObject.zig:699,1053`,
  `jsc/Task.zig:40,71,149,393,467` (`napi_async_work`, `ThreadSafeFunction`, `NapiFinalizerTask`).
  **Delete `C/src/jsc/napi_stub.zig`** (its exports collide with `napi.zig`).
- (c) Restore `U/src/napi/{js_native_api,js_native_api_types,node_api,node_api_types}.h`. `scripts/build/flags.ts:1073`
  still adds `src/napi` as an include dir. Then decide: revert cruller's `napi.cpp` signature edits
  (`node_api_basic_env` etc., 22 lines) to match Bun's own headers, or keep nodejs-headers' newer API.
  Reverse-apply `strip_ffi_napi.py` for the FFI part.
- (d) Tiny: `std.Thread.*` 2, `@bitCast` 2.
- (e) `C/test/napi/napi.test.ts` + 3 others, `C/test/napi/node-napi-tests/` (55). `napi.test.ts` builds
  `napi-app` with `bunExe() install` → node-gyp (`C/test/napi/napi.test.ts:11-12`, `napi-app/package.json` scripts).
  So this gate needs R6 **or** a pre-build of `napi-app` with Node's `npx node-gyp` outside zun.
- (f) Medium risk (ABI). **M**.

### R8b. `sql` + `sql_jsc`: 4,720 + 9,888 lines, 125 files

- (a) `Bun.sql`/`bun:sql` (Postgres, MySQL; the SQLite adapter is JS on top of `bun:sqlite`).
- (b) Kept deps only. Re-wire `runtime/api.zig:58-59`, `runtime/socket/uws_handlers.zig:279-318`,
  `BunObject.cpp:316-336` (restore the two `requireId(... BunSql)` getters).
- (c) Restore `U/src/runtime/api/sql.classes.ts` (generates `${type}Connection`/`${type}Query`),
  `src/js/bun/sql.ts`, `src/js/internal/sql/{mysql,postgres}.ts` (they call `$zig("mysql.zig"/"postgres.zig")`).
  `C/src/js/internal/sql/{errors,query,shared,sqlite}.ts` were kept. `SQLClient.cpp` was kept.
- (d) `@bitCast` 38 (wire-protocol structs: audit closely, since 0.17 rejects `@bitCast` on extern struct/union),
  `** n` 18, `@hasDecl` 5, BoundedArray 3 (`std.BoundedArray` was removed in 0.15: use a fixed array + len, or a bun type).
- (e) `C/test/js/sql/` (23 test files). `sqlite-sql.test.ts`, `sqlite-url-parsing.test.ts`,
  `adapter-*.test.ts` need no server. About 10 use Docker containers (`C/test/docker/docker-compose.yml`).
- (f) Medium risk. **M**.

### Trimmed platform parts (T10, not Phase 4)

| Part | Upstream | Cruller | Notes |
|------|---------:|--------:|-------|
| `sys` | 12,280 | 8,185 | `sys/windows/windows.zig` 4,108 + `env.zig` 60 removed. `C/src/sys/sys.zig:14-18` → `@compileError("bzrt: linux only")` |
| `errno` | 1,850 | 253 | `darwin_errno` 207, `freebsd_errno` 210, `windows_errno` 1,180 removed |
| `exe_format` | 1,903 | 534 | macho/pe are needed by R7c even on Linux |
| `watcher` | 1,736 | 1,418 | `WindowsWatcher.zig` 323 removed. `C/src/watcher/Watcher.zig:150,798` |
| C++ | | | `SecretsDarwin.cpp`, `SecretsWindows.cpp`, `BunProcessReportObjectWindows.cpp`, `uv-posix-polyfills-darwin.c`, `windows/rescle*`, `io/io_darwin.cpp` |

---

## 6. Process for each step (R0 details)

1. **Copy, don't hand-retype.** Cruller restored FFI with `C/scripts/restore_ffi.py`: a file list copied from a
   read-only 1.3.14 checkout with a sha256 check, then `C/scripts/fix_ffi_zig016.py` applied exact,
   counted replacements (`replace_exact(text, old, new, expected=N)` fails if the count is off). Use the same
   two-script pattern per module (`scripts/restore/<module>.py` + `scripts/port/<module>_017.py`), so every port
   edit can be reviewed and replayed. `C/scripts/fix_zig016_round2.py` and `fix_zig016_frontier.py` are
   more examples of the "exact replacement with expected count" style.
2. **Make the compiler see the restored code.** Zig only analyzes what is reachable, and
   `C/check_root.zig` only references `bun.zig`'s top-level decls. For each module add a check root that
   references every file of the module recursively (for example a `refAllDeclsRecursive`-style helper,
   **UNVERIFIED** whether 0.17's `std.testing` still offers one; write a small one if not, and record it
   in `docs/zig/`). Otherwise dead-but-wrong code hides until a later step reaches it.
3. **Keep a stub ledger.** Before each step, grep `bzrt` and the three stub files for the module's names
   (finding 4). Remove the stubs in the same commit that restores the real code.
4. **Re-add `internal-for-testing.ts` blocks** for the module (finding 7).
5. **Test driver before `bun:test` works (R1–R2 only).** `bunExe()` returns `process.execPath`
   (`C/test/harness.ts:106-109`), so a test always spawns whatever runtime runs it. Proposal
   (**UNVERIFIED**, needs a small harness edit): make `bunExe()` prefer an env var such as `ZUN_TEST_EXE`, then run
   spawn-based tests (`test/cli/**`) under a pinned Bun 1.3.14 *release binary downloaded into a scratch dir*
   (never the owner's `bun`, see `AGENTS.md` rule 4), with `ZUN_TEST_EXE=build/debug/zun`. In-process API tests
   can't be driven this way, so for them wait for R3 or write `node:assert` smoke scripts run through
   `scripts/runner.node.mjs --exec-path` (`C/problem.md:38-39`).
6. **Record results** in `docs/status/<module>.md` (pass/fail/skip per test file), as `GAP.md` asks.

## 7. Totals

| Step | Zig lines to bring back (incl. unported in-tree files) | Effort |
|------|------:|------|
| R1 md | 10.5k + 1.3k | S |
| R2 cli (core, rest lands with R3/R5/R6/R7) | ~20k of 36.8k | L |
| R3 test_runner (+ test command) | 18k + ~5k | L |
| R4 js_parser_jsc + Transpiler | 0.75k + 1.2k (+2k JSBundler.zig if not split) | S–M |
| R5 shell | 22.1k | M–L |
| R6 libarchive, Archive, patch, install | 2.2k + 1.1k + 1.6k + 54.3k (+ ~10k cli pm commands) | XL |
| R7 css, bundler, standalone, exe_format, bake | 72.7k + 25k + 1.5k + 1.4k + 4.8k (+ ~4k unported in tree) | XL |
| R8 napi, sql | 2.6k + 14.6k | M + M |

Roughly **250k lines of Zig** come back. That's more than the 224k in cruller's 239 modified files.

---

## Appendix A: how the numbers were produced

- Sizes: `find <dir> -name '*.zig' | xargs cat | wc -l` for each of `U/src/<mod>` and `C/src/<mod>`.
- File-level diffs: `diff <(cd U/src/<d> && find . -type f | sort) <(cd C/src/<d> && find . -type f | sort)`.
- Identical files: `cmp -s` over every `C/src/**/*.zig` (excluding `src/rt`) that also exists in `U` → 471 identical (200,227 lines), 239 modified (224,662 lines), 5 new.
- Dependency counts: a Python script that strips `//` comments, resolves `@import("…zig")` paths to the top-level `src/` dir, and maps `bun.<Name>` through `U/src/bun.zig`'s `pub const Name = @import("./dir/…")` lines.
- Migration counts: a Python script that counts regexes per non-comment line (the patterns in § 4). `std.fs`/`std.posix` were refined by checking each referenced name against 0.17.1's `lib/std/fs.zig` and `lib/std/posix.zig`.
- Cruller's port churn: `diff U/src/f C/src/f | grep -c '^>'` summed per directory.
- Test counts: `find <dir> -regex '.*\.test\.[cm]?[jt]sx?$' | wc -l` in `C/test`.
