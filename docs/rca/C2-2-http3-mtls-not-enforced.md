# C2-2: the HTTP/3 server runs the handler for clients whose certificate failed verification

- **Status:** fix prepared on branch `fix/c2-2`, **not yet built or verified** (the regression test fails on
  `build/snap-ffd9f0b` and passes on Bun 1.4.5; the fix itself needs a build).
- **Severity:** high, security-relevant. Client-certificate authentication (mTLS) on `Bun.serve({ http3: true })`
  doesn't work: any client certificate is accepted, including untrusted, self-signed and blocked-key ones.
- **Found by / date:** review `docs/security/review-2026-11-26-sol.md` (C2), confirmed at runtime in
  `docs/security/review-2026-11-26-verify-C2.md` (C2-2), 2026-11-26. Backports row H3.

## Symptom

A strict-mTLS server: `Bun.serve({ http3: true, tls: { cert, key, ca: clientCA, requestCert: true,
rejectUnauthorized: true } })`. Client: system curl 8.21.0 (ngtcp2/nghttp3).

```sh
sh test/js/node/test/fixtures/zun-review-C2/c2-2-run.sh build/snap-ffd9f0b/zun-debug
client tcp-untrusted: curl: (52) Empty reply from server 000 0
client h3-untrusted: 200 3          # handler ran
client h3-blocked: 200 3            # trusted chain, blocked key (ZUN_DEBUG_BLOCKED_SPKI_SHA256)
server DISPATCHED h3-untrusted
server DISPATCHED h3-blocked
```

TCP on the same port rejects both clients. A client with no certificate is rejected on both transports, because
`SSL_VERIFY_FAIL_IF_NO_PEER_CERT` makes BoringSSL abort that handshake. Bun 1.4.5 rejects the untrusted client over
HTTP/3 too.

## Root cause

Verification of a client certificate has two halves in uSockets. `us_ssl_ctx_build_raw` (`openssl.c`) installs
`us_verify_callback`, which **always returns 1**. So BoringSSL finishes the handshake even when the chain fails
(an untrusted root, or `CERT_REVOKED` from the C2 blocklist) and only records the verdict on the `SSL`
(`SSL_get_verify_result`). The second half is the caller's job: read the verdict and close. This matches Node, where
the socket layer decides with `rejectUnauthorized`.

- The TCP server does that in `packages/bun-uws/src/HttpContext.h` `onHandshake`: when
  `flags.rejectUnauthorized` (set only for `requestCert && rejectUnauthorized`) is on and `verify_error.error != 0`,
  it closes the socket before any request is parsed.
- The QUIC server builds its `SSL_CTX` with the same `us_ssl_ctx_build_raw`, but `us_quic_on_new_conn` and
  `us_quic_on_new_stream` (`packages/bun-usockets/src/quic.c`) **never read the verdict**. The connection opens,
  streams open, and `Http3Context` dispatches the request.

The code came unchanged from Bun 1.3.14 (`quic.c` `us_quic_on_new_conn`, imported by cruller in `a1c009d`). Bun added
the missing half later: 1.4.5's `us_quic_server_peer_verified` (`packages/bun-usockets/src/quic.c:624-631`) is called
from `on_new_conn` and closes the connection. It reads the `SSL` through `lsquic_conn_get_ssl`, an accessor from Bun's
lsquic patch `patches/lsquic/node-quic-accessors.patch`. zun's pinned lsquic (`3181911…`) has neither.

## Why it wasn't caught

No test used a client certificate over HTTP/3. zun's own HTTP/3 client can't present one
(`us_create_quic_client_context` builds a bare `SSL_CTX`), so mTLS over QUIC can only be tested with an outside
client. The C2 blocklist work tested every *client* verify path but assumed that the server's verdict was enforced the
same way on every transport.

## Fix

Port Bun 1.4.5's check, adapted to zun's SNI table:

1. `patches/lsquic/conn-get-ssl.patch` (registered in `scripts/build/deps/lsquic.ts`) adds `lsquic_conn_get_ssl` and
   `lsquic_enc_sess_ietf_get_ssl`, the accessor subset of Bun's `node-quic-accessors.patch`, written against zun's
   lsquic pin.
2. `quic.c` records `request_cert && reject_unauthorized` on the server context and on each `add_server_name` entry.
   That is the same condition the TCP path uses (`HttpContext::create`), and the same one 1.4.5 checks through
   `us_ssl_ctx_reject_unauthorized`.
