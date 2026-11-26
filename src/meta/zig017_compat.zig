//! Array-of-structs views of `@typeInfo`, as Zig 0.16 returned them.
//!
//! Zig 0.17 made `@typeInfo` struct-of-arrays: `Type.Struct` has `field_names`,
//! `field_types` and `field_attrs` instead of `fields: []const StructField`, enums have
//! `field_names`/`field_values`, `decls` became `decl_names`, and `Type.Fn` has
//! `param_types`/`param_attrs` instead of `params`.
//!
//! `scripts/fix_zig017.ts` rewrites the old accesses to these helpers so that the
//! ~250 reflection sites in Bun keep their shape (`for (fields) |f| f.name ... f.type`):
//!
//!   `@typeInfo(T).@"struct".fields` -> `bun.meta.fieldsOf(@typeInfo(T).@"struct")`
//!   `std.meta.fields(T)`            -> `bun.meta.fieldsOf(T)`
//!   `X.@"enum".decls`               -> `bun.meta.declsOf(X.@"enum")`
//!   `X.@"fn".params`                -> `bun.meta.paramsOf(X.@"fn")`
//!
//! New code should use the struct-of-arrays fields directly, e.g.
//! `inline for (info.field_names, info.field_types) |name, T| ...`.
//!
//! This file only depends on `std`, so `zig test src/meta/zig017_compat.zig` runs it alone.

const std = @import("std");
const Type = std.lang.Type;

/// Zig 0.16 `std.builtin.Type.StructField`.
pub const StructField = struct {
    name: [:0]const u8,
    type: type,
    default_value_ptr: ?*const anyopaque,
    is_comptime: bool,
    /// `null` means the alignment was not written explicitly.
    alignment: ?usize,

    pub inline fn defaultValue(comptime sf: StructField) ?sf.type {
        const dp: *const sf.type = @ptrCast(@alignCast(sf.default_value_ptr orelse return null));
        return dp.*;
    }
};

/// Zig 0.16 `std.builtin.Type.UnionField`.
pub const UnionField = struct {
    name: [:0]const u8,
    type: type,
    alignment: ?usize,
};

/// Zig 0.16 `std.builtin.Type.EnumField`.
pub const EnumField = struct {
    name: [:0]const u8,
    value: comptime_int,
};

/// Zig 0.16 `std.builtin.Type.Declaration`.
pub const Declaration = struct {
    name: [:0]const u8,
};

/// Zig 0.16 `std.builtin.Type.Fn.Param`.
pub const Param = struct {
    is_generic: bool,
    is_noalias: bool,
    type: ?type,
};

/// Accepts a type, a `std.lang.Type`, or one of `Type.Struct` / `Type.Union` / `Type.Enum`
/// (and `Type.Opaque` / `Type.Fn` where that makes sense) and returns the specific info.
fn specificInfo(comptime info: anytype) SpecificInfo(info) {
    const I = @TypeOf(info);
    if (I == type) return specificInfo(@typeInfo(info));
    if (I == Type) return switch (info) {
        .@"struct" => |s| s,
        .@"union" => |u| u,
        .@"enum" => |e| e,
        .@"opaque" => |o| o,
        .@"fn" => |f| f,
        else => @compileError("expected a struct, union, enum, opaque or fn type, found " ++ @tagName(info)),
    };
    return info;
}

fn SpecificInfo(comptime info: anytype) type {
    const I = @TypeOf(info);
    if (I == type) return SpecificInfo(@typeInfo(info));
    if (I == Type) return switch (info) {
        .@"struct" => Type.Struct,
        .@"union" => Type.Union,
        .@"enum" => Type.Enum,
        .@"opaque" => Type.Opaque,
        .@"fn" => Type.Fn,
        else => @compileError("expected a struct, union, enum, opaque or fn type, found " ++ @tagName(info)),
    };
    return I;
}

fn FieldOf(comptime info: anytype) type {
    return switch (SpecificInfo(info)) {
        Type.Struct => StructField,
        Type.Union => UnionField,
        Type.Enum => EnumField,
        else => |I| @compileError("fieldsOf: no fields on " ++ @typeName(I)),
    };
}

