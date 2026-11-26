# TLS-CA-1: an explicit `ca` is added to the default roots instead of replacing them

- **Status:** **fixed and verified** 2026-11-27 (built on `integ/night-1`; gate 13/13 and the regression test pass). The
  regression test fails on the pre-fix snapshot and passes on Bun 1.4.5 and Node 26.
- **Severity:** high, security-relevant (CA pinning does not pin; mTLS `ca` does not restrict client certificates).
- **Found by / date:** independent review `docs/security/review-2026-11-26-sol.md` F-1; confirmed at runtime 2026-11-26.

## Symptom

A valid but unrelated private root given as `ca` still lets a publicly trusted peer verify:

```sh
BUN_DEBUG_QUIET_LOGS=1 build/snap-0a5b26b/zun-debug test/js/node/test/parallel/test-zun-tls-ca-replaces-roots.mjs
# AssertionError: tls.connect trusted default roots despite ca: {"ok":true,"authorized":true}   (exit 1)
```

With the assertions for (a) removed, the snapshot reports `tlsOtherCa: {ok:true, authorized:true}` and
`fetchOtherCa: {ok:true, status:200}` against `https://example.com`, where Bun 1.4.5 and Node 26 both report
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. The same holds without network: with `NODE_EXTRA_CA_CERTS=root.pem` and
`ca: other-root.pem`, a local server signed by `root.pem` is `authorized=true` on zun and rejected by Bun 1.4.5 and Node.

## Root cause

`packages/bun-usockets/src/crypto/openssl.c` `us_ssl_ctx_build_raw`, the single builder of every TCP `SSL_CTX` with
options (fetch custom contexts and the `--ca`/`--cafile` HTTP thread context via `HTTPContext.initWithOpts`, the
CONNECT inner context, `node:tls` `SecureContext` and `ssl_wrapper.zig`, `Bun.connect`/`Bun.listen`, `Bun.serve`
including SNI entries, the QUIC server contexts in `quic.c`, `SSLContextCache`):

- `ca_file_name` branch: `SSL_CTX_set_cert_store(ssl_context, us_get_default_ca_store())`, then
  `SSL_CTX_load_verify_locations` adds the file's CAs to that store.
- `ca` branch: `cert_store = us_get_default_ca_store(); SSL_CTX_set_cert_store(...)`, then `X509_STORE_add_cert`
  each PEM certificate (`add_ca_cert_to_ctx_store`).

