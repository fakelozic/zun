// zun probe (CLI restore): gating a missing command with a `@compileError` decl + comptime-false branch.
const std = @import("std");
const flag = false;
pub const InstallCommand = @compileError("zun-gate(install): not restored");
const Ns = struct {};
pub fn main() void {
    // A comptime-false branch is not analysed: naming a @compileError decl there is fine,
    // and so is a missing decl reached through a namespace.
    if (comptime flag) InstallCommand.exec() else std.debug.print("gated\n", .{});
    if (comptime flag) Ns.missing.exec();
    // `if (comptime a) if (b) {...};` as a statement needs the trailing `;`.
    if (comptime flag) if (std.os.argv.len > 99) {
        Ns.missing2();
    };
}
