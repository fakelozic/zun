# Gap analysis: zun today vs Bun canary

Written 2026-11-26. This is the master list of everything zun lacks compared with
current Bun, and how to fill each kind of gap. The task breakdown at the bottom is
what gets delegated.

## The four versions compared

| Name | What | Language | Size (code lines, no tests) |
|------|------|----------|-----------------------------|
| **zun today** | = cruller `f7002b1` (2026-10-05), Linux-only server runtime | Zig 0.16 | Zig 346k, C++ 208k, C 190k, TS 111k |
| **Bun 1.3.14** | last Zig Bun. The source we restore from | Zig (Oven fork, about 0.14/0.15) | Zig 570k, C++ 210k, C 190k, TS 119k |
| **Bun 1.4.5** | latest stable release | Rust | Rust 1.36M, C++ 172k, C 196k, TS 166k |
| **Bun canary** | `main` @ `e13b16b` (2026-11-25), version 1.4.6-dev | Rust | **Rust 1.95M**, C++ 193k, C 180k, TS 254k |

Canary added about **600k lines of Rust on top of 1.4.5**. It's moving fast, so pin a
commit for every parity check and re-baseline from time to time.

## Status legend

- ✅ **have**: in zun and known to work (per cruller's tests)
- 🟡 **in tree**: the code is in zun but isn't wired up or tested
- 🔧 **restore**: existed in Zig 1.3.14, removed by cruller. Port the 1.3.14 Zig to 0.17
- 🦀 **port**: exists only in Rust (1.4.x/canary). Reimplement in Zig, or in Go where that fits better
- ⚙️ **rewrite-C**: canary replaced a C library with its own Rust. Zun's matching end-state is Zig

## 1. Command line

| Command | zun | Source to use |
|---------|-----|---------------|
| `run <file>` (JS) | ✅ minimal launcher only | 🔧 `src/cli` 1.3.14 |
| `run <file.ts>` (transpile on load) | 🟡 parser is there; README says it's cut | verify in Phase 1 |
| `run <script>` (package.json scripts), `--watch`, `--hot`, `--filter`, `x`/`bunx`, `repl`, `init`, `create`, `upgrade`, `completions`, `exec` | ❌ | 🔧 `src/cli` |
| `install` / `add` / `remove` / `update` / `link` / `outdated` / `audit` / `why` / `info` / `publish` / `patch` / `pm` | ❌ | 🔧 `src/install`, `libarchive`, `patch` |
| `pm dedupe`, `pm prune`, `packageExtensions` | ❌ | 🦀 canary `src/install` |
| `test` (+ coverage, snapshots, mocks, reporters, DOM) | ❌ | 🔧 `src/test_runner` |
| `test --parallel` | ❌ | 🦀 canary `src/test_schedule` + runtime |
| `build` (bundler, CSS, HTML, plugins, macros, minifier, `--compile`, bytecode, standalone HTML) | 🟡 7k of 31k bundler lines remain | 🔧 `src/bundler`, `src/css`, `standalone_graph` |
| `compile` = `build --compile --aot` (**AoT to machine code**) | ❌ | 🦀 canary `src/aot` (291k), depends on `sema` |
| `check` (TypeScript type checker), `check --aot` | ❌ | 🦀 `src/sema` (400k in canary; a typescript-go port) |
| `lint` (+1,049 documented rules, plugins) | ❌ | 🦀 `src/lint` (328k) |
| `format` (Prettier-compatible) | ❌ | 🦀 `src/format` (132k) |
| `explain` (typed-percentage report for AoT) | ❌ | 🦀 `src/aot` |

## 2. Runtime APIs

| Area | zun | Notes / source |
|------|-----|----------------|
| `Bun.serve` (HTTP/1, HTTP/2, HTTP/3, TLS, WebSockets, routing, static, cookies, CSRF) | ✅ | cruller's whole focus |
| `fetch`, streams, `Blob`, `Request`/`Response`, Web APIs | ✅ | |
| `node:*` (61 of 62 modules) | 🟡 JS is there; native parts partly tested | `path.win32` removed with Windows |
| N-API / native addons | 🔧 C++ is there, Zig `src/napi` removed | |
| `bun:ffi`, `bun:sqlite`, `Bun.file`/`write`, `Glob`, `spawn`, `hash`, `CryptoHasher`, `password`, `semver`, `dns`, `udp`/`tcp`, `Worker`, `HTMLRewriter`, `Bun.redis`, `Bun.s3`, `cron`, `secrets`, `TOML`/`YAML`/`JSON5`/`JSONL`, `Terminal`, `WebView`, `color` | 🟡 mostly in `src/runtime` | test one by one; macOS/Windows-only parts are gone |
| `Bun.$` shell | 🔧 | `src/shell*` |
| `Bun.sql` (Postgres/MySQL) | 🔧 | `src/sql*` |
| `Bun.markdown` | 🔧 | `src/md` |
| `Bun.Transpiler` | 🔧 | `src/js_parser_jsc` |
| `Bun.Archive` | 🔧 | `src/libarchive*` |
| `Bun.Image` (jpeg/png/webp) | 🟡 needs libjpeg-turbo/libspng/libwebp, which are still listed as deps | |
| `Bun.diff`, `Bun.XML`, module graph API, code generation from strings | ❌ | 🦀 canary-only |
| Plugins, macros, auto-install, bunfig | 🔧 / 🟡 | bunfig loading lives in `src/cli` |

## 3. Platforms

**Decision (2026-11-26):** zun is Linux only until Linux parity is reached. macOS, Windows and FreeBSD are restored later (Roadmap Phase 7).

| Platform | zun | Bun canary |
|----------|-----|------------|
| Linux x64 / arm64 (glibc + musl) | ✅ x64 tested | ✅ |
| macOS | 🔧 removed (`errno/darwin`, `platform/darwin`, Secrets/C++ files) | ✅ |
| Windows | 🔧 removed (`libuv_sys`, `windows_sys`, `path.win32`) | ✅ |
| FreeBSD | 🔧 removed | ✅ (`linker-freebsd.lds`) |

## 4. Native dependencies

| Dependency | zun / 1.3.14 / 1.4.5 | canary | Zun end-state |
|------------|----------------------|--------|---------------|
| WebKit / JavaScriptCore | C++ | C++ | stays (Phase 6, maybe forever) |
| BoringSSL, lsquic, lsqpack, mimalloc, sqlite, tinycc, highway, libuv (Windows), lolhtml (Rust) | yes | still used | case by case |
| zlib, libdeflate, brotli, zstd | C | **removed** (`src/deflate`, …) | ⚙️ Zig; check `std.compress` first |
| libarchive | C | **removed** (`src/tar`, `src/archive`) | ⚙️ Zig; check `std.tar` |
| c-ares (DNS) | C | **removed** | ⚙️ Zig (`std.Io.net` resolver?) |
| picohttpparser, lshpack | C | **removed** (`src/http1`, `src/hpack`) | ⚙️ Zig |
| libjpeg-turbo, libspng, libwebp | C | **removed** (`src/jpeg`, `png`, `webp`) | ⚙️ Zig |
| ICU | inside WebKit | **own copy** (`src/icu`, 55k) | later |
| hdrhistogram | C | removed (`src/histogram`) | ⚙️ Zig (small) |
| rust-argon2 | none in 1.3.14 | Rust dep | ⚙️ Zig (`std.crypto.pwhash.argon2`?) |

Canary's rewrites show that each of these can be replaced and give a working reference
implementation to port from. Bun's own direction now matches zun's Phase 6.

## 5. AoT compilation (canary only, experimental)

`bun compile` type-checks the program with `sema` and compiles TS/JS to machine code at
build time. The result is one executable with no JIT, no bytecode and no source to parse.
Types drive the code generation: a typed property access becomes a fixed-offset load.
Related features: `--aot-harden`, `--aot-order` / `--aot-record-order` (startup layout from
recorded runs, like PGO), `--trim` (`src/trim`), `bun run --aot`, `bun test --aot` and `bun explain`.

- Code: `src/aot` (291k Rust). Inside it: `lower/` (AST → IR), `ir/`, `emit/`, `link/`,
  `engine/`, `standalone/`, and the `bun_aot_builtins` / `bun_aot_interface` crates.
- It depends on `bun_sema` (the type checker), so **AoT can't come before `check`**.
- How the IR becomes machine code isn't documented in the crate. It probably involves
  Bun's WebKit fork. Task T7 finds out.
- User docs: `docs/compiler/*.mdx` in canary (aot, types, compatibility, size, explain, troubleshooting).

## 6. Zig toolchain gap

Zun is on Zig 0.16 (cruller) and the target is 0.17.1. See `docs/zig/migration-to-0.17.md`.
Every 🔧 module also needs the 0.15 and 0.16 migrations, because upstream 1.3.14 predates them.

---

## How to implement each kind of gap

### 🔧 Restore from 1.3.14 Zig (the default path for Phases 3–4)
0. **Linux only:** skip macOS/Windows/FreeBSD branches (`Environment.isMac`/`isWindows`, `*_darwin`, `*_windows` files). Keep them compile-time-disabled or stubbed, and record what was skipped in the module's status doc for Phase 7.
1. Copy `bun-v1.3.14/src/<module>` into zun. Diff it against cruller's neighbouring modules to see how cruller ported similar code to 0.16 (cruller's `scripts/fix_zig016_*.py` automate part of this).
2. Apply the 0.15 → 0.16 → 0.17 migrations (`docs/zig/migration-to-0.17.md`). Fix **leaves first**, using `zig build check`-style semantic checks.
3. Wire it into the build (`build.zig`, codegen in `scripts/build/`) and into the CLI dispatch.
4. Gate: upstream's own tests for that module (`test/` from 1.3.14) pass on the zun binary. Record which tests pass in `docs/status/<module>.md`.
5. Rename user-visible identity to `zun` (binary, paths, env vars), but keep `Bun.*` JS APIs.

