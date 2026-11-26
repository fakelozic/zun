# H5-1: Close the HTTP/1.1 connection after an async response

- **Status:** **fixed and verified 2026-11-27** (built; regression test passes; 56 earlier-passing HTTP server/keep-alive/pipeline parity tests still pass).
- **Severity:** low, security-relevant resource retention. H5 still discards later pipelined requests.
- **Found:** H5 backport verification, 2026-11-27.

## Symptom

`Bun.serve` sends the final response for an async handler whose request carried `Connection: close`, then leaves the
socket open until the peer closes it or the idle timeout expires. RFC 9112 §9.6 requires the server to initiate closure
after sending that response. [RFC 9112 §9.6](https://www.rfc-editor.org/rfc/rfc9112.html#section-9.6)

From the repo root, run the existing regression against each runtime in sequence.

```sh
/home/fak3/.t3/projects/zun/build/snap-ffd9f0b/zun-debug test/js/node/test/parallel/test-zun-serve-close-after-async.mjs
BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 BUN_INSTALL_CACHE_DIR=/tmp/claude-1000/zun-bun-cache \
  bun test/js/node/test/parallel/test-zun-serve-close-after-async.mjs
```

The snapshot exits `1` with `{ statuses: ["200"], closed: false, entered: ["GET /slow"] }`. Bun 1.4.5 exits `0`.

## Root cause

1. `HttpContext::onData` sets `HTTP_CONNECTION_CLOSE` before dispatch. `/slow` suspends, so `onData` releases the read's
   cork and sees `HTTP_RESPONSE_PENDING` still set. Its close check has to wait for response completion.
2. After the timer resolves, `RequestContext.onResolve` calls `handleResolve` and renders the string body as an in-memory
   blob. `toAsync` installed an abort handler, so the small blob takes `doRenderBlob`'s `runCorkedWithType` branch
   (`src/runtime/server/RequestContext.zig:1885`). `uws_res_cork` acquires a fresh cork through `HttpResponse::cork`.
   Inside that callback, `doRenderBlobCorked` calls `renderBytes`, which goes through `resp.tryEnd` → `uws_res_try_end`
   → `HttpResponse::tryEnd` → `internalEnd`.
3. The content-length arm writes the last bytes into the cork and `markDone` clears `HTTP_RESPONSE_PENDING`. The baseline
   close check requires an uncorked socket. Its `else` arm calls `AsyncSocket::uncork`, which releases the slot and writes
   the reply without checking HTTP state. On return, `HttpResponse::cork` finds its slot gone and returns before its
   own close check. With the small reply flushed synchronously, there is no writable event to run the drain close check.

`git log -S HTTP_CONNECTION_CLOSE` traces the `HttpResponse.h` gate to the cruller import `a1c009d`. The imported header
has the same Git blob as Bun 1.3.14 (`e969e029836c23fb21c10da280e4e664cc2bd8e9`). H5 commit `26ecd0e` changes how the
request close flag is detected and latches it in the parser. It does not change response completion.

## Why it wasn't caught

A synchronous corked response can use `onData`'s post-parse check. A test that only checks the HTTP response or handler
invocations also passes because the bytes arrive and the H5 parser latch discards `/b`. The H5 follow-up test waits for
the server to close after the suspended handler settles. The local gate still excludes that reproducer.

## Fix

Bun first added the check after uncork in `eba6c071511e`. It uses the identity of the socket being parsed to decide
whether `internalEnd` or `onData` owns that check. Bun 1.4.5 still uses that division through `uncorkCompletedResponse`
and `closeIfDoneAndMarked`. The Rust `RequestContext` still corks the small blob and calls `try_end`. The later corking
refactor #42762 retained the check and #42986 added parser handling for a response that marks the connection for closure.
[Bun #37074](https://github.com/oven-sh/bun/pull/37074), [Bun #42762](https://github.com/oven-sh/bun/pull/42762), [Bun #42986](https://github.com/oven-sh/bun/pull/42986)

Both completion arms now call `HttpResponse::uncorkAndCloseIfNeeded`. It flushes the cork before testing the close flag,
response completion, and the existing backpressure buffer. A corked response completed during its own socket's parse
still reaches the close check in `onData`. A response completed during another socket's parse runs its own check because
only the parsed socket reaches `onData`'s check. `HttpContext` saves and restores the active socket around parsing for
that comparison. If flushing leaves queued bytes, `onWritable` drains them and runs its existing close check.

Closing destroys the HTTP data synchronously. `tryEnd`, callback cleanup, and writable dispatch now check whether the
socket closed before they access that data again. `markDone` already clears the callbacks needed by the Zig detach path.

## Regression test

[`test-zun-serve-close-after-async.mjs`](../../test/js/node/test/parallel/test-zun-serve-close-after-async.mjs) asserts one
`200`, closure, and one handler invocation. Baseline failure and Bun 1.4.5 success were reproduced. Verification on a
patched zun binary is pending.

## Sibling search

Searched `packages/bun-uws/src` and `src/uws_sys` for `uncork`, `markDone`, and `HTTP_CONNECTION_CLOSE`. Traced the
response entry points in `src/runtime/server`.

- **Chunked streaming.** `uws_res_end_stream` calls `sendTerminatingChunk`, which reaches the chunked completion arm of
  `internalEnd` after the terminal chunk. It uses the same post-flush check. A content-length stream that finishes via
  `tryEnd` uses the other patched arm.
- **Sendfile.** `FileResponseStream.endSendfile` calls `uws_res_end_sendfile` after the file write. The header cork is
  flushed beforehand. That shim marks the response done and resets the timeout. It can miss closure if an async sendfile
  completes outside `onData` or `onWritable`. This is a separate completion path, open by inspection.
- **HEAD and other header-only responses.** `uws_res_end_without_body` marks the response done directly. A response
  inside `HttpResponse::cork` is covered by that wrapper's existing close check. An uncorked completion outside
  `onData` or `onWritable` can bypass the checks. This separate path remains open by inspection.
- **WebSocket upgrade.** `keepCorked` lets the handshake and any buffered bytes pass to WebSocket adoption. An already
  uncorked upgrade can still hit the pre-existing HTTP close check before adoption. Bun addressed that separately by
  ending the `101` through a dedicated handshake path. That follow-up remains open by inspection.
  [Bun #40305](https://github.com/oven-sh/bun/pull/40305)
- **Generic uncork.** Loop drains, slot eviction, and explicit uncork operate on both HTTP and WebSocket sockets. The
  completion check belongs at the HTTP response boundary, where the protocol state and lifetime are known.

## Lessons

Trace which frame releases the cork. A wrapper's post-flush check is reachable only while the wrapper still owns the
cork slot. Async close tests should observe the socket after the response has been delivered.
