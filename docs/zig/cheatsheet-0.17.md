# Zig 0.17 cheatsheet (verified)

Every claim below is backed by a probe that compiles and passes on **zig 0.17.1**
(2026-11-26): `probes/basics.zig`, `probes/std-0.17.zig`, `probes/reflection-io.zig`, `probes/native-deps.zig` and `probes/hello.zig`.
The build.zig skeleton comes from `zig init`. **When you add a line here, add its probe in the same change.**

## Entry point ("Juicy Main")

```zig
const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;                       // general-purpose allocator (leak-checked in Debug)
    const arena = init.arena.allocator();       // lives for the whole process
    const io = init.io;                         // the I/O implementation: pass it to anything that does I/O
    const args = try init.minimal.args.toSlice(arena);
    const home = init.environ_map.get("HOME");  // env vars are only reachable from main now
    _ = .{ gpa, args, home };

    var buf: [4096]u8 = undefined;
    var fw: std.Io.File.Writer = .init(.stdout(), io, &buf);
    const out = &fw.interface;                  // *std.Io.Writer
    try out.print("hello {s}\n", .{"zun"});
    try out.flush();                            // buffered: always flush
}
```

- `main` can take nothing, `std.process.Init.Minimal` (raw args and env), or `std.process.Init`.
- No global env or args anymore. Pass the values down as parameters.
- Quick debug output: `std.debug.print(fmt, args)` writes to stderr, unbuffered, and can't fail.

## I/O is an interface: `std.Io`

- Anything that blocks or is nondeterministic (files, network, time, sleep, randomness, mutexes) takes an `io: std.Io`.
- In tests use `std.testing.io`. As a last resort: `var t: std.Io.Threaded = .init_single_threaded; const io = t.io();`
- Files and directories live under `std.Io.File` / `std.Io.Dir`, and their methods take `io`:
  ```zig
  try dir.writeFile(io, .{ .sub_path = "a.txt", .data = "zun" });
  const data = try dir.readFileAlloc(io, "a.txt", gpa, .limited(1 << 20));
  ```
- Concurrency:
  ```zig
  var f = io.async(square, .{@as(u32, 9)});   // Future(T)
  const r = f.await(io);                      // or f.cancel(io): request cancel, then await
  var g: std.Io.Group = .init;                // many tasks with one shared lifetime
  defer g.cancel(io);
  g.async(io, work, .{ io, &state });
  try g.await(io);
  ```
- Sync primitives moved: `std.Thread.Mutex` → `std.Io.Mutex` (`.init`, `lock(io)` / `lockUncancelable(io)`, `unlock(io)`),
  as did `Condition`, `RwLock`, `Semaphore`, `ResetEvent`→`Io.Event`, `WaitGroup`→`Io.Group`. `std.Thread.Pool` was removed.
- `error.Canceled` appears in most I/O error sets. Propagate it, or `io.recancel()` and swallow it.

## Writers and readers (the new `std.Io.Writer` from 0.15's "Writergate")

```zig
var buf: [64]u8 = undefined;
var w: std.Io.Writer = .fixed(&buf);          // write into a fixed buffer
try w.print("x={d}", .{1});
w.buffered();                                 // the bytes written so far

var aw: std.Io.Writer.Allocating = .init(gpa); // growable output
defer aw.deinit();
try aw.writer.print("{s}", .{"n"});
aw.written();
```
- The writer interface is a non-generic `*std.Io.Writer`. The buffer belongs to the writer, so remember to `flush()`.
- `GenericWriter`, `AnyWriter`, `null_writer` and `CountingReader` were removed in 0.16.

## Formatting

```zig
const Point = struct {
    x: i32, y: i32,
    pub fn format(self: Point, w: *std.Io.Writer) std.Io.Writer.Error!void {
        try w.print("({d},{d})", .{ self.x, self.y });
    }
};
try w.print("{f}", .{p});                     // {f} is REQUIRED to call a format method
const s = try gpa.print("{s}={d}", .{ k, v }); // 0.17: Allocator.print (was std.fmt.allocPrint, now deprecated)
```
- Format methods no longer take a format string or options.
- Specifiers: `{s}` string, `{d}` int, `{x}` hex, `{any}` debug, `{f}` format method, `{q}` / `{qf}` quoted.