### 🦀 Port from Rust (Phase 5)
1. Find the matching module (mapping table in `docs/study/bun-1.4.md`). Read the Rust crate's docs and `CLAUDE.md`/`DESIGN.md` first.
2. When a Zig 1.3.14 version exists, **diff behaviour, not code**: list what Rust does that the Zig didn't, using tests and commit messages. Port only the delta.
3. For new crates, design the Zig version idiomatically (allocators, `std.Io`, comptime). Don't transliterate Rust ownership patterns.
4. Gate: canary's tests for the feature pass.
5. Go is allowed where it's the better tool, for example reusing **typescript-go** for `check` instead of porting 400k lines of `sema`.

### ⚙️ Rewrite C in Zig (Phase 6)
1. First check whether Zig's std already covers it (`std.compress.flate/zstd`, `std.tar`, `std.crypto`, `std.http`, `std.Io.net`).
2. Otherwise port from canary's Rust rewrite, which is already structured "without I/O", or from the original C.
3. Gate: byte-for-byte output equality against the C library on a test corpus, plus benchmarks within ±10%.

---

## Task breakdown (delegation plan)

Order of execution: **T1 → T2 → T3 → (T4 subtasks)**. T5–T9 are research and run in parallel with T1.

| ID | Task | Kind | Depends on | Output |
|----|------|------|------------|--------|
| **T1** | Phase 1: import cruller history into zun, park `src/rt` on `parked/rt-engines`, build the 0.16 baseline, answer "does `.ts` run?" | implementation | none | green 0.16 build, `docs/build.md`, `docs/status/baseline.md` |
| **T2** | Phase 2: port zun to Zig 0.17.1 | implementation | T1 | green 0.17 build, migration notes and probes added to `docs/zig/` |
| **T3** | Phase 3: zun identity (binary name, paths, env, config) | implementation | T2 | `docs/identity.md` |
| **T4.x** | Phase 4: restore 1.3.14 modules: CLI → test runner → install → shell → bundler+CSS → napi/sql/md/… | implementation | T3, one at a time | per-module status docs |
| **T5** | Restore plan: for each 🔧 module, its dependencies, port difficulty and test list | research | none | `docs/plan/restore-1.3.14.md` |
| **T6** | Runtime behaviour diff 1.3.14 → canary (per `Bun.*` / `node:*` API) | research | none | `docs/plan/runtime-diff.md` |
| **T7** | AoT deep-dive: how canary's `src/aot` works end to end, and a Zig plan | research | none | `docs/plan/aot.md` |
| **T8** | Tooling plan: `check` (typescript-go in Go?), `lint`, `format`, React Compiler | research | none | `docs/plan/tooling.md` |
| **T9** | Native deps: Zig std coverage vs canary's Rust rewrites, per library | research | none | `docs/plan/native-deps.md` |
| T10 | Platforms: restore macOS, then Windows (Roadmap Phase 7, **after Linux parity**) | implementation | Linux parity | later |
| T11 | Phase 5/6 implementation from the T6–T9 plans | implementation | T4, plans | later |
