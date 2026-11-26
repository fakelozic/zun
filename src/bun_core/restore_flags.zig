//! Compile-time gates for Bun 1.3.14 modules that zun has not restored yet.
//! Design and rules: docs/status/restore.md, "Gates".
//!
//! A call site that needs a missing module is written as
//!
//!     if (comptime bun.restore_flags.shell) bun.shell.exec(ctx) else bun.restore_flags.cliUnavailable("zun exec");
//!
//! The `comptime`-false branch is never analysed, so it may name `bun.shell` even though that
//! decl does not exist yet (docs/zig/probes/comptime-gate). It must never `@import` a file that is
//! not in the tree: Zig 0.17 loads every imported file eagerly, even from dead code.
//!
//! When a module lands, delete its flag here and every `if (comptime bun.restore_flags.<m>)` around
//! its call sites in the same commit (the compiler then finds any leftover use). `md` landed first
//! and never needed a flag.

/// `src/cli` (argument parsing, subcommand dispatch). Roadmap Phase 4 item 3.
pub const cli = false;
/// `src/test_runner` + `zun test` + `bun:test`. Item 4.
pub const test_runner = false;
/// `src/js_parser_jsc` + `Bun.Transpiler`. Item 5.
pub const transpiler_api = false;
/// `src/shell` + `src/shell_parser` (`Bun.$`, `zun exec`, `--shell=bun`). Item 6.
pub const shell = false;
/// `src/libarchive` + `Bun.Archive`. Item 7.
pub const libarchive = false;
/// `src/patch`. Item 7.
pub const patch = false;
/// `src/install` (package manager, lockfile, bunfig `[install]`). Item 8.
pub const install = false;
/// `src/css` (+ `Bun.color`). Item 9.
pub const css = false;
/// Full `src/bundler` (`zun build`, `Bun.build`). Item 10.
pub const bundler = false;
/// `src/standalone_graph` (`--compile`). Item 10.
pub const standalone = false;
/// `src/bake` DevServer. Item 10.
pub const bake = false;
/// `src/napi`. Item 11.
pub const napi = false;
/// `src/sql` (`bun:sql`). Item 11.
pub const sql = false;

/// For CLI commands and flags whose module is not restored: print one line and exit 1.
/// JS-facing APIs keep throwing a JS exception instead (see `BunObject.cutFeatureCallback`).
pub fn cliUnavailable(comptime what: []const u8) noreturn {
    bun.Output.errGeneric("'" ++ what ++ "' is not available in this zun build yet (Bun 1.3.14 restore pending, see docs/status/restore.md)", .{});
    bun.Output.flush();
    bun.Global.exit(1);
}

const bun = @import("bun");