## Containers: unmanaged everywhere (you pass the allocator to each call)

```zig
var list: std.ArrayList(u8) = .empty;          // ArrayList is unmanaged by default
defer list.deinit(gpa);
try list.append(gpa, 'a');
try list.appendSlice(gpa, "bc");
list.last();                                    // ?T  (0.17: replaces getLast/getLastOrNull)

var m: std.StringHashMapUnmanaged(u32) = .empty;
try m.put(gpa, "a", 1);

var am: std.array_hash_map.String(u8) = .empty; // 0.16: StringArrayHashMapUnmanaged → array_hash_map.String
var an: std.array_hash_map.Auto(u32, u8) = .empty; // AutoArrayHashMapUnmanaged → array_hash_map.Auto
```
- Bit sets were renamed: `std.bit_set.Integer(n)`, `.Static(n)`, `.Array(MaskInt, n)` start from `.empty` / `.full`.
  **Exception:** `std.bit_set.Dynamic` allocates, so it still uses `try .initEmpty(gpa, n)` / `.initFull(gpa, n)` and `deinit(gpa)`.
- `std.enums.EnumSet(E)` also uses `.empty`.

## Allocators

- `std.testing.allocator` in tests fails the test if anything leaks.
- `std.heap.ArenaAllocator` became thread-safe and lock-free in 0.16.
- `std.heap.BufferFirstAllocator` (0.17) replaces `StackFallbackAllocator` / `stackFallback`:
  ```zig
  var buf: [256]u8 = undefined;
  var bfa: std.heap.BufferFirstAllocator = .init(&buf, gpa);
  const a = bfa.allocator();
  ```
- `GeneralPurposeAllocator` is gone. `DebugAllocator` is deprecated in favour of `SafeAllocator` (0.17).

## `std.mem` names (0.16 renamed "indexOf" to "find", and added "cut")

```zig
std.mem.find(u8, hay, "needle")       // ?usize   (was indexOf; old name kept as deprecated alias)
std.mem.findScalar(u8, hay, 'x')      // (was indexOfScalar)
std.mem.cutScalar(u8, "k=v", '=')     // ?struct{ []const u8, []const u8 }  -> .{"k","v"}
std.mem.cutPrefix(u8, "foobar", "foo") // ?[]const u8 -> "bar"
```

## Comptime reflection (big 0.16/0.17 changes)

- `std.builtin` is now `std.lang` (the old name still works but is deprecated).
- `@Type` was removed (0.16). Build types with `@Int`, `@Struct`, `@Union`, `@Enum`, `@Pointer`, `@Fn`, `@Tuple`, `@EnumLiteral`:
  ```zig
  const U12 = @Int(.unsigned, 12);
  const attrs: [2]std.lang.Type.Struct.FieldAttributes = @splat(.{});
  const S = @Struct(.auto, null, &.{ "a", "b" }, &.{ u8, u16 }, &attrs);
  ```
- 0.17: `@typeInfo` for struct, union and enum is **struct-of-arrays**:
  ```zig
  const info = @typeInfo(T).@"struct";
  inline for (info.field_names, info.field_types) |name, FT| { _ = @field(value, name); _ = FT; }
  // also: info.field_attrs[i].default_value_ptr / .@"align" / .@"comptime", info.decl_names
  ```
  Enum has `field_names` and `field_values`. Fn has `param_types`, `param_attrs`, `attrs.@"callconv"` and `return_type`.
  Pointer has `size`, `child` and `attrs.{const,volatile,align,...}`.
- `@hasDecl` is now true **only for `pub` declarations**, even inside the same file (0.17).
- `std.meta.fieldNames` / `fieldInfo` are deprecated. **`std.meta.fields` and `std.meta.declarationInfo` are already
  `@compileError`**, so using them is a compile error. Use `@typeInfo`.

## Syntax removed

