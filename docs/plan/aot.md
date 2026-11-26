# Plan: ahead-of-time compilation (`bun compile`)

Task T7 from `docs/GAP.md`. Research only, no code. Explains how Bun canary's AoT compiler works end to end,
then proposes a realistic path for zun.

**Sources read** (all read-only, cloned outside the repo):

| Short name | What | Version |
|---|---|---|
| `canary:` | `oven-sh/bun` main | `e13b16bc` (2026-11) |
| `webkit:` | `oven-sh/WebKit`, the commit canary pins in `canary:scripts/build/deps/webkit.ts:9`. Only `Source/JavaScriptCore/aot/` was checked out | `32300d4d` (2026-11-24) |
| `docs:` | `canary:docs/compiler/*.mdx`, the user docs | same as canary |

Line numbers are from those commits. Claims marked **UNVERIFIED** are inferences I didn't confirm in code.

---

## 1. The answer in one paragraph

`bun compile` has **two halves in two repositories**. The **front end** is Rust in Bun (`canary:src/aot`,
291k lines). It loads the module graph, parses and type checks with `sema`, lowers sema's HIR to an SSA IR,
links all modules into one program and serializes it as bytes. The **engine** is C++ inside Oven's WebKit
fork (`webkit:Source/JavaScriptCore/aot`, about 750k lines plus 343k lines of tests). It reads the IR, runs
whole-program analysis, plans object layouts and calling conventions, optimizes, and generates machine code
with **its own back end** (not B3/Air, not LLVM, not LLInt). Then it writes an "image" with code and tables.
Bun puts the image into the standalone executable, next to the usual module graph. At run time the image runs
**inside a normal JavaScriptCore VM**. Compiled objects are JSC cells (`AOT::Object : JSObject`), on JSC's GC
heap. Code that the build couldn't see (`eval`, `new Function`, `node:vm`, files loaded from disk) runs in
JSC's interpreter. The executable has no JIT. The two halves talk through one C ABI (`Bun__AOT__*`) and a
byte format generated on both sides from one schema file.

**For zun, this changes the GAP.md estimate a lot.** The hardest part (back end, runtime, GC integration) is
BSD-licensed C++ in the WebKit fork, behind a C ABI that Zig can call directly. Zun doesn't have to write a
code generator. It has to (a) move to that WebKit and (b) write a front end that emits the IR.

---

## 2. Pipeline, end to end

```
 bun compile ./app.ts
   │
   │  ── Rust front end: canary:src/aot ─────────────────────────────────────────────
   ├─ Load       resolve imports, loaders, plugins, data/JSON/wasm, Bun's own built-in modules
   │             (canary:src/aot/load/, 41.7k)
   ├─ Bind       module graph, imports/exports, CommonJS vs ESM        (compile/bind_stage.rs)
   ├─ Check+Lower per file: sema's checker + lower HIR → IR, interleaved (compile/lower_stage.rs:318)
   │             (canary:src/aot/lower/, 86.5k; sema's AoT query API, sema/check/aot/, 29k)
   ├─ Link       merge per-file units: number strings/types/layouts/functions, one Program
   │             (canary:src/aot/link/, 14.8k; link/mod.rs:176)
   ├─ Emit       serialize the Program to bytes (canary:src/aot/emit/, 2.3k)
   │
   │  ── C ABI: Bun__AOT__compile (canary:src/jsc/bindings/BunAOTCompile.cpp:134) ──
   │
   │  ── C++ engine: webkit:Source/JavaScriptCore/aot ──────────────────────────────
   ├─ Read+Verify   ir/  (reader, verifier; 41k)
   ├─ Scan          facts/  per-function summaries, in parallel
   ├─ Link          facts/  whole program: reach, call graph, what fields and results hold (94k)
   ├─ Plan          plan/   object layouts, calling conventions, compile units (19k)
   ├─ Walk          walk/   optimizer, callers before callees, then a dead-code sweep (199k)
   ├─ Emit          codegen/ + machine/  operations → block order, register allocation, bytes
   │                (89k + 48k; x86-64 and ARM64 encoders)
   ├─ Image         image/  link the code, write the runtime's tables, order the layout (40k)
   │
   │  ── back in Bun ─────────────────────────────────────────────────────────────────
   ├─ Executable    image + module graph appended to a copy of the runtime
   │                (canary:src/runtime/cli/compile_command/build.rs:278, standalone_graph)
   └─ --trim        cut unused features' byte ranges out of that copy (canary:src/trim)
```

