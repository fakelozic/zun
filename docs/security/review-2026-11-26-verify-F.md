# Runtime check of review findings F-3, F-4, F-5 (2026-11-26)

The review (`review-2026-11-26-sol.md`) was done from source reading. This note checks F-3, F-4 and F-5 at runtime.
No source code was changed.

- **zun:** snapshot `build/snap-0a5b26b/zun-debug` (debug + ASAN build of `0a5b26b`).
- **Reference:** Bun 1.4.5 (`bun`). Node's `fetch` has no `tls` option, so Node is only the server side.
- **Repro:** `test/js/node/test/fixtures/zun-review-F/`. `run.mjs` runs under Node and starts TLS servers in its own
  process. They log, per connection, the SNI, ALPN, client cert and **every byte received**. It then runs
  `client-<case>.mjs` under the runtime being tested and prints one JSON line. `run-all.sh [cases…]` runs every case on
  both runtimes. Certs come from a throwaway CA in the same directory: `server.pem` is **DNS:localhost only, with no IP
  SAN**, plus `proxy.pem` and `client.pem` (clientAuth).
- Raw output from this run is saved in `/tmp/claude-1000/zun-scratch/review-F/{f3,f4,f5}.jsonl`. The excerpts below are
  copied from it.

## Verdicts

| Finding | Verdict | One line |
|---|---|---|
| F-3 fetch sends data before `checkServerIdentity` | **CONFIRMED** | zun sends the full POST (auth header + body) and then rejects. Bun sends 0 bytes. |
| F-4 H1 pooled reuse skips the per-request callback | **CONFIRMED** | B reuses A's socket, its callback never runs, and B's auth header is sent. Bun opens a new connection and rejects. |
| F-4 H1 reuse of a socket whose callback *rejected* | **CONFIRMED (worse than the review says)** | The socket on which B was rejected goes back to the pool. B2 then reuses it with no callback and gets a 200. |
| F-4 Host header vs transport name | **CONFIRMED** | `Host: localhost` makes a 127.0.0.1 connection verify as "localhost". A later request without the header reuses it and succeeds, although on a fresh connection it fails `ERR_TLS_CERT_ALTNAME_INVALID`. |
| F-4 H2 join / pending-connect | **NOT TESTABLE on this build** | zun's HTTP/2 client fails on every request (`HTTP2ProtocolError`) because its frame headers are byte-reversed on the wire (new bug **H2C-1** below). Bun 1.4.5 refuses H2 when `checkServerIdentity` is set (`HTTP2Unsupported`). |
| F-5 TLS over a unix socket ignores `tls` | **CONFIRMED** | zun ignores `tls.ca` (`SELF_SIGNED_CERT_IN_CHAIN`) and sends no client cert. Bun uses both. |
| F-5 HTTPS proxy hop gets the origin's TLS config | **SHARED** | Both zun and Bun 1.4.5 present the origin's client cert to the proxy, and trust the proxy through the origin's `tls.ca`. |
| F-5 inner SNI vs `serverName` through a proxy | **CONFIRMED (functional, low security impact)** | Through a proxy, zun sends the URL host as SNI (127.0.0.1, so no SNI) but verifies against `serverName`. Bun sends `serverName`. Verification itself stays strict. |

## F-3: data is sent before the identity callback rejects

`node run.mjs <rt> f3`: a fresh connection, a POST with `authorization: Bearer F3-SECRET` and body `F3-BODY`, and
`tls.checkServerIdentity` returning an Error. The `f3-nocheck` control has a callback that accepts.

```
zun  f3: client {"ok":false,"message":"F3 identity rejected"}, callbackCalls ["localhost"]
         server bytes 197, requests [{"line":"POST /secret-path HTTP/1.1","auth":"Bearer F3-SECRET","body":"F3-BODY"}]
bun  f3: client {"ok":false,"message":"F3 identity rejected"}, callbackCalls ["localhost"]
         server bytes 0, requests []
```

The client sees the same result on both runtimes. Only zun leaks the credential and the body to a server its own
policy rejected. This matches backport row **H6(b)**. A regression test must assert on the server's byte count, not
only on the promise.

## F-4: pooled reuse ignores the per-request identity policy (H1)

`f4-h1-seq`: A (`tls:{ca}`) completes. Then B (same `ca`, plus a rejecting `checkServerIdentity` and
`authorization: Bearer F4-B`) is sent.

```
zun  A 200 "conn1"; B 200 "conn1"; callbackCalls []        server conn1 got A and B (auth "Bearer F4-B")
bun  A 200 "conn1"; B rejected "F4 B rejected"; callbackCalls ["localhost"]   conn2 opened for B, 0 bytes
```

