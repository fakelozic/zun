# zun's identity (Phase 3)

How zun differs from Bun in names, paths, env vars, config and outbound traffic, and why.
Decided by the owner on 2026-11-26 (`docs/ROADMAP.md`, Phase 3); implemented in Phase 3.
The pure rules are in `src/bun_core/zun_identity.zig` (std-only, `zig test src/bun_core/zun_identity.zig`);
the process-facing wrappers are `bun.zun` in `src/bun_core/zun.zig`.

**The JavaScript surface stays Bun.** `Bun.*`, `Bun.version`, `process.versions.bun`, `navigator.userAgent`,
`process.release`, error banners (`Bun v1.3.14 (Linux x64)`) and the `bun:*` modules are unchanged, because Bun's
test suite and npm libraries check them. There is no `globalThis.Zun`.

## Summary

| Item | Bun 1.3.14 | zun | Where |
|------|-----------|-----|-------|
| Binary | `bun`, `bun-debug`, `bun-profile`, `bun-asan`… | `zun`, `zun-debug`, `zun-profile`, `zun-asan`… | `scripts/build/config.ts:1022` (`bunExeName`), strip output `scripts/build/bun.ts:698` |
| Ninja phony target | `bun` | `zun` | `scripts/build/bun.ts`, `scripts/build/configure.ts` |
| `--version` | `1.3.14` | `zun 0.1.0 (bun-compat 1.3.14)` | `src/main.zig:68`, `src/bun_core/zun.zig` (`version_line`) |
| `--revision` | `1.3.14+<sha9>` | `zun 0.1.0+<sha9> (bun-compat 1.3.14)` (`-debug` in debug builds) | `src/main.zig:71`, `src/bun_core/zun.zig` (`revision_line`) |
| zun's version | n/a | `0.1.0`, **single source:** `build.zig:21` (`-Dzun_version`) | `src/bun_core/env.zig:68` (`zun_version_string`) |
| `process.versions.zun` | n/a | `"0.1.0"` | `src/runtime/node/node_process.zig:313` (`Zun__version`), `src/jsc/bindings/BunProcess.cpp:218` |
| `process.versions.bun`, `Bun.version` | `1.3.14` | unchanged (`1.3.14`, `-debug` suffix in debug builds) | |
| Env vars | `BUN_X` | `ZUN_X` first, then `BUN_X` | see below |
| Config file | `bunfig.toml` | `zunfig.toml`, else `bunfig.toml` | see below |
| Per-user root | `~/.bun` | `~/.zun` | see below |
| HTTP `User-Agent` | `Bun/1.3.14` | unchanged | `src/bun_core/Global.zig:212` |
| Crash reports | auto-upload to bun.report on macOS/Windows/canary | never by default | see below |
| `bun feedback` | POSTs to bun.report | needs an explicit URL | see below |

## Environment variables: `ZUN_X` first, then `BUN_X`

Bun's test suite sets `BUN_*` (`BUN_DEBUG_QUIET_LOGS`, `BUN_GARBAGE_COLLECTOR_LEVEL`, `BUN_INSTALL`,
`BUN_JSC_*`…), so `BUN_*` must keep working. zun reads `ZUN_<X>` first and falls back to `BUN_<X>`.
**A set `ZUN_X` wins even when it is empty**, so `ZUN_X=` or `ZUN_X=0` can switch off an inherited `BUN_X`.

The rule is applied at three choke points instead of at each call site:

