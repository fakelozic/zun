# AGENTS.md: working on zun

Zun is a **Zig continuation of Bun**: a hard fork of cruller (Bun 1.3.14 ported to Zig 0.16)
that we're growing back into a full Bun. Parity is measured by **Bun's own test suite** against
locked stable Bun releases (1.3.14, then 1.4.5, …), never by chasing canary. The end-state
languages are Zig, Go and TypeScript. **Linux only** until Linux parity; macOS/Windows come later.
Start with `docs/ROADMAP.md` and `docs/GAP.md`.

## Ground rules

1. **Zig is 0.17.1.** Most of what you remember about Zig is from older versions and is
   probably wrong here. Before writing Zig, read `docs/zig/cheatsheet-0.17.md`. When unsure,
   check `docs/zig/upstream/` or the installed std source, or write a probe in `docs/zig/probes/`.
2. **Keep the knowledge bank growing.** When you learn or verify something about Zig, add it
   to `docs/zig/` (cheatsheet, migration notes or `lessons.md`) in the same change. Never add unverified claims.
3. **Small steps with checkpoints.** The owner is learning Zig through this project. Explain
   the Zig involved, and stop at the checkpoints in `ROADMAP.md` instead of racing ahead.
4. **Stay separate from Bun.** The binary, paths, env vars and caches are `zun`'s own. Never
   touch the owner's real `bun` install or its dirs. The JS-facing API stays `Bun.*` for compatibility.
5. **Keep attribution.** Code comes from Bun (MIT) and cruller (MIT). Keep `LICENSE.md` notices.
6. **Security first: zun is meant for production.** Read `docs/security/README.md`.
   - Never weaken security to make something pass: no disabling TLS verification, certificate checks, sandboxing,
     bounds/safety checks or sanitizers; no `catch unreachable` on input-driven errors; no `@setRuntimeSafety(false)` without a written reason.
   - Treat all network, file and env input as hostile. Prefer checked arithmetic and slices over raw pointers on input paths.
   - Every download in the build must be pinned (commit or version) **and** checksum-verified.
   - Nothing is sent to third-party services: no telemetry, and no crash upload by default. Crash upload happens only to a URL
     the operator sets explicitly (`ZUN_CRASH_REPORT_URL`); there is never a built-in default endpoint.
   - Note any security-relevant change in the commit message (`security:` prefix), and log known issues in `docs/security/`.

## Where things are

| Path | What |
|------|------|
| `docs/ROADMAP.md` | phases, decisions, open questions |
| `docs/GAP.md` | everything zun lacks vs Bun canary, how to fill each kind of gap, task breakdown |
| `docs/plan/` | research plans per area (restore, runtime diff, AoT, tooling, native deps) |
| `docs/status/` | what currently builds and passes |
| `docs/security/` | security policy, dependency/CVE audit, backports, production gates |
| `docs/study/` | how Bun 1.3.14, cruller, Bun 1.4 and Node fit together |
| `docs/zig/` | Zig 0.17 knowledge bank (cheatsheet, migration, probes, upstream docs, lessons) |
| `scripts/fetch-zig-docs.sh` | re-download the upstream Zig docs |

## Reference source trees (not in this repo)

When you need upstream code, shallow-clone it outside the repo:

```sh
git clone --depth 1 --branch bun-v1.3.14 --filter=blob:none https://github.com/oven-sh/bun.git   # Zig source we restore from
git clone --depth 1 --branch bun-v1.4.5  --filter=blob:none https://github.com/oven-sh/bun.git   # Rust parity target
git clone git@github.com:fakelozic/cruller.git                                                   # our base
```

## Toolchain on the dev machine

zig 0.17.1, bun 1.4.5 (used only as a build tool for codegen scripts), node 26, go 1.27, all via mise. Linux x86_64.