`f4-h1-conc`: A and B run concurrently, then B2 (B's options) runs after both finish.

```
zun  A 200 conn2; B rejected (callback ran on fresh conn1, but conn1 still received B's request = F-3);
     B2 200 "conn1"  ← reused the socket whose callback had just rejected; callbackCalls only ["localhost"] (once)
bun  A 200 conn2; B rejected; B2 rejected; callbackCalls ["localhost","localhost"]; conn1/conn3 got 0 bytes
```

So zun doesn't only skip the callback on reuse. After the callback rejects, it puts the socket back in the
keep-alive pool as if the connection had been verified. Bun 1.4.5 runs the callback on a fresh connection for every
request that carries one.

`f4-h1-host`: the URL is `https://127.0.0.1:<port>/` and the cert names only `localhost`.

```
zun  C (fresh, no Host)            ERR_TLS_CERT_ALTNAME_INVALID
     A (Host: localhost)           200 conn2   (verified as "localhost", SNI localhost)
     B (no Host, same URL)         200 conn2   ← reused; on a fresh connection this exact request fails (see C)
bun  C, A, B                       all ERR_TLS_CERT_ALTNAME_INVALID
```

There are two separate problems here:

1. zun verifies against the `Host` header. `getTlsHostname`, `src/http/http.zig:59-77`, gives priority to
   `client.hostname`. Bun 1.4.5 verifies against the URL host.
2. The pool key ignores the effective verification name, so B inherits A's verdict.

Both pieces of code came from the cruller/1.3.14 base (`git log -S "fn getTlsHostname"` → `a1c009d`). For the first
one, whether to follow Bun 1.4.5 (never verify against `Host`) is a decision for the fix, and the RCA should record it.

### H2 (join / PendingConnect): not testable here

`f4-h2-seq` / `f4-h2-conc` force `protocol: "http2"` against Node's `http2.createSecureServer`:

```
zun  A HTTP2ProtocolError (Node: session ERR_HTTP2_ERROR "Protocol error" before any stream)
bun  A 200; B HTTP2Unsupported, callbackCalls []  (1.4.5 refuses h2 when checkServerIdentity is set)
```

Because zun's H2 client fails every request, the join path can't be exercised. Fixing H2C-1 is required before F-4's H2
half can be confirmed or refuted. When that happens, rerun `./run-all.sh f4-h2-seq f4-h2-conc`. The review's source
reading still stands: `ClientSession.zig:137-151` and `PendingConnect.zig:7-14` match only on host, port and context. Bun
1.4.5's `HTTP2Unsupported` behaviour is one possible fix.

### H2C-1 (new, found while testing F-4): every HTTP/2 frame header is byte-reversed

The raw bytes zun sends after the preface, captured by a TLS server with ALPN `h2`:

```
00 00 00 00 00 04 00 00 12 | 00 02 00 00 00 00 ...   (zun)
00 00 12 04 00 00 00 00 00 | 00 02 00 00 00 00 ...   (correct SETTINGS header: len 0x12, type 4, flags 0, stream 0)
```

The 9 bytes are the right header in reverse order. `src/http/h2_client/ClientSession.zig:215-223` (`writeFrame`)
fills `wire.FrameHeader`, which is a `packed struct(u72)` (`src/http/H2FrameParser.zig:121`), and calls
`std.mem.byteSwapAllFields` on it. In Zig 0.17.1 that function is an alias of `std.mem.byteSwap`. For a struct with a
backing integer, `byteSwap` reverses the **whole `u72`**, not each field (`lib/std/mem.zig`, `byteSwapAligned`).
`docs/zig/probes/byteswap-packed/byteswap.zig` verifies this and passes. The read side (`FrameHeader.from(..., true)`)
and `src/runtime/api/bun/h2_frame_parser.zig` (`node:http2`) use the same pattern, so they need the same check.

This is a functional bug, not a security one: the peer drops the connection. It is logged in `known-issues.md` and
needs its own RCA and fix. It is out of scope here because this task makes no source changes.

## F-5: special TCP paths

`f5-unix`: a TLS server on a unix socket with `requestCert`, and `fetch("https://localhost/…", {unix, tls})`.

```
zun  tls:{ca}               SELF_SIGNED_CERT_IN_CHAIN   server: 0 bytes
     tls:{ca,cert,key}      SELF_SIGNED_CERT_IN_CHAIN   server: clientCert null
bun  tls:{ca}               200
     tls:{ca,cert,key}      200, server clientCert "zun review-F client"
```

This is **CONFIRMED**. zun drops the whole `tls` object on the unix path and verifies with the default store. Here that
fails closed. With a publicly trusted cert on the socket it would accept a peer the `ca` pin should reject. Mutual TLS
over a unix socket can't work at all.

`f5-proxy` (proxy hop trusted via `NODE_EXTRA_CA_CERTS`) and `f5-proxy-ca-only` (trusted only through the origin's
`tls.ca`). The proxy requests a client cert:

```
zun  200; proxy hop: clientCert "zun review-F client"; origin: clientCert "zun review-F client"
bun  200; proxy hop: clientCert "zun review-F client"; origin: clientCert "zun review-F client"
(f5-proxy-ca-only: identical on both, so the origin's tls.ca also authenticates the proxy hop)
```

This is **SHARED** with Bun 1.4.5. Both runtimes hand the origin's client identity to any HTTPS proxy that asks, and
trust the proxy through the origin's CA pin. It is still worth fixing. Bun 1.4.5 isn't the bar for this one, so keep
it as an open item with "upstream shares it".

`f5-proxy-sni` (URL `https://127.0.0.1`, `tls.serverName: "localhost"`, through the proxy) against the
`f5-sni-direct` control:

```
zun  direct: SNI "localhost", 200        via proxy: inner SNI none (URL host is an IP), 200
bun  direct: SNI "localhost", 200        via proxy: inner SNI "localhost", 200
```

This is **CONFIRMED**. `ProxyTunnel` sets SNI from the URL host, while verification uses `serverName`, so the name sent
and the name checked differ. The check stays strict (it is against `serverName`), so the effect is a wrong certificate
choice on SNI-routed origins, which fails closed, not a bypass.

## What a fix and its regression tests need (summary)

- F-3 / H6(b): hold every application write until the JS identity callback has accepted. Assert `server bytes == 0`.
- F-4 / H2(b): never take a pooled or joined connection for a request that has a `checkServerIdentity`, or else
  run it again. Never repool a socket whose callback rejected. Key reuse on the effective verification name. Decide on
  Host-header verification (Bun 1.4.5 ignores it).
- F-4 H2: fix H2C-1 first, then rerun `f4-h2-*`.
- F-5: pick the custom context before unix dialing. Give the proxy hop its own TLS config. Share the SNI/verify-name
  calculation between direct and tunnelled TLS.
