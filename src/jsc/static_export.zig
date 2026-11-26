Type: type,
symbol_name: []const u8,
local_name: []const u8,

Parent: type,

pub fn Decl(comptime this: *const @This()) bun.meta.Declaration {
    return comptime std.meta.declarationInfo(this.Parent, this.local_name);
}

pub fn wrappedName(comptime this: *const @This()) []const u8 {
    return comptime "wrap" ++ this.symbol_name;
}

const std = @import("std");
const bun = @import("bun");
