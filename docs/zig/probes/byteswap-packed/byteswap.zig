// Probe: what std.mem.byteSwapAllFields (= byteSwap) does to a packed struct in Zig 0.17.1.
// Run: zig test docs/zig/probes/byteswap-packed/byteswap.zig
const std = @import("std");

const FrameHeader = packed struct(u72) {
    length: u24 = 0,
    type: u8 = 4,
    flags: u8 = 0,
    streamIdentifier: u32 = 0,
};

test "byteSwap reverses a packed struct's whole backing integer, not each field" {
    var h: FrameHeader = .{ .length = 0x12, .type = 4, .flags = 0, .streamIdentifier = 0 };
    std.mem.byteSwapAllFields(FrameHeader, &h);
    // HTTP/2 wants 00 00 12 | 04 | 00 | 00 00 00 00. We get the 9 bytes reversed as one u72:
    try std.testing.expectEqualSlices(u8, &.{ 0, 0, 0, 0, 0, 4, 0, 0, 0x12 }, std.mem.asBytes(&h)[0..9]);
}

test "per-field big-endian writes give the wire order" {
    var buf: [9]u8 = undefined;
    std.mem.writeInt(u24, buf[0..3], 0x12, .big);
    buf[3] = 4;
    buf[4] = 0;
    std.mem.writeInt(u32, buf[5..9], 0, .big);
    try std.testing.expectEqualSlices(u8, &.{ 0, 0, 0x12, 4, 0, 0, 0, 0, 0 }, &buf);
}

// H2C-1 sibling: the first field of a packed struct is the LEAST significant bit, so a
// `packed struct(u32) { reserved: bool, uint31: u31 }` bitcast to u32 puts the flag at bit 0,
// not bit 31 where HTTP/2's E/R bit lives (Bun 1.3.14's UInt31WithReserved.toUInt32 did this).
const UInt31WithReserved = packed struct(u32) { reserved: bool = false, uint31: u31 = 0 };

test "packed bitCast: first field is bit 0" {
    const v: UInt31WithReserved = .{ .reserved = true, .uint31 = 5 };
    try std.testing.expectEqual(@as(u32, (5 << 1) | 1), @as(u32, @bitCast(v)));
    // What the wire wants (RFC 9113 §5.3.1): E at bit 31.
    try std.testing.expectEqual(@as(u32, 0x80000005), @as(u32, v.uint31) | (@as(u32, @intFromBool(v.reserved)) << 31));
}