Evidence for the order:

- Front end driver: `canary:src/aot/compile.rs:382` (`compile`). `run_front_end` at `:521` calls
  `bind_modules` (`:525`), `check_and_lower` (`:527`) and `link` (`:531`). `emit` is at `:542`. `run_engine`
  calls `engine::compile` at `:669`.
- Engine stages: `webkit:Source/JavaScriptCore/aot/README.md:5-20` (the "Pipeline" table) and `driver/`.
- The Rust side calls the engine through FFI: `canary:src/aot/engine.rs:251` (`compile`), `:275`
  (`Bun__AOT__compile`). The C++ entry point (`BunAOTCompile.cpp:134`) calls `JSC::AOT::compileProgram`
  through `callRemovable<RemovableFeature::ImageCompiler>`, so `--trim` can remove the compiler itself.
- Debug outputs: `--aot-out=<file>` writes the IR bytes and the engine options (`compile.rs`,
  `write_program_file`). `testaot walk f.ir f3` prints what a stage makes of a function (`README.md`, "Build
  and test").

The front end doesn't use Bun's regular `js_parser` AST for lowering. It lowers sema's HIR
(`use bun_sema::hir` all over `canary:src/aot/lower/`; 143 `use bun_sema` lines in `lower/*.rs`). `bun_js_parser`
is only used in `load/` for side jobs (import.meta.glob, the React Compiler, folding inputs).

---

## 3. The IR

- **One schema, two generated halves.** `webkit:aot/ir/AOTSchema.def` plus `ir/schema/*.def` (28 files)
  define the enums, records and **406 operations**. A TypeScript generator (`webkit:aot/ir/generator/`,
  `emit-cpp-*.ts` and `emit-rust-*.ts`) writes the C++ reader/verifier/walkers *and* the Rust builder/writer
  (`aot_schema*.rs`, included by `canary:src/aot/ir/generated.rs` and listed in `canary:src/aot/build.rs`).
  A hash of the schema is checked at compile time: `BunAOTCompile.cpp:43`
  (`static_assert(JSC::AOT::Wire::schemaHash == BUN_AOT_SCHEMA_HASH)`). The rule in
  `webkit:aot/README.md` is that a schema change lands in both repos together.
- **Shape.** SSA with block parameters (no phi nodes), typed values. The IR text from
  `webkit:aot/tests/README.md`:
  ```
  function f0 name="sum" parameters=[{type=number}, {type=number}] results=[{type=number}] {
    b0(v0: number, v1: number):
      v2 = Add v0, v1
  ```
  The Rust front end builds SSA itself (`canary:src/aot/ir/ssa.rs`).
- **Forms.** The same IR goes through `AsRead → Prepared → Selected → Placed` inside the engine
  (`AOTSchema.def:7`, `enum IRForm`). Operations are tagged with the forms they may appear in
  (`family Constant AsRead..Placed` in `operations.def`).
- **Value representations** the back end chooses: `Int32, Int64, Double, Cell, Cell32, JSValue, OptionalInt64,
  OptionalDouble, RawWord…` (`AOTSchema.def:41`). `Cell32` is a 32-bit compressed reference (see §5).
- **Proofs** are first-class in the IR: `TestedType, Shape, SlotFilled, InBounds, StructureOfClass,
  PrototypeLinkUnchanged, KeyOrder…`, each with a lifetime (`Forever` or `Stretch`) (`AOTSchema.def:51`).
  That's how "this check was already done" travels between optimizations.
- **On the wire** the program is bytes in a `Vec<u64>` (`canary:src/aot/emit/mod.rs:16`). Function bodies
  can stay outside the main buffer (`ExternalFunctionBodies`), so the engine reads them without a copy.

---

## 4. Who generates machine code

**The engine's own back end, in `webkit:aot/machine/`.** README line 20: *"JavaScript does not go through B3 or
Air: `machine/` is the back end. Only WebAssembly modules do (`image/AOTWasmModules.cpp`)."*

`machine/` (48k lines) has its own register allocator (`AOTMachineAllocator*.cpp`, with an allocation fuzzer
`testaot fuzz-allocation`), frame layout, block ordering, folding/fusion, parallel moves, and per-ISA encoders
(`AOTMachineEncoder*X86_64.cpp`, `*ARM64.cpp`). It emits through JSC's assembler (`ImageAssembler`,
`ARM64Assembler` per the README's "Signed return addresses" section), but not through the JIT tiers.

- **Not LLVM.** No LLVM anywhere in `aot/`.
- **Not FTL/DFG offline.** The engine has its own analysis (`facts/`), planner (`plan/`) and optimizer
  (`walk/`). It takes **no profile** and runs **none of the program** at build time (README line 22). That's
  why `--aot-order` only changes layout, never code (§8).
- **B3 is used only for WebAssembly:** `image/AOTWasmModules.cpp:14` is under `ENABLE(WEBASSEMBLY_OMGJIT)` and
  includes `B3Procedure.h`, `WasmOMGIRGenerator.h`. A `.wasm` that you import (or embed as base64) is
  compiled at build time with OMG to relocatable code (`docs:compatibility.mdx:130`).
- Regular expressions are compiled at build time too: `image/AOTRegExpCompiler.cpp`, `AOTRegExpMatcher.cpp`.
- **It builds for the host only.** `docs:index.mdx` ("Builds for: the platform you build on"), and
  `--target` for another platform is listed as unsupported (`docs:compatibility.mdx`, "Not supported").

---

## 5. Run time: how compiled code lives inside JavaScriptCore

The image doesn't replace JSC. It is loaded into a normal JSC VM, and its code operates on JSC values.

- **Objects are JSC cells.** `webkit:aot/object/AOTObject.h:111` `class Object final : public JSObject`.
  `object/AOTClosure.h:22` `class Closure final : public JSFunction`, allocated in a dedicated subspace of
  JSC's heap (`vm.heap.aotClosureSpace`, `:29`). So the fork changes JSC's `Heap` too, not only `aot/`.
  Compiled objects carry a *compiled structure* and a layout (`AOTCompiledStructure.h`,
  `RuntimeLayoutTable` in `object/AOTObjectModel.h`). Uncompiled code still sees ordinary objects:
  `Object.keys`, proxies, the inspector, `JSON.stringify` all go through `JSObject` methods.
- **GC.** Compiled frames are visited by JSC's GC (`runtime/AOTHeapCellVisits.h`, `AOTHeapHooks.cpp`). The
  README rules say a decoded `Structure*` must not be the only thing that keeps a structure alive across a
  call that may collect, and every runtime operation declares whether it may collect, throw or enter the VM.
- **Compressed references.** `Cell32` values need all cells in a 32 GB cage. `Bun__AOT__useImage`
  (`canary:src/jsc/bindings/BunAOTRuntime.cpp:196`) handles `ImageVerdict::NeedsCellCage` by calling
  `JSC::MarkedBlockCage::require()` (`:207-210`). The user-visible limit is "Over 32 GB of objects in a
  thread → `--aot-huge-heap`" (`docs:compatibility.mdx`, "Not supported"). The Rust side picks
  `ReferenceWidth::Narrow` or `Wide` from that flag (`canary:src/aot/engine.rs`, `fill_record`).
- **Runtime library.** `webkit:aot/runtime/` (104k) holds the operations that compiled code calls: property
  access slow paths, calls, iteration, JSON, modules, async/generators (as coroutines), exceptions,
  `AOTInterpreterSlowPaths.cpp`, `AOTDirectEvalOperations.cpp`. Shared stubs are in `stubs/` (60k).
- **Built-ins.** The engine has a table of built-ins (`webkit:aot/builtins/`, `*.builtins.ts` and emitters
  like `AOTBuiltinArrayOperations.cpp`) and inlines many calls directly. That's why built-in prototypes are
  **read-only** in an executable: `Array.prototype.push = f` is a build error `TS100014` or a `TypeError`
  (`docs:compatibility.mdx:24-76`). Some library functions are written in TypeScript and compiled with the
  program (`canary:src/aot/prelude/*.ts`: array sort/search, decorators, iterator consumers). Bun's own
  built-in JS modules (`node:*`, `bun:*`) are compiled as a second project, `ProjectId::Runtime`
  (`compile/lower_stage.rs:327`), so a program only pays for what it reaches.
- **Bun's glue.** Bun registers host bindings for its own classes (`Bun__AOT__registerHostBindings`), and
  `canary:src/jsc/bindings/BunCompiledModules.cpp` (2.8k lines) hooks the image into Bun's module loader,
  `require`, `import.meta`, workers and the test runner. On the Rust side that's
  `canary:src/jsc/compiled_program.rs` (1.35k) and `canary:src/runtime/cli/run_compiled.rs` (1.7k).
- **Loading the image.** The image is carried in the standalone module graph
  (`canary:src/standalone_graph/compiled_program.rs:122-131`, `CompiledProgramInput { image, image_alignment, … }`).
  Its addresses are those of the executable it's written into ("While an executable is written the addresses
  in it are those of the executable", same file; `Bun__AOT__relocateImage` in `BunAOTCompile.cpp`). On Linux the start of the image is
  prefetched with `madvise(MADV_WILLNEED)` (`webkit:aot/image/AOTImageLoading.cpp:590`, `readAheadOfStart`).
- **Stack traces and crashes.** Code addresses map back to functions and source positions
  (`Bun__AOT__frameAtReturnAddress`, `Bun__AOT__offsetInCode`, `canary:src/crash_handler/compiled_frames.rs`).

---

## 6. How types are used

The central rule, `webkit:aot/README.md:18`: *"A value's type is proven by its origin in the function, by a
check that dominates the use, by Link, or by what a caller had proven. A TypeScript type is a speculation. It
never removes a check."*

- **Types from sema become declared types and layouts in the IR.** `canary:src/aot/lower/types.rs` maps
  checker types to IR `TypeId`s. `lower/layouts.rs` (and `layouts/classes.rs`, `object_types.rs`,
  `own_fields.rs`) turns classes and object types into `LayoutId`s with fields in a fixed order. It uses
  sema's AoT queries (`bun_sema::check::aot::{ClassRef, ShapeKind, KeptFact, …}`).
- **The engine decides the real layout.** `plan/` (`AOTFieldsStorage.cpp`, `AOTSlotPlan.cpp`,
  `AOTUnionShapeNumbers.cpp`, `AOTKeyOrders.cpp`) assigns slots. Then `account.balance` becomes one load at a
  fixed offset (`docs:aot.mdx:27`, `docs:types.mdx` "What types get you").
- **Guards.** Where code relies on a declared type that isn't proven (values from `any`, `as`, `JSON.parse`,
  `.d.ts`), it checks the value on entry. If the guard fails, the call takes a slower generic version of the
  function. Nothing throws (`docs:types.mdx:48`; `CodeRole::ParameterGuard` and `SlowBody` in
  `ir/schema/operations.def`).
