const std = @import("std");

const Point = struct {
    x: i32,
    y: i32,
    pub fn format(self: Point, w: *std.Io.Writer) std.Io.Writer.Error!void {
        try w.print("({d},{d})", .{ self.x, self.y });
    }
};

test "ArrayList is unmanaged; .empty + allocator per call" {
    const gpa = std.testing.allocator;
    var list: std.ArrayList(u8) = .empty;
    defer list.deinit(gpa);
    try list.appendSlice(gpa, "hello");
    try list.append(gpa, '!');
    try std.testing.expectEqualStrings("hello!", list.items);
}

test "HashMap unmanaged" {
    const gpa = std.testing.allocator;
    var m: std.StringHashMapUnmanaged(u32) = .empty;
    defer m.deinit(gpa);
    try m.put(gpa, "a", 1);
    try std.testing.expectEqual(@as(?u32, 1), m.get("a"));
}

test "format method uses {f}; fixed Writer to buffer" {
    var buf: [64]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try w.print("p={f}", .{Point{ .x = 1, .y = 2 }});
    try std.testing.expectEqualStrings("p=(1,2)", w.buffered());
}

test "allocPrint" {
    const gpa = std.testing.allocator;
    const s = try std.fmt.allocPrint(gpa, "{d}-{s}", .{ 7, "x" });
    defer gpa.free(s);
    try std.testing.expectEqualStrings("7-x", s);
}

test "Allocating writer" {
    const gpa = std.testing.allocator;
    var aw: std.Io.Writer.Allocating = .init(gpa);
    defer aw.deinit();
    try aw.writer.print("{s}{d}", .{ "n", 42 });
    try std.testing.expectEqualStrings("n42", aw.written());
}

test "@Int and typeInfo" {
    const U = @Int(.unsigned, 12);
    try std.testing.expectEqual(12, @bitSizeOf(U));
    const info = @typeInfo(Point).@"struct";
    try std.testing.expectEqual(2, info.field_names.len);
    try std.testing.expectEqualStrings("x", info.field_names[0]);
}

test "Io file read/write via testing.io and tmpDir" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = "a.txt", .data = "zun" });
    const gpa = std.testing.allocator;
    const data = try tmp.dir.readFileAlloc(io, "a.txt", gpa, .limited(1024));
    defer gpa.free(data);
    try std.testing.expectEqualStrings("zun", data);
}
