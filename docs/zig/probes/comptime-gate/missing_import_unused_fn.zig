//! Zig 0.17.1: `@import` of a missing file inside a function nobody calls.
const std = @import("std");
fn neverCalled() void {
    _ = @import("does_not_exist.zig");
}
test "x" {}
