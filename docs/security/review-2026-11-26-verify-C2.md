# Verification of review findings C2-1, C2-2, C2-3 (2026-11-26)

These are checks of the C2 findings in `review-2026-11-26-sol.md` (NSS roots and blocked SPKIs, `413dec6`). I changed no
source code. The runtime results come from the snapshot binary `build/snap-0a5b26b/zun-debug` (debug + ASAN, includes
C2 and the `ZUN_DEBUG_BLOCKED_SPKI_SHA256` test hook). I compared against **Bun 1.4.5** (`bun` on PATH, never writing
`~/.bun`) and **Node v26.13.1**, both at runtime and in their source. Node source is
`nodejs/node@v26.13.1` `src/crypto/crypto_context.cc`, `src/crypto/crypto_tls.cc` and `lib/internal/tls/wrap.js`.
Neither reference runtime can inject a test key, so for real blocked keys I compared them by reading their source.

Repro scripts are in `test/js/node/test/fixtures/zun-review-C2/`. They reuse the chain in `../zun-blocked-spki/`
(leaf ← intermediate ← test root). The `client*.pem` / `untrusted*.pem` files are test-only client certificates I
generated for C2-2 (P-256, 100-year validity, no other use).

| Finding | Verdict | One line |
|---------|---------|----------|
| C2-1 | **SHARED** (zun matches Bun 1.4.5 and Node), plus one **zun-only** sub-point already under H6 | `rejectUnauthorized:false` accepts a blocked chain and reports `CERT_REVOKED`. Upstream treats the blocklist as an overridable verify error too. Separately, zun's `Bun.connect` reports `authorized: true` even when verification failed, and does so even in strict mode. |
| C2-2 | **CONFIRMED** (zun-only; Bun 1.4.5 fixed it) | A strict-mTLS `Bun.serve({ http3: true })` dispatches requests from clients whose certificate is untrusted or blocked. TCP rejects the same clients. |
| C2-3 | **REFUTED on the snapshot** (the bypass doesn't happen), but **latent and SHARED** by design with Bun 1.4.5 and Node | zun's `node:tls` client never resumes a session, so a full handshake runs the blocklist every time. Fixing resumption without adding re-verification would make the review's scenario real. |

## C2-1: blocked key under `rejectUnauthorized:false`

**Repro:** `c2-1-permissive.mjs`. It runs a `Bun.serve` TLS server with the test chain. Then `fetch`, `tls.connect` (with a
counting `checkServerIdentity`) and `Bun.connect` each connect in strict and permissive mode, trusting the test root.
Run it three ways: with nothing extra blocked, with `ZUN_DEBUG_BLOCKED_SPKI_SHA256=<leaf>`, and with it set to the
intermediate. `C2_1_UNTRUSTED=1` trusts `other-root.pem` instead. That gives an ordinary verify error that Bun 1.4.5 can
reproduce on the same code path.

**zun, leaf or intermediate key blocked** (the two give the same result):

| Client | strict | `rejectUnauthorized:false` |
|--------|--------|----------------------------|
| `fetch` | rejected, `CERT_REVOKED` | **connects**, body `ok` |
| `tls.connect` | rejected, `CERT_REVOKED`, `checkServerIdentity` calls = 0 | **connects**, `authorized:false`, `authorizationError:"CERT_REVOKED"`, `checkServerIdentity` calls = **0** |
| `Bun.connect` | **connects**, `handshake(success=true)`, error "certificate revoked", **`authorized:true`** | same |

With nothing blocked, every client connects with `authorized:true`, and `checkServerIdentity` runs once in each
`tls.connect` mode. The control shows the hook is what causes the failure.

**Upstream:**

- **Bun 1.4.5** `packages/bun-usockets/src/crypto/openssl.c:1172–1187` (`us_x509_verify_chain`) matches zun's line for
  line. It records `CERT_REVOKED` on the store ctx and then returns the per-SSL verify callback's verdict.
  `us_verify_callback` (`:1135–1140`) returns 1, as in zun. On the untrusted-root run, Bun 1.4.5 gives the same results
  as zun for `fetch` and `tls.connect`: permissive connects, `authorized:false`, and `checkServerIdentity` isn't called.
- **Node** `crypto_context.cc` `CertVerifyCallback` (~L1509–1580) documents that a blocked key is "reported like any
  other X509_verify_cert error … the per-certificate verify callback, if any, decides whether the handshake
  continues", so that `socket.authorizationError` reports `CERT_REVOKED`. Node's `VerifyCallback` (`crypto_tls.cc:83`)
  always returns 1. `lib/internal/tls/wrap.js:1795–1822` (`onConnectSecure`) runs `checkServerIdentity` only when
  `verifyError` is empty, and destroys the socket only when `rejectUnauthorized !== false`.
- So **both upstreams make the blocklist an overridable `CERT_REVOKED`, not a hard fail**, and both skip the identity
  callback when the chain fails. zun's `fetch` / `node:tls` behaviour is **SHARED**.
- **QUIC client** with `rejectUnauthorized:false`: zun's `quic.c:1085` returns `ssl_verify_ok` before checking the
  chain, and so does Bun 1.4.5's `quic.c:1366`. This is SHARED and I checked it only in source.

**zun-only sub-point (already H6, open):** zun's `Bun.connect` sets `authorized` from handshake success
(`src/runtime/socket/socket.zig:616–626,815–817`). So it reads `true` when there is a recorded error, and stays
connected even with `rejectUnauthorized:true`. On the untrusted-root run, Bun 1.4.5 gives `authorized:false` in both
modes and `handshake(success=false)` in strict mode (inline reject, 1.4.5 `openssl.c:1142–1162`). This is a sub-case of
backports **H6(a)** ("`Bun.connect` / `upgradeTLS` don't close on a failed verify"). The **wrong `authorized` value**
isn't named there and should be added to H6's test.

**Recommendation (owner decides):** Matching upstream is defensible, because `rejectUnauthorized:false` is an explicit
opt-out of all chain checks. But the blocklist exists for keys whose **private keys are public**, and permissive mode is
common in internal and dev code that ends up in production. I'd propose that zun be **stricter than upstream**: a
blocked key should be a hard handshake failure whatever `rejectUnauthorized` says, with an `ERR_TLS_CERT_BLOCKED`-style
error, and documented as a deliberate divergence. The cost is low: nobody can legitimately depend on talking to a peer
that presents one of these eight keys.

Here is how that would work. Install a fatal path ahead of the soft-error callback. BoringSSL makes an error non-fatal
under `SSL_VERIFY_NONE` (`vendor/boringssl/ssl/ssl_x509.cc:260–261`), but zun forces `SSL_VERIFY_PEER` on clients
(`openssl.c:700–701`). So the blocklist branch of `us_x509_verify_chain` can return 0 without calling the user callback,
which aborts the handshake. The QUIC client also needs the check before its `!reject_unauthorized` early return. This
is a policy change, so it needs its own RCA and test, plus an entry in `docs/security/root-certs.md`.

## C2-2: HTTP/3 listener and rejected client certificates

**Runtime-tested.** `Bun.serve({ http3: true })` works on the snapshot. zun's own H3 client can't present a client
certificate (`quic.c` `us_create_quic_client_context` builds a bare `SSL_CTX`), so the client is system `curl` 8.21.0
(ngtcp2 1.22.1 / nghttp3 1.19.0) with `--http3-only`.

**Repro:** `c2-2-run.sh <runtime>`, with server `c2-2-server.mjs`. The server uses
`tls: { requestCert: true, rejectUnauthorized: true, ca: client-ca.pem }` and serves HTTP/1.1 and HTTP/3 on one port.

| Case | zun TCP | **zun H3** | Bun 1.4.5 TCP | Bun 1.4.5 H3 |
|------|---------|-----------|---------------|--------------|
| valid client cert | 200 | 200 | 200 | 200 |
| no client cert | rejected (`certificate required`) | rejected | rejected | rejected |
| untrusted self-signed cert | rejected (empty reply) | **200, handler ran** | rejected | rejected |
| trusted cert with blocked key (`ZUN_DEBUG_BLOCKED_SPKI_SHA256`) | rejected | **200, handler ran** | n/a (no hook) | n/a |

The server log shows `DISPATCHED h3-untrusted` and `DISPATCHED h3-blocked`.

**Cause (source):** zun's QUIC server context comes from `us_ssl_ctx_build_raw` with `us_verify_callback` (always 1),
so the handshake completes after a verify failure. `us_quic_on_new_conn` / `us_quic_on_new_stream` (`quic.c:479–503,
541–553`) never look at `SSL_get_verify_result`. TCP checks before dispatch (`packages/bun-uws/src/HttpContext.h:152–163`).
Bun 1.4.5 added `us_quic_server_peer_verified` (its `quic.c:623–631`) and closes the connection in `on_new_conn` when
`rejectUnauthorized` is set and the verify result isn't OK. It also applies an SNI policy for
`request_cert` / `reject_unauthorized` (`:841`). **CONFIRMED, zun-only.** This is part of open backports **H3**, which
already carries the production rule that `http3: true` must not face untrusted clients. Note that this also bypasses
the blocklist for mTLS on H3, so C2's "client-certificate verification" coverage claim in `root-certs.md` doesn't hold
for QUIC servers.

## C2-3: session resumption and the blocklist

**Repro:** `node c2-3-driver.mjs <runtime>`. The driver runs a **Node** TLS server with fixed `ticketKeys` and the test
chain, pinned to TLS 1.2 and then TLS 1.3, and stays up while separate client processes run `c2-3-client.mjs`. The
client processes are: (1) a fresh connect that saves `getSession()`; (2) a fresh connect with the leaf blocked; (3) a
resume with nothing blocked, as a control; (4) a resume with the leaf blocked, in strict and in permissive mode.

| Step | zun TLS 1.2 / 1.3 | Bun 1.4.5 TLS 1.2 / 1.3 | Node TLS 1.2 / 1.3 |
|------|-------------------|-------------------------|--------------------|
| 1 fresh | OK, session exported | OK | OK |
| 3 resume, not blocked | OK, **`isSessionReused:false`** | OK, `isSessionReused:true` | OK, `isSessionReused:true` |
| 4 resume, leaf blocked, strict | **rejected `CERT_REVOKED`** (full handshake) | (cannot block) | (cannot block) |
| 4 resume, leaf blocked, permissive | connects, `authorized:false`, `CERT_REVOKED`, `isSessionReused:false` | | |

**zun never resumes a `node:tls` session**, even in-process against a zun or Node server that does issue a ticket
(`getTLSTicket()` returns a ticket). A probe that wraps `TLSSocket.prototype.setSession` shows it's never called on a
plain `tls.connect({ session })`. The likely cause: `SocketHandlers2.open` (`src/js/node/net.ts:487–506`) applies
`options.session` only inside `if (self[kupgraded])`, and `SocketHandlers.open:213–219` isn't the handler this path uses.
I haven't root-caused this further. It's a parity bug, not a security one, and needs its own RCA. zun's `fetch` has no
client session cache (no `SSL_set_session` caller in `src/http`), so `fetch` isn't exposed either. So **the bypass
doesn't occur on the snapshot: REFUTED as a live issue.**

**The mechanism is real and shared upstream.** If zun resumed, nothing would re-check the chain. The pinned BoringSSL
skips certificate processing on resumption unless `reverify_on_resume` is set (`ssl/handshake_client.cc:819–825`,
`ssl/tls13_client.cc:749–755`). zun never sets it: `SSL_CTX_set_reverify_on_resume` exists only as a binding in
`src/boringssl_sys/boringssl.zig:5733`. And `verify_result` is restored from the session (`ssl/ssl_asn1.cc:195–198,570`).
Bun 1.4.5's `setSession` (`src/runtime/socket/tls_socket_functions.rs:1110–1145`) also doesn't enable re-verification.
It resumes (row 3 above), so a pre-block session would resume with its stored OK result. Bun 1.4.5 knows the general
hazard: its fetch session cache arms only after `checkServerIdentity` "so an unverified handshake never inserts"
(`src/http/session_cache.rs:1–9`). But it doesn't address policy changes between sessions. Node uses OpenSSL, where
resumption restores the session's verify result. `CertVerifyCallback` runs only on full handshakes, and
`onConnectSecure` skips `checkServerIdentity` for reused sessions (`wrap.js:1799`). So upstream behaviour is
**SHARED**.

**Real-world exposure** is narrow in any runtime. To resume, the peer must hold the session secret, so only an attacker
who already terminated the original session (MITM with a then-trusted blocked-key chain, before the blocklist existed)
benefits.

**Recommendation:** when someone fixes zun's `tls.connect({ session })` (parity), they must ship it **together with**
re-verification on resume: `SSL_CTX_set_reverify_on_resume(ctx, 1)` on client contexts, so the cert verify callback
and blocklist run against the session's stored chain. Or else they must refuse sessions whose stored chain hits the
current blocklist. Otherwise C2-3 becomes CONFIRMED. Add resumed-session cases (TLS 1.2 and 1.3) to the C2 test.

## Follow-ups for the owner

1. C2-2 → add to backports H3. Port Bun 1.4.5's `us_quic_server_peer_verified` and the SNI policy, then turn
   `c2-2-run.sh` into a gated test. That needs a curl with HTTP/3, so skip the test where curl lacks it.
2. C2-1 → decide on the policy (hard-fail the blocklist even when permissive, or stay with upstream). Add the wrong
   `authorized` value on `Bun.connect` to H6's test list.
3. C2-3 → log the `tls.connect({ session })` no-resume bug (parity), and tie its fix to `reverify_on_resume`.
4. Update `root-certs.md` "Where the check runs": the QUIC server doesn't enforce client-cert results (C2-2), and
   permissive clients don't enforce the blocklist (C2-1).