3. `us_quic_server_peer_verified` enforces the check when the default context or the SNI-selected context
   (`SSL_get_SSL_CTX`) demands it. It returns OK only when `us_ssl_socket_verify_error_from_ssl` reports no error,
   and it rejects when the `SSL` is missing. `us_quic_on_new_conn` calls `lsquic_conn_close` and returns `NULL` for
   a server connection that fails, as 1.4.5 does.

Why this removes the cause rather than the symptom: the verdict is now read at the one point every server connection
passes through before any application data. I checked this in the vendored lsquic:

- `lsquic_ietf_full_conn_server_new` calls `on_new_conn` right after `handshake_ok`, *before* it replays the mini
  connection's buffered application packets.
- A connection marked `IFC_CLOSING` ignores `STREAM` frames (`lsquic_full_conn_ietf.c` "Connection closing: ignore
  frame").
- The `SSL` object is still alive at that point. `drop_SSL` runs only after the handshake is *confirmed*, and on a
  server that means the first 1-RTT ACK has been processed, which happens after `on_new_conn`.

So `on_stream_open` and the request handler never run for a rejected client. The check doesn't depend on the blocklist.
It enforces whatever verdict BoringSSL recorded, so untrusted chains, blocked keys and expired certificates are all
covered.

Not ported: 1.4.5's broader SNI policy (`us_ssl_ctx_set_sni_policy`, which gives each `serverName` its own session-id
context and its own `requestCert`). See the sibling search.

## Regression test

`test/js/node/test/parallel/test-zun-http3-mtls.mjs`. The server is `fixtures/zun-review-C2/c2-2-server.mjs`. curl
probes it over TCP and over HTTP/3 with a valid certificate, with no certificate and with an untrusted one. On debug
zun builds it also probes with a blocked key. Only the valid clients may reach the handler. The test is skipped when
curl lacks HTTP/3.

- Snapshot `build/snap-ffd9f0b`: **fails** (`h3-untrusted got a response`).
- Bun 1.4.5: **passes**.
- Fixed build: pending (not built).

## Sibling search

How I searched: every server-side consumer of `us_ssl_ctx_build_raw` / `us_verify_callback`
(`grep -n us_verify_callback packages/bun-usockets/src/crypto/openssl.c`, the callers of
`us_create_quic_socket_context`), every place that reads `SSL_get_verify_result`, and a diff of 1.4.5's
`quic.c`/`openssl.c` against zun's.

- **`Bun.serve` over TCP:** enforced (`HttpContext.h` `onHandshake`). OK.
- **`node:tls` / `https` servers:** enforced in JS (`rejectUnauthorized` in `tls.ts`), like Node. Not changed here.
- **`Bun.connect` / `Bun.listen`:** `socket.zig` `onHandshake` sets `authorized` from handshake success alone and never
  closes on a failed verify. That is backports H6(a)/(e), handled separately on branch `fix/h6a`.
- **`node:quic`:** zun doesn't ship it (no `src/js/node/quic*`). Nothing to fix.
- **Per-`serverName` client-certificate policy and session partitioning (open, not fixed here):** 1.4.5's
  `us_ssl_ctx_set_sni_policy` gives each SNI context its own session-id context, so a session from one `serverName`
  can't be resumed under another, which would skip client authentication against the second one's CA. It also
  applies that entry's own `requestCert`/`rejectUnauthorized` on the SNI switch. zun sets no session-id context
  anywhere (`grep -rn session_id_context` finds nothing outside the BoringSSL bindings), on TCP or QUIC. Listed as
  an open item in `docs/security/known-issues.md` (C2-2-SIB-a).
- **`us_internal_verify_peer_certificate`** (`openssl.c`) treats "TLS 1.3, session reused, no peer certificate" as
  `X509_V_OK`. Bun 1.4.5 removed that branch (it keeps only the PSK case). With `requestCert` +
  `rejectUnauthorized`, a no-certificate full handshake fails in BoringSSL first, so a client can't get such a
  session from a strict context. Combined with the missing session partitioning above, though, a session from a
  context that doesn't require a certificate could pass. Listed with C2-2-SIB-a.

## Lessons

- uSockets' verify callback deliberately defers the verdict. **Every new transport or listener that builds an
  `SSL_CTX` with `us_ssl_ctx_build_raw` must read `SSL_get_verify_result` before dispatching.** I added this to
  `docs/security/root-certs.md` "Where the check runs".
- When C2 claimed coverage on "every path", it needed a test per transport. The HTTP/3 server is now in the
  test.