- **Untyped code still gets layouts** where the compiler can follow an object from its creation to its use,
  "in `.js` files too" (`docs:types.mdx`). JS files are lowered with the `Inferred` role: sema infers types
  but reports no errors. Where nothing is known, the code looks properties up at run time.
  `bun compile --explain` lists those spots with causes `unknown-object`, `unknown-callee`, `lost-track`
  (`docs:explain.mdx`).
- **`int32`.** `import type { int32 } from "bun"` makes a field 4 bytes wide and skips the fraction checks.
  The build must prove every stored value is a whole number in range, or it stops with `TS100031`
  (`docs:types.mdx`, "32-bit integers"; `canary:src/aot/diagnostics/int32_flows.rs`).
- **Type errors stop the build** under the user's `tsconfig.json` (`docs:aot.mdx`, "Type errors stop the
  build"). That's sema's `check`, and it's also `bun check --aot`.

---

## 7. Hardening (`--aot-harden`)

**The mechanism is just engine option words.** `canary:src/runtime/cli/compile_options.rs:40-56`:

| Name | Engine words |
|---|---|
| `proof-checks` | `testing=CheckProofsAtRunTime`, `testing=DisableFrameCells`, `testing=CheckHoistedCallsAtRunTime`, `testing=CheckResultFreshnessAtRunTime`, `check=VerifyEachStage` |
| `ignore-told-ranges` | `testing=CheckBoundsAtRunTime` |

