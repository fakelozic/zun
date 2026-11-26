//! Zig 0.17.1: build a comptime string in a function that is called from runtime code.
//! The working form: an ordinary fn whose `return` expression is `comptime ...`.
const std = @import("std");

fn prefixed(comptime key: []const u8) [:0]const u8 {
    if (comptime !std.mem.startsWith(u8, key, "BUN_")) @compileError("not a BUN_ key: " ++ key);
    return comptime "ZUN_" ++ key[4..];
}

test "comptime return expression" {
    const k = prefixed("BUN_INSTALL"); // called from a runtime (test) context
    try std.testing.expectEqualStrings("ZUN_INSTALL", k);
    try std.testing.expectEqual(@as(u8, 0), k.ptr[k.len]); // sentinel is there
}

test "std.mem.trimEnd / trimStart (trimRight / trimLeft do not exist in 0.17.1)" {
    try std.testing.expectEqualStrings("/home/u", std.mem.trimEnd(u8, "/home/u//", "/"));
    try std.testing.expectEqualStrings("a/", std.mem.trimStart(u8, "//a/", "/"));
    try std.testing.expect(!@hasDecl(std.mem, "trimRight"));
    try std.testing.expect(!@hasDecl(std.mem, "trimLeft"));
}
