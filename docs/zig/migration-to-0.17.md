# Migrating code to Zig 0.17

Bun 1.3.14 was built with Oven's patched Zig (commit `04e7f6ac`, 0.14/0.15 era).
Cruller ported it to vanilla **0.16**. **Zun is on 0.17.1 since Phase 2** (2026-11-26): status, audit and a
"what changed and why" walkthrough are in `docs/status/zig-017.md`.

## The codemod: `scripts/fix_zig017.ts`

Every mechanical 0.16 → 0.17 rewrite used in the port lives in one script, so code restored from Bun 1.3.14
goes through the same steps. Order for restored code:

1. `bun scripts/restore-module.ts --from=<bun-v1.3.14> <module>` copies the files and runs step 2 for you
   (`docs/status/restore.md`). Cruller's `scripts/fix_zig016_*.py` are per-file replacements for files zun
   already has, so they do nothing on restored code; use them only as worked examples. Then
2. `bun scripts/fix_zig017.ts <paths>` (0.16 → 0.17, plus Oven-fork syntax such as `#field`), then
3. `bun scripts/fix_zig017.ts --report <paths>` and `bun scripts/zig017_audit_hasdecl.ts <paths>`, then
4. compile and fix the rest by hand (the list below says what to expect).

```sh
bun scripts/fix_zig017.ts src/cli              # rewrite in place, prints counts per rule
bun scripts/fix_zig017.ts --check src          # exit 1 if anything would change (idempotency / CI)
bun scripts/fix_zig017.ts --report src         # also list sites that need a human
bun scripts/fix_zig017.ts --only=array-mul,void-init src/foo.zig
bun test ./scripts/fix_zig017.test.ts          # the codemod's own tests
```

It masks comments, strings and `\\` lines, so it only rewrites code, and a second run changes nothing.

| Rule | Rewrite |
|------|---------|
| `array-mul` | `[_]T{x} ** n` → `@splat(x)` when the declaration has a type, else `@as([n]T, @splat(x))`; `.{x} ** n` → `@splat(x)`; `"s" ** n` → `bun.strings.repeatComptime("s", n)`. Multi-element arrays and `x ** if (…)` are left (reported) |
| `void-init` | `void{}` → `{}` |
| `private-field` | `#name` → `priv_name` (Oven Zig-fork private fields, used by Bun 1.3.14; cruller's naming). `--report` lists `"#name"` strings (`private-field-string`) |
| `arraylist-empty` | `std.ArrayList[Aligned][Unmanaged](T) = .{}` and `…(T){}` → `.empty` (type argument matched with balanced parens). Untyped `.list = .{}` and `@memset(lists, .{})` stay manual |
| `stack-fallback` | `std.heap.stackFallback(` / `StackFallbackAllocator(` → `bun.allocators.*` (0.16's implementation, same fields) |
| `alloc-print` | `std.fmt.allocPrint(a, f, x)` → `a.print(f, x)`, `allocPrintSentinel` → `a.printSentinel` |
| `dupe-z` | `a.dupeZ(T, s)` → `a.dupeSentinel(T, s, 0)` |
| `buf-print-z` | `std.fmt.bufPrintZ(b, f, x)` → `std.fmt.bufPrintSentinel(b, f, x, 0)` |
| `meta-int` | `std.meta.Int(s, n)` → `@Int(s, n)` |
| `builtin-target` | `builtin.os/cpu/abi/object_format` → `builtin.target.os/cpu/abi/ofmt` |
| `optimize-mode`, `optimize-type` | `mode == .Debug` → `.debug`, `OptimizeMode.ReleaseSafe` → `std.lang.Optimize.safe`, type → `std.lang.Optimize` |
| `type-renames` | `std.builtin.Type.StructField/UnionField/EnumField/Declaration/Fn.Param` → `bun.meta.*`; `StructField.Attributes` → `Type.Struct.FieldAttributes` (same for Union, Fn.ParamAttributes) |
| `std-builtin` | `std.builtin.` → `std.lang.` |
| `bit-set` | `IntegerBitSet` → `bit_set.Integer`, `StaticBitSet` → `Static`, `DynamicBitSetUnmanaged` → `Dynamic`, … |
| `reflection` | `X.@"struct"/"union"/"enum".fields` → `bun.meta.fieldsOf(X.@"…")`; `.decls` → `bun.meta.declsOf`; `.@"fn".params` → `bun.meta.paramsOf`; `std.meta.fields(T)` → `bun.meta.fieldsOf(T)`; `std.meta.declarations` → `bun.meta.declsOf`; `.@"fn".is_var_args/calling_convention` → `.attrs.varargs/.attrs.@"callconv"`; `.pointer.is_const/is_volatile/is_allowzero/address_space/alignment` → `.attrs.@"…"` |

The `bun.*` helpers keep the 0.16 *shape* (array of `{name, type, …}`) so call sites need no restructuring.
In files that don't import `bun` (std-only tools, files with standalone tests) those rewrites are skipped and
`--report` lists them as `needs-bun`: port those by hand to the struct-of-arrays API.

**Still manual** (the compiler reports all of these; see `docs/status/zig-017.md` for examples):
reflection through a variable (`const info = @typeInfo(T).@"struct"; info.fields`), `std.ArrayList` struct
literals (add `.pointer_stability = .{}`), `@bitCast` on extern structs/unions (`bun.memCast`),
`EnumSet`/`bit_set.Integer` `initEmpty()/initFull()` → `.empty/.full`, `ErrorSet` → `error_names`,
x86_64 `fstatat64` → `bun.sys.fstatat_syscall`, `linux.wait4(*i32)`, `@bitSizeOf` on auto-layout structs,
`errdefer |err|`. Then audit `@hasDecl` and `@bitCast` (silent changes).

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

Code copied back from upstream Bun 1.3.14 (CLI, install, shell, test runner, css, …) is
**already on the 0.15 language** (no `usingnamespace`; it uses `std.Io.Writer` and `{f}`, verified by T5,
`docs/plan/restore-1.3.14.md`). So it needs the **0.16 and 0.17** changes below. The 0.15 list is kept for reference:

- 0.15: `usingnamespace` removed. `async`/`await` removed. "Writergate" (new `std.Io.Writer`/`Reader`, `{f}` required for format methods, format methods lose fmt/options). `ArrayList` unmanaged by default. `BoundedArray` removed. Implicit root module removed from the build.
- 0.16: `std.Io` interface everywhere (fs, net, time, sync primitives). Juicy Main and non-global env/args. `@Type` → `@Int`/`@Struct`/…. `@cImport` deprecated. `mem.indexOf*` → `find*`, plus `cut*`. Unmanaged containers only (`ArrayHashMap` → `array_hash_map.*`). `Thread.Pool` removed. Error renames (`RenameAcrossMountPoints` → `CrossDevice`, …).
- 0.17: the table above.

**Tip:** to see how cruller already solved a 0.16 problem, diff the same file between
upstream `bun-v1.3.14` and cruller. That's a library of worked examples, and the
`scripts/fix_zig016_*.py` files in cruller are its automation.
