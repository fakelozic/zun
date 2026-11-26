# Bundled root certificates and the blocked-key list

## Current state (2026-11-26, security C2)

- **Root store:** Mozilla **NSS 3.131.1** `certdata.txt`, 118 CAs trusted for TLS server auth, compiled into
  `packages/bun-usockets/src/crypto/root_certs.h`.
  - Provenance: downloaded from `https://hg.mozilla.org/projects/nss/raw-file/NSS_3_131_1_RTM/lib/ckfw/builtins/certdata.txt`,
    sha256 `3ec2b4d240dc12c747eaf450061db84af757c483bbda302f9e29ceb5d70be510`. Byte-identical to Bun 1.4.5's copy, and the
    generated root set is identical to Bun 1.4.5's `root_certs.txt` (118 names).
  - Change from the 1.3.14-era store (145 roots): 31 removed, 4 added. Removed include the compromised-adjacent
    **emSign ECC Root CA - G3, emSign Root CA - C1, emSign ECC Root CA - C3**, and also legacy roots Mozilla distrusted for
    TLS such as **DigiCert Global Root CA, DigiCert High Assurance EV Root CA, Entrust Root CA (all), AffirmTrust (all),
    QuoVadis 2/3, Trustwave Global (all), GTS Root R2**. Bun 1.4.5 and Node ship the same set.
  - **Operational impact:** a server whose chain only reaches a removed root now fails verification. Fix on the server
    side (reissue), or trust the root explicitly with `NODE_EXTRA_CA_CERTS` / a `ca` option on `node:tls` / `https`.
    Note: an explicit `ca` is currently *added* to the defaults instead of replacing them, see TLS-CA-1.
- **Blocked public keys:** `packages/bun-usockets/src/crypto/blocked_spkis.cpp` (from Bun 1.4.5, GHSA-26q8-h657-pf84):
  SHA-256 of the SubjectPublicKeyInfo of the **eight eMudhra intermediates** whose private keys are public. Cross-checked
  byte-for-byte against Node's `src/crypto/crypto_context.cc` at `d9a3f3d1`. Any chain that contains one of these keys
  fails with `X509_V_ERR_CERT_REVOKED`, **whatever root it chains to** (bundled, system, `NODE_EXTRA_CA_CERTS`, or `ca`).

## Where the check runs

**Limits (verified 2026-11-26, `review-2026-11-26-verify-C2.md`):** the blocklist is an *overridable* `CERT_REVOKED`,
as in Bun 1.4.5 and Node. With `rejectUnauthorized:false` a blocked chain still connects (`authorizationError:
"CERT_REVOKED"`). The HTTP/3 server does **not** enforce client-certificate verification at all (C2-2, under H3).
Whether zun should make blocked keys a hard failure is an open owner decision.

| Path | How |
|------|-----|
| Every `SSL_CTX` built by uSockets (`us_ssl_ctx_build_raw`, `openssl.c`): `fetch`'s default context, `node:tls`/`https`, `Bun.connect`, `Bun.serve` client-certificate verification | `SSL_CTX_set_cert_verify_callback` → `us_x509_verify_chain` (X509_verify_cert, then the blocklist; error recorded on the store ctx, then the SSL's verify callback decides) |
| HTTP/3 client (`quic.c`, `us_quic_client_verify`) | explicit `us_x509_store_ctx_blocked_key_error` after `X509_verify_cert` |
| `ncrypto.cpp` `SSL_CTX`s | same coverage as Bun 1.4.5 (not hooked there); revisit if they are ever used to make connections directly |
| `boringssl.zig` `initClient()` | dead code with an accept-all verifier; see known issues |

Test: `test/js/node/test/parallel/test-zun-tls-blocked-spki.mjs` (debug builds can add one blocked key via
`ZUN_DEBUG_BLOCKED_SPKI_SHA256`; the code is compiled out of release builds).

## How to update the root store

1. Pick the NSS release (https://wiki.mozilla.org/NSS:Release_Versions), normally the one Bun's stable release uses.
2. Download `certdata.txt` from `https://hg.mozilla.org/projects/nss/raw-file/NSS_<X>_<Y>_<Z>_RTM/lib/ckfw/builtins/certdata.txt`
   and record its sha256 here.
3. Copy it to `packages/bun-usockets/certdata.txt` and run `perl packages/bun-usockets/generate-root-certs.pl`
   (writes `src/crypto/root_certs.h`). `generate-root-certs.mjs` automates download + generation + diff, but check the
   downloaded file's hash yourself.
4. Diff the root names (old vs new), compare with Bun's `packages/bun-usockets/root_certs.txt` for the same release, and
   list removals here with their operational impact.
5. Update the expected count in `test-zun-tls-blocked-spki.mjs`, rebuild, run the gate tests. Commit as `security:`.

When Node/Bun add keys to their blocklists, port them the same way and cross-check the bytes against Node's source.