These are members of `flags TestingSwitch` in `webkit:aot/ir/schema/compile-call.def:77`. The same set of
~60 switches also has intentionally *wrong* ones (`FailSpeculations`, `AssumeIndexesInBounds`,
`MisfoldBranchInSweep`, …), which the tests use to show that a check catches the bug.

What they do: `CheckProofsAtRunTime` re-tests every proof where a value arrives. `DisableFrameCells` keeps
every object on the heap (no stack allocation, since "nobody keeps this cell" can't be re-checked).
`VerifyEachStage` runs the IR verifier after every engine stage. `CheckBoundsAtRunTime` re-tests every
indexed access against the length. Costs from `docs:aot.mdx:109-122`: about 5× and about 1.7× slower on a tight typed loop. A
failed check prints `internal AOT error` and aborts. Even without hardening, every build checks the type of a value
where it enters a place whose type is proven.

Separately, the WebKit build has a *hardened lane* (`BUN_HARDENED`): position-independent images, guarded
pages, and on ARM64 Linux signed return addresses in compiled code (`webkit:aot/README.md`, "Signed return
addresses"; prebuilt tarball suffix `-hardened` in `canary:scripts/build/deps/webkit.ts:76`).

---

## 8. `--aot-order` and `--aot-record-order` (layout PGO)

1. `--aot-record-order` builds an executable that contains a recorder (`webkit:aot/runtime/AOTOrderRecorder.cpp`,
   C ABI `Bun__AOT__startOrderRecording` / `finishOrderRecording`). Running it with `BUN_AOT_ORDER_OUT=x.order`
   writes which functions the start entered, in order. Other executables have no recorder at all.
2. `--aot-order=a.order,b.order` passes the files' bytes into `Bun__AOT__compile` (its last argument,
   `orderFile`, `BunAOTCompile.cpp:134`). The engine ranks functions by the list
   (`webkit:aot/image/AOTStartOrder.h`: `rankFunctionsByListedUnits`, `listSitesInStartOrder`,
   `forEachTextOfListedData`, `sortLayoutRecords`; parser in `image/AOTOrderFile.cpp`).
3. The image places those functions' code next to each other, plus the strings, constants and layout records
   they use. On Linux the start region is prefetched with `MADV_WILLNEED` (§5).

Code generation doesn't change, and builds stay reproducible. The profile holds module paths and function
names, so it survives code edits (`docs:aot.mdx:124-160`). Reported result: a large CLI's cold start went
from 1.67 s to 0.69 s.

---

## 9. `--trim`

Trim is **binary surgery on a copy of the runtime**, prepared when Bun itself is linked.

- **When Bun is built**, `canary:scripts/build/trim/link.ts` wraps the linker
  (`scripts/build/compile.ts:229`). It reads the object files (ELF/Mach-O/COFF readers in `scripts/build/trim/`),
  builds a section graph, finds entry points of each feature (`entry-points.ts`, `declared-uses.ts`), partitions
  and orders sections so each feature's code is contiguous, and writes a table of removable ranges into the
  binary. Features are the ~70 names in `docs:size.mdx` (`jit`, `interpreter`, `sqlite`, `intl`, `cli`, `aot`…).
  C++ calls into a removable feature go through `JSC::callRemovable<Feature, Stub>`, so a removed feature
  traps or throws `ERR_FEATURE_REMOVED` instead of crashing.
- **When a program is compiled**, the engine reports which features and built-ins the program uses
  (`canary:src/aot/engine/used_features.rs`). `canary:src/trim/decide.rs` and `plan.rs` decide what to cut. A
  program that may run unseen code (`eval`, `node:vm`, `bun:ffi`, computed `import()`) blocks parts of the cut
  (`docs:size.mdx`, "What blocks `--trim`").
- **`canary:src/trim/apply.rs:35`** opens the copied executable with `bun_exe_format::image::ImageEditor`,
  then cuts the ranges or fills them with trap instructions (`bun_removable_features::trap::{X86_64_TRAP,
  AARCH64_TRAP}`). It also removes unused ICU locale data (`icu_data.rs`, `--trim-locales`).
- `bun compile` already omits the CLI and the JIT unless the program needs them. `jit` alone is 14.1 MB and
  `cli` 47.4 MB on Linux x64 (`docs:size.mdx`).

Size: `canary:src/trim` 12.5k Rust, `canary:src/exe_format` (ELF/Mach-O/PE editor), `scripts/build/trim/` (~35 TS files).

---

## 10. What isn't compiled (falls back)

| Code | What happens | Source |
|---|---|---|
| `eval`, `new Function`, `node:vm` | Interpreted. There's no JIT in the executable | `docs:compatibility.mdx:93` |
| Same, but the string can be computed from constants (template-generated functions) | Compiled at build time, used when the strings match at run time | `docs:compatibility.mdx` "Code from strings" |
| A call that the build can't see evaluates code (`fn[name](code)` without `"constructor"` written anywhere) | `EvalError` | same |
| Files loaded from disk at run time, computed `import()` outside the executable | Interpreted, second instance of packages | `docs:compatibility.mdx:202` |
| A `Worker` with no image | "All that the thread runs from here on is bytecode" | `BunAOTRuntime.cpp:217-226` |
| WebAssembly imported or embedded as base64 | Compiled at build time with B3/OMG | `webkit:aot/image/AOTWasmModules.cpp:14` |
| WebAssembly bytes created at run time | Interpreted, "much slower" | `docs:compatibility.mdx:130` |
| `ShadowRealm`, macros (`with { type: "macro" }`), `--target` for another OS, breakpoints/`debugger` | Not supported | `docs:compatibility.mdx` "Not supported" |
| `--disallow-code-generation-from-strings` | Removes the parser and interpreter; `eval` throws | `docs:size.mdx` |

The interpreter is JSC's LLInt with an AoT-specific part (`llint/LowLevelInterpreterAOT.asm`, named in
`webkit:aot/README.md`) and `runtime/AOTInterpreterSlowPaths.cpp`. **UNVERIFIED:** which Wasm interpreter
tier (IPInt or LLInt-Wasm) runs run-time Wasm.

