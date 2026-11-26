# Known security issues

Issues found in code zun ships, open until fixed. Each entry: what, impact, where, how found, plan.
Fixed entries move to the bottom with the commit that fixed them.

## md (`Bun.markdown`, `.md` imports): restored 2026-11-26

Threat model: markdown passed to `Bun.markdown.*` or imported as `.md` may be **untrusted** (user content
rendered by a server). Review scope: `src/md/*.zig`, `src/runtime/api/MarkdownObject.zig`.

### MD-1: quadratic time on unmatched link brackets (DoS), open

- `Bun.markdown.html("[".repeat(n))` and `"[a](".repeat(n)` are **O(n²)**. ASAN debug build:
  `[` ×20k = 3.0 s, ×40k = 11.9 s; `[a](` ×10k = 4.3 s, ×20k = 17 s (80 KB of input). A release build is
  faster by a constant factor only, so a few hundred KB of crafted input still pins a CPU core for seconds,
  and the call is synchronous on the JS thread.
- Link reference definitions are superlinear too (~×2.7 per doubling): 10k `[rN]: /uN` lines = 3.6 s (debug).
- Same code as upstream Bun 1.3.14 (inherited, not introduced by the port). Emphasis, backticks, HTML, entities,
  tables and deep nesting were measured linear (`test/js/node/test/parallel/test-zun-markdown.js`).
- **Mitigation now:** cap the input size before calling `Bun.markdown` on untrusted text, or render off the request
  path (a Worker with a timeout).
- **Plan:** check whether a later Bun (1.4.x Rust port, `src/md`) bounded this, else bound the bracket/opener
  search (md4c keeps opener stacks to stay linear). Track in `backports.md`.

### MD-2: offsets are u32; unchecked casts on huge input, fixed in the port

- The parser stores offsets as `u32` (`types.OFF`). Upstream does `@intCast(text.len)` (`parser.zig`) and
  `@intCast(block_bytes.items.len)` (`containers.zig`), and computes `n_lines * @sizeOf(VerbatimLine)` in
  `u32` right before a bounds check (`containers.zig`, `ref_defs.zig`). With input > 4 GiB, or a few hundred MB of
  very short lines (the block buffer grows ~12–16 bytes per line), safe builds panic and **ReleaseFast builds
  truncate or wrap, which can defeat the bounds check and read out of bounds**.
- zun fix (marked `// zun:` in the source): input > 4 GiB returns `error.OutOfMemory` (JS sees an out-of-memory
  error), the block-buffer casts are checked (`std.math.cast … orelse error.OutOfMemory`), and the line-array size
  is computed in `usize`. Upstream behaviour is otherwise unchanged.
- Not tested at that size (needs > 4 GiB of RAM per case); reviewed by reading.

### MD-3: Bun.markdown is not an HTML sanitizer (by design), documented

- Default options follow CommonMark: raw HTML blocks/spans pass through unchanged (`<script>` included) and link
  destinations are not filtered (`[x](javascript:alert(1))` → `href="javascript:alert(1)"`).
- Options that help: `tagFilter: true` (GFM tag filter), `noHtmlBlocks` / `noHtmlSpans`. None of them filter URL
  schemes. **Rendering untrusted markdown into a page needs a real sanitizer** on the output. Same as Bun.

### Reviewed, no finding

- No `@setRuntimeSafety(false)`, no `catch unreachable` / `orelse unreachable`. The one
  `error.JSError => unreachable` (`parser.zig`, `renderToHtml`) is an invariant: the HTML renderer never calls JS.
- 29 `@ptrCast`: renderer vtables (`*anyopaque` → own type) and reads of block headers/line arrays packed into
  `block_bytes`; each packed read is preceded by an `off + size > bytes.len` check.
- Recursion is guarded by `bun.StackCheck` (deep `>` / list nesting throws `RangeError` or renders, no crash).
- Remaining `@intCast`/`@truncate` are on small bounded values (codepoints < 128, digit chars, heading level,
  terminal columns clamped to `u16`, JS array lengths ≤ 2³²−1).
- ANSI renderer column counters are `u32` and reset per line; an overflow needs a single > 4 G-column line.

## Runtime (found during the md restore)

### RT-3 / TQ-3: Worker threads end with `pthread_exit` inside live C++ frames (all builds), open, RCA done

