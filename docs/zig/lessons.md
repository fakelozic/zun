# Lessons log

Things we learned the hard way while working on zun. Add newest first, with a date.
Keep each entry short: what happened, why, what to do instead.

## 2026-11-27 IPv6 presentation in `std.Io.net`

- On 0.16.0 and 0.17.1, `Ip6Address.format` compresses the longest zero run and renders IPv4-mapped addresses
  with a dotted tail. It includes brackets and port and omits the scope. The 0.17.1 formatter also uses a dotted
  tail for `64:ff9b::/96`, where Node uses hex. [Formatting probe](probes/ipv6-format/format.zig).
- (Observed by the TQ-9 agent, not covered by the probe.) On Linux with either release, `Ip6Address.formatResolved(std.testing.io, &writer)` on an address resolved
  from `fe80::1%lo` panics in `Io.Threaded.netInterfaceName`. Formatting `Ip6Address.Unresolved` with a supplied
  interface name works for that address and avoids the lookup. [TQ-9 RCA](../rca/TQ-9-ipv6-format.md).

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

## 2026-11-26: a C enum in Zig must be non-exhaustive if the C side can grow it

Bumping brotli to v1.2.1 (security C1) added decoder error `-17`. zun's bindings declared `BrotliDecoderErrorCode`
as an exhaustive `enum(c_int)`, returned it straight from an `extern fn`, converted it with `@enumFromInt` and
matched it in an `inline for` ending in `unreachable`. With the new library, the exact error a crafted stream
produces would have been "invalid enum value" (a panic in safe builds) or undefined behaviour in ReleaseFast.
**Do:** enums that mirror C values get a `_` member; use `std.enums.tagName(E, v) orelse "unknown"` instead of
`@tagName`, and never end a lookup over C values in `unreachable`. Probe: `probes/nonexhaustive-enum/enum.zig`.
When bumping a C dependency, diff its public headers for new enum values before building.

## 2026-11-26: a `noreturn` call from Zig doesn't unpoison ASAN's stack shadow; std owns a per-thread sigaltstack

Found in TQ-3 (`docs/rca/TQ-3-worker-thread-exit-under-asan.md`). Two verified facts:

- Clang emits `__asan_handle_no_return()` before every call to a `noreturn` function in instrumented C/C++; that
  clears the redzones of the frames about to be abandoned. **Zig code is not ASAN-instrumented**, so a `noreturn`
  call made from Zig (`pthread_exit`, `longjmp`, a stack switch) while C++ frames sit above it on the stack leaves
  their redzones poisoned. The next code that runs on that memory (here pthread TSD destructors) gets a bogus
  `stack-buffer-underflow` or ASAN's `kCurrentStackFrameMagic` CHECK. On any build the skipped C++ destructors are
  a real bug. **Do:** end threads by returning; never leave C++ frames by a non-local exit from Zig.
- Zig 0.16/0.17 std gives every `std.Thread` and the main thread a TLS alt signal stack
  (`std.options.signal_stack_size`, default `1 << 18`; `Thread.callFn` → `maybeAttachSignalStack`, `Thread.zig:1744`
  in 0.17.1). ASAN also gives each thread its own and `munmap`s whatever is current at thread exit, so under ASAN
  an exiting `std.Thread` makes ASAN try to unmap TLS (`failed to deallocate 0x40000 … error code: 22`). Turn it off
  per build with `.signal_stack_size = if (asan) null else (std.Options{}).signal_stack_size` (probe:
  `probes/signal-stack/options.zig`).

## 2026-11-26: `std.mem.byteSwapAllFields` on a packed struct reverses the whole backing integer

