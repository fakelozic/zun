// Probe (zig 0.17.1): facts used by the RT-2 / RT-1 launcher fixes.
// Run: zig test docs/zig/probes/rt2-launcher/coerce.zig
// Symbol check: zig build-obj docs/zig/probes/rt2-launcher/coerce.zig -femit-bin=/tmp/c.o && nm /tmp/c.o | grep zun_probe
//   -> "B zun_probe_flag" (BSS data symbol)
const std = @import("std");

test "a slice of sentinel slices coerces to a slice of plain slices" {
    // Verified 2026-11-26: this compiles and shares the memory (no copy needed).
    // The agent writing the RT-2 fix assumed it would not compile; it does.
    var storage = [_][:0]const u8{ "a", "b" };
    const argv: [][:0]const u8 = &storage;
    const plain: []const []const u8 = argv;
    try std.testing.expectEqualStrings("b", plain[1]);
    try std.testing.expectEqual(@intFromPtr(argv.ptr), @intFromPtr(plain.ptr));
}

// `export var` emits a data symbol (nm: B/D), which is what C's `extern bool x;` needs.
// An `export fn` with the same name emits a code symbol (nm: T), and C reading it as a
// bool reads the first instruction byte (the RT-1 bug).
export var zun_probe_flag: bool = false;

test "export var is a mutable data symbol" {
    zun_probe_flag = true;
    try std.testing.expect(zun_probe_flag);
}
