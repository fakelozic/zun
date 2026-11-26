//! HTTP/2 wire structs shared by fetch's client (`h2_client/`, via
//! `H2FrameParser.zig`) and node:http2 (`runtime/api/bun/h2_frame_parser.zig`).
//!
//! The packed structs are the in-memory form only; their bit layout is NOT the
//! wire layout. Every conversion to or from network bytes goes through the
//! explicit big-endian `decode`/`encode` here (RFC 9113 §4.1, §5.3.1, §6.3,
//! §6.5.1). Never `std.mem.byteSwapAllFields` / `@bitCast` / `asBytes` a packed
//! struct to get wire bytes: since Zig 0.16 a byte swap of a packed struct swaps
//! the whole backing integer and reverses the frame (H2C-1,
//! docs/rca/H2C-1-http2-frame-byte-order.md).
//!
//! Depends only on `std` so the tests below run standalone:
//!   zig test src/http/h2_wire.zig

/// Frame header: Length(24) | Type(8) | Flags(8) | R(1) | Stream Identifier(31).
pub const FrameHeader = packed struct(u72) {
    length: u24 = 0,
    /// Default HTTP_FRAME_SETTINGS (0x4).
    type: u8 = 0x4,
    flags: u8 = 0,
    streamIdentifier: u32 = 0,

    pub const byteSize: usize = 9;

    /// The reserved bit "MUST be ignored when receiving" (RFC 9113 §4.1), so it
    /// is cleared here and `streamIdentifier` is always < 2^31.
    pub fn decode(src: *const [byteSize]u8) FrameHeader {
        return .{
            .length = std.mem.readInt(u24, src[0..3], .big),
            .type = src[3],
            .flags = src[4],
            .streamIdentifier = std.mem.readInt(u32, src[5..9], .big) & 0x7fffffff,
        };
    }

    /// The reserved bit "MUST remain unset when sending" (RFC 9113 §4.1).
    pub fn encode(this: FrameHeader, dst: *[byteSize]u8) void {
        std.mem.writeInt(u24, dst[0..3], this.length, .big);
        dst[3] = this.type;
        dst[4] = this.flags;
        std.mem.writeInt(u32, dst[5..9], this.streamIdentifier & 0x7fffffff, .big);
    }

    /// For node:http2's writer-based send paths. Returns false if nothing was written.
    pub inline fn write(this: *const FrameHeader, comptime Writer: type, writer: Writer) bool {
        var bytes: [byteSize]u8 = undefined;
        this.encode(&bytes);
        return (writer.write(&bytes) catch 0) != 0;
    }
};

/// PRIORITY payload / HEADERS priority block: E(1) | Stream Dependency(31) | Weight(8)
/// (RFC 9113 §5.3.1 / RFC 7540 §6.3). `streamIdentifier` holds the raw 32 bits
/// including E at bit 31; callers split it with their `UInt31WithReserved.from`.
pub const StreamPriority = packed struct(u40) {
    streamIdentifier: u32 = 0,
    weight: u8 = 0,

    pub const byteSize: usize = 5;

    pub fn decode(src: *const [byteSize]u8) StreamPriority {
        return .{
            .streamIdentifier = std.mem.readInt(u32, src[0..4], .big),
            .weight = src[4],
        };
    }

    pub fn encode(this: StreamPriority, dst: *[byteSize]u8) void {
        std.mem.writeInt(u32, dst[0..4], this.streamIdentifier, .big);
        dst[4] = this.weight;
    }

    pub inline fn write(this: *const StreamPriority, comptime Writer: type, writer: Writer) bool {
        var bytes: [byteSize]u8 = undefined;
        this.encode(&bytes);
        return (writer.write(&bytes) catch 0) != 0;
    }
};

/// SETTINGS parameter: Identifier(16) | Value(32) (RFC 9113 §6.5.1).
pub const SettingsPayloadUnit = packed struct(u48) {
    type: u16,
    value: u32,

    pub const byteSize: usize = 6;

    pub fn decode(src: *const [byteSize]u8) SettingsPayloadUnit {
        return .{
            .type = std.mem.readInt(u16, src[0..2], .big),
            .value = std.mem.readInt(u32, src[2..6], .big),
        };
    }

    pub fn encode(this: SettingsPayloadUnit, dst: *[byteSize]u8) void {
        std.mem.writeInt(u16, dst[0..2], this.type, .big);
        std.mem.writeInt(u32, dst[2..6], this.value, .big);
    }
};

/// E/R bit at bit 31, value in bits 0..30 (RFC 9113 §4.1, §5.3.1, §6.9).
/// Not `@bitCast` of a packed {reserved: bool, uint31: u31}: the first packed
/// field is the least significant bit, so that would put the flag at bit 0.
pub inline fn uint31WithReserved(value: u31, reserved: bool) u32 {
    return @as(u32, value) | (if (reserved) @as(u32, 0x80000000) else 0);
}

// ---- tests: known RFC 9113 wire bytes --------------------------------------

const testing = std.testing;

