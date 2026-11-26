// Probe (zig 0.17.1): C enums whose value set can grow (brotli added error -17 in v1.2.1).
// Run: zig test docs/zig/probes/nonexhaustive-enum/enum.zig
const std = @import("std");

const Exhaustive = enum(c_int) { a = -1, b = -2 };
const Open = enum(c_int) { a = -1, b = -2, _ };

test "a non-exhaustive enum accepts unnamed values from @enumFromInt" {
    const v: Open = @enumFromInt(-17);
    try std.testing.expectEqual(@as(c_int, -17), @intFromEnum(v));
    // std.enums.tagName returns null for unnamed values (no panic), unlike @tagName.
    try std.testing.expect(std.enums.tagName(Open, v) == null);
    try std.testing.expectEqualStrings("a", std.enums.tagName(Open, .a).?);
}

test "switch on a non-exhaustive enum needs `_` (or else)" {
    const v: Open = @enumFromInt(-17);
    const r = switch (v) {
        .a, .b => "named",
        _ => "unnamed",
    };
    try std.testing.expectEqualStrings("unnamed", r);
}

test "std.enums.values lists only the named fields" {
    try std.testing.expectEqual(@as(usize, 2), std.enums.values(Open).len);
}

// @enumFromInt(-17) on `Exhaustive` is illegal behaviour: a safety panic in Debug/ReleaseSafe
// ("invalid enum value"), undefined in ReleaseFast. Not run here because it panics.
comptime {
    _ = Exhaustive;
}
