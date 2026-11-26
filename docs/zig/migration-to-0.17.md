# Migrating code to Zig 0.17

Bun 1.3.14 was built with Oven's patched Zig (commit `04e7f6ac`, 0.14/0.15 era).
Cruller ported it to vanilla **0.16**. Its last two commits ("zig 17") only touch build files
(root `build.zig` and `src/unicode/uucode_lib/build.zig`), so the **0.16 → 0.17 port has not really started**.

Sources: `upstream/release-notes-0.15.1.md`, `-0.16.0.md`, `-0.17.0.md`. Read the
named section before migrating a pattern.

## 0.16 → 0.17: how much of cruller each change touches

Rough grep counts over cruller `src/` + `build.zig` (2026-11-26). They are
approximate: a pattern like `.fields` also matches unrelated code.

| Change | Files | Hits | Fails how? |
|--------|------:|-----:|------------|
| `@bitCast` semantics (arrays/vectors use logical bits; extern struct/union rejected) | 91 | 374 | **can be silent**: audit by hand |
| `std.fmt.allocPrint` → `allocator.print` | 56 | 193 | deprecated only (still compiles) |
| `StackFallbackAllocator` / `stackFallback` → `heap.BufferFirstAllocator` | 63 | 147 | compile error |
| `@hasDecl` is now pub-only | 48 | 146 | **silent** where it gates comptime branches |
| `@typeInfo(..).decls` → `decl_names` | 19 | 127 | compile error |
| `@typeInfo(..).fields` → SoA `field_names`/`field_types`/`field_attrs` | 39 | 120 | compile error |
| Fn `.params` / `.calling_convention` → `param_types`/`param_attrs`/`attrs.@"callconv"` | 19 | 105 | compile error |
| `std.builtin.` → `std.lang.` | 27 | 88 | deprecated only |
| `[_]T{x} ** n` array multiplication → `@splat(x)` | 43 | 83 | compile error |
| `std.meta.fields` / `declarationInfo` | ~25 | ~25 | **compile error** (already `@compileError`) |
| `std.meta.fieldNames` / `fieldInfo` | | ~29 | deprecated |
| `IntegerBitSet` / `DynamicBitSet` / … renames | 10 | 49 | deprecated (managed `DynamicBitSet` too) |
| `builtin.os/cpu/abi` → `builtin.target.*` | 8 | 26 | deprecated, removed in 0.18 |
| Pointer `.is_const` / `.is_volatile` → `attrs.@"const"` … | 7 | 19 | compile error |
| `OptimizeMode` → `Optimize` (`.debug/.safe/.fast/.small`) | 4 | 9 | `==` comparisons break |
| `getLast` / `getLastOrNull` → `last()` | 3 | 7 | deprecated |
| `void{}` → `{}` | 2 | 5 | compile error (4 of 5 are in vendored `src/unicode/uucode_lib`) |
| `@Type(` | 2 | 4 | compile error (all in vendored `src/unicode/uucode_lib`) |
| `@cImport` (removed) | 2 | 3 | **none to port**: all 3 hits are in comments |

Also check the build system (0.17 "Separate the Maker Process from the Configurer
Process", cache rework, `addPassthruArgs`) against cruller's custom `build.zig`
and `scripts/build/zig.ts`.

## Suggested order for the 0.17 port

1. Get a **0.16 baseline green** first (build + smoke tests), so every 0.17 failure is clearly a 0.17 problem.
2. Fix the build files (`build.zig`, `build.zig.zon`, translate-c).
3. Fix compile errors module by module, leaves first: `bun_core`, `collections`, `string`, … then `jsc`, `runtime`.
4. Fix deprecations in bulk with careful sed, one pattern per commit.
5. Audit `@bitCast` and `@hasDecl` by hand. These can be silent, so they need tests, not the compiler.

## Earlier changes (already handled by cruller's 0.16 port, but needed when restoring code from upstream 1.3.14)

Code copied back from upstream Bun 1.3.14 (CLI, install, shell, test runner, css, …)
is pre-0.15, so it needs **all** of these:

- 0.15: `usingnamespace` removed. `async`/`await` removed. "Writergate" (new `std.Io.Writer`/`Reader`, `{f}` required for format methods, format methods lose fmt/options). `ArrayList` unmanaged by default. `BoundedArray` removed. Implicit root module removed from the build.
- 0.16: `std.Io` interface everywhere (fs, net, time, sync primitives). Juicy Main and non-global env/args. `@Type` → `@Int`/`@Struct`/…. `@cImport` deprecated. `mem.indexOf*` → `find*`, plus `cut*`. Unmanaged containers only (`ArrayHashMap` → `array_hash_map.*`). `Thread.Pool` removed. Error renames (`RenameAcrossMountPoints` → `CrossDevice`, …).
- 0.17: the table above.

**Tip:** to see how cruller already solved a 0.16 problem, diff the same file between
upstream `bun-v1.3.14` and cruller. That's a library of worked examples, and the
`scripts/fix_zig016_*.py` files in cruller are its automation.