/// The fields of a struct, union or enum in Zig 0.16's array-of-structs form.
pub inline fn fieldsOf(comptime info: anytype) []const FieldOf(info) {
    const i = specificInfo(info);
    const F = FieldOf(info);
    return comptime blk: {
        var out: [i.field_names.len]F = undefined;
        for (&out, 0..) |*f, idx| {
            f.* = switch (F) {
                StructField => .{
                    .name = i.field_names[idx],
                    .type = i.field_types[idx],
                    .default_value_ptr = i.field_attrs[idx].default_value_ptr,
                    .is_comptime = i.field_attrs[idx].@"comptime",
                    .alignment = i.field_attrs[idx].@"align",
                },
                UnionField => .{
                    .name = i.field_names[idx],
                    .type = i.field_types[idx],
                    .alignment = i.field_attrs[idx].@"align",
                },
                EnumField => .{
                    .name = i.field_names[idx],
                    .value = i.field_values[idx],
                },
                else => unreachable,
            };
        }
        const final = out;
        break :blk &final;
    };
}

/// The declarations of a struct, union, enum or opaque in Zig 0.16's form.
/// Note: like `@hasDecl` in 0.17, this only lists `pub` declarations.
pub inline fn declsOf(comptime info: anytype) []const Declaration {
    const i = specificInfo(info);
    return comptime blk: {
        var out: [i.decl_names.len]Declaration = undefined;
        for (&out, i.decl_names) |*d, name| d.* = .{ .name = name };
        const final = out;
        break :blk &final;
    };
}

/// The parameters of a function type in Zig 0.16's form.
pub inline fn paramsOf(comptime info: anytype) []const Param {
    const i: Type.Fn = specificInfo(info);
    return comptime blk: {
        var out: [i.param_types.len]Param = undefined;
        for (&out, i.param_types, i.param_attrs) |*p, T, attrs| p.* = .{
            .is_generic = T == null,
            .is_noalias = attrs.@"noalias",
            .type = T,
        };
        const final = out;
        break :blk &final;
    };
}

const testing = std.testing;

test fieldsOf {
    const S = struct {
        a: u8 = 7,
        b: u32 align(8),
        pub const decl_pub = 1;
        const decl_priv = 2;
    };
    const fs = fieldsOf(S);
    try testing.expectEqual(2, fs.len);
    try testing.expectEqualStrings("a", fs[0].name);
    try testing.expect(fs[0].type == u8);
    try testing.expectEqual(7, fs[0].defaultValue().?);
    try testing.expectEqual(null, fs[0].alignment);
    try testing.expectEqual(8, fs[1].alignment.?);
    // Same answer through every accepted input shape.
    try testing.expectEqual(2, fieldsOf(@typeInfo(S)).len);
    try testing.expectEqual(2, fieldsOf(@typeInfo(S).@"struct").len);

    const E = enum(u8) { x = 3, y = 9 };
    try testing.expectEqual(9, fieldsOf(E)[1].value);

    const U = union(enum) { p: u16, q: void };
    try testing.expect(fieldsOf(U)[0].type == u16);

    // `inline for` over the result, as old code does.
    var names: [2][]const u8 = undefined;
    inline for (comptime fieldsOf(S), 0..) |f, i| names[i] = f.name;
    try testing.expectEqualStrings("b", names[1]);
}

test declsOf {
    const S = struct {
        pub const decl_pub = 1;
        const decl_priv = 2;
        pub fn f() void {}
    };
    const ds = declsOf(S);
    // Only pub declarations are visible to reflection in 0.17.
    try testing.expectEqual(2, ds.len);
    try testing.expectEqualStrings("decl_pub", ds[0].name);
}

test paramsOf {
    const F = fn (noalias a: *u8, b: u32) void;
    const ps = paramsOf(@typeInfo(F).@"fn");
    try testing.expectEqual(2, ps.len);
    try testing.expect(ps[0].is_noalias);
    try testing.expect(ps[1].type.? == u32);
    try testing.expect(!ps[1].is_generic);
}
