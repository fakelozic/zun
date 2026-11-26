//! Zig 0.17.1: a `comptime`-false branch is not analysed, so it may name a decl
//! that does not exist (`root.not_restored_yet`). This is what lets zun gate
//! not-yet-restored CLI commands with one flag per module.
const std = @import("std");
const flags = struct {
    pub const shell = false;
};
const root = struct {
    pub const md = struct {
        pub fn run() u8 {
            return 1;
        }
    };
    // no `not_restored_yet` decl at all
};

fn dispatch(comptime which: enum { md, shell }) u8 {
    return switch (which) {
        .md => root.md.run(),
        .shell => if (comptime flags.shell) root.not_restored_yet.run() else 0,
    };
}

test "dead comptime branch may name a missing decl" {
    try std.testing.expectEqual(@as(u8, 1), dispatch(.md));
    try std.testing.expectEqual(@as(u8, 0), dispatch(.shell));
}
