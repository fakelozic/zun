//! Run with zig test on Zig 0.16.0 and 0.17.1.
const std = @import("std");
const Ip6 = std.Io.net.Ip6Address;

test "the std formatter already compresses IPv6 and prints mapped IPv4 in decimal" {
    const cases = .{
        .{ "::1", "[::1]:80" },
        .{ "::", "[::]:80" },
        .{ "::ffff:127.0.0.1", "[::ffff:127.0.0.1]:80" },
        .{ "2001:db8:0:0:0:1:0:1", "[2001:db8::1:0:1]:80" },
    };
    inline for (cases) |case| {
        const addr = try Ip6.parse(case[0], 80);
        var buf: [64]u8 = undefined;
        try std.testing.expectEqualStrings(case[1], try std.fmt.bufPrint(&buf, "{f}", .{addr}));
    }
}

test "ordinary endpoint formatting omits the scope even when it is resolved" {
    const address = try Ip6.resolve(std.testing.io, "fe80::1%lo", 80);
    try std.testing.expect(!address.interface.isNone());
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings("[fe80::1]:80", try std.fmt.bufPrint(&buf, "{f}", .{address}));
    const named: Ip6.Unresolved = .{ .bytes = address.bytes, .interface_name = "lo" };
    try std.testing.expectEqualStrings("fe80::1%lo", try std.fmt.bufPrint(&buf, "{f}", .{named}));
}

test "0.17 std spells the NAT64 prefix with a dotted tail" {
    const address = try Ip6.parse("64:ff9b::7f00:1", 80);
    const std_version = @import("builtin").zig_version;
    const expected = if (std_version.minor == 16) "[64:ff9b::7f00:1]:80" else "[64:ff9b::127.0.0.1]:80";
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings(expected, try std.fmt.bufPrint(&buf, "{f}", .{address}));
}