- **Root cause found** (`docs/rca/TQ-3-worker-thread-exit-under-asan.md`). Every Worker thread ends with
  `bun.exitThread()` → `pthread_exit` called from Zig (`src/jsc/web_worker.zig:738`) while C++ frames are live:
  always `JSC__VM__holdAPILock`'s `JSLockHolder`, and on an uncaught error the whole JS stack
  (`onUnhandledRejection` → `shutdown()`, `:819`), which tears down the `JSC::VM` while it is still entered.
  Skipped destructors leak the worker's VM (its API lock is never released). It is not a use-after-free today only
  because the abandoned frames are never resumed. Inherited from Bun 1.3.14; Bun 1.4.5 redesigned it (thread
  returns normally).
- **The ASAN reports are a consequence, not an out-of-bounds copy:** the abandoned frames' redzones stay poisoned
  (Zig never calls `__asan_handle_no_return`), and the pthread TSD destructors that run next trip
  `stack-buffer-underflow` in `pas_deallocate`'s own frame, or ASAN's `kCurrentStackFrameMagic` CHECK. Proven by
  calling `__asan_handle_no_return()` at `pthread_exit` under gdb: the report disappears.
- **Second ASAN-only issue:** Zig ≥ 0.16 std attaches a TLS sigaltstack to every `std.Thread`; ASAN `munmap`s the
  current alt stack at thread exit and fails (`failed to deallocate 0x40000 … error code: 22`). With a page-aligned
  buffer it would unmap live TLS. Introduced by the Zig 0.16 port.
- **Impact:** 47 parity tests (31 worker_threads) report SANITIZER/CRASH, so ASAN is blind on Worker code until
  this is fixed. Per-Worker VM leak in production.
- **Plan:** fix A (thread returns normally, port of 1.4.5) and fix B (`signal_stack_size = null` under ASAN) from
  the RCA. Regression test `test/js/node/test/parallel/test-zun-worker-thread-exit.js` (fails on 0a5b26b).

### SPAWN-1 / TQ-10: extra stdio `"pipe"` fds of `child_process.spawn` closed twice (High), open, RCA done

- `child_process.spawn(…, { stdio: [..., 'pipe'] })` with a slot at index ≥ 3: the parent end of the socketpair is
  owned by both the native `Subprocess` (`stdio_pipes[i] = .owned_fd`, closed in `finalizeStreams`,
  `src/runtime/api/bun/subprocess.zig:775`) and the `net.Socket` that `child_process.ts:1219` wraps around it
  (uSockets closes it on socket close). The second close runs from the GC finalizer, often after the number was
  reused, so **zun closes an unrelated fd** (file, socket, TLS connection). Silent in release builds. Debug builds
  panic only when the number was not reused.
- Inherited from Bun 1.3.14 (identical code); fixed in Bun 1.4.5 by a `"socket-fd"` stdio mode that makes JS the
  only owner. RCA and proposed port: `docs/rca/TQ-10-extra-stdio-pipe-double-close.md`.
- **Mitigation now:** avoid extra `"pipe"` stdio slots (index ≥ 3) in `child_process.spawn`/`fork`/`cluster`, or
  keep the `ChildProcess` reachable for the life of the process.
- Regression test `test/js/node/test/parallel/test-zun-spawn-extra-pipe-double-close.js` (fails on 0a5b26b:
  "fd 12 was closed behind our back").

### IPC-1: an IPC peer can leak parent fds via repeated SCM_RIGHTS (Low), open

- `src/jsc/ipc.zig` `onFd` (`:1347-1350`) overwrites an already-stashed `incoming_fd` without closing it ("overwriting"
  is only logged). A peer that sends several fds before the handle message leaks one fd each time, which can lead to
  fd exhaustion. Same as upstream 1.3.14. Found by the TQ-10 sibling search; not reproduced yet.
- **Plan:** close the previous fd (or reject the message) when one is already pending; add a test that sends two fds.

### TLS-CA-1 (review F-1): an explicit `ca` *adds* to the default roots instead of replacing them (High), **fixed 2026-11-27** (fetch/tls/https; HTTP/3 client still open as F-2)

- **What:** `fetch(url, { tls: { ca } })` and `tls.connect({ ca })` trust the given CA **plus** every bundled/system/
  `NODE_EXTRA_CA_CERTS` root. Node documents `ca` as replacing the default trust; Bun 1.4.5 behaves the same as Node.
- **Impact:** a client that pins a private CA for a service still accepts any publicly trusted certificate for that host,
  so a mis-issued or compromised public CA can intercept it. This is what pinning is meant to prevent.
