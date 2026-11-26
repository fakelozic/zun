# Cruller: what zun starts from

- Repo: `fakelozic/cruller` is a GitHub fork of **`solenopsys/cruller`** (author: Alex Storm).
  Both point at the same HEAD `f7002b1` (2026-10-05). It's MIT-licensed like Bun. As a hard
  fork, zun must keep `LICENSE.md` and its attribution to Bun and cruller.
- History starts at one squash commit, "bzrt: strip Bun 1.3.14 to thin zig 0.16 runtime".
  Upstream Bun's git history is **not** included.
- Goal (theirs): a production server runtime only. Development is left to real Bun.

## What it changed

1. **Ported to vanilla Zig 0.16** from Oven's patched Zig. It has its own `build.zig`
   ("replaces the Oven-patched original"), plus `build016.zig` for semantic checks. The
   automation is in `scripts/fix_zig016_*.py`.
2. **Stripped to a runtime.** The binary is 73 MiB versus Bun's 88.5 MiB.
3. **Linux-only.** The macOS, Windows and FreeBSD errno/platform code and `libuv_sys` were removed.
4. **Started an engine-neutral "host/engine" split** in `src/rt/`: a command channel, with JSC,
   QuickJS and V8 adapters and an `ssr-run` benchmark harness. **Zun parks this on a separate branch.**

## What's removed (Zig lines in upstream → cruller)

| Removed entirely | Lines | Feature it powered |
|------------------|------:|--------------------|
| `css` + `css_jsc` | 72.7k | CSS bundling / `Bun.CSS` |
| `install` + `install_jsc` | 54.3k | `bun install` / `bun add` / lockfile |
| `cli` | 36.8k | every subcommand (cruller has a minimal launcher instead) |
| `shell` + `shell_parser` | 22.1k | `Bun.$`, `bun exec` |
| `test_runner` | 18.0k | `bun test`, `bun:test` |
| `sql` + `sql_jsc` | 14.6k | `Bun.sql` |
| `md` | 10.5k | Markdown |
| `libuv_sys`, `windows_sys` | 3.4k | Windows |
| `napi` | 2.6k | **N-API native addons** |
| `libarchive*` | 2.2k | tarballs (install, `Bun.Archive`) |
| `standalone_graph` | 1.5k | `bun build --compile` |
| `patch*` | 1.6k | `bun patch` |
| `js_parser_jsc` | 0.8k | `Bun.Transpiler` |

Shrunk: `bundler` 31k → 7.3k, `bake` 13.3k → 8.5k, `sys` 12.3k → 8.2k, `errno` 1.9k → 0.3k (Linux only).

Kept in the tree: `js_parser` (43k), `js_printer`, `resolver`, `http`, `http_jsc`, `string`, `jsc`, nearly all
of `runtime`, most C++ bindings, and 61 of 62 `src/js/node/*.ts` modules (`path.win32` is gone). The native
dependency list is unchanged.

C++ bindings: Windows/macOS-only files and `ShellBindings.cpp` were deleted, and about 14
were modified (`napi.cpp`, `BunObject.cpp`, `ZigGlobalObject.cpp`, …). The N-API C++ is still there; only the Zig `src/napi` is gone.

**Unresolved: does on-the-fly TS work?** The parser and printer are still in the source, and
`src/jsc/ModuleLoader.zig` still handles `.ts`/`.tsx`. But cruller's README says they were cut
and that there is "no on-the-fly transpilation". This needs settling by building cruller and running a `.ts` file (Phase 1).

## Build and status (from its `problem.md` / `README.md`)

- `zig build --build-file build016.zig check` passes on 0.16. `bun run build:debug` / `build:release`
  link a working binary. Release needs `RUSTUP_TOOLCHAIN=nightly` for lolhtml (`-Zbuild-std`).
- The build still uses **real Bun** to run the TypeScript build scripts and codegen.
- Working: CJS/ESM entrypoints, `Bun.serve`, `fetch`, and a few `node:path` tests through `scripts/runner.node.mjs`.
- About 5.9k JS/TS test files are still in `test/`. Many test deleted features, so filter before running.
- **Not yet checked on this machine.** Getting it to build here is the first hands-on step (see `ROADMAP.md`).
