//! What the codemod produces instead (`scripts/fix_zig017.ts`: private-field, arraylist-empty).
const std = @import("std");
const S = struct {
    priv_n: u32 = 0,
    list: std.ArrayList(u8) = .empty,
    aligned: std.array_list.Aligned(u8, .@"4") = .empty,
};
test "priv_ field and .empty" {
    var s: S = .{};
    defer s.list.deinit(std.testing.allocator);
    try s.list.append(std.testing.allocator, 'a');
    var segs: [2]std.ArrayList(u8) = undefined;
    @memset(&segs, .empty); // arrays of lists: `.empty`, not `.{}`
    try std.testing.expectEqual(@as(usize, 1), s.list.items.len);
    try std.testing.expectEqual(@as(u32, 0), s.priv_n);
}
