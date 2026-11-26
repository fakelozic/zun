# Zun roadmap

**End goal:** a `zun` binary that behaves like Bun, implemented in **Zig, Go and TypeScript**.

**How we measure it:** the percentage of **Bun's own test suite** that passes on `zun`, against a
**locked stable Bun release**: first 1.3.14, then 1.4.5, then each later stable release in turn.
Canary moves too fast to chase (about 600k lines of Rust added since 1.4.5). We read it for reference but never target it.
Current numbers go in `docs/status/parity.md`.

**Starting point:** cruller (Bun 1.3.14 on Zig 0.16, stripped down to a Linux server runtime).

**Pace:** slow and deliberate. Zun is also how we learn Zig, so each phase ends at a
checkpoint where we stop, review, and update `docs/zig/`.

Background reading: `docs/study/` (Bun 1.3.14, cruller, Bun 1.4, Node).
Full gap list against Bun canary, plus the task breakdown: `docs/GAP.md`.

## Decisions so far (2026-11-26)

- Hard fork of cruller. No syncing with it afterwards.
- Cruller's multi-engine `src/rt/` work (QuickJS/V8) is parked on its own branch.
- Zig **0.17** (0.17.1 is the current stable).
- Binary `zun`, fully separate from the user's installed `bun` (no `bun` alias).
- Existing C, C++ and Rust (JSC, BoringSSL, lolhtml, …) stays for now. Replacing it is far-future (Phase 6).
- **Linux only** (x86_64 first, then arm64) until Linux parity is done. macOS and Windows come later, as their own phase (Phase 7).
- Parity is measured by Bun's test suite against locked stable releases, not by matching canary.
- Reuse first, cheapest first: TypeScript (`src/js`, codegen `.classes.ts`) copied from newer Bun (caveat from T6: canary's `src/js` calls native code
  through `$bindgen("x.bind.ts")`, 456 call sites over 153 `.bind.ts` files, so reusing it first needs a Zig output mode for bindgen) → Zig restored from 1.3.14 → Go (typescript-go) where it fits → port from Rust only for behaviour that failing tests show has changed.
- Zig migrations are **scripts** (`scripts/fix_zig017*`, alongside cruller's `fix_zig016_*.py`), so restored code and future Zig upgrades go through the same automation.
- One integration owner merges agent branches. Shared files (`build.zig`, codegen, CLI dispatch) change only through small, green merges.

## Security track (continuous, starts now)

The owner wants to run zun **in production**, so security runs alongside every phase, not after it.
Details: `docs/security/`.

1. **Dependency audit (now):** list every pinned native dependency and the vulnerabilities fixed upstream after
   zun's pinned version (WebKit/JSC, BoringSSL, uSockets/uWS, picohttpparser, lsquic, c-ares, zlib, zstd, brotli,
   libarchive, sqlite, lolhtml, mimalloc, tinycc). Also list Bun security fixes after 1.3.14 that touch code zun still has.
   Output: a prioritised backport list.
2. **Backports:** apply critical fixes to the code zun ships (HTTP/TLS/WebSocket/fetch first).
3. **Supply chain:** every build download pinned and checksum-verified; record an SBOM of what goes into the binary.
4. **Hardening:** sanitizer (ASAN/UBSan) test runs in CI, fuzzing of the HTTP/1, HTTP/2, WebSocket and URL parsers,
   safe release-build flags (PIE, RELRO, stack protector, `_FORTIFY_SOURCE` for C deps).
5. **Process:** `SECURITY.md` (how to report), a watch list of advisories (Bun, WebKit, BoringSSL, …) and a target
   time to patch critical issues.

**Production gates.** Before zun serves real traffic, all of these must hold:
- [ ] No known critical or high CVE unpatched in shipped code (from the audit, re-checked monthly).
- [ ] Release build passes the relevant Bun tests, plus sanitizer runs and fuzzing on network parsers with no open findings.
- [ ] Advisory watch and backport process in place, and has been exercised at least once.
- [ ] Deployed behind a reverse proxy, rolled out gradually, with a tested switch back to Bun.

## Phase 0: Study ✅ (Milestone 1)

