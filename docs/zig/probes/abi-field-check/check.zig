// Probe (zig 0.17.1, `zig test check.zig`): pin every field of a hand-written extern struct mirror at comptime.
// Iterating a tuple of tuples with plain `for` works inside a `comptime {}` block; `@FieldType` gives a field's
// type; `@typeInfo(T).@"struct".field_names` (0.17 struct-of-arrays) gives the field count.
// Add `_x: u8 = 0,` before `b`, or widen `c`, and the build fails with the matching message.
const S = extern struct {
    a: u64 = 0,
    b: u8 = 0,
    c: u8 = 0,
    d: u64 = 0,

    comptime {
        const expected = .{ .{ "a", 0, 8 }, .{ "b", 8, 1 }, .{ "c", 9, 1 }, .{ "d", 16, 8 } };
        if (@typeInfo(@This()).@"struct".field_names.len != expected.len) @compileError("field count changed");
        for (expected) |e| {
            if (@offsetOf(@This(), e[0]) != e[1] or @sizeOf(@FieldType(@This(), e[0])) != e[2])
                @compileError("field " ++ e[0] ++ " moved or resized");
        }
        if (@sizeOf(@This()) != 24 or @alignOf(@This()) != 8) @compileError("size/alignment changed");
    }
};

test {
    _ = S{};
}