| Choke point | Covers | Where |
|-------------|--------|-------|
| `bun.getenvZ` / `bun.getenvZAnyCase` | every `bun.env_var.BUN_*` accessor (`src/bun_core/env_var.zig`: 83 `BUN_*` definitions incl. `feature_flag.*`, ~60 uses in `src`), every direct `bun.getenvZ("BUN_…")`, and the `BUN_DEBUG_<scope>` log switches | `src/bun.zig:925`, `:957`. `getenvZRaw` / `getenvZAnyCaseRaw` read one exact name |
| `Loader.getZunOrBun` / `Map.getZunOrBun` | reads from the env map (process env plus `.env` files): `BUN_CONFIG_VERBOSE_FETCH`, `BUN_GARBAGE_COLLECTOR_LEVEL`, `BUN_SHOW_BUN_STACKFRAMES`, `BUN_FEATURE_FLAG_FORCE_WAITER_THREAD`, `BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING`, `BUN_FEATURE_FLAG_SYNTHETIC_MEMORY_LIMIT`, `BUN_GC_TIMER_INTERVAL`, `BUN_GC_RUNS_UNTIL_SKIP_RELEASE_ACCESS`, `BUN_DISABLE_TRANSPILER`, `BUN_CONFIG_MAX_HTTP_REQUESTS`, `BUN_ENV`, `BUN_PORT`; plus everything through `Loader.has` / `Loader.getAs` (`BUN_GC_TIMER_DISABLE`, `BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD`) | `src/dotenv/env_loader.zig:386`, `:1371` |
| C++ | `BUN_JSC_<option>` then `ZUN_JSC_<option>` (the later one wins); `ZUN_DISABLE_STOP_IF_NECESSARY_TIMER` before `BUN_…` | `src/jsc/bindings/ZigGlobalObject.cpp:326`, `:448` |

Deliberately **not** changed:

- `Loader.get` / `Map.get` stay exact, because they also back JS `process.env` and `Bun.env`
  (`src/runtime/api/BunObject.zig`, `Bun__getEnvValue*`). JS must see what is really set:
  `process.env.BUN_X` is never answered with `ZUN_X`'s value.
- Writes stay `BUN_*` (`src/aio/ParentDeathWatchdog.zig:150` sets `BUN_FEATURE_FLAG_NO_ORPHANS` for children).
  A child zun still sees it, and a `ZUN_FEATURE_FLAG_NO_ORPHANS` in the environment would win.
- The bundler's public env prefix (`options.env.prefix = "BUN_"`, `src/bundler/transpiler.zig:319`) is
  JS-facing behaviour (which `process.env.*` get inlined) and stays Bun's.
- JS builtins in `src/js` that read `process.env.BUN_*` keep doing so (only `src/js/eval/feedback.ts` was
  changed, see below).
- Names are only built for keys shorter than 256 bytes; longer keys skip the `ZUN_` lookup.
- `scripts/runner.node.mjs` spreads `process.env` before its own `BUN_*` settings, so a `ZUN_*` variable in the
  developer's shell overrides the runner's `BUN_*` value for the same setting. Don't export `ZUN_*` when running tests.

## Config file: `zunfig.toml`, else `bunfig.toml`

Bun 1.3.14 (`src/cli/Arguments.zig`, `loadConfig` / `getHomeConfigPath`) loads a global file, then a local one:

- global: `$XDG_CONFIG_HOME/.bunfig.toml`, else `$HOME/.bunfig.toml`;
- local: `$cwd/bunfig.toml` only (no walking up), or the `--config` path.

zun keeps the same places and precedence and applies the fallback **per location**: in each directory,
`zunfig.toml` (global: `.zunfig.toml`) is used if it exists, else `bunfig.toml` (`.bunfig.toml`).
Names: `src/bun_core/zun_identity.zig` (`local_config_names`, `global_config_names`);
lookups: `bun.zun.findLocalConfig` / `findGlobalConfig` (`src/bun_core/zun.zig`).

**State today:** cruller cut config loading entirely (`src/cli/` including `bunfig.zig` is gone). The launcher's
live path (`runSourceWithHook`, called from `src/rt/jsc_engine.zig`) now runs the local lookup and records the
result in `bunfig_path` (`src/bun.js.zig`, `findLaunchConfig`), exactly where Bun stored it; nothing parses it yet.
Debug builds log the chosen file with `ZUN_DEBUG_ZUN=1`, which is how `test-zun-identity.js` checks the rule.
**Deferred to the CLI restore (Phase 4 item 3):** restore `cli/bunfig.zig` + `Arguments.loadConfig`, and make
them call `bun.zun.findGlobalConfig` and `findLocalConfig` instead of the literal `"bunfig.toml"`/`".bunfig.toml"`;
`--config <path>` stays as is. Keep the `[run]`/`[test]`/`[install]` schema identical so a `bunfig.toml` can be
renamed to `zunfig.toml` unchanged.