---

## 11. Does AoT need `sema`?

**The engine doesn't.** Types are speculations (README:18). CI builds every test program **four ways**: as
written, with `--aot-erase-types`, with `--aot-testing=FailSpeculations:<n>`, and with
`--aot-harden=proof-checks`. All four must print what `bun <file>` prints (`test/aot/README.md` in
canary; `webkit:aot/README.md:48`). So a program lowered with no declared types is a supported, tested input.

**Canary's front end does, completely.** It is built on sema's parser, binder, HIR and checker, not on Bun's
`js_parser`:

- `lower_file(inputs, checker, file, …)` takes `&mut Checker` (`compile/lower_stage.rs:189-233`). Checking and
  lowering are interleaved per file, and the checker's types are freed halfway through big builds.
- Even `--aot-erase-types` still runs the checker: it only demotes files from `FileRole::Checked` to
  `FileRole::Inferred` (`compile/lower_stage.rs:1241-1256`). JS files are always `Inferred`.
- sema has a 29k-line module just for AoT queries (`canary:src/sema/check/aot/`: class shapes, call targets,
  const inlining, dead code, constructor evidence, type identity…). sema as a whole is 400k lines.

**So for zun:** a new front end that lowers **without a type checker** is possible in principle, because the
engine accepts untyped IR. **UNVERIFIED:** how much of the IR's layouts and call targets the engine's own
`Link` (`facts/AOTLinkLayouts.cpp`, `AOTLinkCalls.cpp`, `AOTLinkPrototypes.cpp`) recovers by itself, versus
what canary's front end gets from sema's inference on `Inferred` files. The README says Link computes "what
fields and results hold", which suggests a lot of it. A spike (§13, S1) answers this cheaply.