In 0.17.1, `byteSwapAllFields` is a deprecated alias of `std.mem.byteSwap`. For a struct with a backing integer
(any `packed struct`), `byteSwapAligned` does `@byteSwap` on the **whole** `uN`. It does not swap each field. So a
packed `FrameHeader { length: u24, type: u8, flags: u8, streamIdentifier: u32 }` with length 0x12 and type 4 comes out as
`00 00 00 00 00 04 00 00 12`, the wire bytes in reverse, not `00 00 12 04 00 00 00 00 00`. Only `extern` structs are
swapped field by field. Probe: `probes/byteswap-packed/byteswap.zig`, run with `zig test`. This broke zun's HTTP/2
client (security `known-issues.md` H2C-1). **Do:** to serialize a wire header, write each field with
`std.mem.writeInt(..., .big)` (or use an `extern struct` of byte arrays), and never byte-swap a packed struct to get
network order.
**When it changed (verified in the installed std sources):** Zig 0.16.0's `byteSwapAllFields` already does the
whole-integer swap for packed structs (`lib/std/mem.zig:2233`), so this isn't new in 0.17. Bun 1.3.14's pinned Zig (`oven-sh/zig@04e7f6ac`, `lib/std/mem.zig` `byteSwapAllFields`: loops over the fields even for a packed struct)
swapped packed fields one by one, and cruller's 0.16 port (`a1c009d`) silently changed the meaning. **Both** zun HTTP/2
implementations use it (`src/http/h2_client/ClientSession.zig`, `src/http/H2FrameParser.zig`,
`src/runtime/api/bun/h2_frame_parser.zig` for node:http2). zun talking to zun is symmetric, so the bug stays hidden;
it only shows against a real peer (Node, a browser, nginx).


**Follow-up (H2C-1 fix):** a packed struct's **first field is bit 0**, so `@bitCast` of
`packed struct(u32) { reserved: bool, uint31: u31 }` puts the flag at bit 0, not at bit 31 where HTTP/2's E/R bit
lives (probe test "packed bitCast: first field is bit 0" in `probes/byteswap-packed/byteswap.zig`). The HTTP/2 wire
structs now live in `src/http/h2_wire.zig` and have explicit `decode`/`encode` plus RFC byte tests
(`zig test src/http/h2_wire.zig`).

## 2026-11-26: pinning a hand-written `extern struct` mirror field by field

Verified on 0.17.1 (probe `probes/abi-field-check/check.zig`, used for review H1-4 in `src/picohttp_sys/picohttpparser.zig`):
inside a type's `comptime {}` block a plain `for` over a tuple of `.{ "name", offset, size }` tuples works, and
`@offsetOf`, `@sizeOf(@FieldType(T, name))`, `@alignOf(T)` and `@typeInfo(T).@"struct".field_names.len` are all
comptime-known. Checking only `@sizeOf` and the last offsets misses a field moving inside the prefix; check every field
(and the count, so an added field fails too), with matching C `_Static_assert`s on the other side.

## 2026-11-27: an explicit-tag enum with methods inside a packed struct

Verified on 0.17.1 (probe `probes/enum-in-packed/enum-in-packed.zig`, run with `zig test`): an `enum(u2)` with decls
(methods) can be a field of a `packed struct(u32)`. It takes exactly its tag's bits, a `= .none` default works, and you
can call its methods on the field directly (`flags.reused.max(.callback)`), since the enum type is unchanged by being
packed. `@enumFromInt(@max(@intFromEnum(a), @intFromEnum(b)))` gives an ordered `max` over the declared tag values.
Used for `HTTPClient.PeerVerification` in `HTTPClient.Flags` (TLS-ID-1). **Do:** give the enum an explicit tag type
(`enum(u2)`), so the packed struct's bit count stays fixed and the `_: uN` padding can be adjusted by hand.

## 2026-11-26: `BUN_DEBUG_QUIET_LOGS` silences scoped logs only; a cut operand must become a gate, not vanish

TQ-2: debug builds printed `DEBUG: Resolving …` on every resolve even with `BUN_DEBUG_QUIET_LOGS=1`. That variable is
read only in `Output.ScopedLogger.evaluateIsVisible` (`src/bun_core/output.zig`), so it hides `Output.scoped(...)`
logs (`[sys]`, `[fs]`, …) but not `Output.debug(...)`, which prints whenever `Environment.isDebug`. The print was
un-gated because a "make it compile" edit deleted `and bun.cli.debug_flags.hasResolveBreakpoint(...)` when `src/cli`
was cut. **Do:** when a condition's operand refers to a removed subsystem, replace it with an equivalent opt-in gate
(or `false`), never delete it. Verified by running the unfixed and fixed builds (`docs/rca/TQ-2-*.md`).