test "FrameHeader: SETTINGS header (len 18, type 4, flags 0, stream 0)" {
    const wire = [_]u8{ 0x00, 0x00, 0x12, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00 };
    const h = FrameHeader.decode(&wire);
    try testing.expectEqual(@as(u24, 18), h.length);
    try testing.expectEqual(@as(u8, 4), h.type);
    try testing.expectEqual(@as(u8, 0), h.flags);
    try testing.expectEqual(@as(u32, 0), h.streamIdentifier);
    var out: [9]u8 = undefined;
    h.encode(&out);
    try testing.expectEqualSlices(u8, &wire, &out);
}

test "FrameHeader: SETTINGS ACK" {
    var out: [9]u8 = undefined;
    (FrameHeader{ .type = 0x4, .flags = 0x1, .streamIdentifier = 0, .length = 0 }).encode(&out);
    try testing.expectEqualSlices(u8, &.{ 0, 0, 0, 0x04, 0x01, 0, 0, 0, 0 }, &out);
}

test "FrameHeader: HEADERS with PRIORITY|END_HEADERS on stream 3, multi-byte length" {
    // length 0x01_02_03, type 1 (HEADERS), flags 0x24 (PRIORITY|END_HEADERS), stream 3
    const wire = [_]u8{ 0x01, 0x02, 0x03, 0x01, 0x24, 0x00, 0x00, 0x00, 0x03 };
    const h = FrameHeader.decode(&wire);
    try testing.expectEqual(@as(u24, 0x010203), h.length);
    try testing.expectEqual(@as(u8, 1), h.type);
    try testing.expectEqual(@as(u8, 0x24), h.flags);
    try testing.expectEqual(@as(u32, 3), h.streamIdentifier);
    var out: [9]u8 = undefined;
    h.encode(&out);
    try testing.expectEqualSlices(u8, &wire, &out);
}

test "FrameHeader: reserved bit is ignored on read and never sent" {
    // stream 0x7fffffff with R set on the wire
    const wire = [_]u8{ 0, 0, 4, 0x08, 0, 0xff, 0xff, 0xff, 0xff };
    const h = FrameHeader.decode(&wire);
    try testing.expectEqual(@as(u32, 0x7fffffff), h.streamIdentifier);
    var out: [9]u8 = undefined;
    (FrameHeader{ .length = 4, .type = 0x8, .flags = 0, .streamIdentifier = 0xffffffff }).encode(&out);
    try testing.expectEqualSlices(u8, &.{ 0, 0, 4, 0x08, 0, 0x7f, 0xff, 0xff, 0xff }, &out);
}

test "StreamPriority: exclusive dependency on stream 5, weight 200" {
    // E=1, dep=5 -> 0x80000005; weight byte 200 (= weight 201 in RFC terms)
    const wire = [_]u8{ 0x80, 0x00, 0x00, 0x05, 200 };
    const p = StreamPriority.decode(&wire);
    try testing.expectEqual(@as(u32, 0x80000005), p.streamIdentifier);
    try testing.expectEqual(@as(u8, 200), p.weight);
    try testing.expectEqual(uint31WithReserved(5, true), p.streamIdentifier);
    var out: [5]u8 = undefined;
    p.encode(&out);
    try testing.expectEqualSlices(u8, &wire, &out);
}

test "SettingsPayloadUnit: INITIAL_WINDOW_SIZE = 65535" {
    const wire = [_]u8{ 0x00, 0x04, 0x00, 0x00, 0xff, 0xff };
    const u = SettingsPayloadUnit.decode(&wire);
    try testing.expectEqual(@as(u16, 4), u.type);
    try testing.expectEqual(@as(u32, 65535), u.value);
    var out: [6]u8 = undefined;
    u.encode(&out);
    try testing.expectEqualSlices(u8, &wire, &out);
}

test "WINDOW_UPDATE frame: header + 31-bit increment" {
    // WINDOW_UPDATE (type 8) on stream 1, increment 0x00010000
    var out: [13]u8 = undefined;
    (FrameHeader{ .length = 4, .type = 0x8, .flags = 0, .streamIdentifier = 1 }).encode(out[0..9]);
    std.mem.writeInt(u32, out[9..13], uint31WithReserved(0x10000, false), .big);
    try testing.expectEqualSlices(u8, &.{ 0, 0, 4, 0x08, 0, 0, 0, 0, 1, 0, 1, 0, 0 }, &out);
}

test "write() goes through encode (writer-based path)" {
    var buf: [16]u8 = undefined;
    var w: Fixed = .{ .buf = &buf };
    const h: FrameHeader = .{ .length = 0x12, .type = 0x4, .flags = 0, .streamIdentifier = 0 };
    try testing.expect(h.write(*Fixed, &w));
    const p: StreamPriority = .{ .streamIdentifier = uint31WithReserved(7, false), .weight = 15 };
    try testing.expect(p.write(*Fixed, &w));
    try testing.expectEqualSlices(u8, &.{ 0, 0, 0x12, 4, 0, 0, 0, 0, 0, 0, 0, 0, 7, 15 }, buf[0..w.len]);
}

/// Minimal stand-in for the `write([]const u8) !usize` writers node:http2 passes.
const Fixed = struct {
    buf: []u8,
    len: usize = 0,
    fn write(this: *Fixed, bytes: []const u8) error{NoSpaceLeft}!usize {
        if (bytes.len > this.buf.len - this.len) return error.NoSpaceLeft;
        @memcpy(this.buf[this.len..][0..bytes.len], bytes);
        this.len += bytes.len;
        return bytes.len;
    }
};

const std = @import("std");
