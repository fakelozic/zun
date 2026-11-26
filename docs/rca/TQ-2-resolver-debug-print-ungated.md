# TQ-2: debug builds print `DEBUG: Resolving …` on every module resolve

- **Status:** fixed in the commit that adds this file (`fix(resolver): TQ-2 …`).
- **Severity:** medium, test-infrastructure. Debug builds only (see "Release builds" below), not security-relevant:
  no data is exposed beyond the import path and directory the process already knows.
  It broke every parity test that reads a child process's stdout/stderr (≥23, cluster 5 in `docs/status/parity.md`).
- **Found by / date:** parity triage (row TQ-2 in `docs/status/triage.md`), 2026-11-26. RCA on `wp/cli-core`.

## Symptom

```sh
$ printf 'require("node:path"); console.log("ok")\n' > q.js
$ BUN_DEBUG_QUIET_LOGS=1 build/snap-0a5b26b/zun-debug q.js
DEBUG: Resolving /tmp/claude-1000/q.js from /tmp      # on stderr, once per resolve
ok
```

`BUN_DEBUG_QUIET_LOGS=1` silences the scoped `[sys]`/`[fs]` logs but not this line, because it is not a scoped log:
it is `Output.debug`, which prints unconditionally in debug builds. Any test that spawns a child and compares its
output (`assert.strictEqual(stderr, "")`, exact stdout match) failed.

## Root cause

`src/resolver/resolver.zig` (`Resolver.resolveAndAutoInstall`, ~line 657). Upstream Bun 1.3.14:

```zig
if (Environment.show_crash_trace and bun.cli.debug_flags.hasResolveBreakpoint(import_path)) {
    bun.Output.debug("Resolving <green>{s}<r> from <blue>{s}<r>", .{ import_path, source_dir });
    @breakpoint();
}
```

`hasResolveBreakpoint` returns true only when the developer passed `--breakpoint-resolve <substring>` and the import
path contains it (`src/cli/cli.zig:35`, `Arguments.zig:1702`), so upstream prints and traps only on demand.

History in this repo (`git log -S'hasResolveBreakpoint' -- src/resolver/resolver.zig`,
`git log -G'BUN_DEBUG_BREAK_ON_RESOLVE' -- src/resolver/resolver.zig`):

1. `a1c009d` (cruller, "bzrt: strip Bun 1.3.14 to thin zig 0.16 runtime (WIP)") imported the upstream form unchanged.
2. `3d5c916` (cruller, "0 errors") cut `src/cli`, so `bun.cli.debug_flags` no longer existed. To make it compile the
   condition was shortened to `if (Environment.show_crash_trace)`: the **gate** was deleted, not replaced. From then on
   every resolve in a debug build printed the line **and** hit `@breakpoint()` (SIGTRAP, exit 133 with no debugger).
3. `a2ab295` (cruller, "recovery parser") noticed the SIGTRAP and wrapped only the `@breakpoint()` in
   `if (bun.env_var.BUN_DEBUG_BREAK_ON_RESOLVE.get())`, leaving the print un-gated. That is the state zun forked.

So the cause is a compile-fix that deleted a condition whose operand had gone away, then a second fix that restored
half of the behaviour (the visible crash) and not the other half (the print).

### Release builds

`Environment.show_crash_trace = isDebug or isTest or enable_asan` (`src/bun_core/env.zig:31`), and `Output.debug`
returns immediately unless `Environment.isDebug` (`src/bun_core/output.zig:789`). A release build therefore never
printed the line. A release **ASan** build compiles the block in but `Output.debug` is a no-op there; the breakpoint
was already behind the env var. Only debug builds were affected.

## Why it wasn't caught

- Gate tests check exit status and their own assertions, never that a child's stderr is empty.
- The scoped-log noise of debug builds (`[sys] …`) made extra stderr lines look normal, and `BUN_DEBUG_QUIET_LOGS=1`
  was assumed to silence all debug output; nobody checked that `Output.debug` is not a scoped log.
