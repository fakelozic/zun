// Probe (zig 0.17.1): `std.options.signal_stack_size` can be set per build; `(std.Options{}).signal_stack_size`
// is the std default (1 << 18) at comptime. `zig run options.zig` prints 262144; with enable_asan = true it prints null.
// Context: docs/rca/TQ-3-worker-thread-exit-under-asan.md (ASAN owns the per-thread sigaltstack).
const std = @import("std");
const enable_asan = false;
pub const std_options = std.Options{
    .enable_segfault_handler = false,
    .signal_stack_size = if (enable_asan) null else (std.Options{}).signal_stack_size,
};
pub fn main() void {
    std.debug.print("signal_stack_size={?d}\n", .{std.options.signal_stack_size});
}
