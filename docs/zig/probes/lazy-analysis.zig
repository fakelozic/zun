//! Zig 0.17.1: functions nothing references are not analysed, so even a type error
//! in one does not fail the build. `zig test docs/zig/probes/lazy-analysis.zig` passes.
const std = @import("std");

fn neverCalled() void {
    const x: u8 = "not a u8"; // would be a compile error if analysed
    _ = x;
}

test "unreferenced function with a type error still compiles" {
    try std.testing.expect(true);
}
