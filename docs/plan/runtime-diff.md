# Runtime parity checklist: Bun 1.3.14 → canary

Written 2026-11-26 (task T6 in `docs/GAP.md`). Research only: nothing here is implemented yet.

This is the list of **user-visible runtime behaviour** that changed between Bun 1.3.14
(the last Zig Bun, what zun restores from) and Bun canary `main` @ `e13b16b` (1.4.6-dev,
Rust). It covers `Bun.*`, `node:*`, Web APIs, `bun:test`, `bun:sqlite`, `bun:ffi`,
`Bun.sql`/`redis`/`s3`, the package manager and the bundler. The new tools
(`check`, `lint`, `format`, AoT `compile`, `explain`, React Compiler) are covered by T7/T8
and only get one-line mentions here.

## How to read this

Every item has three parts: **what** changed, **evidence**, and **how** zun gets it.

The "how" column uses four codes:

| Code | Meaning | Typical cost |
|------|---------|--------------|
| **TS** | Reuse TypeScript from canary `src/js/**` (or `packages/bun-types`) as-is or nearly so | low, but see "The `$bindgen` catch" below |
| **RS→ZIG** | Port Rust logic to Zig. Usually there's a 1.3.14 Zig version to diff against | medium |
| **NEW** | New native work with no Zig ancestor (new subsystem, new protocol, new C++ glue) | high |
| **C++** | The change lives in C++ bindings (`src/jsc/bindings/**`). zun shares the C++ layer, so it can copy the file, but the Zig↔C++ extern glue must match | low–medium |

**UNVERIFIED** marks items taken from release notes or type declarations without
checking the implementation or a test.

Evidence paths are relative to the three reference trees:
`1.3.14/` = `bun-v1.3.14`, `1.4.5/` = `bun-v1.4.5`, `canary/` = `main@e13b16b`.
Release-note links are `https://bun.com/blog/bun-v1.4.N`.

The method: (1) a symbol-level diff of `packages/bun-types/*.d.ts` with comments
stripped, (2) a file and line diff of `src/js/**`, (3) a diff of `docs/**/*.mdx`
(especially `docs/runtime/nodejs-compat.mdx`, which lists per-module status), and
(4) the v1.4.0–v1.4.5 release notes. Pin `e13b16b` when re-checking; canary moves daily.

---

## 0. Cross-cutting facts that decide the strategy

### 0.1 Engine and Node baselines moved

| | 1.3.14 | canary | Evidence |
|---|---|---|---|
| WebKit (JSC) commit | `5488984d…` | `32300d4d…` | `scripts/build/deps/webkit.ts` in each tree |
| Reported Node.js version | 24.3.0 (ABI 137) | Node 26 line (ABI 147, V8 headers 14.6) | `scripts/build/deps/nodejs-headers.ts` |
| `nodejs-compat.mdx` baseline | "compatibility with Node.js v23" | "compatibility with Node.js v26" | `docs/runtime/nodejs-compat.mdx` |

A big share of the behaviour changes (new JS syntax, `Error.isError`, `Temporal` hooks,
`using`, RegExp features, Wasm) come free with the WebKit bump. **The WebKit upgrade is a
prerequisite for most of this list** and is its own task: zun must move its C++ bindings
to canary's WebKit commit. `process.versions.node` and the N-API ABI number (`147`) change
with it, which affects which prebuilt `.node` addons load.

### 0.2 The `$bindgen` catch: canary's TS is not drop-in

In 1.3.14 the JS layer calls native code through `$zig("file.zig", "fn")` /
`$newZigFunction(...)` (112 call sites) and `$cpp`/`$newCppFunction`.
In canary every `$zig`/`$newZigFunction` is gone. They were replaced by
**`$bindgen("x.bind.ts", "fn")`** (456 call sites) backed by **153 `*.bind.ts` files**
(1.3.14 had 7). A `.bind.ts` file declares a typed native function, for example
`canary/src/runtime/node/node_os.bind.ts`:

```ts
export default b.module({ rustPath: "crate::node::os" });
export const getPriority = b.fn({ args: { pid: b.i32.validateInteger().default(0) },
                                  returns: b.i32, capability: "js", throws: true });
```

and `canary/src/codegen/bindgen*.ts` emits Rust glue from it.

**Consequence for zun.** Canary's `src/js/**` can be reused, but only once zun has a
**Zig backend for canary's bindgen** (`b.module({ zigPath })`, same `b.fn` schema, which
emits Zig + C++ glue instead of Rust). 1.3.14 already had a Zig-emitting bindgen
(`1.3.14/src/codegen/bindgen.ts`, 7 `.bind.ts` files), so this is an extension and not
new invention. **Recommendation: do this once, early (call it T6a), before adopting any
canary `src/js` file.** Without it every adopted file needs hand-edits back to `$zig`.
The 153 `.bind.ts` files are themselves a precise, typed inventory of the native surface
each JS module expects. Use them as the porting checklist for the Zig side.

Top `$bindgen` targets by call count: `node_path` 48, `socket_body` 18, `udp_socket` 15,
`node_fs_binding` 15, `node_os` 14, `node_validators` 13, `ffi` 12, `node_http_binding` 11,
`node_util_binding` 10, `node_cluster_binding` 10.

### 0.3 Web Streams moved out of JS

1.3.14 implemented WHATWG streams as JS builtins: `src/js/builtins/ReadableStream*.ts`,
`WritableStream*.ts`, `TransformStream*.ts`, `StreamInternals.ts`,
`CompressionStream.ts`, `TextEncoderStream.ts`, the queuing strategies and so on (22 files).
Canary **deleted all of them**. Streams are now C++ in
`canary/src/jsc/bindings/webcore/streams/` (80 files, about 23k lines) with Rust parts in
`canary/src/runtime/webcore/{ReadableStream,ByteStream,CompressionStreamCoder,streams}.rs`.
`ImportMetaObject.ts` and `BakeSSRResponse.ts` went the same way.

For zun this is a **C++** item (copy the C++ streams; port the small Rust coder pieces to
Zig). It's also a **dependency**: much of canary's `src/js/node/*` assumes the new
streams. Keep the 1.3.14 JS streams until the C++ streams land, and don't mix the two.

### 0.4 What can be adopted cheaply (TS-layer summary)

| Change | Files | Blocked on |
|--------|-------|------------|
| `node:*` modules grown/rewritten (see §2) | `canary/src/js/node/*.ts`, `src/js/internal/**` | bindgen Zig backend (0.2); per-module native bindings |
| New `node:quic`, `node:stream/iter`, `node:zlib/iter`, `_tls_wrap` | `src/js/node/{quic,stream.iter,zlib.iter,_tls_wrap}.ts`, `src/js/internal/{quic,streams/iter}/` | QUIC native (lsquic is already a dep); the iter modules are mostly pure TS |
| `node:repl` (real REPL) | `src/js/node/repl.ts` (124 → 1,698 lines), `src/js/internal/repl/`, `src/js/eval/node-repl.ts` | CLI `--interactive` |
| `node:test` (real runner) | `src/js/node/test.ts` (449 → 3,058), `src/js/internal/test_runner/` | `bun test` restored |
| `node:trace_events`, `node:inspector` Session | `src/js/internal/trace_event*.ts`, `src/js/internal/inspector/cdp.ts` | native recorder; inspector agents (C++) |
| `node:util` `inspect` rewritten in TS | `src/js/internal/util/inspect.ts` (was `inspect.js`), `util/{diff,comparisons,debuglog}.ts` | none known |
| `Bun.sql` additions | `src/js/bun/sql.ts`, `src/js/internal/sql/{options,pool}.ts` | native protocol changes (§6) |
| `bun:sqlite` additions | `src/js/bun/sqlite.ts` | native `function`/`aggregate`/hooks (§7) |
| `bun:ffi` `CString` change | `src/js/bun/ffi.ts` | `ffi.bind.ts` natives |
| `undici`, `ws` shims converted to TS | `src/js/thirdparty/{undici,ws}.ts` (were `.js`) | none known |
| Fake timers, histograms, Fifo builtins | `src/js/builtins/{useFakeTimers,Histogram,ELDHistogram,Fifo}.ts` | test runner; `histogram.bind.ts` |
| `bun-types` | whole `packages/bun-types/` (+ `vitest.d.ts`, `vitest-globals.d.ts`, `ts7.1/`) | none: zun ships types for the APIs it implements |

`bun-types` is pure declaration and can be copied wholesale. However, it will then promise
APIs zun lacks. **Recommendation:** ship canary `bun-types` but keep a
`docs/status/api-coverage.md` listing which declared APIs work in zun.

---

## 1. `Bun.*` APIs

### 1.1 New top-level APIs

