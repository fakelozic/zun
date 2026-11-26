//! Probes for cheatsheet claims that basics.zig / std-0.17.zig don't cover.
//! Run: zig test docs/zig/probes/reflection-io.zig
const std = @import("std");
const testing = std.testing;

test "bit sets: Integer/Static/Array use .empty; Dynamic still uses initEmpty(alloc, n)" {
    var i: std.bit_set.Integer(8) = .empty;
    i.set(1);
    var s: std.bit_set.Static(100) = .full;
    s.unset(0);
    var a: std.bit_set.Array(usize, 100) = .empty; // Array takes (MaskInt, size)
    a.set(99);
    var d: std.bit_set.Dynamic = try .initEmpty(testing.allocator, 10);
    defer d.deinit(testing.allocator);
    d.set(9);
    try testing.expect(i.isSet(1) and !s.isSet(0) and a.isSet(99) and d.isSet(9));
}

test "Future.cancel and Io.Threaded single-threaded fallback" {
    const io = testing.io;
    var f = io.async(double, .{@as(u32, 4)});
    try testing.expectEqual(@as(u32, 8), f.cancel(io)); // cancel == await + cancel request
    var t: std.Io.Threaded = .init_single_threaded;
    _ = t.io();
}
fn double(x: u32) u32 {
    return x * 2;
}

test "@divCeil, @backingInt, @fromBackingInt" {
    try testing.expectEqual(2, @divCeil(5, 3));
    try testing.expectEqual(-1, @divCeil(-5, 3));
    const P = packed struct(u8) { lo: u4, hi: u4 };
    const p: P = .{ .lo = 1, .hi = 2 };
    try testing.expectEqual(@as(u8, 0x21), @backingInt(p));
    const q: P = @fromBackingInt(@as(u8, 0x43));
    try testing.expectEqual(@as(u4, 3), q.lo);
}

test "SoA @typeInfo for enum, fn, pointer" {
    const E = enum(u8) { a = 1, b = 5 };
    const ei = @typeInfo(E).@"enum";
    try testing.expectEqualStrings("b", ei.field_names[1]);
    try testing.expectEqual(5, ei.field_values[1]);
    const fi = @typeInfo(@TypeOf(double)).@"fn";
    try testing.expect(fi.param_types[0].? == u32);
    try testing.expect(fi.return_type.? == u32);
    const pi = @typeInfo(*const u16).pointer;
    try testing.expect(pi.size == .one and pi.attrs.@"const" and pi.child == u16);
}

test "{q} quotes strings; @ptrCast to *align(1) for extern-struct punning" {
    var buf: [32]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try w.print("{q}", .{"a\"b"});
    try testing.expectEqualStrings("\"a\\\"b\"", w.buffered());

    const TwoBytes = extern struct { b0: u8, b1: u8 };
    const bytes: TwoBytes = .{ .b0 = 0x12, .b1 = 0xAB };
    const int_ptr: *align(1) const u16 = @ptrCast(&bytes);
    if (@import("builtin").target.cpu.arch.endian() == .little) try testing.expectEqual(@as(u16, 0xAB12), int_ptr.*);
}

test "@FieldType (exists; predates 0.15)" {
    const S = struct { x: u32 };
    try testing.expect(@FieldType(S, "x") == u32);
}
