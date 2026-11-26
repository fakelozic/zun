//! `StackFallbackAllocator(size)` and `stackFallback(size, fallback)`, as they were in
//! Zig 0.16's `std.heap` (copied from Zig 0.16.0 `lib/std/heap.zig`, MIT license,
//! Copyright (c) Zig contributors).
//!
//! Zig 0.17 replaced them with `std.heap.BufferFirstAllocator`, which takes a
//! caller-owned buffer. Bun code uses the old shape in ~60 files and reaches into
//! `.fixed_buffer_allocator` / `.buffer` / `.fallback_allocator` directly, so
//! `scripts/fix_zig017.ts` rewrites `std.heap.stackFallback(` and
//! `std.heap.StackFallbackAllocator(` to `bun.allocators.*` instead of
//! restructuring every call site. New code should use `std.heap.BufferFirstAllocator`.

const std = @import("std");
const assert = std.debug.assert;
const Allocator = std.mem.Allocator;
const Alignment = std.mem.Alignment;
const FixedBufferAllocator = std.heap.FixedBufferAllocator;

/// Returns a `StackFallbackAllocator` allocating using either a
/// `FixedBufferAllocator` on an array of size `size` and falling back to
/// `fallback_allocator` if that fails.

pub fn stackFallback(comptime size: usize, fallback_allocator: Allocator) StackFallbackAllocator(size) {
    return StackFallbackAllocator(size){
        .buffer = undefined,
        .fallback_allocator = fallback_allocator,
        .fixed_buffer_allocator = undefined,
    };
}

/// An allocator that attempts to allocate using a
/// `FixedBufferAllocator` using an array of size `size`. If the
/// allocation fails, it will fall back to using
/// `fallback_allocator`. Easily created with `stackFallback`.
pub fn StackFallbackAllocator(comptime size: usize) type {
    return struct {
        const Self = @This();

        buffer: [size]u8,
        fallback_allocator: Allocator,
        fixed_buffer_allocator: FixedBufferAllocator,
        get_called: if (std.debug.runtime_safety) bool else void =
            if (std.debug.runtime_safety) false else {},

        /// This function both fetches a `Allocator` interface to this
        /// allocator *and* resets the internal buffer allocator.
        pub fn get(self: *Self) Allocator {
            if (std.debug.runtime_safety) {
                assert(!self.get_called); // `get` called multiple times; instead use `const allocator = stackFallback(N).get();`
                self.get_called = true;
            }
            self.fixed_buffer_allocator = FixedBufferAllocator.init(self.buffer[0..]);
            return .{
                .ptr = self,
                .vtable = &.{
                    .alloc = alloc,
                    .resize = resize,
                    .remap = remap,
                    .free = free,
                },
            };
        }

        /// Unlike most std allocators `StackFallbackAllocator` modifies
        /// its internal state before returning an implementation of
        /// the`Allocator` interface and therefore also doesn't use
        /// the usual `.allocator()` method.
        pub const allocator = @compileError("use 'const allocator = stackFallback(N).get();' instead");

        fn alloc(
            ctx: *anyopaque,
            len: usize,
            alignment: Alignment,
            ra: usize,
        ) ?[*]u8 {
            const self: *Self = @ptrCast(@alignCast(ctx));
            return FixedBufferAllocator.alloc(&self.fixed_buffer_allocator, len, alignment, ra) orelse
                return self.fallback_allocator.rawAlloc(len, alignment, ra);
        }

        fn resize(
            ctx: *anyopaque,
            buf: []u8,
            alignment: Alignment,
            new_len: usize,
            ra: usize,
        ) bool {
            const self: *Self = @ptrCast(@alignCast(ctx));
            if (self.fixed_buffer_allocator.ownsPtr(buf.ptr)) {
                return FixedBufferAllocator.resize(&self.fixed_buffer_allocator, buf, alignment, new_len, ra);
            } else {
                return self.fallback_allocator.rawResize(buf, alignment, new_len, ra);
            }
        }

        fn remap(
            context: *anyopaque,
            memory: []u8,
            alignment: Alignment,
            new_len: usize,
            return_address: usize,
        ) ?[*]u8 {
            const self: *Self = @ptrCast(@alignCast(context));
            if (self.fixed_buffer_allocator.ownsPtr(memory.ptr)) {
                return FixedBufferAllocator.remap(&self.fixed_buffer_allocator, memory, alignment, new_len, return_address);
            } else {
                return self.fallback_allocator.rawRemap(memory, alignment, new_len, return_address);
            }
        }

        fn free(
            ctx: *anyopaque,
            buf: []u8,
            alignment: Alignment,
            ra: usize,
        ) void {
            const self: *Self = @ptrCast(@alignCast(ctx));
            if (self.fixed_buffer_allocator.ownsPtr(buf.ptr)) {
                return FixedBufferAllocator.free(&self.fixed_buffer_allocator, buf, alignment, ra);
            } else {
                return self.fallback_allocator.rawFree(buf, alignment, ra);
            }
        }
    };
}

test "stackFallback uses the buffer first, then the fallback" {
    var sfa = stackFallback(64, std.testing.allocator);
    const a = sfa.get();
    const small = try a.alloc(u8, 16);
    try std.testing.expect(sfa.fixed_buffer_allocator.ownsSlice(small));
    const big = try a.alloc(u8, 1024);
    defer a.free(big);
    try std.testing.expect(!sfa.fixed_buffer_allocator.ownsSlice(big));
    a.free(small);
}
