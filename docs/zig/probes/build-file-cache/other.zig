const std = @import("std");
pub fn build(b: *std.Build) void {
    _ = b.step("from-other-zig", "declared in other.zig");
}