- **Where:** `packages/bun-usockets/src/crypto/openssl.c` `us_ssl_ctx_build_raw` (both CA branches start from
  `us_get_default_ca_store()` and `X509_STORE_add_cert` the explicit CAs), shared by fetch, `node:tls`/`https`, and the
  CONNECT inner context.
- **Found by:** independent review (`docs/security/review-2026-11-26-sol.md` F-1), **confirmed at runtime** 2026-11-26:
  a valid, unrelated private root as `ca`, connecting to `https://example.com`:

  | runtime | `fetch` | `tls.connect` |
  |---|---|---|
  | zun (snapshot `0a5b26b`) | **200** | **connected, `authorized=true`** |
  | Bun 1.4.5 | `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` | `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` |
  | Node 26 | n/a | `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` |

  `test-zun-fetch-tls-options.mjs` missed it because its wrong-CA case uses a server that the default store rejects too,
  and FETCH-1's "bogus ca rejects example.com" probe used malformed PEM (context creation failed), not a valid other root.
- **Fixed and verified (2026-11-27):** both `ca` branches of
  `us_ssl_ctx_build_raw` now fill the context's own empty store (as upstream `cd1ad599`, #31339, first in bun-v1.4.0).
  RCA `docs/rca/TLS-CA-1-explicit-ca-additive.md`; regression test
  `test/js/node/test/parallel/test-zun-tls-ca-replaces-roots.mjs` (fails on the `0a5b26b` snapshot, passes on Bun
  1.4.5 and Node 26; passes on the fixed build).
  HTTP/3 ignores `ca` entirely; that is F-2, separate.

### TLS-ID-1 (review F-3, F-4, F-5): fetch TLS identity policy is applied too late, to the wrong socket or not at all (High), open, confirmed

- Confirmed at runtime on 2026-11-26. Details, repros and output are in `review-2026-11-26-verify-F.md`, and the scripts
  are in `test/js/node/test/fixtures/zun-review-F/`. Bun 1.4.5 is correct unless marked otherwise.
  - **F-3:** a fresh connection with a rejecting `checkServerIdentity` still sends the full request (auth header and
    body) before rejecting. Bun sends 0 bytes. (backports H6(b))
  - **F-4:** a keep-alive socket is reused for a request with `checkServerIdentity` without running the callback. A
    socket whose callback **rejected** is repooled and reused. The `Host` header changes the verified name, but the
    pool key doesn't include it. (backports H2(b))
  - **F-5:** TLS over a unix socket ignores `tls.ca`/`cert`/`key`. Through a proxy, the inner SNI uses the URL host
    while verification uses `serverName`. *Shared with Bun 1.4.5:* the HTTPS proxy hop gets the origin's client cert
    and trusts the origin's `ca`.
- **Until fixed:** don't rely on `checkServerIdentity` to keep secrets away from a server, and don't pin with
  `tls.ca` over `unix:`.
- **Plan:** one RCA per mechanism, then fixes. These need a build.

### H2C-1: fetch's HTTP/2 client writes byte-reversed frame headers (functional), open

- Every `fetch(..., {protocol: "http2"})` fails with `HTTP2ProtocolError`. Frame headers go out as the 9 bytes
  reversed, because `std.mem.byteSwapAllFields` on the `packed struct(u72)` `FrameHeader` swaps the whole backing
  integer in Zig 0.17.1 (`docs/zig/lessons.md`, probe `docs/zig/probes/byteswap-packed/`). The affected code is
  `src/http/h2_client/ClientSession.zig` `writeFrame`, the read path `FrameHeader.from(..., true)`, and
  `src/runtime/api/bun/h2_frame_parser.zig`.
- It isn't a security hole in itself (the peer drops the connection), but it blocks testing F-4's H2 half.
- **Plan:** RCA, then write and read header fields explicitly big-endian, with an h2 interop test against `node:http2`.

### TLS-RESUME-1: `node:tls` never resumes sessions; fixing that must ship with re-verification (parity bug, latent security), open

`tls.connect({ session })` never calls `setSession`, so `isSessionReused` is always false (Node and Bun 1.4.5 resume
against the same server). Suspected cause: `src/js/node/net.ts` applies the session only to upgraded sockets
(unconfirmed). **When fixing:** resumed sessions keep the stored verify result (BoringSSL `reverify_on_resume` is off in
zun and upstream), so a session made before a key was blocked (C2) or under a different `ca` would be accepted. Turn on
re-verification of the cached chain in the same change. Source: `review-2026-11-26-verify-C2.md` (C2-3).

