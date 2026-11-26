# Plan: zun's developer tools (`check`, `lint`, `fmt`, React Compiler)

Task T8 in `docs/GAP.md`. Research only, written 2026-11-26.

Sources used (all read-only):

- **Bun canary** `main` @ `e13b16b` (1.4.6-dev): `src/sema`, `src/lint`, `src/format`, `src/react_compiler`,
  their `CLAUDE.md` / `DESIGN.md` / crate docs, `docs/runtime/check.mdx`, `docs/lint/*.mdx`, `docs/format/index.mdx`,
  `docs/typescript-6.mdx`, and the test tree (`test/cli/{check,lint,format}`, read with `git ls-tree` / `git show`
  because the checkout is sparse).
- **microsoft/typescript-go** @ `89d5d5b` (2026-08-20, the last commit before the repo closed).
- **microsoft/TypeScript** `main` @ `e0fce98` (2026-11-25), checked only for layout.
- **oxc-project/tsgolint** @ `020d62f` and **web-infra-dev/rslint** @ `cc9b323`: two Go linters built on
  typescript-go, checked for layout, license and rule counts.
- A **probe** I built during this task: typescript-go compiled as a Go `c-archive` and linked into a Zig 0.17.1 program
  (see [the probe](#probe-typescript-go-inside-a-zig-binary)).

Line counts are `.rs` / `.go` / `.zig` lines with `cat | wc -l` (comments included, tests excluded unless stated).
Anything not checked against source or a run is marked **UNVERIFIED**.

---

## TL;DR

| Tool | Bun canary | Recommendation for zun | First milestone |
|------|-----------|------------------------|-----------------|
| `zun check` | `src/sema`, 400k Rust, a port of typescript-go's parser/binder/checker | **(A) embed typescript-go (Go) as a `c-archive`** linked into the Zig binary | `zun check` = `tsc --noEmit` from TypeScript 7, in about 1–2 weeks of work |
| `zun lint` | `src/lint`, 328k Rust, rules over sema's HIR | **(A′) Go, on the same embedded typescript-go AST/binder/checker**, starting from **rslint**'s rules (MIT, ~900 rules in Go) and graded with Bun's conformance bundle | the ESLint + typescript-eslint recommended sets, including type-aware rules |
| `zun fmt` | `src/format`, 132k Rust, oxc_formatter port printing from sema's HIR | **(A′) Go, port Bun's `src/format` onto the typescript-go AST**. Optional stage 0: run Prettier itself in zun's JSC | JS/TS/JSON byte-identical to Prettier 3.9.9 on Prettier's fixtures |
| React Compiler | `src/react_compiler`, 61k Rust, runs on the *runtime* parser's AST | **(B) port to Zig** on zun's `js_parser` AST, after the bundler/transpiler is restored | `bun test --react-compiler` fixtures pass |

The deciding fact: **in Bun canary, `lint` and `fmt` do not use Bun's runtime parser.** They sit on `sema`'s own
parser and HIR, which is a port of typescript-go's parser. So "how do we do `check`" decides the foundation for `lint`
and `fmt` too. Embedding typescript-go gives zun a maintained, full-fidelity TypeScript AST, binder and checker for
free, and the Go linter ecosystem (rslint, tsgolint) already builds on exactly that. Only the React Compiler belongs to
the runtime parser, so it goes to Zig.

The biggest strategic cost: Bun's **AoT compiler (`src/aot`) is built on sema's HIR, binder and checker** (hundreds of
`bun_sema::hir` / `bind` / `check` uses). Choosing typescript-go for `check` means zun's AoT (if it ever comes) needs a
different front end. See [Interaction with AoT](#interaction-with-aot-t7) and T7's `docs/plan/aot.md`.

---

## How Bun canary's tools fit together

```
                         text of a .ts/.tsx/.js file
                                     │
          ┌──────────────────────────┴───────────────────────────┐
          ▼                                                      ▼
 src/js_parser (runtime parser,                         src/sema/parser  (34.5k)
 esbuild-style, skips types)                            "structured like typescript-go's parser.go",
          │                                             writes sema's HIR directly, no syntax tree
          ▼                                                      │
 bun_ast (src/ast)                                               ▼
          │                                       src/sema: hir, bind (27k), check (180k), program,
          ▼                                       resolve, config  ──────────────────► bun check
 src/react_compiler (61k)                                        │                      src/sema/driver (27k)
 lowers bun_ast → React HIR                                      ▼
 → upstream passes → bun_ast                      src/lint/ast "handles" over HIR + binder (9k)
          │                                       semantic/ tokens/ code_path/ types/ ...
          ▼                                         │                        │
 transpiler / bundler / bun test                    ▼                        ▼
                                                  lint rules (~170k)     src/format (132k)
                                                  src/lint/driver (29k)  prints from the same handles
                                                  ── bun lint ──         ── bun fmt (driver in src/lint/driver/fmt) ──
```

Evidence:

- `src/sema/parser/lib.rs`: "A parser that writes `bun_sema::hir` directly, with no syntax tree in between. It's a
  recursive descent parser structured like TypeScript's own (parser.go of typescript-go …)". It uses `bun_ast` only for
  lexer tables (`bun_ast::lexer_tables::JSX_ENTITY`).
- `src/lint/CLAUDE.md`: "Rules are written in Rust against the HIR and binder output that `bun check` already produces.
  **Nothing is converted to ESTree**". Type-aware rules read `bun_sema::check::services` (`src/lint/types/flags.rs`).
- `src/format/CLAUDE.md`: "There is no AST of its own. It prints straight from the type checker's HIR through the
  handles of `bun_lint::ast`".
- `src/react_compiler/DESIGN.md`: "Bun's parser already produces a fully resolved AST … we lower that AST straight into
  the compiler's HIR … and emit Bun AST nodes straight from the `ReactiveFunction` codegen." The hook is in
  `src/js_parser/visit_stmt.rs` via `src/js_parser/react_compiler_host.rs`.

---

## Probe: typescript-go inside a Zig binary

Done on the dev machine (Linux x86_64, go 1.27.4, zig 0.17.1) during this task. Not committed: it lived in the
session scratchpad. Steps to reproduce:

1. Shallow-clone typescript-go. Add `cmd/zuncheck/main.go` **inside that module** (Go only lets code under
   `github.com/microsoft/typescript-go/...` import its `internal/` packages):

   ```go
   package main
   // #include <stdlib.h>
   import "C"
   import ("context"; "unsafe"; "github.com/microsoft/typescript-go/internal/execute")

   //export ZunTscMain
   func ZunTscMain(argc C.int, argv **C.char) C.int {
       ptrs := unsafe.Slice(argv, int(argc))
       args := make([]string, len(ptrs))
       for i, p := range ptrs { args[i] = C.GoString(p) }
       return C.int(execute.CommandLine(context.Background(), newSystem(), args, nil).Status)
   }
   func main() {}
   ```

   plus a copy of `cmd/tsgo/sys.go` (the `tsc.System` implementation for the real file system).
2. `go build -buildmode=c-archive -trimpath -ldflags='-s -w' -o libtsgo.a ./cmd/zuncheck` → **28.5 MB** `libtsgo.a`
   plus `libtsgo.h`. Cold build: 62 s wall, 4.6 cores. The build cache needs ~2.8 GB (it filled the 8 GB tmpfs once).
3. Zig side (0.17 "juicy main"):

   ```zig
   extern fn ZunTscMain(argc: c_int, argv: [*]const [*:0]const u8) c_int;
   pub fn main(init: std.process.Init) !void {
       const arena = init.arena.allocator();
       const args = try init.minimal.args.toSlice(arena);
       const rest = args[1..];
       const cargs = try arena.alloc([*:0]const u8, rest.len);
       for (rest, 0..) |a, i| cargs[i] = a.ptr;
       std.process.exit(@intCast(ZunTscMain(@intCast(rest.len), cargs.ptr)));
   }
   ```

   `zig build-exe main.zig libtsgo.a -lc -O ReleaseFast` links cleanly in 19 s → **28.7 MB** executable.

Results:

- `zuncheck --version` → `Version 7.1.0-dev`. `zuncheck -p .` on a two-line project prints
  `TS2322` and `TS7006` exactly like `tsc`, exit code 2. 0.18 s wall for that project (lib `.d.ts` files are embedded
  with `go:embed`, 3.9 MB, so no `typescript` package is needed, as in Bun).
- On zun's own `src/tsconfig.json` it reports `TS5102: Option 'baseUrl' has been removed` (the TS 6/7 behaviour Bun's
  docs describe) in 0.04 s.
- **Startup cost of the Go runtime**: a c-archive starts the Go runtime from an `.init_array` constructor, so *every*
  process pays for it, even one that never calls Go. A loop of 200 runs of a binary that exits before calling Go took
  0.457 s vs 0.341 s for an empty Zig binary: **≈0.6 ms per process** (crude measurement, no `perf` on the machine).
  Thread count and RSS at idle not measured (UNVERIFIED).

So option (A) works mechanically today. The real work is the Bun-flavoured driver, build integration and process-level
concerns, below.

---

## 1. `check`: type checker

### What Bun canary does

- **CLI** (`docs/runtime/check.mdx`, "CLI usage"): `bun check [flags] [...files or directories]`, flags `-p/--project`,
  `-b/--build`, `--pretty/--no-pretty`, `--all` (group identical errors above 50), `--threads`, `--no-follow-imports`,
  `--timing`, `--cwd`, `--no-script`, `--aot`, `--explain`, `--define`, and **every compiler option as a flag**.
  `--check` also exists on `bun <file>`, `bun run`, `bun test`, `bun build`, `Bun.build`, `bun compile`, and watch mode.
  If `package.json` has a `check` script, `bun check` runs the script (`--no-script` forces the checker).
- **Semantics**: "reports the same errors as `tsc` from TypeScript 7". `process.versions.typescript` is the exact
  version. `lib.*.d.ts` are built in (`bundled:///libs/lib.dom.d.ts`). Never writes files, no `.tsbuildinfo`.
  Intentional differences from `tsc` (section "Differences from `tsc`"): referenced projects read from source, compiler
  flags allowed with `-b`, `tsconfig.json` with only `references` is followed, paths next to a `tsconfig.json` use it,
  cross-file errors are kept, TS2563 does not poison later files, GitHub Actions annotations, a note for missing
  `bun install`, no language-service plugins, no Yarn PnP.
- **Code**: `src/sema` (`bun_sema`, 400k lines across sub-crates). Biggest parts: `check/` 180k, `driver/` 27k
  (`src/sema/driver/lib.rs`: "`bun check`, `bun build --check` and `bun run --check` all use this"), `parser/` 34.5k,
  `bind/` 27k, `import_sites/` 20k, `program/` 17.5k, `file_analysis/` 15k, `fold/` 10.5k, `resolve/` 9.7k.
  `src/sema/lib.rs`: "Large parts of `check` and `bind` are ported from typescript-go's checker and binder … Comments
  cite the upstream function". Sema is also used by the runtime (`bun_sema_driver::check_provided_then` for `--check`)
  and the bundler (`bun_sema::session::Session`).
- **Tests** (`test/cli/check/`, 52 files):
  - `typescript-go/bundle.zst` (8.3 MB): **TypeScript's compiler and conformance tests plus typescript-go's own tests
    and reference baselines**, unchanged, pinned in `version.json` to typescript-go `2bd066d` / TypeScript `4d4f005`.
    `conformance/{1..8}.test.ts` run all of it and compare `.errors.txt`, `.types`, `.symbols`, declaration output and
    `.trace.json` byte for byte. `README.md` there lists the few places where Bun follows 7.1 rather than 7.0.
  - `differential-cases.json` (3.5 MB) + `differential.test.ts`: differential testing against `tsc`.
  - `check.test.ts` (1.5 MB), `entry-points.test.ts`, `named-files.test.ts` and ~30 regression tests.
  - `src/sema/baselines` writes `.types` / `.symbols` baselines (feature `baselines`).

### typescript-go facts that matter

| Question | Answer |
|----------|--------|
| License | Apache-2.0 (`LICENSE`, `NOTICE.txt`). Compatible with zun's MIT; keep both notices (AGENTS.md rule 5). |
| Where it lives now | **The `microsoft/typescript-go` repo is closed** ("This was the staging repo for the TypeScript 7.0 release … will be permanently archived in September 2026"). Development continues in **`microsoft/TypeScript`**, whose `main` now has a Go module at `tsc/` (`module github.com/microsoft/TypeScript/tsc`, `go 1.27`, `go.work` at the root) with `tsc/internal/{checker,api,execute,…}`. Tags `v7.0.2`, `v7.1-beta` exist. |
| Size | 316k non-test Go lines in typescript-go (incl. `ls` 41k, `lsp` 22k). What a checker needs (`checker` 60k, `ast` 21k, `parser` 9k, `binder` 3.5k, `compiler`, `module`, `tsoptions`, `scanner`, `nodebuilder`, `printer`, …) ≈ 125k. `checker/checker.go` alone is 32k lines. |
| Public Go API | **None.** Everything is under `internal/`. Workarounds: put our package inside the module path (probe), or the **shim** technique used by tsgolint and rslint: separate modules named `github.com/microsoft/typescript-go/shim/<pkg>` (allowed to import `internal/` because Go's rule is path-based), generated re-exports (`tools/gen_shims`), plus a small `patches/` series, with typescript-go as a git submodule. Both pin typescript-go **`2bd066d`, the same commit Bun's `version.json` names**. |
| Other modes | `tsgo --lsp` (full LSP server, `internal/lsp`) and `tsgo --api` (`internal/api`: JSON-RPC/msgpack over stdio, with file-system callbacks, used by the `@typescript/api` client). A `typescript-wasip1-wasm` package exists in `microsoft/TypeScript/packages`. |
| Perf | Microsoft's announced figure is ~10× `tsc` (UNVERIFIED here). Parallel per-file checking with goroutines. |
| Bun's sema vs typescript-go | Sema *is* a typescript-go port (`check`, `bind`, parser structure), with Bun-specific drivers, `import_sites`, `file_analysis`, `fold`, `erasure` and AoT hooks on top. Its conformance gate is typescript-go's own baselines. So typescript-go **is the oracle Bun measures itself against**; embedding it gives zun the oracle's behaviour by definition, minus Bun's intentional differences. |

### Options

**(A) Embed typescript-go via cgo `c-archive` (recommended).**

- Pros: correct by construction (it *is* TS 7); ~125k lines of checker we never port or maintain; TS syntax and checker
  updates arrive by bumping a pin; LSP and API mode come along if wanted; Go is an allowed language; the probe works.
- Cons: +28 MB binary (stripped; zun's current size not measured here, UNVERIFIED how much `-ldflags` / dead-code
  trimming can recover, e.g. by not linking `ls`/`lsp`); a Go runtime in every zun process (≈0.6 ms startup, extra
  threads); `internal/` access needs shims or living inside the module; Bun's intentional differences need our own Go
  driver instead of `execute.CommandLine`; the build needs a Go toolchain; upstream moved repos mid-2026, so the pin
  must move to `microsoft/TypeScript/tsc`.

**(B) Port to Zig** (either Bun's 400k-line sema or typescript-go's ~125k-line core).

- Pros: one language, no Go runtime, full control (and it is what AoT would want, see below).
- Cons: the largest port in the whole project; perpetual chase of TypeScript releases (Bun pays this: its README lists
  per-version baseline differences); typescript-go's checker is one 32k-line file of dense, cyclic, GC-heavy code that
  does not map well onto explicit allocators. Many person-months at minimum (UNVERIFIED estimate).

**(C) Other.**

- *C1: run `tsgo --api` / `tsgo` as a child process* (shipped as a separate file or extracted at runtime). Avoids
  in-process Go, but breaks "one binary" and adds IPC; good as a fallback if in-process Go causes trouble.
- *C2: compile typescript-go to WASI (`wasip1`) and run it in-process with a Zig WASM runtime.* No Go runtime in the
  native process, but much slower and no threads (UNVERIFIED). Not worth it.
- *C3: shell out to the user's `tsc`.* Not parity.

### Recommendation: (A), staged

| Stage | Work | Size | Gate |
|-------|------|------|------|
| C0 | Probe (done above). Record the cgo/Zig link facts in `docs/zig/lessons.md` when the real code lands (they are verified now, but AGENTS.md rule 2 asks for the probe file in the same change). | done | — |
| C1 | Vendoring: `third_party/typescript` as a submodule pinned to a release tag of `microsoft/TypeScript` (`tsc/` module), or to `2bd066d` of typescript-go to match Bun's test bundle. Shim modules generated tsgolint-style. A zun Go module (`go/`) with one `package main` exporting the C ABI. `build.zig`: a `b.addSystemCommand` step running `go build -buildmode=c-archive` with `CC="zig cc -target …"`, its `.a` linked into `zun`. `zun check` passes straight to `execute.CommandLine`. | Go ≈0.5k, Zig ≈0.5k | `zun check` on the probe projects; typescript-go's own baselines need no re-run (same code) |
| C2 | Bun-flavoured driver in Go on `compiler`/`tsoptions` (via shims): nearest-`tsconfig` per named file, `references`-only configs, `-b` with flags, `--no-follow-imports`, output (pretty with code frames, `tsc --pretty false` when piped, >50 grouping, GitHub `::error` lines, summary to stderr), `--threads`, empty-run failure, missing-`bun install` note. Zig CLI side: `check` script precedence, `--no-script`, `--cwd`. `process.versions.typescript`. | Go ≈3–6k, Zig ≈1k (UNVERIFIED) | canary `test/cli/check/{check,named-files,entry-points,messages-*}.test.ts`, run against zun |
| C3 | `--check` on run / test / build / watch: Zig hands Go a list of entry points plus resolver settings (`--conditions`, `--loader`, `--tsconfig-override`) and gets diagnostics back as a C struct or buffer. Needs the restored CLI, test runner and bundler (T4). | Go ≈1–2k, Zig ≈1–2k | canary `compile-with-check`, `--check` tests |
| C4 | Keep in sync: a script that bumps the pin, regenerates shims, re-applies patches, re-runs Bun's `differential` + conformance tests. | small, recurring | CI |
| C5 (opt.) | `zun check --lsp` via `internal/lsp`. Not in Bun; free once C1 exists. | small | — |

Risks:

1. **Signals and threads with JavaScriptCore.** A Go c-archive installs handlers for synchronous signals (SIGSEGV,
   SIGBUS, SIGFPE) and uses SA_ONSTACK; JSC also uses signals (thread suspension for GC, possibly WASM fault handling).
   In `zun check` JSC never starts, so no conflict. In `zun run --check`, Go runs first and JSC installs its handlers
   afterwards, which should win for the JS phase. **UNVERIFIED**: needs a test that runs JSC GC-heavy code after a Go
   check in one process. Fallback: C1-style child process for `--check`.
2. **One Go runtime per process.** Two c-archives cannot coexist. `check`, `lint` and `fmt` Go code must be built into
   **one** archive from one `package main`.
3. **Cross-compiling** the c-archive for arm64 / musl needs a C cross compiler for cgo; `zig cc` is the natural `CC`.
   UNVERIFIED for musl (Go's runtime assumes some glibc behaviour in c-archive mode on Linux; needs a probe).
4. **Binary size**: +28 MB for every user, even those who never type-check. Mitigations: don't link `ls`/`lsp` unless
   wanted; or (C1) ship the checker as a lazily-loaded companion. Decision for the owner (ROADMAP open question).
5. **Upstream relocation**: typescript-go is archived; tsgolint/rslint/Bun still pin it. Move to `microsoft/TypeScript`
   tags early, so shims are generated against the living repo.

### Interaction with AoT (T7)

`src/aot` uses sema directly: `bun_sema::hir` (349 uses), `bind` (253), `atom` (248), `program` (172), `check` (124),
`fold`, `import_sites`, `resolve`, `session`, plus `bun_sema_driver::host`. AoT lowers **sema's HIR** with sema's types;
it is not a consumer of "types only". With option (A) zun has no sema HIR, so an AoT port would need either a Go front
end that lowers typescript-go's AST/types into AoT IR and hands it to Zig, or a Zig sema after all. This plan does not
block AoT, but it means **check-via-Go does not pay for AoT's front end**. T7 should weigh that; if AoT becomes a hard
goal, revisit (B) for the checker or a Go-side lowering.

---

## 2. `lint`: ESLint-compatible linter

### What Bun canary does

- **CLI / config** (`docs/lint/index.mdx`, `plugins.mdx`): `bun lint [paths|globs|!exclusions]`, `--fix`,
  `--fix-suggestions`, `--fix-dangerously`, `--rules`, `--explain <rule>`, `--init`, `--type-aware`, `--type-check`,
  `--tsconfig`, `--doctor`, `--no-script`, formats including `pretty` and `agent`. Config in `bunfig.toml`
  (`[lint]`, `[lint.rules]`, `plugins = [...]`, `typeAware`, `typeCheck`), **and** it reads `eslint.config.js`,
  `.eslintrc*`, `.oxlintrc.json` and reports what that tool reports. Respects `.gitignore`. A `lint` script in
  `package.json` takes precedence.
- **Rules**: 1,049 documented (`docs/lint/rules/*/`: eslint 218, typescript 137, unicorn 138, react 135, vitest 73,
  bun-test 65, jest 60, import 46, jsx-a11y 36, bun 29, oxc 27, markdown 21, nextjs 21, promise 16, node 13, json 6,
  react-perf 4, prettier 1). Rule code: eslint 42k, typescript 40.5k, react 26.5k, plugins 22k, unicorn 16k, jest 4k,
  markdown 1.8k, json 0.4k. 62 rule files in `eslint/`, `typescript/` and `plugins/` mention `requires_types` (type-aware).
- **Infrastructure**: `ast/` 9k (handles over HIR), `linter/` 34k, `driver/` 29k, `utils/` 15k, `semantic/` 6k,
  `types/` 6k (bridge to `bun_sema::check::services`), `code_path/` 5k (ESLint code-path analysis), `regex/` 5k,
  `estree/` 4k + `js_plugin/` 6k + `selector/` 2.6k (the **JavaScript plugin API**: real ESLint plugins run in JSC with
  `context`, `sourceCode`, scopes, fixers), `oxlint/`, `oxlint_order/`, `graph/` (module graph for `import/*`).
  Non-JS languages (`json/`, `markdown/`) plug in through `languages.rs`; files whose config needs a plugin Bun lacks go
  to the installed `eslint` package (`Route::Eslint`).
- **Design rules worth copying** (`src/lint/CLAUDE.md`): listeners declared as constants (`On::new().exprs(..)`) and run
  as tight loops over per-kind node vectors, not tree walks; lazy scopes/tokens/references; report order and locations
  must match ESLint's exactly; per-rule perf budget "0.5 to 3 ms of CPU" on 10,000 files.
- **Tests**: `test/cli/lint/conformance/bundle.zst` (4 MB): **upstream test cases as JSON with what real ESLint reports
  for each** (`meta`, `code`, `options`, `languageOptions`, `messages`, `output`), run by
  `bun lint --run-eslint-tests` (`src/lint/conformance/`). Plus `bun-rules.test.ts` (Bun's own rules), `rule-docs.test.ts`
  (every rule has a doc page whose examples run), `hints.test.ts`, `rule-throws.test.ts`, and `oracle/` fixtures for
  drivers, oxlint, JS plugins and the React Compiler rules.

### Options

**(A′) Go, on embedded typescript-go (recommended).** Rules over typescript-go's `ast` + `binder` + `checker`, through
the same shims as `check`.

- Pros: the AST, scopes and types are already there (and are what Bun's HIR was modelled on, so Bun's rules translate
  structurally); type-aware rules cost nothing extra; **rslint** (MIT, Bytedance) already has about 900 ESLint-family
  rules in Go on typescript-go (by directory count: core ~200, typescript 132, unicorn 145, react 103, jest 70,
  import 44, jsx-a11y 37, node 29, promise 17, react-hooks 3, plus rstest/test-framework); **tsgolint** (MIT, VoidZero)
  has 63 type-aware typescript-eslint rules and is what oxlint uses for type-aware linting. Bun's conformance bundle is
  language-neutral JSON, so it grades any implementation.
- Cons: rslint's fidelity to ESLint is UNVERIFIED (Bun's bar is "byte-identical messages, locations, order, fixes");
  typescript-go's AST is TS-shaped, not ESTree (Bun had the same problem and documents the mapping in
  `src/lint/CLAUDE.md` "ESTree → this API"); Go GC in a hot loop over millions of nodes (perf UNVERIFIED vs Bun); no Flow
  parser in typescript-go.

**(B) Zig.** Needs a full-fidelity parser first: zun's `js_parser` **skips TypeScript types** (`src/js_parser/ast/skipTypescript.zig`)
and only tracks the comments a transpiler needs (pure/legal/preserve flags in `lexer.zig`; full comment retention UNVERIFIED), so it can't serve lint (or fmt) without invasive changes to the runtime's hot path, which Bun
itself avoided by writing a second parser. So (B) = port sema's parser (34.5k) + HIR (2k) + binder (27k) + lint infra
(~100k) + rules (~170k), and type-aware rules still need a checker (back to Go via a cross-language type query API, or
a Zig checker).

- Pros: fastest possible, single language with the runtime, the owner learns Zig on it.
- Cons: ~330k+ lines of porting before parity; type-aware rules need a Zig↔Go bridge for types (tsgolint exists
  precisely because cross-language type queries are impractical).

**(C) Other.** *C1:* run real ESLint inside zun's JSC (zun has the runtime; ESLint runs on Bun). Good as a fallback route
for unknown plugins (Bun does this too) and as a stage 0, not as the product (slow, needs `node_modules`). *C2:* oxlint
(Rust): not an allowed language.

### Recommendation: (A′) Go, staged

| Stage | Work | Size (UNVERIFIED) | Gate |
|-------|------|-------------------|------|
| L0 | Bring Bun's `bundle.zst` + a Go runner (port `src/lint/conformance/`, 1.2k) that feeds cases to a rule and diffs `messages`/`output`. Evaluate rslint's rules against it, plugin by plugin, and record a pass table in `docs/status/lint.md`. **Decide: fork rslint's rules, or port Bun's.** | Go ≈2k | a table, no product |
| L1 | Linter core in Go: listener registration by node kind, lazy scopes/references/tokens, code-path analysis (port `code_path/`), `eslint-disable` comments, fixes and suggestions with ESLint's conflict rules, report ordering. Driver: file walking with `.gitignore`, `bunfig.toml` `[lint]` (parsed on the Zig side and passed down, or in Go), output formats, exit codes, `lint` script precedence. | Go ≈30–50k | ESLint recommended + typescript-eslint recommended pass the bundle |
| L2 | Type-aware rules (tsgolint/rslint typescript rules, graded by the bundle's type-aware cases); `--type-aware`, `--type-check`, `--tsconfig` (reuses `check`'s program loading). | Go ≈10–20k | the 62 type-aware rules |
| L3 | The remaining plugins (unicorn, react, jsx-a11y, import with a module graph, jest/vitest/bun-test, promise, node, nextjs, oxc) and Bun's own `bun/*` rules; doc pages; `--explain`, `--rules`. | Go ≈150k | full bundle, `bun-rules.test.ts`, `rule-docs.test.ts` |
| L4 | Config compatibility: `eslint.config.js` (needs JS evaluation: run it in JSC from the Zig side and pass the resolved config as JSON), `.eslintrc*`, `.oxlintrc.json`, presets; fallback to installed `eslint` for unknown plugins. | Go ≈10k, Zig ≈2k | `oracle/driver` fixtures |
| L5 | JS plugin API: real ESLint plugins in JSC. Needs an ESTree view: build ESTree JS objects from the Go AST (Bun keeps `estree/` for exactly this). Cross-runtime calls Go → Zig/JSC per node are costly; batch per file. | Go+Zig+TS ≈15k | `oracle/jsplugins` |
| L6 | JSON / Markdown languages; React Compiler rules (`react-hooks/*` via the Zig React Compiler, see §4: needs a Go→Zig call with a serialized function, or skip until §4 lands). | ≈5k | rest of the bundle |

Risks: rslint fidelity (L0 decides); Go performance at Bun's budget; the JS-plugin bridge (L5) is the most
architecture-sensitive part because it crosses Go ↔ Zig ↔ JSC; ESLint flat configs are JS, so the Zig runtime has to
evaluate them before Go sees them.

---

## 3. `fmt`: Prettier-compatible formatter

### What Bun canary does

- **CLI / config** (`docs/format/index.mdx`): the command is **`bun fmt`** (`src/cli/format_command.rs`, root matcher
  `b"fmt"`; the crate is `src/format`). `--check` (exit 1 if a file needs formatting, 2 on error), paths/globs/`!`,
  stdin, `--init`, `--doctor`, `--no-script`, every Prettier option as a flag. Config: `bunfig.toml` `[fmt]` and
  `[[fmt.overrides]]`, `.editorconfig`, `.prettierrc*`, `.oxfmtrc.json` (the "oxfmt flavor"), `.prettierignore`,
  `.gitignore`. Extras from oxfmt: `sortImports` (trivago/ianvs/organize-imports flavours), `sortTailwindcss`,
  `sortPackageJson`, `jsdoc`, Svelte, TOML, `insertFinalNewline`.
- **Languages**: JS, JSX, TS, Flow, JSON(5/C), CSS/SCSS/Less, GraphQL, YAML, Markdown/MDX, HTML, Vue, Angular, LWC, MJML,
  Svelte, Handlebars, TOML; embedded code in templates and `<script>`/`<style>`. Not Astro (sent to installed Prettier).
- **Target**: "byte for byte that of Prettier … released **3.9.9**", with a small set of documented deliberate fixes
  where Prettier's output changes program meaning, and idempotence where Prettier isn't.
- **Code** (`src/format`, 132k): `js/` 59k (prints from `bun_lint::ast` handles over sema's HIR; includes `settled/`, a
  second lexer/parser that recognises already-formatted statements and skips them, and `sort_imports/`), `ir/` 6k (the
  document IR, `Formatter`, printer: port of `oxc_formatter_core`), `html/` 13k, `css/` 12k (its own `Elements`
  printer that mimics `printDocToString`, used also by YAML and Markdown), `svelte/` 8k, `markdown/` 7k (on Bun's
  `src/md` parser), `handlebars/` 5k, `json/` 4k, `yaml/` 3k (on `bun_parsers::yaml`), `graphql/` 3k, `verify/` 3k
  (`--debug-check`), `toml/` 1k (on Bun's TOML scanner). Driver in `src/lint/driver/fmt/`.
  Lineage: Prettier ← Biome ← `oxc_formatter` (MIT) ← Bun's port; "where oxc deviates from Prettier, Prettier wins".
- **Tests**: `test/cli/format/prettier/bundle.zst` (853 KB, Prettier 3.9.9 fixtures and snapshots) run by
  `bun fmt --run-prettier-tests` with Prettier's six checks (snapshot, rejection, second pass, CRLF, CR, BOM);
  `EXCLUDED` in `src/format/conformance/prettier.rs` lists skips with reasons; `expected.txt` freezes totals.
  `oxfmt/bundle.zst` (173 KB) for the oxfmt flavor. `own/cases/` (1,255 files: comments 321, ignore 114, css 84, …)
  from fuzzing and real code; `settled/` agreement tests; `format.test.ts`.

### Options

**(A′) Go, port Bun's `src/format` onto the typescript-go AST (recommended).** The JS printer needs the same "handles"
layer as lint (ESTree-ish accessors, comment ownership, spans), so it shares lint's Go adapter over typescript-go. The
language-neutral parts (`ir/`, `css/`, `yaml/`, `markdown/`, `graphql/`, `html/`, `handlebars/`, `toml/`, `json/`) are
plain parser+printer code that ports to Go independently.

- Pros: one AST adapter for lint and fmt (the same split Bun has); TypeScript syntax maintained upstream; no new parser
  to write; Bun's documented, test-driven port is the spec (and is itself ported from MIT code).
- Cons: no Go Prettier-compatible formatter exists to start from (none found; UNVERIFIED); typescript-go keeps comments
  as scanner ranges, not nodes, so comment attachment (`js/attach/`) must be redone over its trivia; YAML/Markdown/TOML
  ride on Bun parsers zun doesn't have in Go (zun has Zig `interchange/` YAML/TOML; `src/md` is a 🔧 restore); Flow
  needs a parser (defer).

**(B) Zig.** Same parser problem as lint: needs sema's parser + HIR + lint's handles in Zig first (~45k) before the
132k-line formatter. Attractive only if lint also goes to Zig.

- Pros: speed; reuses zun's Zig YAML/TOML parsers (`src/interchange`) and the restored `src/md`.
- Cons: ~177k lines of porting before JS/TS formatting works; a Zig TypeScript parser to maintain forever.

**(C) Run Prettier in zun's JSC (stage 0 only).** Embed a bundled Prettier 3.9.9 (MIT) as a built-in module and run it
in the runtime zun already has.

- Pros: 100% Prettier output from day one, for all its languages; days of work once module loading works.
- Cons: slow startup and per-file cost vs native (UNVERIFIED numbers), a few MB of JS in the binary, needs a working
  runtime (`node:` APIs Prettier uses). Not parity with Bun's speed or oxfmt extras.

### Recommendation: (A′) Go, with (C) as an optional stage 0

| Stage | Work | Size (UNVERIFIED) | Gate |
|-------|------|-------------------|------|
| F0 (opt.) | `zun fmt` runs embedded Prettier in JSC. CLI surface, `--check`, config discovery, ignore files. The driver logic is reused by F1+. | TS ≈1k, Zig ≈1k | Prettier's own output by definition |
| F1 | Go port of `ir/` (document + printer) and the conformance runner (`src/format/conformance/`, 1.2k) over Bun's `prettier/bundle.zst`. JSON first (own parser, small) to prove IR and runner. | Go ≈10k | JSON fixtures |
| F2 | JS/TS/JSX printer on the typescript-go adapter shared with lint: comment attachment, parentheses, `js/print/`, `js/utils/`. Skip `settled/` (pure optimisation) until later. | Go ≈50k | `js`, `jsx`, `typescript` fixtures, idempotence, `own/cases` |
| F3 | CSS/SCSS/Less + YAML + Markdown (the `css/doc.rs` printer family), GraphQL, embedded templates. Needs Go parsers for YAML/Markdown or calls into zun's Zig parsers (Go→Zig cgo call per file is fine). | Go ≈25k | those fixtures |
| F4 | HTML/Vue/Angular, Svelte, Handlebars, TOML; import sorting, Tailwind, `package.json`, JSDoc; `.oxfmtrc.json` flavor. | Go ≈40k | `oxfmt/bundle.zst`, remaining fixtures |
| F5 | Perf: port `settled/` (skip already-formatted statements), memoisation (`css/memo.rs`), stack-depth safety (`stack.rs`). | Go ≈10k | benchmarks |

If the owner prefers Zig for fmt (to learn Zig on a CPU-bound, self-contained subsystem), the alternative is: F1/F3/F4
in Zig (they don't need the TS parser), and only F2 waits on a Zig port of sema's parser + HIR + handles. That is a
legitimate choice; it costs ~45k extra lines and a second TypeScript parser to keep current.

---

## 4. React Compiler

### What Bun canary does

- `src/react_compiler` (61k): upstream React Compiler's **Rust crates** (`react_compiler_hir`, `ssa`, `inference`,
  `typeinference`, `optimization`, `validation`, `reactive_scopes`, `diagnostics`, `utils`), copied "byte-for-byte,
  only import paths rewritten", pinned by `UPSTREAM_PORTED` (`560db514…`). Only the AST boundary is Bun's own:
  `lowering/` (8.9k, `bun_ast` → React HIR, replacing upstream's Babel-shaped `react_compiler_ast`) and `codegen.rs`
  (React `ReactiveFunction` → `bun_ast`). Sizes: inference 11k, hir 9k, lowering 9k, reactive_scopes 8k, validation 7k,
  optimization 5k.
- Hook: per function, post-visit, in `src/js_parser/visit_stmt.rs` (same sites as React Fast Refresh), through
  `Host` (`src/js_parser/react_compiler_host.rs`) for symbols, scopes, JSX runtime shape and the
  `react/compiler-runtime` import. Unlowerable nodes bail out per function, as upstream does.
- Surface: `test.reactCompiler` in `bunfig.toml` / `--react-compiler` (`docs/runtime/bunfig.mdx`); bundler option
  `react_compiler: ReactCompilerMode` (`src/bundler/options.rs`); AoT tests under `test/aot/react-compiler`. Also
  "the compiler as a linter": `lint.rs` runs validations only, for `bun lint`'s `react-hooks/*` rules
  (`src/lint/react_compiler/convert.rs` builds a `bun_ast` tree from the linter's tree).
- Tests: `test/bundler/transpiler/react-compiler-fixtures/*.{js,tsx}` + `.expect.md` (upstream-style fixtures),
  `react-compiler-fixtures-run.test.ts` (renders them), `react-compiler.test.ts` snapshots.

### Options

**(B) Port to Zig on zun's `js_parser` AST (recommended).** Zun's AST is the 1.3.14 Zig ancestor of `bun_ast`
(`src/js_parser/ast/*.zig`, `Expr.zig`, `E.zig`, `P.zig`, `visitStmt.zig`), so Bun's type mappings in `DESIGN.md`
(`E::Call`, `S::Local`, `G::Fn`, `Ref`, `Scope`) apply almost one to one. The upstream-copied passes (~45k) don't touch
the AST at all: a mechanical Rust→Zig port. Only `lowering/` + `codegen.rs` + `Host` (~11k) are AST-specific.

- Pros: in-process with the transpiler, where it must run; no runtime cost when off; Zig is the right language here.
- Cons: re-syncing upstream means re-porting Rust diffs into Zig by hand (Bun's `/sync-react-compiler` skill does hunk
  syncs Rust→Rust); depends on the restored transpiler/bundler and test runner (T4).

**(A) Go.** Wrong place: it runs inside the parser's visit pass, per function, on the Zig AST. Crossing into Go per
function with a serialized AST would be slow and complex. Rejected.

**(C) Run upstream `babel-plugin-react-compiler` (JS) through a zun bundler plugin.** Works today in principle for users
(UNVERIFIED on zun), but it's slow and needs Babel. Fine as a documented workaround until (B).

### Recommendation: (B), staged

| Stage | Work | Size (UNVERIFIED) | Gate |
|-------|------|-------------------|------|
| R1 | Port the AST-free passes (hir, ssa, typeinference, inference, optimization, validation, reactive_scopes, diagnostics) to Zig, keeping file layout and names 1:1 with upstream so diffs stay syncable. Unit-test via upstream's HIR printer outputs where possible. | Zig ≈40–50k | per-pass snapshot tests |
| R2 | `lowering/` + `codegen.zig` + `Host` on zun's `P`/`Expr`/`Stmt`; hook at the Fast Refresh sites in `visitStmt.zig`; bail-out semantics. | Zig ≈10k | `react-compiler-fixtures` `.expect.md` |
| R3 | Surface: `--react-compiler`, `test.reactCompiler`, bundler option, include/exclude globs. | small | canary `react-compiler*.test.ts` |
| R4 | Lint mode for `react-hooks/*` rules: expose a C entry point the Go linter can call with one function (serialized), or defer those rules. | ≈2k | lint `oracle/react-compiler` |

Risks: upstream churn (React Compiler is under active development; Bun pins a commit); the port is large but
low-judgement, a good fit for delegated, checkpointed work.

---

## What existing zun pieces can be reused

| zun piece | Reuse |
|-----------|-------|
| `src/js_parser` (43k Zig incl. `ast/`) + `src/js_printer` (7k incl. `renamer.zig`) | **React Compiler** input and output (§4). Also `--check` entry-point discovery on the Zig side. **Not** usable for lint/fmt: skips TS types (`skipTypescript.zig`), tracks only transpiler-relevant comments, esbuild-style lowered AST. |
| `src/interchange` (9k Zig: JSON/TOML/YAML…) | `bunfig.toml` `[lint]`/`[fmt]`/`[test.reactCompiler]` parsing on the Zig side; possibly the YAML/TOML parsers for fmt F3/F4 via a Go→Zig call. |
| `src/resolver` | `--check` passes resolver settings (`--conditions`, `--loader`) to the Go side; typescript-go does its own module resolution for checking. |
| `src/glob`, `.gitignore` handling in the CLI | File walking for lint/fmt could stay in Zig and hand file lists to Go. Simpler first version: walk in Go. |
| JSC runtime | Evaluating `eslint.config.js` / Prettier JS configs (L4), the ESLint JS-plugin API (L5), stage-0 Prettier (F0). |
| `build.zig` | Gets a Go build step for the single c-archive (`go/` → `libzuntools.a`) used by check + lint + fmt. |

---

## Cross-cutting decisions for the owner (checkpoint)

1. **Go in the zun binary at all?** (A) for `check` puts a Go runtime (+28 MB, ≈0.6 ms startup) in every process.
   Alternative: build the Go tools as a companion executable `zun-tools` that `zun` execs for `check`/`lint`/`fmt`.
   Same code, different packaging; can switch later.
2. **Lint/fmt language**: Go on typescript-go (recommended, maximises reuse) vs Zig on a ported sema parser (maximises
   Zig, costs ~45k extra lines plus a parser to maintain).
3. **Pin**: follow Bun's test bundle (`typescript-go 2bd066d`, also tsgolint's and rslint's pin) for the first
   conformance runs, then move to `microsoft/TypeScript` release tags.
4. **AoT**: accept that check-via-Go does not provide AoT's front end (T7 decides).

## Suggested order

C1 → C2 (small, high value, independent of T4) → L0 (cheap evaluation of rslint against Bun's bundle) → F1/F2 and L1/L2
in parallel → C3 and R1–R3 after the CLI, bundler and test runner are restored (T4) → the long tails (L3–L6, F3–F5).
