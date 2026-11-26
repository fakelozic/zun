# FETCH-1: fetch drops per-request TLS options (and TLS error detail) on cruller's rt host bridge

- **Status:** **open**. Root cause known; the fix is to put `fetch` back on upstream's direct HTTP client path
  (same work as triage TQ-1, fetch streaming). Not patched here on purpose (AGENTS.md rule 7).
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

## Fix (planned, not done)
Don't extend the wire format. That would keep a second, partial copy of the HTTP client's request model. Put `fetch` back on
upstream Bun 1.3.14's direct `AsyncHTTP`/`HTTPClient` path (which takes `tls_props` and reports `certificate_info` /
error codes), and remove the bridge from `fetch` (and from `event_loop.zig`'s polling) once nothing else uses it.
This is the same change TQ-1 (fetch doesn't stream) needs. Do both in one task with one RCA update.

## Regression tests (to add with the fix)
- `fetch` with `tls: { ca: <test root> }` to a server using the `zun-blocked-spki` fixture chain → 200.
- `fetch` with a bogus `tls.ca` to a server whose cert chains to a *different* root → rejects.
- `fetch` to a chain with a blocked key → error code `CERT_REVOKED` (tighten `test-zun-tls-blocked-spki.mjs`).
- mTLS: server with `requestCert` + `ca`, client `fetch` with `tls.cert/key` → 200; without → rejected.

## Sibling search
- Other request options that live on the tasklet but not in `http_wire.Request`: audit when fixing (e.g. `verbose`,
  `check_server_identity`, `upgraded_connection`, `force_http*` are flags; `ssl_config` is not). Anything not serialized is
  silently ignored the same way.
- Accept-all TLS context: `src/boringssl/boringssl.zig` `initClient()` builds an `SSL_CTX` with `noop_custom_verify`
  (accepts every certificate). It has **no callers** in zun or upstream 1.3.14 (dead, never compiled). Listed as a
  hazard in `docs/security/known-issues.md`; delete or harden it when touching that file.
