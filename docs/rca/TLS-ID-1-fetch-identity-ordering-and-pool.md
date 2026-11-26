# TLS-ID-1: fetch applies its TLS identity policy too late, to the wrong socket, or not at all

- **Status:** **fix prepared (branch `t3/fix-fetch-tls-identity`), not yet built or verified.** The regression test
  fails on the pre-fix snapshot (`build/snap-ffd9f0b`) and passes on Bun 1.4.5.
- **Severity:** high, security-relevant. Credentials and request bodies reach a server that the request's own
  `checkServerIdentity` rejects; a pinning callback can be bypassed through the keep-alive pool; `tls.ca` pinning is
  ignored over `unix:`.
- **Found by / date:** independent review `docs/security/review-2026-11-26-sol.md` F-3, F-4, F-5; confirmed at runtime
  2026-11-26 (`docs/security/review-2026-11-26-verify-F.md`). Backports H6(b) and H2(b).

## Symptom

```sh
BUN_DEBUG_QUIET_LOGS=1 build/snap-ffd9f0b/zun-debug test/js/node/test/parallel/test-zun-fetch-tls-identity.mjs
# AssertionError: F-3: server received 197 application bytes   (exit 1)
```

With every assertion turned into a log line, the snapshot fails all five groups (Bun 1.4.5 passes all of them):