| Removed | Use instead | Since |
|---------|-------------|-------|
| `usingnamespace` | explicit decls / re-exports | 0.15 |
| `async` / `await` keywords | `io.async` / `Future.await` | 0.15 |
| `@cImport` / `@cInclude` | build-system C translation (`translate_c` package) | removed 0.17 |
| `[_]u8{0} ** n`, `"ab" ** n` (`**` is gone for every operand) | `@splat(0)`, or a comptime loop for strings | 0.17 |
| `void{}` | `{}` | 0.17 |
| `errdefer \|err\|` | split into an inner fn + `catch \|err\|` | 0.17 |
| `i0` | `u0` | 0.17 |
| `.ReleaseFast` etc. in `std.lang.Optimize` | `.debug` `.safe` `.fast` `.small` | 0.17 |

New in 0.17: `@divCeil`, `@backingInt` / `@fromBackingInt` (packed types ↔ backing int). Also useful, though older: `@FieldType(T, "name")`.

⚠️ **`@bitCast` semantics changed in 0.17.** Arrays and vectors are reinterpreted by
*logical* bits, and `extern struct` / `extern union` casts are rejected. Some
changes don't produce a compile error. For type punning an extern struct, use
`@ptrCast` to an `*align(1) const T`.

## Compression, archives, password hashing (`probes/native-deps.zig`)

```zig
const flate = std.compress.flate;                // Container: .raw, .gzip, .zlib
var out: std.Io.Writer.Allocating = try .initCapacity(gpa, 64); // Compress asserts output buffer > 8 bytes
var c = try flate.Compress.init(&out.writer, window, .gzip, .default); // window.len >= flate.max_window_len
try c.writer.writeAll(data);
try c.finish();

var in: std.Io.Reader = .fixed(compressed);
var d: flate.Decompress = .init(&in, .gzip, &.{});  // empty buffer = direct mode, stream into a Writer
_ = try d.reader.streamRemaining(&out.writer);

var z: std.compress.zstd.Decompress = .init(&in, &.{}, .{}); // decoder only; no zstd encoder in std
try std.crypto.pwhash.argon2.kdf(gpa, &key, pw, salt, .{ .t = 2, .m = 64, .p = 1 }, .argon2id, io);
std.hash.Crc32.hash(bytes);                       // same value as zlib crc32
var tw: std.tar.Writer = .{ .underlying_writer = w }; // + std.tar.Iterator for reading
```
- std flate output is valid but **not byte-identical to zlib(-ng)**, and `flush()` is not `Z_SYNC_FLUSH`
  (no guaranteed `00 00 ff ff`). No dictionaries, no `windowBits` < 15.
- `zstd.Decompress` options: `verify_checksum = true` panics (not implemented); dictionary frames fail.
- `argon2.kdf` matches Node's `crypto.argon2Sync`, and rejects `m < 8 * p` with `error.WeakParameters`.
- `std.tar` handles file/dir/symlink with name/size/mode only (it exists for the Zig package manager).

## Testing

```zig
test "name" {
    const gpa = std.testing.allocator;      // leak-checked
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});      // tmp.dir is a std.Io.Dir
    defer tmp.cleanup();
    try std.testing.expectEqualStrings("a", "a");
    try std.testing.expectEqual(@as(u32, 1), x);
}
```
- `zig test file.zig`. Filter with `--test-filter "name"`.
- Fuzzing is built in: `std.testing.fuzz(ctx, fn, .{})` with a `*std.testing.Smith` (see the `zig init` template).

## build.zig skeleton (from `zig init` on 0.17.1)

```zig
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const exe = b.addExecutable(.{
        .name = "zun",
        .root_module = b.createModule(.{          // root_module is required (0.15+)
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(exe);
    const run = b.addRunArtifact(exe);
    run.addPassthruArgs();                        // 0.17: replaces `if (b.args) |a| run.addArgs(a)`
    b.step("run", "Run").dependOn(&run.step);
    const tests = b.addTest(.{ .root_module = exe.root_module });
    b.step("test", "Run tests").dependOn(&b.addRunArtifact(tests).step);
}
```
- `build.zig.zon` has `.name = .identifier` (an enum literal), `.fingerprint`, and `.minimum_zig_version = "0.17.1"`.
- C headers: add the `translate_c` package (`zig fetch --save git+https://codeberg.org/ziglang/translate-c#zig-0.17.x`).
  See `upstream/release-notes-0.17.0.md`, section "C Translation Moving to External Package".
