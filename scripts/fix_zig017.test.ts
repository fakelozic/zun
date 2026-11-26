// Tests for scripts/fix_zig017.ts. Run: bun test scripts/fix_zig017.test.ts
import { expect, test } from "bun:test";
import { fixSource, reportSource } from "./fix_zig017.ts";

/** Fix as part of the bun module (the import is appended, then stripped again). */
const fix = (s: string) => {
  const out = fixSource(s + BUN).out;
  if (!out.endsWith(BUN)) throw new Error("bun import lost");
  return out.slice(0, -BUN.length);
};
const BUN = 'const bun = @import("bun");\n';

const cases: [string, string, string][] = [
  ["typed var", "var a: [16]u8 = .{0} ** 16;\n", "var a: [16]u8 = @splat(0);\n"],
  ["typed [_]", "var b: [256]i32 = [_]i32{0} ** 256;\n", "var b: [256]i32 = @splat(0);\n"],
  ["untyped [_]", "var c = [_]bool{false} ** 256;\n", "var c = @as([256]bool, @splat(false));\n"],
  ["expr count", "var d = [_]u8{0} ** (Metadata.size * 2);\n", "var d = @as([(Metadata.size * 2)]u8, @splat(0));\n"],
  ["field default", "    keys: [n]Key = [_]Key{.{}} ** n,\n", "    keys: [n]Key = @splat(.{}),\n"],
  ["field init", "    .freqs = [_]i32{0} ** 64,\n", "    .freqs = @as([64]i32, @splat(0)),\n"],
  ["nested elem", "var pal: [256][4]u8 = .{.{ 0, 0, 0, 255 }} ** 256;\n", "var pal: [256][4]u8 = @splat(.{ 0, 0, 0, 255 });\n"],
  ["generic T", "var m = [_]std.array_list.Managed([]const u8){undefined} ** k;\n", "var m = @as([k]std.array_list.Managed([]const u8), @splat(undefined));\n"],
  ["count chain", 'var e: [x.@"struct".decls.len][]const u8 = .{""} ** x.@"struct".decls.len;\n', 'var e: [bun.meta.declsOf(x.@"struct").len][]const u8 = @splat("");\n'],
  ["string", 'const s = "=" ** 60 ++ "\\n";\n', 'const s = bun.strings.repeatComptime("=", 60) ++ "\\n";\n'],
  ["void{}", "return void{};\n", "return {};\n"],
  ["private field", "const S = struct {\n    #ptr: *u8,\n    #n: usize = 0,\n    fn f(s: *S) usize { return s.#n; }\n    fn g(p: *u8) S { return .{ .#ptr = p }; }\n};\n", "const S = struct {\n    priv_ptr: *u8,\n    priv_n: usize = 0,\n    fn f(s: *S) usize { return s.priv_n; }\n    fn g(p: *u8) S { return .{ .priv_ptr = p }; }\n};\n"],
  ["arraylist empty", "    a: std.ArrayListUnmanaged(Foo(u8)) = .{},\n    var b = std.ArrayListUnmanaged(u8){};\n    var c: std.ArrayList(u8) = .{ .items = x };\n", "    a: std.ArrayListUnmanaged(Foo(u8)) = .empty,\n    var b = std.ArrayListUnmanaged(u8).empty;\n    var c: std.ArrayList(u8) = .{ .items = x };\n"],
  ["arraylist nested in map left alone", "m: std.AutoHashMapUnmanaged(i32, std.ArrayListUnmanaged(W)) = .{},\n", "m: std.AutoHashMapUnmanaged(i32, std.ArrayListUnmanaged(W)) = .{},\n"],
  ["private field not in strings", 'const c = "#fff"; // #ptr\n', 'const c = "#fff"; // #ptr\n'],
  ["stackFallback", "var sfa = std.heap.stackFallback(512, a);\nx: std.heap.StackFallbackAllocator(4),\n", "var sfa = bun.allocators.stackFallback(512, a);\nx: bun.allocators.StackFallbackAllocator(4),\n"],
  ["allocPrint", 'const s = try std.fmt.allocPrint(bun.default_allocator, "{d}", .{1});\n', 'const s = try bun.default_allocator.print("{d}", .{1});\n'],
  ["allocPrint call arg", 'x = std.fmt.allocPrint(arena.allocator(), "{s}", .{a});\n', 'x = arena.allocator().print("{s}", .{a});\n'],
  ["allocPrintSentinel", 'x = std.fmt.allocPrintSentinel(a, "{s}", .{b}, 0);\n', 'x = a.printSentinel("{s}", .{b}, 0);\n'],
  ["builtin.os", "if (builtin.os.tag == .linux) {}\nconst c = @import(\"builtin\").cpu.arch;\n", "if (builtin.target.os.tag == .linux) {}\nconst c = @import(\"builtin\").target.cpu.arch;\n"],
  ["builtin.mode", "const d = builtin.mode == .Debug;\nconst s = std.builtin.OptimizeMode.ReleaseSafe == builtin.mode;\n", "const d = builtin.mode == .debug;\nconst s = std.lang.Optimize.safe == builtin.mode;\n"],
  ["OptimizeMode type", "o: std.builtin.OptimizeMode,\n", "o: std.lang.Optimize,\n"],
  ["std.builtin", "const t: std.builtin.Type = undefined;\n", "const t: std.lang.Type = undefined;\n"],
  ["type renames", "a: std.builtin.Type.StructField.Attributes,\nb: []const std.builtin.Type.EnumField,\n", "a: std.lang.Type.Struct.FieldAttributes,\nb: []const bun.meta.EnumField,\n"],
  ["bit set", "const B = std.bit_set.IntegerBitSet(8);\nconst D = std.DynamicBitSetUnmanaged;\n", "const B = std.bit_set.Integer(8);\nconst D = std.bit_set.Dynamic;\n"],
  ["fields", 'inline for (@typeInfo(T).@"struct".fields) |f| {}\n', 'inline for (bun.meta.fieldsOf(@typeInfo(T).@"struct")) |f| {}\n'],
  ["fields via var", 'const n = info.@"union".fields.len;\n', 'const n = bun.meta.fieldsOf(info.@"union").len;\n'],
  ["decls", 'for (@typeInfo(@This()).@"struct".decls) |d| {}\n', 'for (bun.meta.declsOf(@typeInfo(@This()).@"struct")) |d| {}\n'],
  ["params", 'const p = @typeInfo(@TypeOf(f)).@"fn".params;\n', 'const p = bun.meta.paramsOf(@typeInfo(@TypeOf(f)).@"fn");\n'],
  ["fn attrs", 'const v = @typeInfo(F).@"fn".is_var_args;\nconst cc = @typeInfo(F).@"fn".calling_convention;\n', 'const v = @typeInfo(F).@"fn".attrs.varargs;\nconst cc = @typeInfo(F).@"fn".attrs.@"callconv";\n'],
  ["pointer attrs", 'const k = @typeInfo(P).@"pointer".is_const;\n', 'const k = @typeInfo(P).@"pointer".attrs.@"const";\n'],
  ["pointer align", 'const a = @typeInfo(P).pointer.alignment;\n', 'const a = @typeInfo(P).pointer.attrs.@"align";\n'],
  ["dupeZ", "const z = try a.dupeZ(u8, s);\n", "const z = try a.dupeSentinel(u8, s, 0);\n"],
  ["bufPrintZ", 'const z = try std.fmt.bufPrintZ(&buf, "{d}", .{n});\n', 'const z = try std.fmt.bufPrintSentinel(&buf, "{d}", .{n}, 0);\n'],
  ["meta.Int", "const I = std.meta.Int(.unsigned, 8);\n", "const I = @Int(.unsigned, 8);\n"],
  ["unquoted pointer", "const k = info.pointer.is_const;\n", 'const k = info.pointer.attrs.@"const";\n'],
  ["std.meta.declarations", "for (std.meta.declarations(T)) |d| {}\n", "for (bun.meta.declsOf(T)) |d| {}\n"],
  ["std.meta.fields", "inline for (std.meta.fields(T)) |f| {}\n", "inline for (bun.meta.fieldsOf(T)) |f| {}\n"],
];

