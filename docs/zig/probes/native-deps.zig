//! Probes for docs/plan/native-deps.md: what Zig 0.17.1's std can replace among
//! zun's C dependencies. Run: zig test docs/zig/probes/native-deps.zig
//!
//! Expected bytes were produced on 2026-11-26 with Python 3.15 `zlib` (zlib-ng 1.3.1,
//! the same library cruller links), `zstd -19` (CLI 1.5.x) and Node 26 `crypto.argon2Sync`.
const std = @import("std");
const flate = std.compress.flate;
const testing = std.testing;

// 0.17: the `**` array-repeat operator is gone entirely (even for string literals); build it at comptime.
const sample: []const u8 = blk: {
    const unit = "hello hello hello zun ";
    var a: [unit.len * 20]u8 = undefined;
    for (0..20) |i| @memcpy(a[i * unit.len ..][0..unit.len], unit);
    const final = a;
    break :blk &final;
};

fn stdDeflate(gpa: std.mem.Allocator, data: []const u8, container: flate.Container, opts: flate.Compress.Options) ![]u8 {
    // Compress asserts the output writer already has a buffer of more than 8 bytes,
    // so a fresh `.init(gpa)` (empty buffer) trips an assertion: use initCapacity.
    var out: std.Io.Writer.Allocating = try .initCapacity(gpa, 64);
    defer out.deinit();
    const window = try gpa.alloc(u8, flate.max_window_len);
    defer gpa.free(window);
    var c = try flate.Compress.init(&out.writer, window, container, opts);
    try c.writer.writeAll(data);
    try c.finish();
    return out.toOwnedSlice();
}

fn stdInflate(gpa: std.mem.Allocator, data: []const u8, container: flate.Container) ![]u8 {
    var in: std.Io.Reader = .fixed(data);
    var d: flate.Decompress = .init(&in, container, &.{}); // empty buffer = direct (streaming) mode
    var out: std.Io.Writer.Allocating = .init(gpa);
    defer out.deinit();
    _ = try d.reader.streamRemaining(&out.writer);
    return out.toOwnedSlice();
}

test "flate: gzip/zlib/raw round trip" {
    const gpa = testing.allocator;
    for (flate.Container.list) |container| {
        const z = try stdDeflate(gpa, sample, container, .default);
        defer gpa.free(z);
        const back = try stdInflate(gpa, z, container);
        defer gpa.free(back);
        try testing.expectEqualStrings(sample, back);
    }
}

test "flate: std inflates zlib-ng output" {
    const gpa = testing.allocator;
    var zng: [26]u8 = undefined;
    _ = try std.fmt.hexToBytes(&zng, "789ccb48cdc9c957c84022ab4af350f8a3a283511400b681a1f5");
    const back = try stdInflate(gpa, &zng, .zlib);
    defer gpa.free(back);
    try testing.expectEqualStrings(sample, back);
}

test "flate: std level 6 output is NOT byte-identical to zlib-ng level 6" {
    // Same decompressed data, different compressed bytes. Matters for snapshot tests and
    // for anything that hashes compressed output (e.g. `bun pm pack` integrity).
    const gpa = testing.allocator;
    var zng: [26]u8 = undefined;
    _ = try std.fmt.hexToBytes(&zng, "789ccb48cdc9c957c84022ab4af350f8a3a283511400b681a1f5");
    const ours = try stdDeflate(gpa, sample, .zlib, .default);
    defer gpa.free(ours);
    try testing.expect(!std.mem.eql(u8, ours, &zng));
}

test "flate: flush() is not zlib Z_SYNC_FLUSH (no guaranteed 00 00 ff ff trailer)" {
    // permessage-deflate (RFC 7692) and node:zlib Z_SYNC_FLUSH need the empty stored block.
    // zlib-ng raw deflate of "hello" + Z_SYNC_FLUSH = ca48cdc9c907000000ffff.
    const gpa = testing.allocator;
    // Compress asserts the output writer already has a buffer of more than 8 bytes,
    // so a fresh `.init(gpa)` (empty buffer) trips an assertion: use initCapacity.
    var out: std.Io.Writer.Allocating = try .initCapacity(gpa, 64);
    defer out.deinit();
    const window = try gpa.alloc(u8, flate.max_window_len);
    defer gpa.free(window);
    var c = try flate.Compress.init(&out.writer, window, .raw, .default);
    try c.writer.writeAll("hello");
    try c.writer.flush();
    const got = out.written();
    try testing.expect(!std.mem.endsWith(u8, got, &.{ 0x00, 0x00, 0xff, 0xff }));
}