### FETCH-2 (review H1-1): chunked framing without body bytes keeps a fetch alive forever (Medium), **accepted for now** (matches Bun 1.4.5; stricter check deferred as HL-3 in `hardening-later.md`)

- A server can send endless chunk extensions or trailer lines with no body bytes. CPU is linear in the bytes and RSS is
  flat (no spin, no growth), but the request never ends while the peer stays active. Nothing caps extension or trailer
  length. Evidence and the fix sketch (per-line and per-response caps in the decoder) are in
  `review-2026-11-26-verify-H1.md`. **Mitigation now:** pass an `AbortSignal.timeout()` to fetches of untrusted
  origins.

### FETCH-3 (review H1-2): lax trailer terminator; same-read surplus discarded and socket reused (Medium), **accepted for now** (matches Bun 1.4.5; stricter check deferred as HL-2 in `hardening-later.md`)

- `0\r\n\n` and `0\r\n\r\r\n` complete a chunked body (Node rejects them). Bytes after the terminator in the same
  read are dropped and the socket goes back to the keep-alive pool. No desync was reproduced, but this leniency is a
  smuggling primitive behind a strict proxy. Fix sketch: require CRLF in the trailer states, and disable keep-alive when
  `phr_decode_chunked` returns > 0 (`src/http/http.zig:2712`, `:2794`). See `review-2026-11-26-verify-H1.md`. A
  related H2 note: zun also reuses an idle pooled socket that received unsolicited bytes, where Bun 1.4.5 opens a new
  one.

### RT-4: `__crullerHandle` SSR dispatch drops JS exceptions (dormant), open

- `src/rt/jsc_engine.zig` `callHandler` / `src/rt/server_dispatch.zig:59`: a throw in `globalThis.__crullerHandle`
  becomes `error.JSError` → `sendError(-2)`; the exception is neither reported nor cleared from the VM.
  `sourceLoaded` does `get(…) catch return` (same), and if a script defines `__crullerHandle` it busy-polls before the
  event loop runs.
- Dormant: nothing in zun sends `server_request` commands (that host was cruller's QuickJS/V8 SSR path). A script that
  happens to define `globalThis.__crullerHandle` would hang, though.
- **Plan:** delete with `src/rt` during the CLI restore (Phase 4 item 3). Found by the RT-2 sibling search.

## Fixed

### RT-2: CommonJS entry errors were swallowed (exit 0, no output), fixed

- Cause: `JSC::evaluate`'s 3-argument overload clears the exception into a discarded `NakedPtr`
  (`JSCommonJSModule.cpp`, inherited from Bun 1.3.14, fixed upstream by 1.4.5), and cruller's launcher (`1a78c80`) ran
  every entry file as `-e` eval source, which takes that path. Fixed both: the binding (backport of 1.4.5's out-param
  pattern) and the launcher (runs the file like `bun file.js`; real `__filename`, `import.meta.dir`, `process.argv`).
- RCA: `docs/rca/RT-2-cjs-entry-errors-swallowed.md`. Regression test: `scripts/zun-negative-controls.sh`.

### RT-1: `Bun__Node__ZeroFillBuffers` type confusion, fixed

- C++ reads `extern "C" bool Bun__Node__ZeroFillBuffers`; cruller (`05f7094`) defined a function with that name, so
  C++ read a code byte. Now `export var … : bool = false` as upstream (`nm`: `b`). RCA:
  `docs/rca/RT-1-zero-fill-buffers-type-confusion.md`. `--zero-fill-buffers` itself comes back with the CLI restore.

## FETCH-1 (fixed 2026-11-26, was High): fetch dropped per-request TLS options

`fetch(url, { tls: { ca } })` trusts the public roots instead of (only) `ca`; mTLS client certs are likely not sent; TLS
errors surface as `FetchHostFailure fetching ""`. Cause: cruller's rt host bridge (`src/rt/http_wire.zig`) has no TLS fields.
Fixed by restoring the direct fetch path (also fixes TQ-1, streaming). RCA: `docs/rca/FETCH-1-fetch-bridge-drops-tls-config.md`.

## TLS-2 (hazard, Low): dead accept-all TLS context

`src/boringssl/boringssl.zig` `initClient()` creates an `SSL_CTX` whose custom verify accepts every certificate
(`noop_custom_verify`). No callers in zun or upstream 1.3.14, so it's never compiled (Zig only analyzes referenced code).
Delete it or make it verify properly before anything calls it.

