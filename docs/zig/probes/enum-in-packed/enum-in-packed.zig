// Probe (zig 0.17.1, `zig test enum-in-packed.zig`): an `enum(u2)` with methods can be a `packed struct(u32)` field,
// keeps its default, and its methods are callable on the field (`f.reused.max(.callback)`). Used by TLS-ID-1
// (`HTTPClient.PeerVerification` inside `HTTPClient.Flags`).
const std = @import("std");
const PeerVerification = enum(u2) {
    none = 0,
    callback = 1,
    native = 2,
    pub fn admits(self: PeerVerification, pooled: PeerVerification) bool {
        return self == .none or self == pooled;
    }
    pub fn max(a: PeerVerification, b: PeerVerification) PeerVerification {
        return @enumFromInt(@max(@intFromEnum(a), @intFromEnum(b)));
    }
};
const Flags = packed struct(u32) {
    a: bool = false,
    reused: PeerVerification = .none,
    _: u29 = 0,
};
test "enum(u2) with methods in a packed struct" {
    var f: Flags = .{};
    try std.testing.expect(f.reused.max(.callback) == .callback);
    f.reused = .native;
    try std.testing.expect(f.reused.max(.callback) == .native);
    try std.testing.expect(PeerVerification.none.admits(.native));
    try std.testing.expect(!PeerVerification.callback.admits(.native));
    try std.testing.expect(!PeerVerification.native.admits(.none));
    try std.testing.expect(PeerVerification.callback.admits(.callback));
}
