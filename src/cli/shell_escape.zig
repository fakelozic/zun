//! Shell-argument escaping for `zun run <script> -- args…` and `--filter` scripts.
//!
//! zun: copied verbatim from Bun 1.3.14 `src/shell/shell.zig` (MIT, see LICENSE.md):
//! `SPECIAL_CHARS`, `SPECIAL_CHARS_TABLE`, `BACKSLASHABLE_CHARS`, `escape8Bit`,
//! `needsEscapeUtf8AsciiLatin1`, and `SPECIAL_JS_CHAR`. The CLI needs only these to append
//! passthrough arguments to a package.json script that runs under the system shell, and
//! `src/shell` is not restored yet (Phase 4 item 6). When it is, delete this file and point the
//! callers (run_command.zig, filter_run.zig) back at `bun.shell`.
//! Security: the escaping is what keeps passthrough arguments from being interpreted by
//! `/bin/sh`; keep it byte-identical to upstream.

/// Characters that need to escaped
const SPECIAL_CHARS = [_]u8{ '~', '[', ']', '#', ';', '\n', '*', '{', ',', '}', '`', '$', '=', '(', ')', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '|', '>', '<', '&', '\'', '"', ' ', '\\', SPECIAL_JS_CHAR };
const SPECIAL_CHARS_TABLE: bun.bit_set.IntegerBitSet(256) = brk: {
    var table = bun.bit_set.IntegerBitSet(256).initEmpty();
    for (SPECIAL_CHARS) |c| {
        table.set(c);
    }
    break :brk table;
};
pub fn assertSpecialChar(comptime c: u8) void {
    bun.assert(SPECIAL_CHARS_TABLE.isSet(c));
}
/// Characters that need to be backslashed inside double quotes
const BACKSLASHABLE_CHARS = [_]u8{ '$', '`', '"', '\\' };


/// works for utf-8, latin-1, and ascii
pub fn escape8Bit(str: []const u8, outbuf: *std.array_list.Managed(u8), comptime add_quotes: bool) !void {
    try outbuf.ensureUnusedCapacity(str.len);

    if (add_quotes) try outbuf.append('\"');

    loop: for (str) |c| {
        inline for (BACKSLASHABLE_CHARS) |spc| {
            if (spc == c) {
                try outbuf.appendSlice(&.{
                    '\\',
                    c,
                });
                continue :loop;
            }
        }
        try outbuf.append(c);
    }

    if (add_quotes) try outbuf.append('\"');
}

/// Checks for the presence of any char from `SPECIAL_CHARS` in `str`. This
/// indicates the *possibility* that the string must be escaped, so it can have
/// false positives, but it is faster than running the shell lexer through the
/// input string for a more correct implementation.
pub fn needsEscapeUtf8AsciiLatin1(str: []const u8) bool {
    for (str) |c| {
        if (SPECIAL_CHARS_TABLE.isSet(c)) return true;
    }
    return false;
}

/// Backspace (decimal value 8), see `src/shell/shell.zig`.
const SPECIAL_JS_CHAR = 8;

const bun = @import("bun");
const std = @import("std");