---

## 12. Testing approach

| Level | Where | How |
|---|---|---|
| Engine stages | `webkit:aot/tests/` (3,162 files, 343k lines) | `testaot`: `.ir` text tests with `RUN:`/`CHECK:` lines, one folder per stage (`ir/`, `types/`, `link/`, `plan/`, `walk/<mechanism>/`, `machine/`, `image/`), plus native C++ tests. Each stage prints text, so a bug gets a test at its stage (`tests/README.md`) |
| Front end lowering | `canary:test/aot/ir/` | small source → expected IR, `cargo test -p bun_aot --test ir_tests` |
| Whole programs | `canary:test/aot/parallel/<topic>/` | `run-parallel.ts` builds each program 4 ways and compares stdout/exit code with `bun <file>`. `// STATISTIC:` lines assert an optimization fired |
| Everything else | `canary:test/aot/*.test.ts` (949 files at top level), `test/cli/aot-*`, `test/bundler/compile-aot-*` | `bun test` |
| Conformance | `test/aot/other-suites` | test262, JSTests, Node's and Bun's tests, compiled, run by hand |
| Fuzzing | `testaot fuzz-allocation`; `test/aot/fuzz/` | register allocator and programs |
| `--trim` | `trimmed-is-whole/cases/` | a trimmed build behaves the same |

The four-way build and `FailSpeculations` are the key ideas: they test the *slow paths* that a correct type
would never reach.

---

## 13. Plan for zun

### 13.1 Recommendation

**Reuse the engine. Write only the front end and the glue.** Zun already decided that JSC (C++) stays
(ROADMAP "Decisions", GAP §4). The AoT engine is part of that same JSC fork, BSD-2-Clause, and reachable
through C functions (`Bun__AOT__compile`, `Bun__AOT__useImage`, …) that Zig can call with `extern fn` like any
other `Bun__*` binding. Writing a JavaScript native compiler in Zig would mean recreating ~750k lines of C++
(analysis, planner, optimizer, back end, image format, runtime, GC hooks, unwinder) and keeping it in sync with
JSC's object model. That's not realistic.