## Default directories: `~/.zun`, never `~/.bun`

Install root (`bun.zun.installRoot`, rule in `chooseInstallRoot`): `$ZUN_INSTALL` → `$BUN_INSTALL` →
`$XDG_CACHE_HOME/.zun` → `$HOME/.zun`. Same order as Bun (`BUN_INSTALL` → `$XDG_CACHE_HOME/.bun` → `$HOME/.bun`).

**`BUN_INSTALL` that points into `~/.bun` is ignored.** Bun's installer writes
`export BUN_INSTALL="$HOME/.bun"` into shell rc files, so following `BUN_INSTALL` blindly would make zun install
into the real Bun's directory on most machines that have Bun. zun accepts `BUN_INSTALL` only when it is not
`$HOME/.bun` or inside it (Bun's tests point it at temp dirs, which keeps working). `ZUN_INSTALL` is always
honoured. (`isInsideRealBunHome`, unit-tested.) Note that `bun.env_var.BUN_INSTALL.get()` itself only applies the
generic `ZUN_` fallback, not this guard: restored code must use `bun.zun.installRoot()` / `installSubpath()`.

| Directory | Bun | zun | State |
|-----------|-----|-----|-------|
| Runtime transpiler cache | `$BUN_RUNTIME_TRANSPILER_CACHE_PATH`, `$XDG_CACHE_HOME/bun/@t@`, (macOS `~/Library/Caches/bun/@t@`), `~/.bun/install/cache/@t@`, `$TMPDIR/bun/@t@` | `ZUN_`/`BUN_RUNTIME_TRANSPILER_CACHE_PATH`, `$XDG_CACHE_HOME/zun/@t@`, (macOS `…/Caches/zun/@t@`), `~/.zun/install/cache/@t@`, `$TMPDIR/zun/@t@` | **done**, `src/jsc/RuntimeTranspilerCache.zig:435` (`reallyGetCacheDir`) |
| Build cache (dev builds) | `$BUN_INSTALL/build-cache` or `~/.bun/build-cache` | `$ZUN_INSTALL/build-cache` or `~/.zun/build-cache`; `BUN_INSTALL` deliberately not read | **done**, `scripts/build/config.ts:637` |
| Install cache | `BUN_INSTALL_CACHE_DIR`, `$BUN_INSTALL/install/cache`, `$XDG_CACHE_HOME/.bun/install/cache`, `~/.bun/install/cache` | `ZUN_`/`BUN_INSTALL_CACHE_DIR`, `installSubpath(&.{"install","cache"})` | deferred: `src/install` is cut. Restore must use `bun.zun` |
| Global packages | `$BUN_INSTALL/install/global`, `~/.bun/install/global` | `installSubpath(&.{"install","global"})` | deferred (install cut) |
| Global bin | `BUN_INSTALL_BIN`, `$BUN_INSTALL/bin`, `~/.bun/bin` | `ZUN_`/`BUN_INSTALL_BIN`, `installSubpath(&.{"bin"})` | deferred (install cut) |
| REPL history | `~/.bun_repl_history` | `~/.zun_repl_history` (`identity.repl_history_filename`) | deferred (REPL cut) |
| Shell completions | `$BUN_INSTALL`, `XDG_DATA_HOME` | same rule as install root | deferred (CLI cut) |
| `bun feedback` email | `$BUN_INSTALL/feedback`, `~/.bun/feedback` | same install-root rule, `~/.zun/feedback` | **done**, `src/js/eval/feedback.ts:137` |

**Bug fixed on the way:** the transpiler cache's `toFile` opened the cache dir with `openDir` and fell back to the
**cwd** when it did not exist, so the first run in any project wrote a `<hash>.debug.pile` file into the project
directory (reproduced with the pre-Phase-3 `bun-debug`). Upstream 1.3.14 used `makeOpenPath`. zun now creates
the dir and skips caching if that fails (`src/jsc/RuntimeTranspilerCache.zig`, `toFile`).

Kept on purpose: `Bun.cron` writes crontab entries marked `# bun-cron: <title>` and temp files `bun-cron-*`
(`src/runtime/api/cron.zig`). That marker is behaviour Bun's tests inspect, so it stays; a user running both Bun
and zun with the same cron title would see them replace each other's entry. Revisit if that matters.
`node_modules/.bun` (isolated installs) and the `.bun` ELF section for standalone executables are on-disk
formats shared with Bun and stay.

## Outbound traffic: nothing goes to Oven by default

(Also `AGENTS.md` rule 6, `docs/security/outbound.md`.)

- **Crash reports** (`src/crash_handler/crash_handler.zig`). Bun uploads a trace URL to `https://bun.report` via
  `curl` on macOS, Windows and canary builds, or whenever `BUN_ENABLE_CRASH_REPORTING=1`. zun:
  `isReportingEnabled()` (`:1429`) is true **only** when `ZUN_CRASH_REPORT_URL`/`BUN_CRASH_REPORT_URL` is set to a
  non-empty URL by the user; `BUN_ENABLE_CRASH_REPORTING` alone does nothing. Bun's own crash-handler test
  (`test/cli/run/run-crash-handler.test.ts`) sets the URL to a local server, so it keeps working. The local crash
  output is unchanged, except: the trace string's default prefix is `zun-trace:` instead of `https://bun.report`
  (`:29`), so it is not a link to Oven's service, and the "file a GitHub issue with Bun's team" advice now says
  this is zun and that nothing was sent. The "oh no: Bun has crashed. This indicates a bug in Bun, not your code"
  sentence is kept because that test matches it.
- **Feedback** (`src/js/eval/feedback.ts`, reachable only once the CLI is back): Bun POSTs to
  `https://bun.report/v1/feedback`; zun refuses unless `ZUN_FEEDBACK_URL`/`BUN_FEEDBACK_URL` is set.
- **Telemetry**: `src/analytics` only counts feature use in memory (it feeds the crash trace string); it sends
  nothing. No change needed.
- **Upgrade checks** (`bun upgrade`, version checks against GitHub/bun.sh) live in `src/cli`, which is cut.
  **Deferred:** when restoring the CLI, `upgrade` must not fetch Bun's releases (decide: remove it or point it at zun's).