| API | What | Evidence | How |
|-----|------|----------|-----|
| `Bun.diff` (`lines`, `words`, `chars`, `arrays`, `hunks`, `createPatch`, `parsePatch`, `applyPatch`) | jsdiff-compatible text diff and unified-patch tools | `canary/packages/bun-types/bun.d.ts` `namespace diff`; `canary/docs/runtime/diff.mdx`; canary HEAD commit `e13b16b` "Bun.diff: compare a Latin-1 text with a UTF-16 text without a copy" | RS→ZIG (Myers diff; no Zig ancestor, so effectively NEW but self-contained). `internal/util/diff.ts` and `internal/assert/myers_diff.ts` show the TS side |
| `Bun.XML.parse` / `Bun.XML.stringify` | XML ↔ JS (compact `{"@attr","#text"}` form or full `Node` tree). Also a `.xml` loader/import (`import x from "./a.xml"`) | `bun.d.ts` `namespace XML`; `extensions.d.ts` `declare module "*.xml"`; `canary/docs/runtime/xml.mdx`, `docs/guides/runtime/import-xml.mdx`, `docs/runtime/file-types.mdx` `### xml`; `highway_xml.cpp` | NEW (parser in Rust `src/parsers`, SIMD in C++ `highway_xml.cpp`) |
| `Bun.ModuleGraph` (experimental) | Load a second, isolated module graph into the current global: own module instances, `require.cache`, timers and I/O; compiled code shared. `import()`, `run()`, `dispose()`, `ModuleGraph.current` | `bun.d.ts` `class ModuleGraph`; `canary/docs/runtime/module-graph.mdx` | NEW (deep module-loader change; touches `ModuleLoader.zig` equivalents and the event loop) |
| `Bun.FetchSession` | A `fetch` with its own connection pool, TLS, proxy, keep-alive and unix-socket settings; `fetch(url, { session })` | `bun.d.ts` `class FetchSession`, `FetchSessionInit`; `globals.d.ts` `session?:`; `docs/runtime/networking/fetch.mdx` "Fetch sessions" | RS→ZIG (`src/http` grew 10k → 19k lines; diff behaviour) |
| `Bun.isStandaloneExecutable` | `true` in a `--compile`d binary | `bun.d.ts` | RS→ZIG (trivial once `standalone_graph` is restored) |
| `Bun.memoryFootprint()` | process memory footprint, `undefined` where unsupported | `bun.d.ts` | RS→ZIG (small; Linux: `/proc/self/statm` or similar, UNVERIFIED) |
| `Bun.setJITPolicy(scale)` | scale JIT tier-up thresholds at runtime (related to `--compile-jit-policy`) | `bun.d.ts`; `build --compile-jit-policy` | C++ (JSC options) |
| `Bun.TOML.stringify(value, replacer, space)` (new); `TOML`/`JSONC`/`JSON5`/`JSONL`/`YAML` `.parse` accept `TypedArray`/`DataView`/`ArrayBuffer` (and `Blob` for TOML/JSON5) as input | serializer + byte input | `bun.d.ts` `namespace TOML` `stringify<T>` (absent in 1.3.14); `parse(input: string \| NodeJS.TypedArray \| … \| Blob)`; `docs/runtime/toml.mdx` | RS→ZIG (TOML writer is small; byte input = decode then parse) |
| `Bun.stringWidth` | new `perCodePoint` option | `bun.d.ts` (`StringWidthOptions`) | RS→ZIG (small) |
| `Bun.Encoding` type | now the full WHATWG label list instead of `utf-8 \| windows-1252 \| utf-16` (typing; whether runtime gained encodings is UNVERIFIED, probably comes with ICU/WebKit) | `bun.d.ts` `type Encoding` | C++ |
| `Bun.Archive` | input accepts `ReadableStream`; `Bun.write` data accepts `ReadableStream` | `bun.d.ts` | RS→ZIG (restore `Bun.Archive` first; canary dropped libarchive for Rust `src/tar`, see T9) |
| `Bun.hash` | the base callable now returns `bigint` only (was `number \| bigint`) | `bun.d.ts` `const hash` | RS→ZIG (return-type change; check every hasher) |
| `Bun.CSRF.generate/verify` | `sessionId` option binds tokens to a principal; `maxAge`; `blake2b256` etc. algorithms | `bun.d.ts` `sessionId?: string`; `docs/runtime/csrf.mdx` | RS→ZIG (small) |
| `Bun.cron` | `options.tz` (IANA zone) for `Bun.cron(...)` and `Bun.cron.parse(...)`; path may be a `URL`; handler may return a Promise and the next fire waits for it | `bun.d.ts` `CronOptions`; `docs/runtime/cron.mdx` | RS→ZIG (time-zone math needs a tz database: ICU is in WebKit) |
| `Bun.mmap` | `offset`/`size` options (number or bigint); path is `string` only | `bun.d.ts` `MMapOptions` | RS→ZIG (small) |
| `Bun.indexOfLine` | `offset` may be a `bigint` | `bun.d.ts` | RS→ZIG (trivial) |
| `Bun.FileSystemRouter` | options type exported; `assetPrefix`/`origin` may be `null`; `style` narrowed to `"nextjs"`; `reload()` returns `this`; new `scriptSrc` | `bun.d.ts` | RS→ZIG (small) |
| `Bun.WebView` | `back()`/`forward()` renamed `goBack()`/`goForward()` | `bun.d.ts` | macOS-only in practice; skip on Linux |
| `Bun.spawn` | new options `uid`, `gid`, `cgroup` (Linux cgroup v2 resource limits); extra `stdio` slots may be `"socket-fd"`; `signalCode` may be a number; `resourceUsage().cpuTime.{user,system,total}` are now `bigint` | `bun.d.ts` `uid?`/`gid?`/`cgroup?`; `docs/runtime/child-process.mdx` "Resource limits with cgroups (Linux)" | RS→ZIG (`spawn` is its own crate in canary, `src/spawn`) |
| `Bun.connect`/`listen` (TCP) | TLS `servername`, `checkServerIdentity`, `crl` option; `ipv6` field | `bun.d.ts` | RS→ZIG |
| `Bun.build` | many new options; see §10 | | |
| `Bun.Transpiler`/plugins | `OnLoadResult` may be `null` | `bun.d.ts` | RS→ZIG (trivial) |
| `Bun.secrets` | `persist?: "local" \| "enterprise"` option (UNVERIFIED Linux meaning) | `bun.d.ts` | RS→ZIG |
| `bun:jsc` | `bytecodeOrderStats()`, `startSamplingProfiler(dir, interval)`, `samplingProfilerStackTraces()` now returns structured frames; `noFTL`/`noOSRExitFuzzing` return `void`; `totalCompileTime()` takes no argument; `callerSourceOrigin()` may return `null` | `canary/packages/bun-types/jsc.d.ts` | C++ |

### 1.2 `Bun.serve` and server WebSockets

| Change | Evidence | How |
|--------|----------|-----|
| Static **directory routes**: `routes: { "/static/*": { dir: "./public", statCache?: true } }` | `serve.d.ts` `DirectoryRouteOptions` | RS→ZIG (sendfile, ranges, etags: check canary tests) |
| `http2?: boolean` option on the server (HTTP/2 for `Bun.serve`) and `docs/runtime/http/server.mdx` `## HTTP/2` | `serve.d.ts`; docs | RS→ZIG (cruller already has HTTP/2 for `Bun.serve` per GAP.md; diff behaviour) |
| `server.closeIdleConnections(): number` | `serve.d.ts`; docs | RS→ZIG (small) |
| `ServerWebSocket.send/sendBinary/ping/pong/publish` accept `Blob` | `serve.d.ts` | RS→ZIG |
| `ws.subscribe()`/`unsubscribe()` return `boolean` | `serve.d.ts` | RS→ZIG (trivial) |
| `ws.pause()`, `ws.resume()`, `ws.isPaused` (read-side backpressure) | `serve.d.ts` | RS→ZIG (uWS/usockets pause) |
| `binaryType: "blob"` | `serve.d.ts` | RS→ZIG |
| `websocket.message` is optional; new `websocket.error(error, ws)` handler | `serve.d.ts` | RS→ZIG |
| Documented semantics: close codes 0/1005/1006 send an empty Close; `idleTimeout` range 0–960; `perMessageDeflate` modes table | `docs/runtime/http/websockets.mdx` | verify against tests |
| `server.publish` accepts `Blob` | `serve.d.ts` | RS→ZIG |

### 1.3 Client `WebSocket`

