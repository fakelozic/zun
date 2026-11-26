//! Zig 0.17.1: does `@import` of a file that does not exist fail even inside a
//! dead `comptime` branch? (run.sh checks the answer)
const std = @import("std");
const enabled = false;
const Shell = if (enabled) @import("does_not_exist.zig") else struct {};
test "x" {
    _ = Shell;
}
