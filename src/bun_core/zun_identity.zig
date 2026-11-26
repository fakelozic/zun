//! zun's identity rules, as pure functions (no `@import("bun")`), so they can be
//! unit-tested on their own: `zig test src/bun_core/zun_identity.zig`.
//!
//! The process-facing wrappers (that read the real environment and file system)
//! live in `zun.zig` next to this file and are exposed as `bun.zun`.
//! Every decision here is documented in `docs/identity.md`.

const std = @import("std");

/// Env-var prefixes. zun reads `ZUN_<X>` first and falls back to `BUN_<X>`.
pub const zun_env_prefix = "ZUN_";
pub const bun_env_prefix = "BUN_";

/// Name of zun's per-user root directory under `$HOME` (Bun uses `.bun`).
pub const home_dir_name = ".zun";
/// Name of the real Bun's per-user root. zun never writes there by default.
pub const bun_home_dir_name = ".bun";
/// Subdirectory name used under `$XDG_CACHE_HOME` / tmp dirs (Bun uses `bun`).
pub const cache_dir_name = "zun";
/// REPL history file name under `$HOME` (Bun 1.3.14: `.bun_repl_history`).
/// The REPL itself is cut until the CLI restore; this is the name it must use.
pub const repl_history_filename = ".zun_repl_history";

/// Per-project config file names, in lookup order: `zunfig.toml` wins,
/// `bunfig.toml` is the fallback when there is no `zunfig.toml` in the same directory.
pub const local_config_names = [_][:0]const u8{ "zunfig.toml", "bunfig.toml" };
/// Global (per-user) config file names, in lookup order. Bun 1.3.14 reads
/// `$XDG_CONFIG_HOME/.bunfig.toml`, else `$HOME/.bunfig.toml`.
pub const global_config_names = [_][:0]const u8{ ".zunfig.toml", ".bunfig.toml" };

/// For a `BUN_<X>` key, write `ZUN_<X>` (NUL-terminated) into `buf` and return it.
/// Returns null for keys that don't start with `BUN_` or don't fit in `buf`.
pub fn zunKeyFor(bun_key: []const u8, buf: []u8) ?[:0]const u8 {
    if (!std.mem.startsWith(u8, bun_key, bun_env_prefix)) return null;
    if (bun_key.len + 1 > buf.len) return null;
    @memcpy(buf[0..zun_env_prefix.len], zun_env_prefix);
    @memcpy(buf[zun_env_prefix.len..bun_key.len], bun_key[bun_env_prefix.len..]);
    buf[bun_key.len] = 0;
    return buf[0..bun_key.len :0];
}

/// Comptime version of `zunKeyFor`: `"BUN_X"` → `"ZUN_X"`.
pub fn comptimeZunKey(comptime bun_key: []const u8) [:0]const u8 {
    if (comptime !std.mem.startsWith(u8, bun_key, bun_env_prefix))
        @compileError("expected a BUN_ env var name, got " ++ bun_key);
    // `return` inside a `comptime { }` block is rejected here ("function called at
    // runtime cannot return value at comptime"); a `comptime` expression is fine.
    return comptime zun_env_prefix ++ bun_key[bun_env_prefix.len..];
}

/// The ZUN_-first lookup rule, independent of where values come from.
/// A `ZUN_<X>` that is set (even to "") wins over `BUN_<X>`, so `ZUN_X=` can
/// switch off a `BUN_X` inherited from the environment.
pub fn pickZunOrBun(zun_value: ?[]const u8, bun_value: ?[]const u8) ?[]const u8 {
    return zun_value orelse bun_value;
}

/// True when `path` is the real Bun's per-user root (`$HOME/.bun`) or inside it.
/// Used to refuse a `BUN_INSTALL`-style fallback that would make zun write into
/// the user's Bun install (Bun's installer exports `BUN_INSTALL=$HOME/.bun`).
pub fn isInsideRealBunHome(path: []const u8, home: ?[]const u8) bool {
    const h = std.mem.trimEnd(u8, home orelse return false, "/");
    if (h.len == 0) return false;
    const p = std.mem.trimEnd(u8, path, "/");
    if (!std.mem.startsWith(u8, p, h)) return false;
    const rest = p[h.len..];
    if (!std.mem.startsWith(u8, rest, "/" ++ bun_home_dir_name)) return false;
    const after = rest[1 + bun_home_dir_name.len ..];
    return after.len == 0 or after[0] == '/';
}

