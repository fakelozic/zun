//! Probes for the Zig 0.16 -> 0.17 migration (scripts/fix_zig017.ts, docs/status/zig-017.md).
//! Run: zig test docs/zig/probes/migration-017.zig
const std = @import("std");
const testing = std.testing;

// --- `**` is gone: replacements -------------------------------------------------

/// Same helper as `bun.strings.repeatComptime` (src/string/immutable.zig).
inline fn repeatComptime(comptime s: []const u8, comptime n: usize) *const [s.len * n:0]u8 {
    return comptime blk: {
        var buf: [s.len * n:0]u8 = undefined;
        for (0..n) |i| @memcpy(buf[i * s.len ..][0..s.len], s);
        const final = buf;
        break :blk &final;
    };
}

test "repeatComptime replaces \"ab\" ** n, keeps the sentinel, and works with ++" {
    const r = repeatComptime("ab", 3);
    try testing.expectEqualStrings("ababab", r);
    try testing.expectEqual(0, r[r.len]); // sentinel is set
    // `++` needs comptime-known operands; works because the fn is `inline`.
    const line = repeatComptime("=", 4) ++ "\n";
    try testing.expectEqualStrings("====\n", line);
    const typed: *const [5]u8 = repeatComptime(" ", 5); // coerces like the old literal
    try testing.expectEqual(5, typed.len);
}

test "@splat replaces [_]T{x} ** n" {
    var a: [4]u8 = @splat(7); // result type from the declaration
    a[0] = 1;
    try testing.expectEqualSlices(u8, &.{ 1, 7, 7, 7 }, &a);
    const b = @as([3]bool, @splat(false)); // no declared type: spell it with @as
    try testing.expectEqual(false, b[2]);
    const c: [2][4]u8 = @splat(.{ 0, 0, 0, 255 }); // element can itself be an aggregate
    try testing.expectEqual(255, c[1][3]);
    const S = struct { buf: [3]u8 = @splat(0) }; // also fine as a field default
    try testing.expectEqual(0, (S{}).buf[2]);
}

// --- inline vs non-inline for comptime-only results -------------------------------

const F = struct { name: []const u8, type: type };
fn plainFields(comptime T: type) []const F {
    return comptime blk: {
        const out = [_]F{.{ .name = @typeName(T), .type = T }};
        break :blk &out;
    };
}
inline fn inlineFields(comptime T: type) []const F {
    return comptime blk: {
        const out = [_]F{.{ .name = @typeName(T), .type = T }};
        break :blk &out;
    };
}

test "a slice of comptime-only structs from a non-inline call is runtime-known" {
    // `const fs = plainFields(u8); fs[0].type` fails: "cannot load comptime-only
    // type 'type' ... pointer is runtime-known" (same on 0.16). Fixes: call it with
    // `comptime`, or make the helper `inline` (what bun.meta.fieldsOf does).
    const a = comptime plainFields(u8);
    try testing.expect(a[0].type == u8);
    const b = inlineFields(u8);
    try testing.expect(b[0].type == u8);
}

// --- @typeInfo is struct-of-arrays -------------------------------------------------

test "struct/enum/fn reflection shapes on 0.17" {
    const S = struct { a: u8 = 1, b: u16 align(4) };
    const info = @typeInfo(S).@"struct";
    try testing.expectEqualStrings("b", info.field_names[1]);
    try testing.expect(info.field_types[1] == u16);
    try testing.expectEqual(null, info.field_attrs[0].@"align"); // natural alignment -> null
    try testing.expectEqual(4, info.field_attrs[1].@"align".?);
    try testing.expectEqual(1, info.field_attrs[0].defaultValue(u8).?);

    const E = enum { x, y };
    try testing.expectEqual(1, @typeInfo(E).@"enum".field_values[1]);

    const P = @typeInfo(*const u8).pointer;
    try testing.expect(P.attrs.@"const");
    try testing.expectEqual(null, P.attrs.@"align"); // natural alignment -> null
    try testing.expectEqual(2, @typeInfo(*align(2) u8).pointer.attrs.@"align".?);
}

test "Fn info: varargs and callconv live in attrs" {
    const Fn = @typeInfo(fn (fmt: [*:0]const u8, ...) callconv(.c) c_int).@"fn";
    try testing.expect(Fn.attrs.varargs);
    try testing.expect(std.meta.eql(Fn.attrs.@"callconv", std.lang.CallingConvention.c)); // .c is a decl (union value), not a tag
    try testing.expect(Fn.param_types[0] != null);
}

// --- @hasDecl sees only pub decls ---------------------------------------------------

const HasDecl = struct {
    pub const visible = 1;
    const hidden = 2;
};
test "@hasDecl is false for a non-pub decl, even in the same file" {
    try testing.expect(@hasDecl(HasDecl, "visible"));
    try testing.expect(!@hasDecl(HasDecl, "hidden"));
    try testing.expect(HasDecl.hidden == 2); // still accessible by name in this file
}

