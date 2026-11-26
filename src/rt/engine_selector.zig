pub const Kind = enum {
    jsc,
};

/// Compile-time engine selection. Only JavaScriptCore is left on this branch;
/// the QuickJS/V8 experiments live on `parked/rt-engines`.
pub fn Implementation(comptime kind: Kind) type {
    return switch (kind) {
        .jsc => @import("./jsc_engine.zig").JscEngine,
    };
}
