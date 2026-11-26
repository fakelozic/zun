pub const panic = _bun.crash_handler.panic;
pub const std_options = std.Options{
    .enable_segfault_handler = false,
    // Zig >= 0.16 std gives every std.Thread (and the main thread) a TLS alt signal stack. Under ASAN, ASAN
    // already gave the thread its own mmap'ed one and munmaps *whatever is current* at thread exit, so a second
    // owner makes ASAN unmap our TLS (TQ-3, docs/rca/TQ-3-worker-thread-exit-under-asan.md). ASAN builds keep
    // ASAN's alt stack (it reports stack overflows itself; crash_handler installs no SEGV handler under ASAN).
    // Other builds keep std's default, which the crash handler needs on Zig-spawned threads.
    .signal_stack_size = if (_bun.Environment.enable_asan) null else (std.Options{}).signal_stack_size,
};

pub const io_mode = .blocking;

comptime {
    _bun.assert(builtin.target.cpu.arch.endian() == .little);
}

pub extern "c" var _environ: ?*anyopaque;
pub extern "c" var environ: ?*anyopaque;

pub fn main(init: std.process.Init.Minimal) void {
    _bun.crash_handler.init();

    if (Environment.isPosix) {
        var act: _bun.sys.Sigaction = .{
            .handler = .{ .handler = std.posix.SIG.IGN },
            .mask = _bun.sys.sigemptyset(),
            .flags = 0,
        };
        _bun.sys.sigaction(@intFromEnum(std.posix.SIG.PIPE), &act, null);
        _bun.sys.sigaction(@intFromEnum(std.posix.SIG.XFSZ), &act, null);
    }

    if (Environment.isDebug) {
        _bun.debug_allocator_data.backing = .init;
    }

    // This should appear before we make any calls at all to libuv.
    // So it's safest to put it very early in the main function.
    if (Environment.isWindows) {
        _ = _bun.windows.libuv.uv_replace_allocator(
            &_bun.mimalloc.mi_malloc,
            &_bun.mimalloc.mi_realloc,
            &_bun.mimalloc.mi_calloc,
            &_bun.mimalloc.mi_free,
        );
        _bun.handleOom(_bun.windows.env.convertEnvToWTF8());
        environ = @ptrCast(std.os.environ.ptr);
        _environ = @ptrCast(std.os.environ.ptr);
    }

    _bun.start_time = blk: {
        var ts: std.c.timespec = undefined;
        if (std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts) != 0)
            if (std.c.clock_gettime(std.c.CLOCK.REALTIME, &ts) != 0)
                break :blk 0;
        break :blk @as(i128, ts.sec) * std.time.ns_per_s + @as(i128, ts.nsec);
    };
    _bun.initArgv(init.args) catch |err| {
        Output.panic("Failed to initialize argv: {s}\n", .{@errorName(err)});
    };

    Output.Source.Stdio.init();
    defer Output.flush();

    _bun.StackCheck.configureThread();
    _bun.ParentDeathWatchdog.install();

    // bzrt: src/cli/ (arg parsing, subcommands) is fully removed — minimal
    // process entrypoint per tz.md. argv[0] is the executable itself;
    // argv[1] is the pre-built entry file to run, except for the two
    // version-reporting flags the build system's own smoke test relies on.
    if (_bun.argv.len > 1 and _bun.strings.eqlComptime(_bun.argv[1], "--version")) {
        Output.writer().writeAll(_bun.zun.version_line ++ "\n") catch {};
        _bun.Global.exit(0);
    } else if (_bun.argv.len > 1 and _bun.strings.eqlComptime(_bun.argv[1], "--revision")) {
        Output.writer().writeAll(_bun.zun.revision_line ++ "\n") catch {};
        _bun.Global.exit(0);
    } else if (_bun.argv.len > 1) {
        // zun (RT-2): everything after the entry path goes to the script
        // (`process.argv.slice(2)`), as with `bun file.js a b`.
        const entry_index: usize = blk: {
            if (_bun.strings.eqlComptime(_bun.argv[1], "run")) {
                for (_bun.argv[2..], 2..) |arg, i| {
                    if (arg.len > 0 and arg[0] != '-') break :blk i;
                }
                Output.errGeneric("Usage: {s} run path/to/script.js", .{_bun.argv[0]});
                Output.flush();
                _bun.Global.exit(1);
            }
            break :blk 1;
        };
        const entry_path = _bun.argv[entry_index];
        // `[][:0]const u8` coerces to `[]const []const u8` (Zig 0.17.1, probe
        // docs/zig/probes/rt2-launcher/coerce.zig); `bun.argv` lives for the process.
        const passthrough: []const []const u8 = _bun.argv[entry_index + 1 ..];
        var runtime: Runtime = undefined;
        runtime.init(_bun.default_allocator) catch |err| {
            Output.panic("Failed to initialize runtime boundary: {s}\n", .{@errorName(err)});
        };
        defer runtime.deinit();
        runtime.loadEntryPath(entry_path, passthrough) catch |err| {
            Output.panic("Failed to load runtime entrypoint: {s}\n", .{@errorName(err)});
        };
        runtime.run() catch |err| {
            Output.panic("Failed to run entry file: {s}\n", .{@errorName(err)});
        };
    } else {
        Output.errGeneric("Usage: {s} path/to/script.js", .{if (_bun.argv.len > 0) _bun.argv[0] else "zun"});
        Output.flush();
        _bun.Global.exit(1);
    }
    _bun.Global.exit(0);
}

pub export fn Bun__panic(msg: [*]const u8, len: usize) noreturn {
    Output.panic("{s}", .{msg[0..len]});
}

// -- Zig Standard Library Additions --
pub fn copyForwards(comptime T: type, dest: []T, source: []const T) void {
    if (source.len == 0) {
        return;
    }
    _bun.copy(T, dest[0..source.len], source);
}
pub fn copyBackwards(comptime T: type, dest: []T, source: []const T) void {
    if (source.len == 0) {
        return;
    }
    _bun.copy(T, dest[0..source.len], source);
}
pub fn eqlBytes(src: []const u8, dest: []const u8) bool {
    return _bun.c.memcmp(src.ptr, dest.ptr, src.len) == 0;
}
// -- End Zig Standard Library Additions --

// Claude thinks its @import("root").bun when it's @import("bun").
const bun = @compileError("Deprecated: Use @import(\"bun\") instead");

const builtin = @import("builtin");
const std = @import("std");

const _bun = @import("bun");
const Runtime = _bun.rt.monolith.Runtime;
const Environment = _bun.Environment;
const Output = _bun.Output;
