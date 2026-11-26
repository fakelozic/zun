// Probe: does `zig build --build-file other.zig` share the configure cache with build.zig?
// Run: sh docs/zig/probes/build-file-cache/run.sh   (expects the bug on 0.17.1, see lessons.md)
const std = @import("std");
pub fn build(b: *std.Build) void {
    _ = b.step("from-build-zig", "declared in build.zig");
}