- [x] Compare upstream 1.3.14, cruller and 1.4.5 (sizes, what was removed, module map): `docs/study/`
- [x] Zig 0.17 knowledge bank with verified probes and upstream docs: `docs/zig/`
- [x] Agent setup: `AGENTS.md`, `CLAUDE.md`
- [x] **Checkpoint:** study reviewed; strategy and Linux-only decided (2026-11-26). Remaining open questions below.

## Phase 1: Bring cruller in and get it building ✅ (2026-11-26, T1)

Done: cruller merged with history (`4625a1c`), `parked/rt-engines` created, Zig 0.16 debug build green in about 3 min,
5/5 cruller tests pass, `.ts` runs directly. Found a bug: static `import` crashes debug builds (`macro_context = undefined`).
Details: `docs/build.md`, `docs/status/baseline.md`.

1. Import cruller **with its history** into this repo. Keep `LICENSE.md` attribution (Bun and cruller).
2. Branch `parked/rt-engines` keeps `src/rt/`, `ssr-run/` and the QuickJS/V8 bits. Main drops only the QuickJS/V8 parts:
   the launcher itself depends on `src/rt` (`src/main.zig` uses `bun.rt.monolith.Runtime`), so the JSC path stays until the CLI restore replaces it.
3. Build it **as-is on Zig 0.16** on this machine. That gives a baseline that is known to work (debug build + `scripts/runner.node.mjs` smoke tests).
4. Write down the build steps that worked in `docs/build.md`.
- **Checkpoint:** a green 0.16 baseline, and we understand the build pipeline (codegen → zig obj → C++ → link).

## Phase 2: Zig 0.17 port ✅ (2026-11-26, T2; independently re-verified: clean rebuild from `4444d08` in 73 s, 6/6 tests, codemod 40/40 tests and idempotent on `src`, all probes pass)

Done: static-import crash fixed and QuickJS/V8 dropped on 0.16 first (Part A); then build files, codemod
(`scripts/fix_zig017.ts`, idempotent, tested), hand fixes and the `@hasDecl`/`@bitCast` audit (no silent changes found).
Zig 0.17.1 debug build green, 6/6 tests pass. Details: `docs/status/zig-017.md`. Open: `translate_c` package, 0.18 deprecations.

Follow `docs/zig/migration-to-0.17.md`: build files first, then compile errors from the
leaves upward, then deprecations, then a hand audit of `@bitCast` / `@hasDecl`.
Each step is accepted only when the Phase 1 smoke tests pass again.
**Deliverable besides the green build:** a reusable `scripts/fix_zig017` codemod, so code restored from 1.3.14 can be run through `fix_zig016` + `fix_zig017`.
- **Checkpoint:** a green baseline on 0.17. Fold everything we learned into `docs/zig/`.

## Phase 3: Become zun ✅ (2026-11-26, T3; re-verified at `712b8cf`: rebuild 89 s, 7/7 tests incl. `test-zun-identity`, no default outbound calls to Oven)

Done: `zun`/`zun-debug` binary, `zun --version` = `zun 0.1.0 (bun-compat 1.3.14)`, `process.versions.zun`, `ZUN_*`-first env,
`~/.zun` dirs, `zunfig.toml` lookup (parser still cut), no crash upload or feedback to Oven; 7/7 tests. Details and deferred items: `docs/identity.md`.

Rename the identity: binary `zun`, and its own install dir, cache dir, env-var prefix and config file,
so nothing collides with the real Bun. The global API stays `Bun.*`, so existing code still runs.
Decided 2026-11-26: config is `zunfig.toml` with `bunfig.toml` fallback; env vars `ZUN_*` first with `BUN_*` fallback (Bun's
tests set `BUN_*`); all default dirs under `~/.zun`, never `~/.bun`; no `Zun` JS alias; no crash reports or telemetry sent to Bun's servers.

## Phase 4: Restore Bun 1.3.14 features (port upstream Zig to 0.17)

The source for each feature is `bun-v1.3.14/src/<module>`. Every restored module is gated
by upstream's own tests for it. **Hard rule: the test runner comes right after the CLI skeleton**, because every later
restore is measured with it. Each step makes the next one testable.

Order (decided 2026-11-26, from `docs/plan/restore-1.3.14.md`):

