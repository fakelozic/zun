# FETCH-1: fetch drops per-request TLS options (and TLS error detail) on cruller's rt host bridge

- **Status:** **fixed** in the `security: FETCH-1` commit (same commit fixes triage **TQ-1**, fetch didn't stream).
- **Severity:** **High, security-relevant**
- **Found by / date:** integration owner while testing C2, 2026-11-26

## Symptom
1. `fetch(url, { tls: { ca } })` **ignores `ca`**. With a bogus `ca`, zun still connects to `https://example.com` and
   returns 200, trusting the public roots. Bun 1.4.5 refuses (`FailedToOpenSocket`). With a private CA that is not in the
   default store, zun fails with a meaningless `FetchHostFailure fetching ""`.
2. A TLS verification failure surfaces as `FetchHostFailure` with an **empty URL**, instead of the real code
   (e.g. `CERT_REVOKED`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`).

Reproduction (`build/debug/zun-debug`, also the pre-C2 `build/debug017/bun-debug`):
```js
await fetch("https://example.com/", { tls: { ca: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" } }); // 200, should reject
```
`tls: { rejectUnauthorized: false }` **is** honoured, and `node:tls` honours `ca` correctly.

## Root cause
Cruller commit `1a78c80` ("proxy interface + quckjs integration (mvp)") routed every `fetch` through the engine/host
command channel (`src/rt`). `FetchTasklet.get` serializes the request with `bun.rt.http_wire.encodeRequest`
(`src/runtime/webcore/fetch/FetchTasklet.zig`, around the `wire_flags` / `encodeRequest` block). `http_wire.Request`
(`src/rt/http_wire.zig:67-77`) carries method, redirect, flags (including `reject_unauthorized`), URL, proxy, hostname,
unix socket, headers and body, **and no TLS configuration**. The `ssl_config` that `fetch.zig` builds from `tls`
(`ca`, `cert`, `key`, `passphrase`, `serverName`, …, interned in `SSLConfig.GlobalRegistry`) is stored on the tasklet but
never crosses the bridge, so the host side always uses the default client context (bundled roots + `NODE_EXTRA_CA_CERTS`).
The response path (`http_wire.Response`) likewise has no field for the TLS error, so the host's failure is reduced to a
generic `FetchHostFailure`.

## Impact
- **Security:** code that pins a private CA (`tls.ca`) for a service expects only that CA to be trusted. zun trusts every
  public root for that request, so anyone who can obtain or mis-issue a publicly trusted certificate for the host can
  intercept it. `checkServerIdentity` and other per-request TLS settings are also likely bypassed (verify when fixing).
- **Functionality:** private-CA and mTLS (`tls.cert`/`tls.key`) requests fail or go out without the client certificate.
- **Operability:** TLS failures are undiagnosable (`FetchHostFailure fetching ""`).

## Why it wasn't caught
No test used `fetch` with per-request TLS options; cruller's smoke test uses plain HTTP. The bridge was an MVP for
the multi-engine experiment, and its wire format only carried what the SSR workload used.

## Fix
Not by extending the wire format (that would keep a second, partial copy of the HTTP client's request model), but by
**removing the bridge from `fetch`**. `src/runtime/webcore/fetch/FetchTasklet.zig` is restored to its pre-bridge form
(cruller `a1c009d`, which is upstream 1.3.14 already ported to Zig 0.16), then run through `scripts/fix_zig017.ts` plus
the one manual 0.17 change (`ArrayList` literals need `.pointer_stability`, 6 sites). `FetchTasklet` again drives
`AsyncHTTP` on the HTTP thread with `tls_props`, streams response bodies as they arrive, applies request-body
backpressure (`onWriteRequestDataDrain` / `resumeRequestDataStream`) and reports real TLS error codes. No other file used
the bridge for HTTP. The bridge itself (`src/rt`, polled from `event_loop.zig`) stays for cruller's `rt` runtime and is
now idle for fetch; removing `src/rt` is a separate cleanup.

Verified against Bun 1.4.5 on the same probes: private `tls.ca` works; a bogus `tls.ca` rejects `https://example.com`
(`FailedToOpenSocket`, as Bun 1.4.5); a blocked key surfaces as `CERT_REVOKED`; a 12.5 MiB streamed request body arrives
intact; `checkServerIdentity` is called and enforced; responses stream before the body completes.

## Regression tests
- `test-zun-fetch-tls-options.mjs`: pinned `tls.ca` → 200; unrelated `tls.ca` → rejected with a real TLS error (not
  `FetchHostFailure`); no CA → rejected; `rejectUnauthorized: false` → 200. Fails on the pre-fix build.
- `test-zun-fetch-streaming.mjs`: the server holds the rest of the body until the client has read the first chunk; a
  buffering fetch deadlocks (guarded). Fails on the pre-fix build, passes on the fix and on Bun 1.4.5.
- `test-zun-tls-blocked-spki.mjs`: now requires `CERT_REVOKED` from fetch too.
- **Still open:** an mTLS test (server `requestCert` + `ca`; fetch with `tls.cert/key` → 200, without → rejected).

## Sibling search
- Other request options that live on the tasklet but not in `http_wire.Request`: audit when fixing (e.g. `verbose`,
  `check_server_identity`, `upgraded_connection`, `force_http*` are flags; `ssl_config` is not). Anything not serialized is
  silently ignored the same way.
- Accept-all TLS context: `src/boringssl/boringssl.zig` `initClient()` builds an `SSL_CTX` with `noop_custom_verify`
  (accepts every certificate). It has **no callers** in zun or upstream 1.3.14 (dead, never compiled). Listed as a
  hazard in `docs/security/known-issues.md`; delete or harden it when touching that file.