- **`User-Agent: Bun/1.3.14`** (`src/bun_core/Global.zig:212`, used by `fetch` and `navigator.userAgent`) is kept.
  It contains only the Bun-compatible version, nothing zun-specific, and servers and libraries sniff it. zun's
  version is not added, so requests don't reveal that zun is in use.
- Remaining `bun.sh`/`bun.report` strings in `src` are comments, docs links in error messages, or type docs.

## Tests

- `test/js/node/test/parallel/test-zun-identity.js` (runner style): `process.versions.zun`, `Bun.version`,
  no `globalThis.Zun`, `ZUN_PORT` over `BUN_PORT` (env-map path, every build), `ZUN_DEBUG_QUIET_LOGS=0` over
  `BUN_DEBUG_QUIET_LOGS=1` (`getenvZ` path, debug only), `zunfig.toml` over `bunfig.toml` (debug only, via the log).
- `zig test src/bun_core/zun_identity.zig`: key mapping, precedence, the `~/.bun` guard, install-root order, version line.

## Deferred (CLI restore and later)

1. Config parsing (`cli/bunfig.zig`, `Arguments.loadConfig`) must use `bun.zun.findLocalConfig` / `findGlobalConfig`.
2. Install, global bin, install cache, REPL history, completions must use `bun.zun.installRoot` / `installSubpath`
   and `identity.repl_history_filename`. Install code restored from 1.3.14 reads `env.get("BUN_INSTALL")` /
   `env.get("BUN_INSTALL_CACHE_DIR")` from the env map: switch those to `getZunOrBun` too.
3. `zun upgrade`: no requests to Bun's release servers.
4. Help text, usage lines and error messages that say `bun …` (`bun run`, `bun install`) should say `zun` where they
   describe the command line; messages that name the runtime in a way tests check stay.
5. `BUN_FEATURE_FLAG_NO_ORPHANS` written for children, `bun-cron` markers: revisit if they cause clashes.
6. Pre-existing, unrelated: `BUN_CONFIG_VERBOSE_FETCH=curl` prints nothing in this tree (also on the pre-Phase-3
   binary), and the minimal launcher does not forward script arguments to `process.argv`.
