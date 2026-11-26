# Bun 1.3.14: the last Zig Bun (the source we restore from)

Tag `bun-v1.3.14` in `oven-sh/bun`. Built with Oven's patched Zig (`ZIG_COMMIT =
04e7f6ac…` in `scripts/build/zig.ts`).

## Size by language (cloc, excluding `test/`)

| Language | Lines of code |
|----------|--------------:|
| Zig | 569,910 |
| C++ | 210,394 (mostly `src/jsc/bindings`: JSC glue, WebCore, node:crypto, …) |
| C | 189,805 (almost all is the vendored `sqlite3.c` amalgamation; plus llhttp and uSockets) |
| TypeScript | 119,017 (codegen, `src/js/` builtins, node:* modules) |
| JavaScript | 77,075 |
| C/C++ headers | 57,292 |
| Rust | 1,501 (side packages: `packages/bun-build-mdx-rs`, `bun-native-plugin-rs`, scripts, bench; lolhtml itself is a fetched dependency) |

## How it fits together

```
 zun/bun CLI (src/cli)  ──>  Transpiler (js_parser, js_printer, resolver, bundler)
        │                                │ TS/JSX → JS on load
        ▼                                ▼
 Runtime (src/runtime, src/jsc)  ──  JavaScriptCore (prebuilt WebKit, C++)
        │   Bun.* APIs, webcore (fetch, Blob, streams), node:* (TS in src/js/node + C++ bindings)
        ▼
 Event loop + I/O (src/event_loop, src/io, src/aio, uSockets/uWS) ── HTTP/1/2/3, TLS (BoringSSL)
```

- **The JS engine is JavaScriptCore.** It's a prebuilt, Oven-patched WebKit, statically
  linked (LGPL-2). Zig talks to it through C++ shims (`bindings/*.cpp`) and generated bindings.
- **Codegen is a big deal.** TypeScript scripts generate Zig and C++ glue for classes, builtins,
  and the JS modules embedded in the binary. Bun builds with Bun, so a working `bun` is a build dependency.
- **Native dependencies** (`scripts/build/deps/`): boringssl, brotli, c-ares, hdrhistogram, highway,
  libarchive, libdeflate, libjpeg-turbo, libspng, libuv (Windows), libwebp, lolhtml (Rust), lshpack,
  lsqpack, lsquic (HTTP/3), mimalloc, picohttpparser, sqlite, tinycc (`bun:ffi`), webkit, zlib, zstd,
  plus nodejs-headers.

## Biggest Zig subsystems (lines)

| Dir | Lines | What |
|-----|------:|------|
| `runtime` | 126k | Bun.* APIs, servers, webcore, node bindings |
| `css` | 72k | CSS parser/bundler (a lightningcss port) |
| `install` | 54k | package manager (`bun install`, lockfile) |
| `string` | 46k | string types and helpers |
| `js_parser` | 43k | TS/JSX/JS parser |
| `cli` | 37k | all subcommands |
| `jsc` | 35k | JSC bindings (Zig side) |
| `bundler` | 31k | `bun build` |
| `shell` | 21k | `Bun.$` / `bun exec` |
| `test_runner` | 18k | `bun test` |
| `sql` + `sql_jsc` | 15k | `Bun.sql` (Postgres/MySQL) |
| `boringssl_sys` | 19k | TLS bindings |
| `md` | 10.5k | Markdown (`Bun.markdown`) |
| `http` | 10k | HTTP client |

Platforms: Linux, macOS, Windows, FreeBSD (`src/errno/*_errno.zig`, `src/platform/`).
