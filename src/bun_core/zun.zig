//! `bun.zun`: zun's identity, wired to the real environment and file system.
//!
//! The rules themselves are pure functions in `zun_identity.zig` (unit-tested with
//! `zig test src/bun_core/zun_identity.zig`). Decisions: `docs/identity.md`.
//!
//! - Env vars: `bun.getenvZ("BUN_X")` (and so every `bun.env_var.BUN_*`) reads
//!   `ZUN_X` first. Env-map reads (`.env` files included) use
//!   `Loader.getZunOrBun` / `Map.getZunOrBun`. JS `process.env` is untouched.
//! - Default dirs: `installRoot` (never `~/.bun`), `transpilerCacheDir`.
//! - Config: `findLocalConfig` / `findGlobalConfig` (`zunfig.toml`, else `bunfig.toml`).

pub const identity = @import("./zun_identity.zig");

pub const name = "zun";
/// zun's own version (`process.versions.zun`). Source of truth: `build.zig`, option `zun_version`.
pub const version: [:0]const u8 = bun.Environment.zun_version_string;
/// `zun --version`: `zun 0.1.0 (bun-compat 1.3.14)`.
pub const version_line = identity.versionLine(version, bun.Environment.version_string);
/// `zun --revision`: `zun 0.1.0+<sha9> (bun-compat 1.3.14)`; `-debug` on debug builds.
pub const revision_line = "zun " ++ version ++
    (if (bun.Environment.isDebug) "-debug" else "") ++
    (if (bun.Environment.git_sha_short.len > 0) "+" ++ bun.Environment.git_sha_short else "") ++
    " (bun-compat " ++ bun.Environment.version_string ++ ")";

/// Read the process environment for `key` with no ZUN_/BUN_ fallback.
pub fn getenvRaw(key: [:0]const u8) ?[]const u8 {
    return bun.getenvZRaw(key);
}

/// Where zun keeps per-user state (install cache, global packages, bins).
/// `$ZUN_INSTALL` → `$BUN_INSTALL` (unless it points into `$HOME/.bun`) →
/// `$XDG_CACHE_HOME/.zun` → `$HOME/.zun`. Returns null when none is known.
pub fn installRoot(buf: *bun.PathBuffer) ?[:0]const u8 {
    const choice = identity.chooseInstallRoot(.{
        .zun_install = getenvRaw("ZUN_INSTALL"),
        .bun_install = getenvRaw("BUN_INSTALL"),
        .xdg_cache_home = bun.env_var.XDG_CACHE_HOME.get(),
        .home = bun.env_var.HOME.get(),
    });
    return switch (choice) {
        .zun_install, .bun_install => |dir| bun.path.joinAbsStringBufZ(dir, buf, &.{}, .auto),
        .xdg_cache, .home => |dir| bun.path.joinAbsStringBufZ(dir, buf, &.{identity.home_dir_name}, .auto),
        .none => null,
    };
}

/// `installRoot()` joined with `parts`, e.g. `&.{ "install", "cache" }`.
pub fn installSubpath(buf: *bun.PathBuffer, parts: []const []const u8) ?[:0]const u8 {
    var root_buf: bun.PathBuffer = undefined;
    const root = installRoot(&root_buf) orelse return null;
    return bun.path.joinAbsStringBufZ(root, buf, parts, .auto);
}

/// Return the first of `names` that exists as a file in `dir`.
pub fn findConfigInDir(dir: []const u8, names: []const [:0]const u8, buf: *bun.PathBuffer) ?[:0]const u8 {
    for (names) |config_name| {
        const path = bun.path.joinAbsStringBufZ(dir, buf, &.{config_name}, .auto);
        if (bun.sys.existsZ(path)) return path;
    }
    return null;
}

/// Per-project config: `<cwd>/zunfig.toml`, else `<cwd>/bunfig.toml`
/// (Bun 1.3.14 only looks in the cwd, it does not walk up).
pub fn findLocalConfig(cwd: []const u8, buf: *bun.PathBuffer) ?[:0]const u8 {
    return findConfigInDir(cwd, &identity.local_config_names, buf);
}

/// Global config: `$XDG_CONFIG_HOME/.zunfig.toml` (else `.bunfig.toml` there); without
/// `XDG_CONFIG_HOME`, the same two names in `$HOME`. Same directory choice as Bun 1.3.14.
pub fn findGlobalConfig(buf: *bun.PathBuffer) ?[:0]const u8 {
    const dir = bun.env_var.XDG_CONFIG_HOME.get() orelse bun.env_var.HOME.get() orelse return null;
    return findConfigInDir(dir, &identity.global_config_names, buf);
}

const bun = @import("bun");
