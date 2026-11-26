# Lessons log

Things we learned the hard way while working on zun. Add newest first, with a date.
Keep each entry short: what happened, why, what to do instead.

## 2026-11-26: Phase 3 (become zun)

- **`return` inside `comptime { }` fails in a runtime-called fn.** A helper that turned `"BUN_X"` into
  `"ZUN_X"` with `comptime { return "ZUN_" ++ key[4..]; }` was rejected ("function called at runtime cannot
  return value at comptime"). **Do:** `return comptime "ZUN_" ++ key[4..];`. Probe: `probes/comptime-return/`.
- **Keep pure rules in a std-only file.** `src/bun_core/zun_identity.zig` doesn't import `bun`, so
  `zig test src/bun_core/zun_identity.zig` runs its tests in about a second, without the 75 s build.
  The `bun`-dependent wrappers live next to it in `zun.zig`.
- **Dead code is not compiled.** Zig only analyses what is referenced, so a helper that nothing calls is never
  type-checked (`probes/lazy-analysis.zig`: a type error in an unused fn still passes). `runEntryFile` in `src/bun.js.zig` looked like the launcher path but has no callers; the live
  path is `runSourceWithHook` (from `src/rt/jsc_engine.zig`). Check with `grep` for callers before wiring code in.

## 2026-11-26: Phase 2 port to 0.17: what the compiler did and didn't tell us

- **Parse errors come first, and stop everything.** The first `zig build obj` on 0.17 reported only `**`
  syntax errors (37 files) and nothing else: the semantic errors only showed up once the codemod had removed
  every `**`. Fix syntax-level changes in bulk before reading semantic errors.
- **Errors arrive in waves.** Zig analyses lazily, so fixing one layer exposes the next (65 → 41 → 8 → 7 → 0 unique
  errors). Deduplicate with `rg "^\S+:\d+:\d+: error: " log | sort -u`: 720 reported errors were 65 real ones.
- **A codemod must know about files outside the module.** `src/unicode/uucode_lib` is std-only and not part of
  `bun`, so rewriting it to `bun.meta.*` would have broken it. The codemod now skips bun-helper rewrites in files
  without `@import("bun")`. (That directory turned out not to compile on 0.16 either: it still uses `@Type`.)
- **`x ** if (c) a else b` is valid old Zig.** The right operand of `**` can be an `if` expression. The first
  codemod version treated `if` as an identifier and produced garbage; it now refuses keywords.
- **Read the old semantics precisely before auditing.** "`@hasDecl` now sees only pub decls" sounded like 57
  suspicious calls. The exact 0.16 rule ("pub, or non-pub *in the same file as the call*") cut it to 10, all fine.
- **0.17.1's configure cache ignores `--build-file`.** With one `--cache-dir`, `zig build --build-file other.zig -l`
  printed `build.zig`'s steps. Probe: `probes/build-file-cache/run.sh`. **Do:** one cache dir per build file.
- **`inline fn` vs comptime-only results.** A helper returning `[]const StructField` (which holds `type`) must be
  `inline` with a `comptime` body, or callers get "pointer is runtime-known". Probe in `migration-017.zig`.
- **`@typeInfo(E).error_set.error_names` is not in declaration order.** A probe that indexed `[1]` failed. Search by name.
- **`zig test file.zig` writes `.zig-cache/` into the current directory.** It's gitignored here; run probes from the repo root.

## 2026-11-26: `Writer.Allocating.init` starts with no buffer

`std.compress.flate.Compress.init` asserts its output writer has a buffer of more than
8 bytes, so passing `&aw.writer` from `Writer.Allocating.init(gpa)` aborted the test
with "reached unreachable code". **Do:** use `try .initCapacity(gpa, n)` when a consumer
writes into the writer's buffer directly. Also: `"str" ** n` no longer parses at all in
0.17 (the `**` operator is gone, the error talks about whitespace around `*`).

## 2026-11-26: `0xaaaa…` in a crash means "read `undefined`"

In Debug builds, Zig fills memory assigned `undefined` with `0xaa` bytes. The baseline
crashed with `rax = 0xaaaaaaaaaaaaaaaa` in `P.zig:2777`. The cause was
`opts.macro_context = undefined;` in `src/bundler/transpiler.zig` (see `docs/status/baseline.md`).
In release builds the memory isn't filled, so the same bug can *seem* to work.
**Do:** when you see `0xaa…` in a register or pointer, look for an `= undefined` upstream of the crash.

## 2026-11-26: build-script APIs that differ between 0.16 and 0.17 (checked against both std trees)

Cruller's build broke on 0.16 after two "zig 17" commits. Checked in `lib/std` of both versions:
- `std.builtin.OptimizeMode`: 0.16 has `.Debug/.ReleaseSafe/.ReleaseFast/.ReleaseSmall`; 0.17 has
  `std.lang.Optimize` with `.debug/.safe/.fast/.small` (`OptimizeMode` is an alias). On 0.16, `.fast` fails with
  `no field named 'fast' in enum 'builtin.OptimizeMode'`.
- `b.pathFromRoot(p)` exists in 0.16 (`Build.zig:1770`) and is gone in 0.17. Use `b.root.joinString(b.allocator, p)`
  (`b.root` is a `Cache.Path`; 0.16 has `b.build_root`, a `Cache.Directory`, instead).
- `allocator.dupeZ(u8, s)` exists in 0.16 and is gone in 0.17. `dupeSentinel(u8, s, 0)` exists in **both**, so
  switch to it before the port.
**Do:** the Zig build runner type-checks `build.zig` before running any step, so one stale API blocks every step.
To bisect, run `zig build -l` first: it lists the steps and fails fast on build-script errors.

## 2026-11-26: memory of Zig is out of date; probe first

Assuming `@typeInfo(T).@"struct".fields` still worked (it's been the API for years)
failed on 0.17.1: struct info is now struct-of-arrays (`field_names`, `field_types`,
`field_attrs`). **Do:** before using any reflection or std API you haven't checked
on 0.17, write a 5-line test in `probes/` or grep `lib/std`.

## 2026-11-26: `std.builtin` is `std.lang`

The definitions of `Type`, `CallingConvention`, `Optimize`, etc. live in
`lib/std/lang.zig`. `std.builtin` is a deprecated alias. Look in `lang.zig` when
you need the real shape of a reflection type.

## 2026-11-26: an independent fact-check caught 3 wrong claims

A reviewer agent found that the cheatsheet said `bit_set.Dynamic` uses `.empty` (it
still needs `initEmpty(gpa, n)`) and that `std.meta.fields` was "deprecated" (it is
already a `@compileError`). Both were written from release-note summaries, not probes.
**Do:** every cheatsheet line needs a probe. Grep hits in comments or vendored code
(`src/unicode/uucode_lib`) inflate migration counts, so check where hits land before estimating.

## 2026-11-26: restoring `src/md`: upstream Bun is not vanilla Zig

Bun 1.3.14 was built with Oven's Zig fork, which accepts `#name` private fields. Vanilla 0.17.1 fails to
parse them ("expected type expression, found 'invalid token'"). Cruller had already renamed them to `priv_name`
in kept files, so the codemod now does the same (`private-field` rule). The other surprise: 10 of 14 errors
were `std.ArrayListUnmanaged(T) = .{}`, and the same pattern sat in 10 never-compiled zun files
(`JSTranspiler.zig`, `HTMLBundle.zig`, …) that nobody had noticed. **Do:** after copying a module, run the
codemod over the whole tree (`--check src` must stay clean) so dead files get the same fix.

## 2026-11-26: a gate cannot hide a missing file

A gate like `const Shell = if (flag) @import("./shell/shell.zig") else struct {};` fails when the file is
absent, even though the branch is dead: Zig loads every imported file eagerly. Gates can only hide **decls**
(`bun.shell.x`) behind `if (comptime flag)`. `probes/comptime-gate/run.sh`.

## 2026-11-26: `[][:0]const u8` coerces to `[]const []const u8`; `export var` vs `export fn`

Writing the RT-2 launcher fix, the agent assumed `bun.argv` (`[][:0]const u8`) would not coerce to
`[]const []const u8` and wrote a copy loop. The probe showed it does coerce on 0.17.1, sharing the same memory,
so the copy was removed. RT-1 was the opposite kind of mistake: cruller stubbed a C `extern bool` as an
`export fn`, so C++ read instruction bytes as the flag. `export var x: bool = false;` gives a BSS data symbol
(`nm`: `B`). Probe: `probes/rt2-launcher/coerce.zig`. **Do:** when C declares `extern T name;`, the Zig side
must be `export var`, and check with `nm` (`T` = code, `B`/`D` = data).