- Nothing flagged that `3d5c916` changed a condition rather than a call: "make it compile" edits around cut
  subsystems were not reviewed for lost gates.

## Fix

Both the print and the breakpoint are again under one gate, the opt-in `BUN_DEBUG_BREAK_ON_RESOLVE` (the stand-in for
`--breakpoint-resolve` while `src/cli` is not restored):

```zig
if (Environment.show_crash_trace and bun.env_var.BUN_DEBUG_BREAK_ON_RESOLVE.get()) {
    bun.Output.debug(...);
    @breakpoint();
}
```

This restores upstream's semantics (print only together with the breakpoint, only on developer request) rather than
filtering the line out of test output. Verified: with `BUN_DEBUG_BREAK_ON_RESOLVE=1` the line prints and the process
traps (exit 133); without it nothing prints.

**Follow-up (R2), done in the CLI-restore commit:** with `bun.cli.debug_flags` back, the gate is upstream's
`bun.cli.debug_flags.hasResolveBreakpoint(import_path)` (per-path, from `--breakpoint-resolve`), with
`BUN_DEBUG_BREAK_ON_RESOLVE` kept as an extra opt-in for every resolve.

## Regression test

`test/js/node/test/parallel/test-zun-no-resolve-debug-log.js`: spawns the runtime on an entry that does a relative
`require`, a `node:` builtin and a dynamic `import()`, with and without `BUN_DEBUG_QUIET_LOGS=1` and with
`BUN_DEBUG_BREAK_ON_RESOLVE` removed, and asserts that `Resolving` never appears and that (quiet) stdout is exactly
`ok 42`. Fails on `build/snap-0a5b26b/zun-debug` (unfixed, `AssertionError` on the `doesNotMatch`), passes on the fix.

## Sibling search

Searched `src/` for (a) other places where cruller deleted a `bun.cli.*` operand from a condition, and (b) other
un-gated debug prints on hot paths.

- `grep -rn 'debug_flags\|bun\.cli\.' <bun-1.3.14>/src` outside `src/cli`, compared with zun:
  - **`src/runtime/server/server.zig:1747-1760`, same pattern, left open:** upstream gates the development-mode
    "`[Bun.serve]: request timed out after 10 seconds`" warning on `!bun.cli.Command.get().debug.silent`; cruller
    dropped that operand, so `--silent` can't suppress it. It is user-facing (not debug-build-only) and needs
    `Command.get()` back, so it is fixed with R2 (CLI restore), listed here and in the TQ-2 triage row.
  - `node_process.zig` (`auto_params`), `HTMLBundle.zig` (`serve_*` args), `VirtualMachine.zig` (hot reload, debugger),
    `Debugger.zig` (`start_time`): not prints; they are part of the R2 restore, no lost gate that prints.
- `grep -rn 'std\.debug\.print(' src` → only a doc comment (`ptr/ref_count.zig:29`) and the uucode build script.
- `grep -rn 'std\.log\.' src` → only uucode table self-checks (build/test time).
- `grep -rn 'Output\.debug(' src` → five sites; all are debug-build only by construction (`Output.debug` checks
  `isDebug`) and match upstream: `js_parser/runtime.zig:7` (prints once, fallback bundle), `VirtualMachine.zig:796`
  (`--watch` reload), `picohttp.zig:311` (malformed response, `allow_assert` only), `dns.zig:29` (macOS only), and this
  one. No other hot-path print found.

## Lessons

- When cutting a subsystem, a condition operand that referenced it must be **replaced with an equivalent gate or
  `false`**, never deleted: deleting it turns "on demand" into "always". Upstream defaults for removed debug flags
  are all "off".
- `BUN_DEBUG_QUIET_LOGS` only silences scoped logs (`Output.scoped`); `Output.debug` ignores it. Added to
  `docs/zig/lessons.md`.
