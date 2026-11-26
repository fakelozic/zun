const std = @import("std");
const Io = std.Io;

test "Allocator.print replaces fmt.allocPrint" {
    const gpa = std.testing.allocator;
    const s = try gpa.print("{s}={d}", .{ "k", 3 });
    defer gpa.free(s);
    try std.testing.expectEqualStrings("k=3", s);
}

test "mem find/cut naming" {
    try std.testing.expectEqual(@as(?usize, 2), std.mem.find(u8, "abcd", "cd"));
    try std.testing.expectEqual(@as(?usize, 1), std.mem.findScalar(u8, "abcd", 'b'));
    const kv = std.mem.cutScalar(u8, "key=val", '=').?;
    try std.testing.expectEqualStrings("key", kv[0]);
    try std.testing.expectEqualStrings("val", kv[1]);
    try std.testing.expectEqualStrings("bar", std.mem.cutPrefix(u8, "foobar", "foo").?);
}

test "@splat replaces array ** n" {
    const a: [4]u8 = @splat(7);
    try std.testing.expectEqual(@as(u8, 7), a[3]);
}

test "ArrayList.last" {
    const gpa = std.testing.allocator;
    var l: std.ArrayList(u32) = .empty;
    defer l.deinit(gpa);
    try std.testing.expectEqual(@as(?u32, null), l.last());
    try l.append(gpa, 5);
    try std.testing.expectEqual(@as(u32, 5), l.last().?);
}

test "BufferFirstAllocator (was StackFallbackAllocator)" {
    var buf: [256]u8 = undefined;
    var sfa: std.heap.BufferFirstAllocator = .init(&buf, std.testing.allocator);
    const a = sfa.allocator();
    const x = try a.alloc(u8, 16);
    a.free(x);
}

test "array_hash_map.String / Auto" {
    const gpa = std.testing.allocator;
    var m: std.array_hash_map.String(u8) = .empty;
    defer m.deinit(gpa);
    try m.put(gpa, "a", 1);
    var n: std.array_hash_map.Auto(u32, u8) = .empty;
    defer n.deinit(gpa);
    try n.put(gpa, 9, 1);
    try std.testing.expectEqual(@as(usize, 1), m.count() + n.count() - 1);
}

test "Io.Mutex + io.async/await + Group" {
    const io = std.testing.io;
    var mutex: Io.Mutex = .init;
    var total: u32 = 0;
    var g: Io.Group = .init;
    defer g.cancel(io);
    for (0..4) |i| g.async(io, addTo, .{ io, &mutex, &total, @as(u32, @intCast(i)) });
    try g.await(io);
    try std.testing.expectEqual(@as(u32, 6), total);
    var f = io.async(square, .{@as(u32, 9)});
    try std.testing.expectEqual(@as(u32, 81), f.await(io));
}
fn addTo(io: Io, m: *Io.Mutex, t: *u32, v: u32) void {
    m.lockUncancelable(io);
    defer m.unlock(io);
    t.* += v;
}
fn square(x: u32) u32 {
    return x * x;
}

test "bit_set.Integer.empty, EnumSet.empty" {
    var s: std.bit_set.Integer(8) = .empty;
    s.set(3);
    try std.testing.expect(s.isSet(3));
    const E = enum { a, b };
    var es: std.enums.EnumSet(E) = .empty;
    es.insert(.b);
    try std.testing.expect(es.contains(.b));
}

test "Optimize rename + std.lang" {
    const m: std.lang.Optimize = .debug;
    _ = m;
    try std.testing.expect(@hasDecl(std, "lang"));
}

test "@Struct builds a type" {
    const names = [_][]const u8{ "a", "b" };
    const types = [_]type{ u8, u16 };
    const attrs: [2]std.lang.Type.Struct.FieldAttributes = @splat(.{});
    const S = @Struct(.auto, null, &names, &types, &attrs);
    const v: S = .{ .a = 1, .b = 2 };
    try std.testing.expectEqual(@as(u16, 2), v.b);
}
