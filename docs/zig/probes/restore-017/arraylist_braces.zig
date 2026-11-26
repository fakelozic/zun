//! 0.17.1: `std.ArrayList(T)` (unmanaged) cannot be initialised with `.{}` any more.
const std = @import("std");
test "x" {
    var l: std.ArrayList(u8) = .{};
    _ = &l;
}
