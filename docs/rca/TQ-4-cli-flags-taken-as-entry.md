# TQ-4 / TQ-8: command-line flags taken as the entry file; `--config` silently ignored

- **Status:** fixed in `bfddd44` (R2 checkpoint (a), CLI restore; rebased from `1824fe7`). Regression test in the commit that adds this file.
- **Severity:** high. Security-relevant in two ways: a config file the operator named (`--config`) was silently not
  applied, and the security-relevant runtime flags (`--use-system-ca`, `--zero-fill-buffers`,
  `--throw-deprecation`, …) had no effect because their globals were stubs nobody could set.
- **Found by / date:** parity triage (rows TQ-4 and TQ-8 in `docs/status/triage.md`, clusters 1 and 1a in
  `docs/status/parity.md`), 2026-11-26. One RCA for both: they share the root cause.

## Symptom

```sh
$ BUN_DEBUG_QUIET_LOGS=1 build/snap-0a5b26b/zun-debug -e 'console.log(1)'
error: Module not found '/tmp/-e'                                   # exit 1
$ build/snap-0a5b26b/zun-debug --expose-gc f.js                     # same: '--expose-gc' is the "entry"
$ build/snap-0a5b26b/zun-debug run --config=/nonexistent.toml f.js  # runs f.js, exit 0: flag ignored
```

TQ-8: `child_process.fork()` and `cluster` start the child as `execPath ...execArgv script args` (no `run`). The
parity harness runs tests as `zun run --config=<repo>/bunfig.node-test.toml file`, so `execArgv` was
`["--config=…"]` and every forked child died with `Module not found '<cwd>/--config=…'`.
Before the fix: 139 tests in cluster 1 (TQ-4; Node tests re-spawn themselves with their `// Flags:` line) and
52 in cluster 1a (TQ-8). Counts after the fix: see `docs/status/triage.md`.

## Root cause

zun had **no command-line parser**. Bun parses argv in `src/cli/cli.zig` (`Cli.start` → `Command.which` →
`Command.init` → `Arguments.parse` with clap, then `loadConfig`), and `src/main.zig` just calls `Cli.start`.

- `a1c009d` (cruller, "strip Bun 1.3.14 to thin zig 0.16 runtime") deleted `src/cli` (36.8k lines) and
  `a2ab295` ("recovery parser") replaced `_bun.cli.Cli.start(...)` in `main.zig` with a minimal launcher:
  `argv[1]` *is* the entry file (only `--version`/`--revision` special-cased). Any flag in first position
  became a module path.
- `3ab97f3` ("small fixes") added `zun run …`, which **skipped** every leading `-…` argument to find the entry. That
  hid the problem for the harness's own `run --config=… file` invocation and made `--config` (and every other flag)
  a silent no-op, including a config path that doesn't exist.
- Knock-on effects of the same cut: `process.execArgv`'s table of value-taking flags
  (`node_process.zig`, built from `Arguments.auto_params`) was replaced by an empty map, so `execArgv` could not
  tell `-r ./pre.js f.js` from `-r` + entry; and `Bun__Node__{UseSystemCA,ZeroFillBuffers,ProcessNoDeprecation,
  ProcessThrowDeprecation}` became constant stubs (`vm_exports_stub.zig`), so those flags could never be honoured.

## Why it wasn't caught

- No gate test spawned the binary with a flag. Gate tests are run as `zun run --config=… file`, exactly the form
  that `3ab97f3` made work by skipping flags, so they passed.
- The skip was silent: nothing printed "ignored `--config`", and no test used a config with a visible effect.
- Fork/cluster tests were only run in the full parity harness, which landed after the cut.

## Fix

Restore Bun 1.3.14's CLI core (Roadmap Phase 4 item 3, R2 checkpoint (a), `1824fe7`) instead of writing a
stop-gap parser: `cli.zig`, `Arguments.zig`, `bunfig.zig`, `run_command.zig`, `filter_run.zig`, `multi_run.zig`
and friends, ported to Zig 0.17, with `main.zig` calling `bun.cli.Cli.start` again. This removes the cause: zun now
parses argv with the same clap tables as Bun, so `-e`, `-p`, `-r`, `--config`, `--smol`, `--expose-gc` and unknown
Node flags behave as in Bun 1.3.14, a missing `--config` file is an error (exit 1), `execArgv` is split with the real
`auto_params` table again, and the `Bun__Node__*` globals are the real ones in `Arguments.zig` that the flags set.
Subcommands whose module isn't restored exit 1 with "not available in this zun build yet" (never a silent ignore).
zun-specific behaviour kept: `zunfig.toml` before `bunfig.toml`, zun identity for `--version`/`--revision`.

## Regression test

`test/js/node/test/parallel/test-zun-cli-flags.js`: `-e`, `--print`, `--expose-gc --smol -r <pre> file args`
with and without `run` (checks script args, `execArgv`, `gc`, the preload), `--config=<missing>` → exit 1 with and
without `run`, `--config=<file>` whose `[define]` reaches the script, `zun install` → "not available", and a
`fork()` child started with `execArgv: ["--config=…"]`. Fails on `build/snap-0a5b26b/zun-debug`, passes on the fix.

## Sibling search

Other places where cruller's cut turned a CLI-controlled behaviour into a constant (searched
`grep -rn 'bzrt' src`, the "cli" table in `docs/status/restore.md`, and `bun.cli.` uses in upstream outside `src/cli`):

- Fixed with this restore: `execArgv` value-flag map (`node_process.zig`), process title (`--title`),
  `getUseSystemCA`, the four `Bun__Node__*` globals, crash-handler command tag (`bun.cli.Cli.cmd`).
- Still constant, listed in `docs/status/restore.md` § cli as open: console depth (`--console-depth`,
  `ConsoleObject.zig`), `HotReload` (`--hot`/`--watch` reach `Command.HotReload` but `VirtualMachine.zig:56` still uses
  the `options_types` copy), `Bun.openInEditor` (`rare_data.zig`), the `[Bun.serve]` idle-timeout warning ignoring
  `--silent` (TQ-2 sibling), `Bun__githubURL`.
- bunfig `[install]` is parsed by nothing until `src/install` is restored (no consumer exists); recorded in
  restore.md, not silently dropped for a feature that exists.

## Lessons

- A launcher that "skips what it doesn't understand" turns misconfiguration into silent success. Unknown or
  unsupported inputs must fail loudly or be handled exactly as upstream does.
- Gate tests need at least one run of the real binary with flags in first position (now `test-zun-cli-flags.js`).
