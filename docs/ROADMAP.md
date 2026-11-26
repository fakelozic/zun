# Zun roadmap

**End goal:** a `zun` binary that matches current Bun 1:1 (Bun 1.4.x, which is written
in Rust), implemented in **Zig, Go and TypeScript**.

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

## Phase 0: Study ✅ (Milestone 1)

- [x] Compare upstream 1.3.14, cruller and 1.4.5 (sizes, what was removed, module map): `docs/study/`
- [x] Zig 0.17 knowledge bank with verified probes and upstream docs: `docs/zig/`
- [x] Agent setup: `AGENTS.md`, `CLAUDE.md`
- [ ] **Checkpoint:** review the study together and settle the open questions below

## Phase 1: Bring cruller in and get it building

1. Import cruller **with its history** into this repo. Keep `LICENSE.md` attribution (Bun and cruller).
2. Branch `parked/rt-engines` keeps `src/rt/`, `ssr-run/` and the QuickJS/V8 bits. Main drops them.
3. Build it **as-is on Zig 0.16** on this machine. That gives a baseline that is known to work (debug build + `scripts/runner.node.mjs` smoke tests).
4. Write down the build steps that worked in `docs/build.md`.
- **Checkpoint:** a green 0.16 baseline, and we understand the build pipeline (codegen → zig obj → C++ → link).

## Phase 2: Zig 0.17 port

Follow `docs/zig/migration-to-0.17.md`: build files first, then compile errors from the
leaves upward, then deprecations, then a hand audit of `@bitCast` / `@hasDecl`.
Each step is accepted only when the Phase 1 smoke tests pass again.
- **Checkpoint:** a green baseline on 0.17. Fold everything we learned into `docs/zig/`.

## Phase 3: Become zun

Rename the identity: binary `zun`, and its own install dir, cache dir, env-var prefix and config file,
so nothing collides with the real Bun. The global API stays `Bun.*`, so existing code still runs.
Decide whether to also expose a `Zun` alias (open question).

## Phase 4: Restore Bun 1.3.14 features (port upstream Zig to 0.17)

The source for each feature is `bun-v1.3.14/src/<module>`. Every restored module is gated
by upstream's own tests for it. Order, chosen so each step makes the next one testable:

1. **CLI** (`src/cli`): real argument parsing and the subcommand skeleton. `zun run file.ts` with on-the-fly TS (the parser is in the tree, but cruller's README says transpiling on load is cut: Phase 1 finds out).
2. **Test runner** (`src/test_runner`, `bun:test`). Restore it early so we can run Bun's own test suite as the spec.
3. **Package manager** (`src/install`, `libarchive`, `patch`): `zun install/add/remove`, lockfile.
4. **Shell** (`src/shell*`): `Bun.$`, `zun exec`.
5. **Bundler + CSS** (`src/bundler`, `src/css`, `standalone_graph`): `zun build`, `--compile`.
6. **The rest:** `napi` (native addons), `sql`, `md`, `Bun.Transpiler`, …
7. **Platforms:** macOS next, Windows last (both were removed by cruller).
- **Checkpoint after each item.**

## Phase 5: Catch up to Bun 1.4.x

1. Behaviour diff: compare 1.3.14 and 1.4.x per module (most Rust crates keep the Zig directory names; see the mapping table in `docs/study/bun-1.4.md`) and from release notes. Track it as a checklist.
2. New tools that exist only in Rust: `zun format` (Prettier-compatible), `zun lint`, `zun check`
   (type checker; consider using **typescript-go** directly, since Go is in our language set), React Compiler.

## Phase 6: Language end-state (far future)

Replace non-Zig/Go/TS code where it's worth it: the lolhtml (Rust) binding, and C libraries with
Zig ports or `std` equivalents (compression, hashing). Decide case by case.
JavaScriptCore (C++, LGPL) is by far the largest item and may stay indefinitely.

## Open questions (bring to the next checkpoint)

1. Platform order: Linux-only until Phase 4 is done, or restore macOS sooner?
2. Config file: read `bunfig.toml` for compatibility, use our own `zunfig.toml`, or both?
3. Expose `globalThis.Zun` as an alias of `Bun`?
4. Node target version for `process.version` (Bun 1.3.14 reports 24.3.0).
5. N-API: restore early (many npm packages need it) or in item 6 as planned?
6. Go's role: only for tooling like typescript-go, or more?
