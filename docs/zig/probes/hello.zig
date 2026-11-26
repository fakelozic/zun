const std = @import("std");
pub fn main(init: std.process.Init) !void {
    var buf: [256]u8 = undefined;
    var fw: std.Io.File.Writer = .init(.stdout(), init.io, &buf);
    const out = &fw.interface;
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    try out.print("zun says hi, {d} args, HOME set: {}\n", .{ args.len, init.environ_map.get("HOME") != null });
    try out.flush();
}