| Change | Evidence | How |
|--------|----------|-----|
| `binaryType: "blob"` added (default stays `"nodebuffer"`, unlike Node's `"blob"`) | `bun.d.ts`, `nodejs-compat.mdx` | C++/RS→ZIG |
| `send/ping/pong` accept `Blob`; client `pause()`/`resume()`/`isPaused` | `bun.d.ts` | RS→ZIG |
| constructor `url` may be a `URL`; `headers` may be `Headers` or tuple array; `tls` may be `boolean`; TLS `servername`, `checkServerIdentity` | `bun.d.ts` | RS→ZIG |
| `onerror` gets `ErrorEvent`; new `ping`/`pong` events; `CloseEvent` and `ErrorEvent` are now listed globals | `bun.d.ts`, `nodejs-compat.mdx` | C++ |
| `BUN_CONFIG_WS_CLOSE_TIMEOUT` env var | `docs/runtime/environment-variables.mdx` | RS→ZIG (rename to `ZUN_…`? see identity rules) |
| `undici:websocket:*` diagnostics channels published | `nodejs-compat.mdx` | TS + RS→ZIG |

### 1.4 `fetch`

| Change | Evidence | How |
|--------|----------|-----|
| `proxy` may be `false` or `{ url, headers, respectNoProxy }`; `NO_PROXY` matching table (`*`, suffix, CIDR, `host:port`) | `globals.d.ts`; `bun.d.ts` `FetchProxyOption`; `fetch.mdx` | RS→ZIG |
| `protocol: "http3" \| "h3"`: **HTTP/3 client** | `globals.d.ts` | NEW-ish (lsquic is already in the tree for the server side; client path is new) |
| `compress` request option (`gzip`/`deflate`/`br`/`zstd`, with `level`) | `globals.d.ts` | RS→ZIG |
| `maxRedirects`, `timeout` options | `globals.d.ts` | RS→ZIG |
| `session` option (see `Bun.FetchSession`) | | RS→ZIG |
| `tls.serverName`; "connecting to a specific address" | `fetch.mdx` | RS→ZIG |
| "Incomplete compressed responses" behaviour documented | `fetch.mdx` | verify against tests |
| `undici:*` diagnostics channels published by `fetch` (with listed differences) | `nodejs-compat.mdx`; `src/js/internal/undici_channels.ts` | TS + RS→ZIG hooks |
| `Request`: `keepalive` and `duplex` documented as **missing**; `integrity`, `referrer…` ignored | `nodejs-compat.mdx` | none (document) |
| `Response`/`Request`/`Blob` gain `textStream(): ReadableStream<string>` | `fetch.d.ts` | C++ |
| `BUN_CONFIG_MAX_HTTP_REQUESTS` now also caps `bun install` | env-var docs | RS→ZIG |
| `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_USE_SYSTEM_CA` honoured | env-var docs | RS→ZIG (check what 1.3.14 already did, UNVERIFIED) |

### 1.5 Other Web APIs / globals

| Change | Evidence | How |
|--------|----------|-----|
| `ReadableStream` with `type: "bytes"` typed constructor; `CompressionStream(format, { level })`, `DecompressionStream(format, { highWaterMark })` | `globals.d.ts` | C++ (new streams, §0.3) |
| `TextDecoderStream(encoding, { fatal, ignoreBOM })` | `globals.d.ts` | C++ |
| `PerformanceObserver(callback)` + `supportedEntryTypes` | `globals.d.ts` | C++ |
| New globals listed: `URLPattern`, `CloseEvent`, `ErrorEvent`, `File`, `navigator` (partial) | `nodejs-compat.mdx` | C++ (check which exist in 1.3.14 already; `URLPattern` likely from WebKit, UNVERIFIED) |
| Still not implemented: `Storage`/`localStorage`, `QuotaExceededError` | `nodejs-compat.mdx` | none |
| `structuredClone`/`postMessage`: only `ArrayBuffer` and `MessagePort` transferable; streams not transferable | `nodejs-compat.mdx` | document |
| `SubtleCrypto`: ML-DSA, ML-KEM-768/1024, SHA3-*, ChaCha20-Poly1305, `encapsulate*/decapsulate*`, `supports()`, `getPublicKey()` | `nodejs-compat.mdx` | C++ (+ BoringSSL version bump, UNVERIFIED) |
| `import.meta.glob(pattern, { eager, import, query, base, exhaustive })` (Vite-compatible) | `globals.d.ts` `ImportMetaGlob`; `module-resolution.mdx` | RS→ZIG in the transpiler + loader |
| Import suffixes `?raw`, `?url`, `?worker`, `?worker&url`, `?inline`, `?init` (wasm) | `module-resolution.mdx` "Import suffixes" | RS→ZIG (resolver/loader) |
| `import.meta.env` = `process.env` (Vite vars under `bun test`) | `module-resolution.mdx` | RS→ZIG |
| `NODE_PATH` honoured | `module-resolution.mdx` `### NODE_PATH` | RS→ZIG (resolver) |
| `.mts`/`.cts` resolution for extensionless imports and `index.mts/.cts` | `module-resolution.mdx` | RS→ZIG (resolver, trivial) |
| Built-in replacements for npm packages (`undici`, `node-fetch`, `isomorphic-fetch`, `@vercel/fetch`, `ws`, `utf-8-validate`, `abort-controller`) | `module-resolution.mdx` table | TS (`src/js/thirdparty/*`) + resolver table |
| `--disallow-code-generation-from-strings[=strict]` | `canary/docs/runtime/code-generation-from-strings.mdx` | C++ (JSC option) + loader checks for `=strict` |
| `process.on("memoryPressure", level)` event | `overrides.d.ts`; `memory_pressure.bind.ts` | RS→ZIG (Linux: PSI / cgroup `memory.events`, UNVERIFIED) |
| `process.binding()` covers `buffer`, `config`, `constants`, `crypto/x509`, `fs`, `http_parser`, `natives`, `tty_wrap`, `util`, `uv` | `nodejs-compat.mdx` | TS + C++ |
| `Bun.stdout`-style `FileSink.flush(wait?)`; `write()` may return a Promise | `globals.d.ts` | RS→ZIG |
| `EventTarget`/`Event` types now defer to lib.dom when loaded | `globals.d.ts` | types only |
| Wasm: Memory64 behind `BUN_JSC_useWasmMemory64=1`; `bun ./program.wasm` runs a WASI command | `nodejs-compat.mdx` | C++/WebKit; CLI |

---

## 2. `node:*` modules

Source of truth: `canary/docs/runtime/nodejs-compat.mdx` (diffed against 1.3.14's). Line
counts are `src/js/node/<m>.ts` 1.3.14 → canary. **TS** = the module is mostly JS;
reuse it once its `.bind.ts` natives exist in Zig.

| Module | What changed (status 1.3.14 → canary) | Lines | How |
|--------|---------------------------------------|-------|-----|
| `node:assert` | legacy `deepEqual` documented as `Bun.deepEquals` semantics | 490-line diff | TS |
| `node:async_hooks` | `AsyncLocalStorage` reworked (`internal/async_context_frame.ts`, `internal/async_hooks*.ts`); `createHook` hooks still stubs, but `init` fires for `nextTick` | 480 → 680 | TS + C++ (`AsyncContextFrame.cpp`) |
| `node:buffer` | `MAX_LENGTH` documented 2^32; `internal/buffer.ts` removed (moved native) | | C++ |
| `node:child_process` | **IPC can send `net.Socket`, `net.Server`, `dgram.Socket` handles** (also to/from Node); `serialization: "advanced"` between Bun processes; `proc.uid/gid` | 797-line diff | TS + RS→ZIG (SCM_RIGHTS fd passing) |
| `node:cluster` | `net`/`dgram` servers shared through primary (`SCHED_RR`/`SCHED_NONE`), handle passing via `worker.send()`; new `internal/cluster/SharedHandle.ts` | | TS + RS→ZIG (`node_cluster_binding.bind.ts`) |
| `node:console` | documented: writes straight to fds, replacing `process.stdout.write` doesn't capture | | document |
| `node:crypto` | `argon2()`/`argon2Sync()` added; ML-KEM via subtle; `setEngine` throws; `internal/crypto/` dir removed (moved native) | 490 → 790 | TS + C++ (argon2: canary uses rust-argon2, zun → `std.crypto.pwhash.argon2`, see T9) |
| `node:dgram` | 99% of Node tests; multicast fixes; `internal/dgram.ts` | 1,089 → 1,722 | TS + RS→ZIG (`udp_socket.bind.ts`) |
| `node:diagnostics_channel` | built-in channels published (except `locks.*`, permission model, fips, quic.session.application); `undici:*` from fetch/WebSocket | 414 → 887 | TS + native publish points |
| `node:dns` | 90% → "missing only `resolveTlsa`" | 731-line diff | TS + RS→ZIG (canary dropped c-ares for Rust, see T9) |
| `node:domain` | `active` implemented; only sync errors routed | | TS |
| `node:events` | 100% → 95% of Node tests (status worded more strictly); `asyncId` 0 | 865 → 1,057 | TS |
| `node:fs` | 92% → 98% of Node tests; new `internal/fs/{binding,file_handles,watch,watchfile}.ts`; `Stats` lacks Temporal getters | fs.promises 717 → 1,752 | TS + RS→ZIG (`node_fs_binding.bind.ts`) |
| `node:http` | "client body buffered" fixed (streamed); `http.Server` not a `net.Server`; `internal/http1_server_fallback.ts` | `_http_server` 1,925 → 4,401; `_http_outgoing` 588 → 1,336 | TS + RS→ZIG (`node_http_binding.bind.ts`) |
| `node:http2` | 🟡 → 🟢: `allowHTTP1`, `enableConnectProtocol`, ALTSVC, `pushStream` were missing; now "94% of Node tests" | 4,326 → 6,933 | TS + RS→ZIG (`h2_frame_parser.bind.ts`; canary has own HPACK in `src/hpack`, T9) |
| `node:https` | 🟢 → 🟡 (stricter wording) but real `Agent` with pooling; client sockets are `tls.TLSSocket` | 55 → 636 | TS |
| `node:inspector` | `Session` with Profiler (precise coverage), `Runtime.enable`, `NodeTracing`; `inspector/promises` | 154 → 771 + `internal/inspector/cdp.ts` | TS + C++ inspector agents |
| `node:module` | `require.extensions`, `module._resolveFilename` overriding supported; `syncBuiltinESMExports`, `module._load`, `module.register` are no-ops; still missing `registerHooks`, `findPackageJSON`, `stripTypeScriptTypes` | `CommonJS.ts` 407-line diff | TS + C++ (`JSCommonJSExtensions.cpp`) |
| `node:net` | `BlockList`, `SocketAddress`, `autoSelectFamily`, `listen({ fd })`; `internal/net/{symbols,server_abort_signal}.ts` | 2,667 → 4,663 | TS + RS→ZIG (`socket_body.bind.ts`, `BlockList.bind.ts`, `Listener.bind.ts`) |
| `node:os` | documented `userInfo()` from env; `machine()` = `arm64` | | TS + RS→ZIG (`node_os.bind.ts`) |
| `node:path` | `matchesGlob()` (Bun.Glob semantics); `path.win32` (zun dropped it, restore for parity) | 48 `$bindgen` calls | TS + RS→ZIG (`node_path.bind.ts`) |
| `node:perf_hooks` | `monitorEventLoopDelay()`, `createHistogram()`, `timerify()`, `PerformanceObserver` with `function/net/http/http2` entries; `internal/perf_hooks/` dir replaced by builtins `Histogram.ts`, `ELDHistogram.ts` | | TS + RS→ZIG (`histogram.bind.ts`; canary replaced hdrhistogram C with Rust, T9) |
| `node:process` | `internal/process/` dir new; `process.binding` widened; `getActiveResourcesInfo` etc. (UNVERIFIED which landed) | `ProcessObjectInternals.ts` 756-line diff | TS + C++ (`BunProcess.cpp`) |
| `node:querystring`, `node:url` | changes (url 936 → 1,388) | | TS |
| `node:quic` **(new)** | `listen()`, `connect()`, `QuicEndpoint`, `QuicSession`, `QuicStream`; 99% of Node tests; emits `ExperimentalWarning` | `node/quic.ts` + `internal/quic/*` (7 files) | TS + NEW native (lsquic binding) |
| `node:readline` | big shrink 2,732 → 631; logic moved to `internal/readline/` | | TS |
| `node:repl` | 🔴 → 🟡 "mostly implemented"; `bun --interactive` starts a Node-compatible REPL | 124 → 1,698 + `internal/repl/`, `eval/node-repl.ts` | TS + CLI flag |
| `node:sqlite` | 🔴 → 🟢 **fully implemented** (`backup()` synchronous) | `internal/sql/sqlite.ts` diff | TS + RS→ZIG (shares SQLite with `bun:sqlite`) |
| `node:stream` | `isReadable`/`isWritable`/`isErrored` only for Node streams; **new `node:stream/iter`** (`internal/streams/iter/*`, 12 files) | | TS (iter is pure TS, UNVERIFIED) |
| `node:test` | "missing mocks, snapshots, timers" → in-process API under `bun test`: suites, subtests, hooks, `t.plan()`, `t.assert`, `t.mock`, `t.waitFor()`, `expectFailure`; `internal/test_runner/mock_timers.ts` | 449 → 3,058 | TS (needs `bun test`) |
| `node:timers` | `timers/promises` `scheduler.wait()`/`yield()` | | TS |
| `node:tls` | `_tls_wrap` module; missing list narrowed to PSK, OCSP stapling, session tickets | 1,056 → 1,763 | TS + RS→ZIG (`SecureContext.bind.ts`, `node_tls_binding.bind.ts`) |
| `node:trace_events` | 🔴 → 🟢: `createTracing()`, `getEnabledCategories()`, `--trace-events-enabled`, `--trace-event-categories`, `--trace-event-file-pattern` | `internal/trace_event{s,_recorder}.ts` | TS + RS→ZIG (writer at exit) |
| `node:tty` | `ReadStream`/`WriteStream` on non-TTY fd → `isTTY=false` instead of throwing | | TS |
| `node:util` | 🟡 → 🟢: `getCallSite(s)`, `getSystemErrorMap`, `getSystemErrorMessage` added; `inspect` rewritten in TS (`internal/util/inspect.ts`) | 338 → 845 | TS + C++ (`CallSite*.cpp`) |
| `node:v8` | `getHeapStatistics`, `getHeapSpaceStatistics`, `GCProfiler`, `startupSnapshot` added | 218 → 482 | TS + C++ |
| `node:vm` | 🟡 → 🟢 incl. `vm.Module`, `SourceTextModule`, `SyntheticModule` | 488 → 811 | TS + C++ (`NodeVM*.cpp`) |
| `node:wasi` | `args`, `env`, `preopens`, `wasiImport`, `start()`; `bun x.wasm` runs WASI | 3,600-line diff | TS |
| `node:worker_threads` | `stdout`/`stderr`/`eval` options (v1.4.0 notes); canary docs say `resourceLimits` and `trackUnmanagedFds` are ignored; some `execArgv` flags honoured in the worker; `'online'` fires first (v1.4.2); `internal/worker/` | 426 → 1,317 | TS + C++ (`JSWorker.cpp`) |
| `node:zlib` | **new `node:zlib/iter`**; brotli/zstd paths (canary replaced C zlib/brotli/zstd with Rust, T9) | 937 → 1,118 | TS + RS→ZIG (`node_zlib_binding.bind.ts`) |
| `node:sea` | still 🔴 | | none |

---

## 3. `bun:test`

`bun:test` is the largest behaviour area: `test.d.ts` gained about 560 non-comment lines,
and `docs/test/*` grew by more than 1,000 lines. All of it needs **`bun test` restored
first** (task T4, `src/test_runner` is under `src/runtime/` in canary).

| Feature | Evidence | How |
|---------|----------|-----|
| **Vitest compatibility**: `import … from "vitest"` resolves to the built-in; `vi` gets `mock`, `doMock`, `unmock`, `doUnmock`, `importActual`, `importMock`, `mocked`, `hoisted`, `stubEnv`, `stubGlobal`, `unstubAll*`, `waitFor`, `waitUntil`, `resetModules`, `dynamicImportSettled`, `setConfig`/`resetConfig`; `bun-types/vitest.d.ts`; `chai` `assert` rewrite | `test.d.ts`; `vitest.d.ts`; `docs/test/mocks.mdx` | TS (`internal/test/{binding,environment,globals}.ts`) + RS→ZIG (module mock registry, import rewriting) |
| `test.globals` / `--globals` (`"bun"`/`"vitest"`) | `bunfig.mdx` `test.globals`; CLI `--globals` | RS→ZIG |
| `test.environment` / `--environment` (DOM envs, UNVERIFIED which: happy-dom/jsdom) | `bunfig.mdx`; `docs/test/dom.mdx` | RS→ZIG |
| **Fixtures**: `test.extend({...})`, `{ auto, scope: "file" }`, `test.override`, fixture-aware hooks | `writing-tests.mdx` `## Fixtures`; `test.d.ts` `Fixture*` | TS? + RS→ZIG (runner) |
| **Test context** argument: `task`, `expect`, `skip()`, `onTestFinished`, `onTestFailed`, `signal`, `annotate()` | `writing-tests.mdx` `### Test Context` | RS→ZIG |
| `aroundEach`/`aroundAll` hooks; global `onTestFinished` | `test-globals.d.ts` | RS→ZIG |
| `test.for`/`describe.for`; more `%` format specifiers (`%p`, `%$`, …); combinable modifiers (`test.skip.concurrent…`); `describe.shuffle` | `writing-tests.mdx`; `test/index.mdx` | RS→ZIG |
| Fake timers: `advanceTimersByTimeAsync`, `advanceTimersToNextTimerAsync`, `advanceTimersToNextFrame`, `runAllTimersAsync`, `runOnlyPendingTimersAsync`, `runAllTicks`, `runAllImmediates`, `getRealSystemTime`, `setTimerTickMode`, `FakeTimersOptions` (`toFake`, `shouldAdvanceTime`, `loopLimit`, …) | `test.d.ts`; `builtins/useFakeTimers.ts`; `docs/test/dates-times.mdx` | TS (`useFakeTimers.ts`) + RS→ZIG hooks |
| Matchers: `toHaveBeenCalledBefore/After`, `toHaveBeenCalledExactlyOnceWith`, `toHaveBeenCalledOnce`, `toHaveResolved*`, `toHave(Last\|Nth)ResolvedWith`, `toMatchFileSnapshot`; `expect.soft`, `expect.poll`, `expect.addEqualityTesters`, `expect.addSnapshotSerializer`, `expect.getState/setState` | `test.d.ts` | RS→ZIG (`src/runtime/test_runner/expect*`) |
| Mocks: `mockThrow`, `mockThrowOnce`, `mock.settledResults`, `mockReset` semantics change after `vi.fn()`/`spyOn`, getter/setter spies, `createMockFromModule`, `requireActual`, `requireMock`, `isMockFunction` | `mocks.mdx`; `test.d.ts` | C++ (`JSMockFunction.cpp`) + RS→ZIG |
| Config: `clearMocks`, `mockReset`, `restoreMocks`, `unstubEnvs`, `unstubGlobals`; `test.reporter.junitSuites` (`nested`/`flat`); `--reporter-junit-suites` | `bunfig.mdx`; `configuration.mdx` | RS→ZIG |
| **`bun test --parallel`**, `--isolate[=modules]`, `--shard` + `--timings` balancing | `canary/docs/test/parallel.mdx` | NEW (canary `src/test_schedule`; GAP.md already lists it) |
| Test file globs add `*_test.*`, `*_spec.*`, `.mts`/`.cts` | `test/index.mdx` | RS→ZIG (trivial) |
| `--no-compile-function-source` | CLI snippet | C++ option |
| `--react-compiler`, `--check`, `--aot` | CLI snippet | out of scope (T7/T8) |

---

## 4. `bun:sqlite`

| Change | Evidence | How |
|--------|----------|-----|
| **User-defined functions**: `db.function(name, [options], fn)` with `varargs`, `deterministic`, `directOnly`, `safeIntegers` | `sqlite.d.ts`; `docs/runtime/sqlite.mdx` | TS (`bun/sqlite.ts`) + RS→ZIG / C++ (`sqlite3_create_function_v2`) |
| **Aggregate/window functions**: `db.aggregate(name, { start, step, inverse, result })` | same | same |
| **Update hooks**: `db.onInsert`, `db.onUpdate`, `db.onDelete` | same | same (`sqlite3_update_hook`) |
| `Database.MAX_QUERY_CACHE_SIZE`, `db.clearQueryCache()` | `sqlite.d.ts` | TS |
| `Statement`: `reader`, `readonly`, `isFinalized`, `safeIntegers(bool)`, `toJSON()` | `sqlite.d.ts` | TS + C++ |
| `values()` row element type: `boolean` removed, `null` added (typing fix, behaviour UNVERIFIED) | `sqlite.d.ts` | check |
| `fileControl(op, arg)`: `arg` may be `null`; documented 8-byte TypedArray in/out semantics | `sqlite.mdx` | C++ |
| Bindings accept `ArrayBufferLike` | `sqlite.d.ts` | C++ |
| `export var native` removed | `sqlite.d.ts` | TS |

## 5. `bun:ffi`

| Change | Evidence | How |
|--------|----------|-----|
| **Breaking:** `CString` is no longer a `String` subclass with `.ptr`/`.arrayBuffer`. `new CString(ptr)` and `CString(ptr)` now return a **plain `string`**; `cstring` returns are `string \| null` | `ffi.d.ts` (old `class CString extends String` removed) | TS (`bun/ffi.ts`) + C++ (`JSFFICString.cpp`) |
| Pointer params accept `number \| bigint` everywhere (`read.*`, `toBuffer`, `toArrayBuffer`, `CFunction`); `ptr`/`function` args accept `bigint` | `ffi.d.ts` | RS→ZIG / C++ |
| `cstring` **arguments** accept JS `string` (auto-encoded) | `ffi.d.ts` | RS→ZIG |
| New `FFIType.buffer_length` (`"buffer_length"`/`"buffer_bytelength"`): pass a TypedArray as (ptr, len) | `ffi.d.ts` | RS→ZIG (TinyCC codegen) |
| `--no-ffi-cc` run flag (also implied by `--no-addons`; `cc()` throws `ERR_FFI_CC_DISABLED`) | CLI `run` snippet; v1.4.1 notes | RS→ZIG |
| **Engine-native FFI replaces TinyCC** for `dlopen` call stubs (no-op calls about 3x faster). `dlopen()` throws `TypeError` when the JIT is disabled; `napi_env`/`napi_value` types throw outside `cc()`; `viewSource()`/`new JSCallback()` validate arguments | v1.4.0 notes | NEW (JIT-level thunks in canary's WebKit fork + C++ `JSCFFIBridge.cpp`, UNVERIFIED). zun can keep TinyCC for parity of behaviour first and treat the engine-native path as a perf item. Whether `cc()` still uses TinyCC in canary is UNVERIFIED |

## 6. `Bun.sql` (Postgres / MySQL / SQLite)

| Change | Evidence | How |
|--------|----------|-----|
| `LISTEN`/`NOTIFY`: `sql.listen(channel, onnotify, onlisten?)` → `ListenSubscription` (`unlisten()`, `AsyncDisposable`), `sql.notify()` | `sql.d.ts` | TS (`bun/sql.ts`, `internal/sql/postgres.ts`) + RS→ZIG (async notification messages) |
| `COPY` streams: `query.readable()`, `query.writable()` | `sql.d.ts` | TS + RS→ZIG |
| Result metadata on every result: `count`, `affectedRows`, `lastInsertRowid`, `command`, `columns`, `statement` | `sql.d.ts` `ResultMetadata` | TS + RS→ZIG |
| Name transforms: `transform: { column, undefined }`, `sql.camel/pascal/kebab`, `toCamel`/`fromCamel`… | `sql.d.ts` | TS |
| `sql.json(value)`; `sql.array()` accepts TypedArrays; `unsafe()`/`file()` accept named params (`Record`) | `sql.d.ts` | TS + RS→ZIG |
| `close({ timeout })` on reserved/transaction; `release()` returns a Promise; `reserve({ signal })` | `sql.d.ts` | TS |
| TLS modes as `sslmode` strings (`disable`…`verify-full`); `checkServerIdentity`; `channelBinding` (SCRAM-PLUS); `socket` (unix path); MySQL `allowPublicKeyRetrieval`, `foundRows`; `bigint`; `url` may be `URL` | `sql.d.ts` | TS options (`internal/sql/options.ts`) + RS→ZIG (channel binding, RSA public-key auth) |
| New `internal/sql/pool.ts` (pool moved to TS, UNVERIFIED) | `src/js/internal/sql/pool.ts` | TS |
| `UUID` array type | `sql.d.ts` | TS |
| `DATABASE_URL` / `POSTGRES_URL` env precedence documented | env-var docs | TS |
| `docs/runtime/sql.mdx` +1,096 lines: read it in full before porting | | |

Note: `Bun.sql` must first be **restored** from 1.3.14 (`src/sql*`, GAP.md 🔧).

## 7. `Bun.redis` (RedisClient)

`redis.d.ts` grew by about 900 lines: **typed methods for roughly 130 more commands**:
streams (`xadd`, `xread`, `xreadgroup`, `xack`, `xclaim`, `xautoclaim`, `xpending`,
`xinfo`, `xgroup`, `xtrim`, …), geo (`geoadd`, `geosearch`, …), scripting (`eval`,
`evalsha`, `fcall`, `function`, `script`), blocking list ops (`blpop`, `brpop`, `blmove`,
`blmpop`, `bzpopmin`, …), sorted-set ops (`zrange*`, `zunion`, `zinter`, `zmpop`, …),
server (`info`, `config`, `client`, `dbsize`, `flushall`, `time`, `wait`, …), bitfield ops,
`hgetdel`/`hgetex`/`hsetex`, `lcs`, `sort`, `object`, `debug`. Plus:
- `ReplyOptions` `{ buffer: true }` to get `Buffer` replies (binary data section in docs).
- `tls` options incl. `checkServerIdentity`.
- `PSUBSCRIBE`; error codes `ERR_REDIS_SERVER_ERROR`, `ERR_REDIS_CONNECTION_TIMEOUT`, `ERR_REDIS_IDLE_TIMEOUT`.

Evidence: `canary/packages/bun-types/redis.d.ts`, `docs/runtime/redis.mdx`.
How: mostly **RS→ZIG** table work. Most commands are thin `send(cmd, args)` wrappers with
reply shaping (RESP3), so this is high-volume but low-risk. Generate from a table where possible.

## 8. `Bun.s3`

Types unchanged after stripping comments; docs list `s3File.stream()` → `ReadableStream`
and other doc edits. Treat as **no API change** (UNVERIFIED behaviour fixes: check the
release notes in §13).

## 9. `Bun.$` shell

`shell.d.ts` unchanged. Docs add `1>&2` and `2>&1` redirections (UNVERIFIED whether
1.3.14 lacked them or the docs merely gained them). `builtins/shell.ts` has an 87-line diff.
How: restore 1.3.14 shell (🔧), then RS→ZIG the delta from `canary/src/runtime/shell`.

---

## 10. Bundler (`bun build` / `Bun.build`)

Runtime-adjacent because `Bun.build` is a runtime API and the transpiler/loader share code.

| Change | Evidence | How |
|--------|----------|-----|
| Code splitting knobs: `splitRequire`, `minChunkSize`, `modulePreload` (`--no-module-preload`) | `bun.d.ts` `BuildConfig`; `bundler/index.mdx` | RS→ZIG |
| `treeShaking?: boolean`; "tree-shaking `import()` and `require()` results" | same | RS→ZIG |
| `deprecatedNamespaceObjectSetters` (`--no-deprecated-namespace-object-setters`); re-exported namespaces section | same | RS→ZIG |
| `bytecodeDepth`, `optimize.bytecode`, `bytecodeOrder` | same | RS→ZIG + C++ |
| `dts: true`: **emit `.d.ts`** per source file (needs `sema`) | `bundler/index.mdx` `### dts` | out of scope (T8) |
| `check`, `reactCompiler`, `aot*`, `trim`, `obfuscate`, `jitPolicy` | `bun.d.ts` | out of scope (T7/T8) |
| `--metafile`, `--metafile-md` (`BundlerMetafile.cpp`) | CLI snippet | RS→ZIG |
| `--allow-unresolved` / `--reject-unresolved` | CLI snippet | RS→ZIG |
| `--asset`/`assets` | same | RS→ZIG |
| `--compile-*` family: `autoload-{bunfig,dotenv,package-json,tsconfig}`, `executable-path`, `in-place`, `inspector`, `jit-policy`, `--no-compile-function-source`, `disallowCodeGenerationFromStrings` | CLI snippet; `bun.d.ts` | RS→ZIG (after `standalone_graph` restore) |
| `--server-components` removed from `build` | CLI snippet | remove |
| `[hash]` documented as 8 lowercase alphanumerics with collision handling | `bundler/index.mdx` | RS→ZIG (check vs 1.3.14) |
| New loaders: `xml`, `md` (`file-types.mdx`), `.jsonc`, asset `publicPath` table | `bundler/loaders.mdx` | RS→ZIG |
| `bun build` "esbuild" compat page +156 lines | `bundler/esbuild.mdx` | read before porting |
| `docs/bundler/bytecode.mdx`, `executables.mdx` moved to `docs/compiler/` | docs tree | doc move |

## 11. Package manager

| Change | Evidence | How |
|--------|----------|-----|
| **`bun.lock` format versions 2 and 3.** v2: stricter parsing (tarball URLs outside the registry must have an integrity hash; integrity must be supported or empty; safe `.bun-tag`). v3: `overrides` values may be objects (scoped rules). v0/v1 still load | `canary/src/install/lockfile/bun.lock.rs` `enum Version` (`CURRENT = V3`); `bun.d.ts` `lockfileVersion: 0 \| 1 \| 2` (types lag) | RS→ZIG (on top of the 1.3.14 `src/install` restore) |
| **Version-scoped / nested overrides**; `"resolutions"`; `catalog:` and `npm:` alias targets | `docs/pm/overrides.mdx` | RS→ZIG |
| `packageExtensions` | `docs/pm/package-extensions.mdx`; `lockfile/package_extensions.rs` | RS→ZIG |
| `bun pm dedupe`, `bun pm prune` | `docs/pm/cli/{dedupe,prune}.mdx` | RS→ZIG (GAP.md lists) |
| `bun pm licenses`, `bun pm diff` (semantic package diff with `--minify`, `--stat`, `--json`…); `bun pm pack` `--destination/--filename/--gzip-level/--quiet` | `docs/pm/cli/pm.mdx` | RS→ZIG / NEW for `diff` |
| `bun audit fix` (`--dry-run`, `--json`, `--latest`) | `docs/pm/cli/audit.mdx` | RS→ZIG |
| `bun update`: `--recursive`, `--filter`, `--dev/--prod/--no-optional`, `--depth 0`, `--global`, `--no-save`; operator-preserving rewrite rules | `docs/pm/cli/update.mdx` | RS→ZIG |
| `bun publish --recursive/--filter`, `--provenance`, `publishConfig.registry` | `docs/pm/cli/publish.mdx` | RS→ZIG (provenance = sigstore: NEW) |
| `bun add --save-prod`, `--catalog`, `--filter`; local paths | `docs/pm/cli/add.mdx` | RS→ZIG |
| `bun install`: offline modes (`--prefer-offline`, `--offline`, `install.offline`, `install.prefer`); `--minimum-release-age-excludes` / `minimumReleaseAgeExcludes`; `--cpu/--os/--libc`; npm/yarn/pnpm flag aliases (`--save-dev`, `--omit=…`, `--only=prod`); `--env-file`, `--use-system-ca`; `--production` implies `--frozen-lockfile`; frozen lockfile on pruned monorepos; `BUN_CONFIG_HTTP_RETRY_*` | `docs/pm/cli/install.mdx`; `snippets/cli/install.mdx` | RS→ZIG |
| `install.hoist = false` (strict isolated resolution); isolated-linker fallback toggle | `docs/pm/isolated-installs.mdx`; `npmrc.mdx` | RS→ZIG |
| `.npmrc`: which files are read, `_auth`, `email`, per-path credential matching, port normalisation | `docs/pm/npmrc.mdx` | RS→ZIG |
| Self-contained workspaces | `docs/pm/workspaces.mdx` | RS→ZIG |
| npm lockfile migration from `lockfileVersion` 2/3/4 (not 1) | `docs/pm/lockfile.mdx` | RS→ZIG |
| `Bun.semver`, `hosted_git_info_jsc.bind.ts`, `ini_jsc.bind.ts` | | RS→ZIG |

The package manager also depends on the C-library rewrites (tar, gzip; T9). All of it
needs **`src/install` restored** from 1.3.14 first (54k Zig lines; canary is 107k Rust).

## 12. CLI flags and `bunfig.toml` (runtime side)

| Change | Evidence | How |
|--------|----------|-----|
| `bun run` / `bun` new flags: `--interactive` (REPL), `--watch-kill-signal`, `--no-ffi-cc`, `--disallow-code-generation-from-strings`, `--trace-event*`; `--target` removed from `run` | `snippets/cli/run.mdx`; nodejs-compat | RS→ZIG (CLI) |
| `bunfig`: `test.environment`, `test.globals`, `test.clearMocks`…, `test.reporter.junitSuites`, `install.offline`, `install.prefer`, `install.hoist`, `minimumReleaseAgeExcludes`; `[lint]`/`[format]` (out of scope) | `docs/runtime/bunfig.mdx` | RS→ZIG |
| Env vars documented: `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_USE_SYSTEM_CA`, `BUN_CONFIG_WS_CLOSE_TIMEOUT`, `BUN_CONFIG_MAX_HTTP_REQUESTS` (+install), `BUN_OPTIONS`, `BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD`, `DATABASE_URL` | `docs/runtime/environment-variables.mdx` | RS→ZIG. **Identity rule:** zun reads `ZUN_*` names (Phase 3); decide per variable whether to also accept `BUN_*` |
| `.env` load order documented (`.env.local` skipped when `NODE_ENV=test`) | same | verify vs 1.3.14 |

## 13. Behaviour changes from the release notes (v1.4.0–v1.4.5)

The type and docs diffs above show **new surface**. Behaviour changes to existing APIs
are mostly visible only in the release notes. This is the condensed list, weighted
toward items the notes label **BREAKING** ("(B)" below). Sources:
[v1.4.0](https://bun.com/blog/bun-v1.4.0) (2026-08-20, the Rust rewrite),
[v1.4.1](https://bun.com/blog/bun-v1.4.1), [v1.4.2](https://bun.com/blog/bun-v1.4.2),
[v1.4.3](https://bun.com/blog/bun-v1.4.3), [v1.4.4](https://bun.com/blog/bun-v1.4.4),
[v1.4.5](https://bun.com/blog/bun-v1.4.5) (2026-11-19, security). No v1.3.15+ exists
(the URL returns 404; the blog index goes from 1.3.14 straight to 1.4.0).

Caveat: the v1.4.0 notes are very long and parts were read only as a summary. Treat
every row here as **UNVERIFIED until a canary test confirms it**. Each is a candidate
test to port into zun's parity suite (search canary `test/` for the error code or option).
Almost all are **RS→ZIG** edits to code zun restores from 1.3.14; the column notes otherwise.

### 13.1 `Bun.*`

| Version | Change |
|---------|--------|
| 1.4.0 | (B) `Bun.cron.parse` and in-process `Bun.cron` use **local time**; `{ tz: "UTC" }` restores UTC |
| 1.4.0 | (B) `Bun.YAML` uses YAML 1.2 booleans (`yes`/`no`/`on`/`off` are strings); `Bun.TOML.parse` and `Bun.JSONC.parse` throw `SyntaxError` and are stricter (`JSONC.parse("")` throws) |
| 1.4.0 | (B) `Bun.mmap({ offset })` view starts at `offset`, not the page boundary |
| 1.4.0 | (B) `Bun.password` argon2 `memoryCost >= 8`; `Bun.randomUUIDv7()` range-checks the timestamp; `Bun.udpSocket()` port range checked |
| 1.4.0 | (B) `Bun.spawn`: NUL in `argv0`/`cwd` → `ERR_INVALID_ARG_VALUE`; `timeout: NaN` → `ERR_OUT_OF_RANGE`; `killSignal: 0` → `ERR_UNKNOWN_SIGNAL`; already-aborted `signal` → `AbortError` without spawning |
| 1.4.0 | (B) `Bun.color()` output changes (`ansi-16`, `hsl`, `lab`, near-black `ansi-256`; `0xff0000` opaque); `Bun.Cookie` `Expires` like `toUTCString()`; `Bun.FileSystemRouter.match()` → `null` for paths without leading `/`; `Bun.deepEquals` compares Temporal by value and boxed BigInt/Symbol |
| 1.4.0 | (B) `Bun.Terminal#write()` returns full input length; `drain` fires |
| 1.4.0 | `Bun.dns.lookup({ backend: "c-ares" })`; `Bun.openInEditor()` throws when no editor |
| 1.4.0 | `Temporal` is defined by default (`BUN_JSC_useTemporal=0` disables) (B). Comes with the WebKit bump |
| 1.4.1 | `Bun.write(path, Response \| Request \| ReadableStream)` streams (was `[object ReadableStream]`) |
| 1.4.1 | `localhost`/`*.localhost` resolve to loopback without the system resolver (fetch, WebSocket, connect, install) |
| 1.4.3 | Pipe I/O errors (`EIO`, `ENOBUFS`) from `Bun.spawn` are reported, not truncated; `EMFILE` instead of blocking |
| 1.4.3 | (B) `Bun.semver.satisfies()` returns `false` for invalid versions |
| 1.4.4 | (B) `Bun.Glob`: extglobs `?() *() +() @() !()` and brace ranges `{1..3}` (also in `--filter`, `workspaces`, `files`, `sideEffects`) |
| 1.4.4 | (B) `Bun.hash`/`CryptoHasher` throw `TypeError` for `Bun.file()`, S3 files, build outputs, `null`/`undefined`; `YAML`/`TOML.parse` throw for S3 files |
| 1.4.4 | `Bun.gzipSync`/`deflateSync` honour `memLevel`/`strategy`; `Bun.Archive` rejects truncated archives; `Bun.gc(true)` returns memory to the OS |

### 13.2 `Bun.serve` / server WebSocket

| Version | Change |
|---------|--------|
| 1.4.0 | Static and `Bun.file` responses: `Range` → 206; `If-None-Match`/`If-Modified-Since` → 304; `If-Match`/`If-Unmodified-Since` → 412 (1.4.3 adds `If-Range`) |
| 1.4.0 | (B) HTML routes: no sourcemaps in production (`[serve.static] sourcemap = "linked"` restores); `inspector` option removed; out-of-range `port` throws `RangeError`; 400 for any `Transfer-Encoding` other than a single final `chunked`; 413 for >16 KiB chunk extensions |
| 1.4.0 | (B) `server.upgrade()` returns `false` unless `Upgrade: websocket` with a valid key; 426 on wrong version |
| 1.4.0 | (B) `server.stop()` closes idle connections and waits for in-flight; `stop(true)` force-closes |
| 1.4.0 | (B) `publish()` returns `0` dropped / `-1` backpressure / byte count |
| 1.4.0 | Invalid response status → `error()` (500); per-method route objects answer `HEAD` with `GET`; per-`serverName` `requestCert`/`rejectUnauthorized`; `ws.subscriptions` getter |
| 1.4.1 | `http2: true` serves HTTP/2 on the same port (ALPN, cleartext preface); `http1: false` refuses HTTP/1.x; no WebSockets or trailers over HTTP/2 yet |
| 1.4.4 | `ws.pause()/resume()/isPaused` (idle timeout suspended while paused); `error(error, ws)`; all `websocket` handlers optional; `idleTimeout: 0` = none; `stop(true)` closes with 1001 |

### 13.3 Web APIs, `fetch`, client `WebSocket`, TLS

| Version | Change |
|---------|--------|
| 1.4.0 | Native web streams pass 100% of WPT; `CompressionStream`/`DecompressionStream` support **brotli and zstd**; `Response.textStream()`; `URLPattern` |
| 1.4.0 | (B) `clone()` throws after the body is read/locked; `fetch` network errors are `TypeError`; a second body read rejects `ERR_BODY_ALREADY_USED`; duplicate response headers joined with `,`; option-reading errors reject (not throw) |
| 1.4.0 | `fetch` HTTP/2 and HTTP/3 clients behind `BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1` / `--experimental-http3-fetch` (status in canary UNVERIFIED); `compress`; proxy `headers`; truncated compressed body rejects; `redirect: "error"` only on 301/302/303/307/308; Latin-1 header bytes sent as-is |
| 1.4.0 | (B) client `WebSocket`: `close()`/`terminate()` queue `close`; code/reason validation; `ping`/`pong` >125 bytes throw; subprotocol mismatch fails with 1002; no `agent` option |
| 1.4.1 | (B, security) `fetch` verifies TLS against the URL hostname, not a custom `Host` header (`tls.servername` overrides) |
| 1.4.1 | `fetch`/S3 bodies pause at 256 KiB unread; discarded `Response` closes its connection; 204/205/304/HEAD → `null` body; `fetch({ unix })` keep-alive |
| 1.4.3 | Hardening: certificates checked during the handshake; strict hostname/IP matching (CVE-2026-48618); `file://host/…` rejects; `Content-Length` vs stream mismatch rejects |
| 1.4.4 | (B) client `WebSocket`: `close` fires after the closing handshake (30 s, `BUN_CONFIG_WS_CLOSE_TIMEOUT`); `close()` without code → empty frame, 1005 both ends; failed connect → `error` then `close` 1006 with Node-style `code`; `send/ping/pong` throw while `CONNECTING`; `proxy.tls` |
| 1.4.4 | TLS: `ca` alone no longer requests a client cert; `tls.DEFAULT_CIPHERS` applies to fetch/WebSocket/connect/Redis/SQL/S3 |
| 1.4.5 | Security fixes (HTTP/3, HTTP/1.1, TLS, DNS, zstd); stricter custom-root validation; deps: lsquic 4.11.2, c-ares 1.34.9, SQLite 3.54.1, llhttp 9.4.4, BoringSSL Nov 2026. Note c-ares is still a dep in 1.4.5 (GAP.md says canary removed it, so the removal is post-1.4.5) |

### 13.4 `node:*`

| Version | Change |
|---------|--------|
| 1.4.0 | Node 26 test suite: +1,517 passing; `process.versions.modules` = `147` (B); `res.writeHeader()` removed (B) |
| 1.4.0 | (B) `node:fs`: `rmdir({ recursive })` throws; object `flags` throws; explicit `undefined` options to `rm` reject; `appendFile({ flag: "w" })` truncates; `fs.watch` recursive emits `'error'` for unwatchable dirs; callback exceptions go to `uncaughtException` |
| 1.4.0 | (B) `node:dgram`: second `bind()` → `ERR_SOCKET_ALREADY_BOUND`; ops on closed socket → `ERR_SOCKET_DGRAM_NOT_RUNNING` |
| 1.4.0 | (B) `node:dns`: `lookup` uses `getaddrinfo` on Linux, so `setServers()` doesn't affect it |
| 1.4.0 | (B) `node:tls`: `host` is default `servername`; `requestCert: true` rejects unverified clients; literal checks of `requestCert`/`rejectUnauthorized`; `handshakeTimeout` keeps the socket open; **no longer reads `NODE_TLS_REJECT_UNAUTHORIZED`** (note: the canary env-var docs still list it; UNVERIFIED which is current) |
| 1.4.0 | (B) `node:net` accepted sockets not auto-resumed; `X509Certificate` serial/modulus uppercase; `deepStrictEqual` compares prototypes; `child_process.spawn` ignores `encoding`; `process.title` defaults to `argv[0]`; `process.reallyExit()` doesn't emit `'exit'`; running as `node` doesn't load `.env`; paused-mode `read()` returns one chunk |
| 1.4.0 | `node:zlib` on zlib-ng; `socket.upgradeTLS({ isServer: true })`; `util.styleText` plain on non-TTY; Node-style warning printing |
| 1.4.1 | `crypto.argon2()`/`argon2Sync()`; lazy-loaded internals for many modules; `net.createServer(cb)` registers `"connection"`; `tls.getCACertificates('system')` dedup |
| 1.4.3 | (B) `buf.utf8Write(123)` and other per-encoding writes throw `ERR_INVALID_ARG_TYPE`; N-API finalizers after exit get `napi_cannot_run_js`; `fs` opens with `O_CLOEXEC`; `node:http` `listen()` twice → `ERR_SERVER_ALREADY_LISTEN` |
| 1.4.4 | `ws` package is a built-in port of `ws` 8.22.0 (B: `'error'` is an `Error` and needs a listener; `'close'` reason is a `Buffer`; no Bun idle timeout/pings/backpressure on `ws` servers; `send()` throws while connecting; `maxPayload` default 100 MiB) → TS (`src/js/thirdparty/ws.ts`) |
| 1.4.4 | `util.types.isDate` etc. throw on `new`; `navigator.hardwareConcurrency`/`os.availableParallelism()` honour cgroup v2 |

### 13.5 `bun:test`, `bun:sqlite`, `Bun.sql`, `Bun.redis`

| Version | Change |
|---------|--------|
| 1.4.0 | `bun test --parallel[=N]`, `--isolate`, `--shard=M/N`, `--timings`, `--changed[=ref]`, `--retry`, `{ retry, repeats }`, `--only-failures`, `--path-ignore-patterns`, `--pass-with-no-tests`, `--grep`; `JEST_WORKER_ID`/`BUN_TEST_WORKER_ID` |
| 1.4.0 | (B) `resetAllMocks()` drops implementations; `toContain()` uses `===` |
| 1.4.0 | `bun:sqlite`: SQLite 3.53 (3.54.1 in 1.4.5; `ALTER TABLE` can't touch `rowid` columns); `db.close()` finalizes `query()` statements, `close(true)` also `prepare()` ones; empty SQL in `prepare()` throws |
| 1.4.4 | `bun:sqlite`: (B) `{ readonly: true, create: true }` throws; binding a lone `Date`/`Map`/`Promise` throws |
| 1.4.0 | (B) `Bun.sql`: MySQL `DATETIME`/`TIMESTAMP` and Postgres `.simple()` timestamps decode as UTC; MariaDB `JSON` parsed; `±infinity` dates; `connectionTimeout` bounds the handshake; `PGSSLMODE` / `?sslmode=` honoured |
| 1.4.0 | `Bun.sql` `prepare: false` = one round trip (PgBouncer-safe); named params in `unsafe()`/`file()` |
| 1.4.4 | `Bun.sql`: `query.cancel()`; COPY streams; transforms; array params; metadata; `sql.json`; `--hot` keeps connections; (B) no longer reads `PASSWORD` env; (B) loose-mode-compiled tagged templates throw |
| 1.4.0 | (B) `RedisClient`: `rediss://` verifies hostname; non-numeric db in URL throws; `expire(NaN)` throws |

### 13.6 Package manager, bundler, CLI

| Version | Change |
|---------|--------|
| 1.4.0 | (B) **new monorepos default to the isolated linker**; new lockfiles are `lockfileVersion: 2`; v3 for scoped overrides (older Bun can't read v3) |
| 1.4.0 | (B) `trustedDependencies` auto-trusts only npm-registry packages and matches exact names; `--registry` doesn't leak credentials cross-host; `workspace:` only in root/workspace `package.json`; `bun update` updates transitive deps |
| 1.4.0 | `nativeDependencies` and `ignoreScripts` in `package.json`; global virtual store (isolated linker); SHA-512 integrity for GitHub/tarball deps; `bun feedback` removed |
| 1.4.1 | `selfContained` workspaces (and Yarn `hoistingLimits: "workspaces"`); `--offline` / `--prefer-offline` |
| 1.4.3 | Failed installs exit non-zero; `--dry-run` runs no scripts; `NODE_ENV=development/test` read `.env` not `.env.production` |
| 1.4.4 | Yarn Berry lockfile migration; retries with backoff (`BUN_CONFIG_HTTP_RETRY_BACKOFF`, `Retry-After`); `--libc`; pnpm-like peer resolution; `bun pm fetch`, `bun pm cache pack/unpack/prune`; `publish --recursive`; `packageExtensions`; `link:./dir`; `minimumReleaseAge` units; (B) unknown npm/yarn/pnpm flags are an error; prerelease publish needs `--tag` |
| 1.4.0 | Bundler (B): `--metafile` `path` matches `inputs` keys; sorted `import * as ns` enumeration; assigning to an import throws at runtime |
| 1.4.1 | Namespace tree-shaking (`export * as`), `--min-chunk-size`, `modulePreload`, `splitRequire`, stable nested class/function names; `--bytecode-depth`; deterministic cross-platform bytecode |
| 1.4.0 | CLI: `--cpu-prof*`, `--heap-prof*` (`BUN_CPU_PROFILE=1`), `--no-env-file` / `env = false`, `--no-orphans` (`[run] noOrphans`), native `bun repl`, `bun ./README.md` renders Markdown |
| 1.4.1 | `--env-file` from a pipe/FIFO; `--no-ffi-cc`; TS 7.1 import-attribute types (`text`, `file`, `md`, `toml`, `yaml`, `jsonc`, `json5`, `xml`, `sqlite`, `html`) |
| 1.4.4 | `--disallow-code-generation-from-strings=strict` refuses files written at runtime |

## 14. Out of scope here (one line each)

`bun check` and `bun build --check/--dts` (sema), `bun lint`, `bun format`, React Compiler,
AoT (`bun compile`, `--aot*`, `bun explain`, `--trim`, `obfuscate`, `Bun.ModuleGraph`'s
AoT interplay): see `docs/plan/aot.md` (T7) and `docs/plan/tooling.md` (T8).
C-library replacements (zlib/brotli/zstd/tar/c-ares/picohttpparser/lshpack/images/hdrhistogram): T9.

---

## 15. Suggested order for zun

1. **WebKit bump** to canary's commit (§0.1). Unlocks the most behaviour for free.
2. **Zig backend for canary bindgen** (§0.2). After this, canary `src/js` is adoptable.
3. **C++ web streams** (§0.3) together with the canary `src/js/node/stream*` family.
4. `node:*` module by module, in order of user impact: `fs`, `net`, `http`/`https`, `child_process` (+ IPC handle passing), `crypto`, `util`, `zlib`, `dns`, `worker_threads`, `http2`, then `sqlite`, `repl`, `test`, `trace_events`, `quic`. Gate each on canary's `test/js/node/**` tests.
5. `Bun.serve`/`fetch`/WebSocket deltas (§1.2–1.4): small RS→ZIG items on code zun already has.
6. After the restores in GAP.md T4: `bun:test` (§3), `bun:sqlite` (§4), `bun:ffi` (§5), `Bun.sql` (§6), `Bun.redis` (§7), install (§11), bundler (§10).
7. New subsystems last: `Bun.ModuleGraph`, `Bun.XML`, `Bun.diff`, `node:quic`, HTTP/3 client, `bun test --parallel`.

## 16. Biggest gaps (summary)

1. WebKit/Node baseline jump (Node 23 → 26 compat, N-API ABI 137 → 147).
2. Bindgen architecture change (`$zig` → `$bindgen` + 153 `.bind.ts`): gatekeeper for TS reuse.
3. Web Streams rewritten from JS to C++ (23k lines).
4. `node:*` rewrites: `http`/`http2`/`net`/`tls`/`fs`/`child_process` grew 50–200%; new `node:quic`, `node:sqlite`, `node:repl`, `node:test`, `node:trace_events`, `stream/iter`.
5. `bun:test` Vitest compatibility (fixtures, context, `vi.*`, async fake timers, `--parallel`).
6. `Bun.sql` LISTEN/NOTIFY, COPY, metadata, transforms; `Bun.redis` +130 commands.
7. `bun:sqlite` UDFs/aggregates/hooks; `bun:ffi` `CString` breaking change.
8. Package manager: lockfile v2/v3, scoped overrides, `packageExtensions`, `audit fix`, `pm diff`, offline modes.
9. New `Bun.*`: `ModuleGraph`, `XML`, `diff`, `FetchSession`; fetch HTTP/3 client; `Bun.serve` directory routes and same-port HTTP/2.
10. Roughly 100 release-note **breaking** behaviour changes (§13) across fs/tls/dgram/WebSocket/serve/sql/install, each needing a ported test.
11. Engine-native FFI (no TinyCC for `dlopen`) and native web streams: perf/architecture items where zun can ship the old mechanism first.
