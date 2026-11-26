//! Bun 1.3.14 uses `#name` private fields, an Oven Zig-fork extension. Vanilla 0.17.1 rejects them.
const S = struct {
    #n: u32 = 0,
};
test "x" {
    _ = S{};
}