Alternatives I rejected:

| Option | Why not |
|---|---|
| Zig's own backends | They're the Zig compiler's internals, not a library with a stable API. And codegen is the small part: the runtime/GC interop is the hard part |
| LLVM via its C API | Gives codegen only. Zun would still need a JSC-compatible object model, stack maps for GC, unwinding, and calls into the JSC runtime. It's a second engine |
| JSC's DFG/FTL run offline | JSC has no offline mode for JS, and Oven didn't take this path either (README:20) |
| Cache JSC bytecode (`--bytecode`) | Already exists in 1.3.14 for `build --compile`. It's worth restoring as a stepping stone (S0), but it's not AoT |

### 13.2 Prerequisites

1. **Phase 4 bundler + standalone executable**: `zun build --compile` with `standalone_graph` restored. AoT
   puts its image into the same graph (`CompiledProgramInput`).
2. **A WebKit that has `ENABLE(AOT)`.** Prebuilt tarballs for it have the suffix `-aot`
   (`canary:scripts/build/deps/webkit.ts:76-79`), at the pinned commit. Moving zun from the 1.3.14-era WebKit to
   `32300d4d` (or later) means porting zun's C++ bindings (`src/jsc/bindings`) to the newer JSC API. Phase 5
   needs this anyway for canary parity. **This is the biggest prerequisite and it isn't AoT-specific.**
   **UNVERIFIED:** whether `ENABLE(AOT)` can be built for zun's Linux x64 target with the JIT also present
   (`webkit.ts:325` sets `ENABLE_AOT` only when `c.jit` is false in the *local* build; the prebuilt `-aot`
   tarball is what canary ships and it can still run `bun build --compile` without AoT).
3. **`check`** (T8) only for the typed stage (S5). Not needed for S1–S4.

### 13.3 Staged path

Each stage ends at a checkpoint (AGENTS.md rule 3).