// --- Optimize ----------------------------------------------------------------------

test "std.lang.Optimize: new tags; old names are decls, not tags" {
    const m: std.lang.Optimize = .debug;
    try testing.expect(m == .debug);
    try testing.expect(m == std.lang.Optimize.Debug); // deprecated decl, still compares
    try testing.expectEqual(.fast, std.lang.Optimize.fromString("ReleaseFast").?);
}

// --- More std/language moves found while porting zun (docs/status/zig-017.md) -----

test "ArrayList has a non-defaulted pointer_stability field: literals must set it" {
    // `.{ .items = &.{}, .capacity = 0 }` is "missing struct field: pointer_stability".
    var l: std.ArrayList(u8) = .{ .items = &.{}, .capacity = 0, .pointer_stability = .{} };
    try l.append(testing.allocator, 1);
    defer l.deinit(testing.allocator);
    try testing.expectEqual(1, l.items.len);
}

test "ErrorSet info is { error_names: ?[]const [:0]const u8 }" {
    const E = error{ A, OutOfMemory };
    const names = @typeInfo(E).error_set.error_names.?;
    // Order is NOT declaration order (it follows the global error table), so search.
    var found = false;
    for (names) |n| found = found or std.mem.eql(u8, n, "OutOfMemory");
    try testing.expect(found and names.len == 2);
    try testing.expect(@typeInfo(anyerror).error_set.error_names == null);
}

test "EnumSet and bit_set.Integer: .empty / .full replace initEmpty() / initFull()" {
    const S = std.enums.EnumSet(enum { a, b });
    try testing.expectEqual(0, (S.empty).count());
    try testing.expectEqual(2, (S.full).count());
    try testing.expectEqual(0xff, std.bit_set.Integer(8).full.mask);
}

const TwoBytes = extern struct { lo: u8, hi: u8 };
test "punning an extern struct: bytesToValue(toBytes(x)) (what bun.memCast does)" {
    // `@as(u16, @bitCast(TwoBytes{...}))` is a compile error in 0.17.
    const v: u16 = std.mem.bytesToValue(u16, &std.mem.toBytes(TwoBytes{ .lo = 0x34, .hi = 0x12 }));
    try testing.expectEqual(0x1234, v); // little-endian host
    const back = std.mem.bytesToValue(TwoBytes, &std.mem.toBytes(@as(u16, 0xabcd)));
    try testing.expectEqual(0xab, back.hi);
    comptime std.debug.assert(std.mem.bytesToValue(u16, &std.mem.toBytes(TwoBytes{ .lo = 1, .hi = 0 })) == 1); // works at comptime
}

test "@bitCast on byte arrays and bool vectors still matches the old result on little-endian" {
    const a: [4]u8 = .{ 1, 2, 3, 4 };
    try testing.expectEqual(0x04030201, @as(u32, @bitCast(a)));
    const m: @Vector(4, bool) = .{ true, false, false, true };
    try testing.expectEqual(0b1001, @as(u4, @bitCast(@as(@Vector(4, u1), @bitCast(m)))));
}

test "@bitSizeOf: fine on ints/packed, but a compile error on auto-layout structs" {
    // `@bitSizeOf(struct { a: usize })` -> "no bit size available for type" (0.16 returned @sizeOf*8).
    try testing.expectEqual(12, @bitSizeOf(packed struct { a: u4, b: u8 }));
    try testing.expectEqual(64, @sizeOf(struct { a: usize }) * 8);
}

test "std.meta.declarations returns names; Allocator.dupeSentinel, fmt.bufPrintSentinel, @Int" {
    const S = struct {
        pub const x = 1;
    };
    try testing.expectEqualStrings("x", std.meta.declarations(S)[0]);
    const z = try testing.allocator.dupeSentinel(u8, "ab", 0);
    defer testing.allocator.free(z);
    try testing.expectEqual(0, z[2]);
    var buf: [8]u8 = undefined;
    const p = try std.fmt.bufPrintSentinel(&buf, "{d}", .{7}, 0);
    try testing.expectEqual(0, p.ptr[p.len]);
    try testing.expect(@Int(.unsigned, 7) == u7);
}

test "linux: x86_64's fstatat syscall is named newfstatat; wait4 takes *i32" {
    const linux = std.os.linux;
    if (@import("builtin").target.cpu.arch == .x86_64) {
        try testing.expect(!@hasField(linux.SYS, "fstatat64"));
        try testing.expect(@hasField(linux.SYS, "newfstatat"));
    }
    const W = @typeInfo(@TypeOf(linux.wait4)).@"fn";
    try testing.expect(W.param_types[1].? == *i32);
}