`us_get_default_ca_store()` (`root_certs.cpp`) returns a fresh store holding the bundled NSS roots,
`NODE_EXTRA_CA_CERTS` and (with `--use-system-ca`) the system roots. So the explicit CAs were a union with the
defaults, and `X509_verify_cert` succeeds for any chain to any of them. Node's `ca` (and Bun ≥ 1.4.0) replaces the
defaults: `_tls_common.js` calls `addCACert` (the context's own empty store) when `ca` is given and `addRootCerts`
only when it is not.

**Introduced:** inherited, not a zun change. The additive code is already in `bun-v1.3.14`
(`packages/bun-usockets/src/crypto/openssl.c`, the same two branches), came into cruller with the 1.3.14 import and
into zun with `a1c009d` (`git log -S "cert_store = us_get_default_ca_store();"` stops there). Upstream fixed it in
`cd1ad599` "Hardening: input validation and bounds tightening across 36 subsystems (round 4) (#31339)", 2026-05-25,
first released in bun-v1.4.0 (`git tag --contains`), whose comment reads "An explicit CA replaces the default trust
store (Node.js semantics)". Bun 1.4.5 later restructured it (`us_ctx_user_ca_ex_idx`, shared default store) but kept
the semantics. Our restore-from-1.3.14 policy carried the pre-fix behaviour forward and the backport audit did not
list #31339.

## Why it wasn't caught

- `test-zun-fetch-tls-options.mjs`'s wrong-CA case uses a local self-signed server, which the default store rejects
  too, so it passes whether `ca` replaces or adds.
- FETCH-1's "bogus ca rejects example.com" probe used malformed PEM: context creation failed, so it never reached
  verification. A real test needs a peer the *default* store trusts plus a *valid* unrelated `ca`.
- The backport audit compared 1.3.14 → 1.4.5 by security advisory and by named PRs; #31339 is a bulk hardening PR
  whose title does not mention TLS.

## Fix

`us_ssl_ctx_build_raw`: both `ca` branches now use the `X509_STORE` that `SSL_CTX_new()` already gave the context
(empty) instead of installing `us_get_default_ca_store()`. `SSL_CTX_load_verify_locations` and
`add_ca_cert_to_ctx_store` fill only that store, so a chain verifies only against the supplied CAs. Default roots are
still used when no `ca`/`ca_file_name` is given: the `request_cert` branch installs them, and client sockets on a
VERIFY_NONE context get the shared default store per-SSL (`us_internal_ssl_attach`, `ssl_wrapper.zig`); both are
unchanged and are not reached when `ca` is set (the `ca` branches set `SSL_VERIFY_PEER` on the context). The
blocked-SPKI check (C2) is installed with `SSL_CTX_set_cert_verify_callback` before the store is chosen, so it runs
for every store. This removes the cause (the union), matching upstream `cd1ad599`.

Behaviour change to note: `bun install --ca/--cafile` (the HTTP thread context) now trusts only the given CAs, as in
Bun ≥ 1.4.0 and npm.

## Regression test

`test/js/node/test/parallel/test-zun-tls-ca-replaces-roots.mjs` (+ fixture `zun-blocked-spki/extra-ca-client.mjs`):
(a) `tls.connect` and `fetch` to `https://example.com` with `ca: other-root` must reject; (b) control without `ca`
succeeds; (c) a local leaf ← intermediate ← root server verifies with `ca: root` (tls and fetch) and not with
`ca: other-root`; (d) with `NODE_EXTRA_CA_CERTS=root.pem`, no `ca` verifies the local server and `ca: other-root`
rejects it. Snapshot `0a5b26b`: fails at (a) (exit 1); (b)–(c) pass. Bun 1.4.5 and Node 26 pass (exit 0).

## Sibling search

`grep -rnE "us_get_default_ca_store|SSL_CTX_set_cert_store|set0_verify_cert_store|X509_STORE_new|X509_STORE_add_cert|SSL_CTX_get_cert_store" packages/bun-usockets/src src`:

- `openssl.c` `ca_file_name` / `ca` branches: fixed here. `request_cert` branch: defaults on purpose (no `ca`).
- `openssl.c` `us_internal_ssl_attach` and `src/runtime/socket/ssl_wrapper.zig`: shared defaults only when the
  context's verify mode is NONE, i.e. no `ca`; correct.
- `quic.c` QUIC **client** context (`us_create_quic_client_context`): always the default store, and no per-request
  `ca` reaches HTTP/3 at all; that is review F-2 (open, separate). QUIC **server** contexts use `us_ssl_ctx_build_raw`,
  so they are fixed by this change.
- `root_certs.cpp` `us_get_default_ca_store` / `us_get_shared_default_ca_store`: they define the defaults
  (bundled + `NODE_EXTRA_CA_CERTS` + `--use-system-ca`); correct when no `ca` is given. `tls.getCACertificates()`
  only lists them.
- `src/jsc/bindings/ncrypto.cpp` `X509Pointer::IssuerFrom`: reads the context's store for `getIssuerCertificate`;
  it now sees only the explicit CAs when `ca` is given, as in Node.
- Not present in zun: Node's `SecureContext.addCACert` / `addRootCerts` / `setAllowPartialTrustChain`, CRLs.
- Same class elsewhere: server-side mTLS with `ca` is the same branch and is fixed; a test with a client certificate
  chaining to a public root is not feasible locally (no public-root client cert); (d) exercises the same store.

## Lessons

- When restoring from 1.3.14, check 1.4.x for semantic security fixes in bulk "hardening" PRs, not only advisories.
- Trust-store tests need a peer that the default store trusts and a valid, unrelated explicit CA; a peer the defaults
  reject, or malformed PEM, cannot tell "replace" from "add".