| Stage | What | Zig work | Gate |
|---|---|---|---|
| **S0** | Restore `build --compile --bytecode` from 1.3.14 | port existing Zig | `zun build --compile` runs, starts faster. Part of Phase 4, not AoT |
| **S1. Spike** (research) | Build `testaot` and `jsc` from `oven-sh/WebKit@32300d4` (`bun run build:local --target=engine-test-programs` in canary, or WebKit's CMake). Write IR text by hand, run `testaot compile`/`image`. Also get `--aot-out` IR from a canary binary installed under a scratch dir (never the owner's `bun`, rule 4) to see real IR for small programs, typed and with `--aot-erase-types` | none | Answers §11's UNVERIFIED: how fast is untyped IR? Writes `docs/plan/aot-ir.md` |
| **S2. IR writer in Zig** | Add an `emit-zig-*.ts` target to the schema generator (next to `emit-rust-*.ts`), or a Zig `comptime`/build-step generator that reads `AOTSchema.def`. Emit the same wire bytes and the same schema hash | builder, writer, enums, ids (Rust equivalents: `ir/` 17.5k, `emit/` 2.3k, `interface/`) | `testaot verify` accepts zun's bytes; round-trip with IR text |
| **S3. Untyped front end** | Lower zun's own Zig AST (`js_parser`, already in tree) to IR with no declared types: scopes, closures/captures, classes, generators/async, destructuring, modules (ESM + CommonJS), exceptions. Link modules (Rust `link/` 14.8k is the model) | the big one. Canary's `lower/` is 86.5k but leans on sema's HIR. **UNVERIFIED** estimate: 40–80k lines of Zig | A `run-parallel`-style harness: each program as `zun file` vs compiled, plus a `FailSpeculations` build |
| **S4. Runtime glue** | Port `BunCompiledModules.cpp`, `BunAOTRuntime.cpp`, `BunAOTCompile.cpp` (C++, ~3.6k, can be copied with attribution) and the Rust `compiled_program.rs`, `run_compiled.rs`, `compile_command/` (~7k) to Zig. Hook the image into the module loader, `require`, workers | ~10k Zig + copied C++ | `zun compile hello.ts && ./hello`; start-time and memory benchmark vs `--bytecode` |
| **S5. Typed lowering** | Feed checker answers into lowering: declared types, class layouts, call targets, `int32`. Needs `check`. If T8 picks typescript-go in Go, this needs a query API across the Go boundary, per file, interleaved with lowering (canary's `sema/check/aot` is 29k lines of such queries). **UNVERIFIED** whether that's workable across a C ABI; porting sema to Zig is the other route (400k) | large, depends on T8 | typed programs beat untyped in `--explain` |
| **S6. Extras** | `--aot-harden` (option words, nearly free once S4 works), `--aot-order` (engine does it; zun passes the files and sets `BUN_AOT_ORDER_OUT`), `--explain` (engine records → report, canary's `report/` 9k), `bun test --aot`, `--trim` (needs zun's own link-time tooling like `scripts/build/trim/` plus `src/trim` and `exe_format`) | medium each | per flag |

### 13.4 Size and risk

| Item | Size (canary) | Zun's cost | Risk |
|---|---|---|---|
| Engine (C++, WebKit fork) | ~750k + 343k tests | **0**, reused through the prebuilt `-aot` WebKit | It changes almost daily (commit `32300d4d` is "fix wrong answers in Object.assign…"). Zun must track WebKit bumps together with schema changes |
| WebKit bump + C++ binding port | (Phase 5) | high | Blocks running any image. Shared with canary parity |
| IR schema → Zig | generator ~60 TS files | low–medium | Schema hash must match exactly. Every WebKit bump can change the schema |
| Front end, untyped | Rust `lower/`+`link/`+`load/`+`modules/` ≈ 190k | high | Semantics bugs show up as wrong answers. The 4-way test harness is essential |
| Front end, typed | + `sema` 400k (or Go bridge) | very high | Depends on T8's choice |
| Glue (module loader, standalone graph) | C++ 3.6k + Rust ~10k | medium | Ties into the module loader that Phase 4 restores |
| `--trim` | Rust 12.5k + TS link tooling + exe_format | medium–high | Needs control of zun's final link |
| Licensing | WebKit fork BSD-2, Bun MIT | keep notices | low |

**Big uncertainty:** whether Oven keeps the engine in the public WebKit fork with a stable C ABI. It's public
today (`oven-sh/WebKit`, releases with `-aot` tarballs). If it moves or the ABI churns, S2–S4 get more expensive.

### 13.5 Order relative to the rest of the roadmap

AoT is Phase 5 work at the earliest. Its true prerequisites are Phase 4 (bundler, standalone) and the WebKit bump. `check` is only
needed for S5. S1 (the spike) is cheap, needs no zun code, and can run any time. It's the right next step
once someone has time, because it turns the main UNVERIFIED item (untyped-IR quality) into a measured fact.

---

## 14. File map (for whoever picks this up)

| Concern | Canary (Rust/C++ in `oven-sh/bun`) | Engine (`oven-sh/WebKit`, `Source/JavaScriptCore/`) |
|---|---|---|
| Driver | `src/aot/compile.rs`, `compile/*_stage.rs` | `aot/driver/AOTDriver.cpp` |
| IR | `src/aot/ir/` (generated: `ir/generated.rs`) | `aot/ir/AOTSchema.def`, `ir/schema/*.def`, `ir/generator/` |
| Lowering | `src/aot/lower/` | none |
| Type queries | `src/sema/check/aot/` | `aot/ir/AOTType*.cpp` (type algebra) |
| Whole-program analysis | `src/aot/link/` (merge) | `aot/facts/` |
| Layout | `src/aot/lower/layouts/` (declared) | `aot/plan/` (chosen) |
| Optimizer | none | `aot/walk/` |
| Back end | none | `aot/codegen/`, `aot/machine/` |
| Image | `src/standalone_graph/compiled_program.rs` | `aot/image/` |
| Runtime | `src/jsc/compiled_program.rs`, `src/jsc/bindings/BunCompiledModules.cpp`, `BunAOTRuntime.cpp` | `aot/runtime/`, `aot/object/`, `aot/stubs/`, `llint/LowLevelInterpreterAOT.asm` |
| C ABI | `src/aot/engine.rs`, `src/jsc/bindings/BunAOTCompile.cpp` | `aot/driver/` (`compileProgram`, `useImage`) |
| CLI options | `src/runtime/cli/compile_options.rs`, `src/options_types/aot_options.rs` | `aot/support/` (option words) |
| Trim | `src/trim/`, `src/exe_format/`, `scripts/build/trim/` | `JSC::callRemovable` |
| Build pin | `scripts/build/deps/webkit.ts`, `scripts/build/aot.ts`, `aot-source-lists.ts` | `aot/AOT.cmake`, `Sources.txt` |
| Tests | `test/aot/`, `src/aot/tests/` | `aot/tests/` (`testaot`) |