| Case | zun snapshot | Bun 1.4.5 |
|---|---|---|
| F-3: fresh connection, rejecting `checkServerIdentity`, POST with `authorization` + body | promise rejects, but the server got all 197 bytes (header, credential, body) | rejects, server got 0 bytes |
| F-4 seq: A (`tls.ca`) pooled, then B (`ca` + rejecting callback) | B reuses A's socket, callback never runs, B gets 200 and its credential is sent | B gets a fresh connection, callback runs, rejects |
| F-4 conc: A and B together, then B2 (B's options) | B2 reuses the socket whose callback *rejected* B, gets 200 | B2 runs its callback again, rejects |
| F-4 host: URL `127.0.0.1`, cert names only `localhost`, A with `Host: localhost`, then B without it | A verifies as "localhost" (200), B reuses A's socket (200) | both `ERR_TLS_CERT_ALTNAME_INVALID` |
| F-5 unix: `fetch("https://localhost/", {unix, tls:{ca[,cert,key]}})` | `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, no client cert | 200, client cert presented |

## Root cause

Four separate mechanisms, all in code imported unchanged from Bun 1.3.14 by cruller (`a1c009d`, the strip/port
commit; `git log -S` on each snippet below lands there). Bun fixed each of them during 1.4.x.

1. **The JS verdict was asynchronous but nothing waited for it (F-3).** `src/http/http.zig` `checkServerIdentity`
   (HTTP thread, `onHandshake`) has a slow path for requests with a JS callback (`signals.cert_errors`): it copies the
   certificate into `state.certificate_info`, calls `progressUpdate` to hand it to the JS thread, and then
   `return true`. `HTTPContext.zig` `Handler.onHandshake` treats `true` as "verified" and calls `firstCall`, which calls
   `onWritable` and writes the whole request. The JS side
   (`FetchTasklet.onProgressUpdate`) made it worse: it returned early on `metadata == null and isSuccess()` **before**
   looking at `certificate_info`, so the callback only ran once the response headers had arrived, after the request
   had been sent and answered. The CONNECT path (`ProxyTunnel.onHandshake`) has the same shape.
2. **Pool admission ignored how the pooled socket was verified (F-4 seq).** `HTTPContext.existingSocket` matched on
   host, port, interned `SSLConfig` pointer and the `rejectUnauthorized:false`-with-error flag. A socket verified by
   the native host check and a request that wants its own JS callback share the same key, so B took A's socket and
   its callback never ran (a JS callback runs only in `onHandshake`).
3. **A rejected socket could still be repooled (F-4 conc).** Because of (1), the server's response arrived while the
   JS callback was still pending; the HTTP thread finished the response and `releaseSocket`ed the connection.
   `scheduleShutdown` from the rejecting callback then found no abort-tracker entry (the request was done) and did
   nothing, so the pool kept a socket whose identity had just been rejected.
4. **Verification used the `Host` header (F-4 host).** `getTlsHostname` preferred `client.hostname` (the `Host`
   header) over the URL host for both SNI and the certificate check, while the pool key uses the URL host
   (`connected_url.hostname`). A request with `Host: localhost` to `127.0.0.1` was verified as "localhost" and parked
   under "127.0.0.1", where a request without the header inherited it. Bun 1.4.5 `get_tls_hostname` uses only
   `tls.serverName` or the URL host. (`node:https` is unaffected: `_http_client.ts` passes the `host` option as
   `tls.servername`.)
5. **Unix sockets dialled before the TLS context was chosen (F-5).** `HTTPThread.connect` returned
   `this.context(is_ssl).connectSocket(...)` (the shared default context) as its first statement, before the
   `tls_props` → custom-context lookup, so `ca`, `cert` and `key` never applied over `unix:`.

## Why it wasn't caught

- No test looked at the server side. Bun 1.3.14's own tests for `checkServerIdentity` assert only that the promise
  rejects, which it did. F-3 is only visible as bytes on the wire.
- Pool tests never mixed verification modes on one origin (callback vs native vs `rejectUnauthorized:false`), and none
  sent the same request after a rejection.
- `fetch({unix, tls})` had no test with a private CA; the shared context fails closed against a self-signed server,
  which looks like "TLS works, the cert is just untrusted".
- The parity suite runs against Bun's tests, which for 1.3.14 encode the old behaviour; the 1.4.x fixes came with new
  tests that we don't run yet.

## Fix

Ported from Bun 1.4.5 (`src/http/lib.rs`, `HTTPContext.rs`, `HTTPThread.rs`, `ProxyTunnel.rs`,
`runtime/webcore/fetch/FetchTasklet.rs`), re-implemented in Zig:

- **Park until the JS verdict (F-3, and F-4 conc).** New `InternalState.flags.is_waiting_for_cert_check`, set in the
  `checkServerIdentity` slow path. `onWritable` returns early while it is set (after flushing the CONNECT tunnel, so
  the inner handshake's last flight still goes out); `onData` and `ProxyTunnel.onData` fail with `UnexpectedData`.
  `FetchTasklet.onProgressUpdate` now runs the callback on the certificate-only update (before the metadata early
  return). On success it calls the new `HTTPThread.scheduleCertCheckResume`, drained on the HTTP thread through the
  abort tracker into `HTTPClient.resumeAfterCertCheck`, which clears the flag and calls `onWritable`. On failure the
  existing `scheduleShutdown` closes the parked socket. Since nothing is written or answered before the verdict, a
  rejected socket can no longer complete a response and be repooled. If the VM is shutting down, a pending
  certificate gets a shutdown instead of waiting for the idle timeout.
- **Record and check how each pooled socket was verified (F-4 seq).** New `HTTPClient.PeerVerification`
  (`none` / `callback` / `native`, `admits(pooled) = self == .none or self == pooled`).
  `PooledSocket.verification` is recorded by `releaseSocket` as `max(reused, socketVerification())`;
  `existingSocket` skips sockets the request doesn't admit, and tunnels carry their own `verification` for the
  origin. A callback request therefore never takes a natively verified socket, and vice versa. Like Node's `https.Agent`
  and Bun 1.4.5, a callback verdict is per connection: two callback requests with the same `SSLConfig` may share one.
- **Verify the URL host or `tls.serverName`, never `Host` (F-4 host).** `getTlsHostname` drops `client.hostname`.
  `ProxyTunnel.onOpen` now takes SNI from `getTlsHostname` too, so the tunnelled SNI equals the verified name (this also
  fixes the F-5 "inner SNI vs `serverName`" item).
- **Proxy certificates take the native check.** The callback applies only to the target's certificate (Node, Bun
  1.4.5); before, an HTTPS proxy's own certificate was also handed to the user's callback. This makes the outer socket of
  a proxied request `native`, which is what the pool records.
- **h2/h3 never bypass the callback.** `canOfferH2` returns false when a callback is set (the h2 session writes from
  `attach()` without the park gate), and `protocol: "http2"` with a callback fails up front with `HTTP2Unsupported`.
  `ClientSession.matches` and `PendingConnect.matches` also check `admits`, so a strict request can't join an h2
  session opened with `rejectUnauthorized:false`. HTTP/3 (forced or via Alt-Svc) runs neither the callback nor a
  custom context, so those requests stay on TCP, or fail with `HTTP3Unsupported` when `protocol: "http3"` is forced.
- **Unix sockets use the custom context (F-5).** `HTTPThread.connect` selects the custom context first and dials the
  unix path through it.

Not changed: the HTTPS proxy hop still gets the origin's client certificate and trusts the origin's `tls.ca`. Bun
1.4.5 does the same (F-5 proxy, shared), so it stays open in `known-issues.md`.

Files: `src/http/http.zig`, `HTTPContext.zig`, `HTTPThread.zig`, `InternalState.zig`, `ProxyTunnel.zig`,
`h2_client/ClientSession.zig`, `h2_client/PendingConnect.zig`, `src/runtime/webcore/fetch/FetchTasklet.zig`.

## Regression test

`test/js/node/test/parallel/test-zun-fetch-tls-identity.mjs`: in-process `node:tls` servers that count every byte
per connection. F-3 asserts **0 bytes** on a rejected identity (plus an accepting control that proves the log works),
F-4 seq/conc assert rejection, the callback count and that no credential reached the server, F-4 host asserts that
both requests fail, and F-5 unix asserts `tls.ca` and the client certificate over a unix socket. Fails on
`snap-ffd9f0b` (all five groups), passes on Bun 1.4.5. Built on the fixtures in
`test/js/node/test/fixtures/zun-review-F/`.

## Sibling search

Searched for every `checkServerIdentity` / `cert_errors` / `getTlsHostname` / `existingSocket` /
`connectUnixGroup` / `releaseSocket` user (`grep -rn` over `src/`):

- **CONNECT tunnel (`ProxyTunnel.zig`):** same ordering bug. Fixed by the same flag (the tunnel's `onHandshake`
  goes through `onWritable`), plus the `ProxyTunnel.onData` gate and per-tunnel `verification`.
- **HTTP/2 pool joining (`HTTPContext.connect`, `ClientSession.matches`, `PendingConnect.matches`):** keyed on host,
  port and context only. Callback requests no longer use h2; the matchers now also check `admits`. **Not runtime
  tested:** the h2 client is broken by H2C-1, so `f4-h2-*` can't run until that is fixed.
- **HTTP/3 (`h3_client/ClientContext.zig`):** sessions match on host, port and `reject_unauthorized`. No callback and
  no custom context ever applied. Fixed by keeping those requests off h3 (see Fix). That h3 ignores `tls.ca` without a
  callback when Alt-Svc is off is out of scope: h3 is experimental and opt-in.
- **WebSocket client upgrade (`WebSocketUpgradeClient.zig` `handleOpen` / `handleHandshake`, backports H6(c)):**
  `handleOpen` writes the upgrade request (cookies, `Authorization`) on open, before `handleHandshake` runs the host
  check, and a failed check only `fail()`s afterwards. Same class of bug (bytes before verification). **Open**, tracked
  as H6(c); not changed here.
- **`Bun.connect` / `upgradeTLS` (H6(a)/(e)):** handshake-time verification issues of the same family, already tracked
  separately (C2-1). Not changed here.
- **Host-header SNI elsewhere:** `proxyAuthHash` still hashes the `Host` override into the tunnel pool key. It only
  splits the pool further, so it is harmless; left unchanged.
- **Unix dial before context selection:** only `HTTPThread.connect`. The WebSocket client picks its context before
  `connectUnixGroup`.

## Lessons

- For TLS identity bugs, a regression test must assert on what the **server received**, not only on the client's
  promise.
- Any asynchronous verdict (a JS callback) needs an explicit "parked" state that every write and read path checks.
  Returning "ok for now" from a check function is a hazard.
- Pool keys must include everything that decided whether a connection was trusted, not just where it goes.
- Zig: `docs/zig/lessons.md` (2026-11-27), an explicit-tag enum with methods inside a packed struct.