test "zstd: std decompresses a zstd CLI frame (decoder only, no encoder in std)" {
    const gpa = testing.allocator;
    var frame: [35]u8 = undefined;
    _ = try std.fmt.hexToBytes(&frame, "28b52ffd0468b50000807a756e207a7374642070726f6265200a010022cf3a2669ae9d");
    var in: std.Io.Reader = .fixed(&frame);
    var d: std.compress.zstd.Decompress = .init(&in, &.{}, .{});
    var out: std.Io.Writer.Allocating = .init(gpa);
    defer out.deinit();
    _ = try d.reader.streamRemaining(&out.writer);
    try testing.expectEqualStrings("zun zstd probe zun zstd probe\n", out.written());
    try testing.expect(!@hasDecl(std.compress.zstd, "Compress"));
}

test "crc32 and adler32 match zlib" {
    try testing.expectEqual(@as(u32, 0xCBF43926), std.hash.Crc32.hash("123456789"));
    try testing.expectEqual(@as(u32, 0x091E01DE), std.hash.Adler32.hash("123456789"));
}

test "tar: Writer then Iterator round trip" {
    const gpa = testing.allocator;
    var buf: std.Io.Writer.Allocating = .init(gpa);
    defer buf.deinit();
    var tw: std.tar.Writer = .{ .underlying_writer = &buf.writer };
    try tw.writeFileBytes("package/index.js", "module.exports = 1;\n", .{ .mode = 0o644 });
    try tw.finishPedantically();

    var in: std.Io.Reader = .fixed(buf.written());
    var name_buf: [std.fs.max_path_bytes]u8 = undefined;
    var link_buf: [std.fs.max_path_bytes]u8 = undefined;
    var it: std.tar.Iterator = .init(&in, .{ .file_name_buffer = &name_buf, .link_name_buffer = &link_buf });
    const f = (try it.next()).?;
    try testing.expectEqualStrings("package/index.js", f.name);
    try testing.expectEqual(@as(u64, 20), f.size);
    try testing.expectEqual(std.tar.FileKind.file, f.kind);
    try testing.expect((try it.next()) == null);
}

test "argon2id kdf matches Node's crypto.argon2Sync" {
    // node -e "crypto.argon2Sync('argon2id',{message:'password',nonce:'somesaltsomesalt',
    //          parallelism:1,tagLength:32,memory:64,passes:2})"
    const argon2 = std.crypto.pwhash.argon2;
    var want: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&want, "1a98fba8e6394425c9bdc333a9c750aaf811df070f5fb4a5788e1cf4db5793a1");
    var got: [32]u8 = undefined;
    try argon2.kdf(testing.allocator, &got, "password", "somesaltsomesalt", .{ .t = 2, .m = 64, .p = 1 }, .argon2id, testing.io);
    try testing.expectEqualSlices(u8, &want, &got);
}

test "argon2id PHC string round trip" {
    const pw = std.crypto.pwhash;
    var buf: [128]u8 = undefined;
    const h = try pw.argon2.strHash("hunter2", .{ .allocator = testing.allocator, .params = .{ .t = 1, .m = 64, .p = 1 } }, &buf, testing.io);
    try testing.expect(std.mem.startsWith(u8, h, "$argon2id$v=19$m=64,t=1,p=1$"));
    try pw.argon2.strVerify(h, "hunter2", .{ .allocator = testing.allocator }, testing.io);
    try testing.expectError(error.PasswordVerificationFailed, pw.argon2.strVerify(h, "nope", .{ .allocator = testing.allocator }, testing.io));
}

test "http: HeadParser finds the end of a head; no HPACK in std" {
    var p: std.http.HeadParser = .{};
    const msg = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi";
    const n = p.feed(msg);
    try testing.expectEqual(msg.len - 2, n);
    try testing.expectEqual(std.http.HeadParser.State.finished, p.state);
}