for (const [name, input, expected] of cases) {
  test(name, () => {
    expect(fix(input)).toBe(expected);
  });
}

test("idempotent on every case", () => {
  for (const [, input] of cases) {
    const once = fix(input);
    expect(fix(once)).toBe(once);
  }
});

test("leaves comments and strings alone", () => {
  const src = '// var a = [_]u8{0} ** 4; builtin.os.tag void{}\nconst s = "std.heap.stackFallback( ** void{}";\n';
  expect(fix(src)).toBe(src);
});

test("std-only files (no bun import) never get bun.* helpers", () => {
  const src = 'inline for (@typeInfo(T).@"struct".fields) |f| {}\nvar a: [4]u8 = .{0} ** 4;\nconst s = "=" ** 3;\n';
  const out = fixSource(src).out;
  expect(out).toBe('inline for (@typeInfo(T).@"struct".fields) |f| {}\nvar a: [4]u8 = @splat(0);\nconst s = "=" ** 3;\n');
  expect(reportSource(out).map(r => r.rule)).toEqual(["needs-bun", "array-mul-left"]);
});

test("multi-element arrays are left and reported", () => {
  const src = "var a = [_]u8{ 1, 2 } ** 4;\n";
  expect(fix(src)).toBe(src);
  expect(reportSource(src).map(r => r.rule)).toContain("array-mul-left");
});

test("report finds @hasDecl, @bitCast, errdefer capture", () => {
  const src = 'if (@hasDecl(T, "x")) {}\nconst y: u32 = @bitCast(f);\nerrdefer |err| log(err);\n';
  expect(reportSource(src).map(r => r.rule)).toEqual(["has-decl", "bit-cast", "errdefer-capture"]);
});

test("`x ** if (...) a else b` is left for a human", () => {
  const src = "    pad: [if (T == u32) 4 else 0]u8 = [_]u8{0} ** if (T == u32) 4 else 0,\n";
  expect(fix(src)).toBe(src);
});
