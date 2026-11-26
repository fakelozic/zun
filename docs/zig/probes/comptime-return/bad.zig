//! Zig 0.17.1 rejects this: `return` inside a `comptime { }` block of a function that is
//! called at runtime. Error: "function called at runtime cannot return value at comptime".
const std = @import("std");

fn prefixed(comptime key: []const u8) [:0]const u8 {
    comptime {
        return "ZUN_" ++ key[4..];
    }
}

test "bad" {
    try std.testing.expectEqualStrings("ZUN_X", prefixed("BUN_X"));
}