/// Where zun's install root comes from. Mirrors Bun 1.3.14's
/// `BUN_INSTALL` → `$XDG_CACHE_HOME/.bun` → `$HOME/.bun` order with zun names.
pub const InstallRoot = union(enum) {
    /// `$ZUN_INSTALL`, used as-is.
    zun_install: []const u8,
    /// `$BUN_INSTALL`, accepted because it does not point into `$HOME/.bun`.
    bun_install: []const u8,
    /// `$XDG_CACHE_HOME`, to be joined with `.zun`.
    xdg_cache: []const u8,
    /// `$HOME`, to be joined with `.zun`.
    home: []const u8,
    none,
};

pub const InstallEnv = struct {
    zun_install: ?[]const u8 = null,
    bun_install: ?[]const u8 = null,
    xdg_cache_home: ?[]const u8 = null,
    home: ?[]const u8 = null,
};

pub fn chooseInstallRoot(env: InstallEnv) InstallRoot {
    if (env.zun_install) |d| if (d.len > 0) return .{ .zun_install = d };
    if (env.bun_install) |d| if (d.len > 0 and !isInsideRealBunHome(d, env.home)) return .{ .bun_install = d };
    if (env.xdg_cache_home) |d| if (d.len > 0) return .{ .xdg_cache = d };
    if (env.home) |d| if (d.len > 0) return .{ .home = d };
    return .none;
}

/// `version` line printed by `zun --version`: `zun 0.1.0 (bun-compat 1.3.14)`.
pub fn versionLine(comptime zun_version: []const u8, comptime bun_compat_version: []const u8) []const u8 {
    return "zun " ++ zun_version ++ " (bun-compat " ++ bun_compat_version ++ ")";
}

test "zunKeyFor maps BUN_ to ZUN_" {
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings("ZUN_DEBUG_QUIET_LOGS", zunKeyFor("BUN_DEBUG_QUIET_LOGS", &buf).?);
    try std.testing.expectEqual(@as(u8, 0), zunKeyFor("BUN_X", &buf).?.ptr[5]);
    try std.testing.expect(zunKeyFor("HOME", &buf) == null);
    try std.testing.expect(zunKeyFor("NODE_ENV", &buf) == null);
    var tiny: [5]u8 = undefined;
    try std.testing.expect(zunKeyFor("BUN_ABC", &tiny) == null);
    try std.testing.expectEqualStrings("ZUN_", zunKeyFor("BUN_", &buf).?);
}

test "comptimeZunKey" {
    try std.testing.expectEqualStrings("ZUN_INSTALL", comptimeZunKey("BUN_INSTALL"));
}

test "pickZunOrBun: ZUN_ wins, even when empty" {
    try std.testing.expectEqualStrings("z", pickZunOrBun("z", "b").?);
    try std.testing.expectEqualStrings("", pickZunOrBun("", "b").?);
    try std.testing.expectEqualStrings("b", pickZunOrBun(null, "b").?);
    try std.testing.expect(pickZunOrBun(null, null) == null);
}

test "isInsideRealBunHome" {
    try std.testing.expect(isInsideRealBunHome("/home/u/.bun", "/home/u"));
    try std.testing.expect(isInsideRealBunHome("/home/u/.bun/", "/home/u/"));
    try std.testing.expect(isInsideRealBunHome("/home/u/.bun/install/cache", "/home/u"));
    try std.testing.expect(!isInsideRealBunHome("/home/u/.bunny", "/home/u"));
    try std.testing.expect(!isInsideRealBunHome("/home/u/.zun", "/home/u"));
    try std.testing.expect(!isInsideRealBunHome("/tmp/bun-test-123", "/home/u"));
    try std.testing.expect(!isInsideRealBunHome("/home/u/.bun", null));
}

test "chooseInstallRoot" {
    const home = "/home/u";
    try std.testing.expectEqualDeep(InstallRoot{ .zun_install = "/z" }, chooseInstallRoot(.{ .zun_install = "/z", .bun_install = "/b", .home = home }));
    try std.testing.expectEqualDeep(InstallRoot{ .bun_install = "/tmp/t" }, chooseInstallRoot(.{ .bun_install = "/tmp/t", .home = home }));
    // Bun's installer exports BUN_INSTALL=$HOME/.bun: never follow it.
    try std.testing.expectEqualDeep(InstallRoot{ .home = home }, chooseInstallRoot(.{ .bun_install = "/home/u/.bun", .home = home }));
    try std.testing.expectEqualDeep(InstallRoot{ .xdg_cache = "/c" }, chooseInstallRoot(.{ .xdg_cache_home = "/c", .home = home }));
    try std.testing.expectEqualDeep(InstallRoot.none, chooseInstallRoot(.{}));
    try std.testing.expectEqualDeep(InstallRoot{ .home = home }, chooseInstallRoot(.{ .zun_install = "", .home = home }));
}

test "versionLine" {
    try std.testing.expectEqualStrings("zun 0.1.0 (bun-compat 1.3.14)", versionLine("0.1.0", "1.3.14"));
}