1. **Prep:** stub inventory and CLI gates.
2. **`md`** (`Bun.markdown`), which removes one CLI gate.
3. **CLI core** (`src/cli`): real argument parsing, subcommand skeleton, compile-time gates for commands not yet restored.
4. **Test runner** (`src/test_runner`, `bun:test`, `internal-for-testing.ts`). 1,492 of 1,790 test files need it.
5. **`js_parser_jsc` / `Bun.Transpiler`**: parser conformance tests early.
6. **Shell** (`src/shell*`, `Bun.$`, `zun exec`). 70 test files use `Bun.$`.
7. **libarchive / `Bun.Archive`**, then **`patch`**.
8. **Package manager** (`src/install`): `zun install/add/remove`, lockfile.
9. **CSS** (`src/css`; watch the 983 `@hasDecl` uses).
10. **Full bundler**, then **standalone executables** (`standalone_graph`, macho/pe), then **bake DevServer**.
11. **In parallel any time after the test runner:** N-API (`src/napi`) and `sql`.
- **Checkpoint after each item.** Update `docs/status/parity.md` (test pass rates per area) after each one.

## Phase 5: Catch up to Bun 1.4.x

1. Behaviour diff: compare 1.3.14 and 1.4.x per module (most Rust crates keep the Zig directory names; see the mapping table in `docs/study/bun-1.4.md`) and from release notes. Track it as a checklist.
2. New tools that exist only in Rust (plan: `docs/plan/tooling.md`):
   - `zun check`: **embed typescript-go** as a Go c-archive linked into the Zig binary (T8 built a working probe: about 28 MB, output identical to `tsc`).
   - `zun lint` and `zun fmt`: in **Go**, on the same embedded typescript-go syntax tree (zun's own parser drops types and most comments, so it can't serve them). Start by grading rslint's ~900 rules against Bun's conformance bundle.
   - React Compiler: port to **Zig** on zun's `js_parser` tree (it waits for the bundler restore).
   - Conformance gates come with Bun: `test/cli/{check/typescript-go,lint/conformance,format/prettier}/bundle.zst`.

## Phase 6: Language end-state (far future)

Good **learn-Zig projects for the owner** (small, self-contained, with canary's Rust rewrite as a
reference and the C library as an oracle): `histogram`, `hpack`, WebSocket framing, `png`.

Replace non-Zig/Go/TS code where it's worth it: the lolhtml (Rust) binding, and C libraries with
Zig ports or `std` equivalents (compression, hashing). Decide case by case.
JavaScriptCore (C++, LGPL) is by far the largest item and may stay indefinitely.

**Recurring cost: the JSC/WebKit version.** Zun is locked to the WebKit build that 1.3.14 used. Upgrading means updating the
C++ bindings too. We need a policy for when to upgrade (open question).

## Phase 7: Other platforms (after Linux parity)

macOS first, then Windows, then FreeBSD. All three were removed by cruller, and the 1.3.14 code for them
(`errno/*`, `platform/darwin`, `libuv_sys`, `windows_sys`, `path.win32`, platform C++ files) is the restore source.

## Open questions (bring to the next checkpoint)

1. ~~Platform order~~ **Decided:** Linux only until Linux parity is done; macOS and Windows in Phase 7.
2. ~~Config file~~ **Decided:** `zunfig.toml`, falling back to `bunfig.toml` when absent.
3. ~~`globalThis.Zun` alias~~ **Decided:** no alias for now; the JS surface stays identical to Bun.
4. Node target version for `process.version` (Bun 1.3.14 reports 24.3.0).
5. N-API: restore early (many npm packages need it) or in item 6 as planned?
6. Go's role: only for tooling like typescript-go, or more?
7. JSC/WebKit upgrade policy: stay on the 1.3.14 WebKit (`5488984`) until when? Canary's WebKit (`32300d4`) is needed for
   Node 26 compatibility, `Temporal`, the C++ Web Streams and AoT (`docs/plan/runtime-diff.md`, `docs/plan/aot.md`), so the upgrade
   is probably a planned task between Phase 4 and Phase 5, not open-ended.
8. Go placement: link check/lint/fmt into the `zun` binary (+28 MB, about 0.6 ms startup cost on every run, one Go runtime per process, untested signal-handler interplay with JSC) or ship a companion executable?
9. AoT front end: choosing typescript-go for `check` does not give zun an AoT front end (canary's is built on sema's internals). Decide when AoT work starts (`docs/plan/aot.md` vs `docs/plan/tooling.md`).
10. ~~Phase 4 restore order~~ **Decided:** adopt T5's order (see Phase 4).
