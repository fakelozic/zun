# Security backports

**Date:** 2026-11-26. **Inputs:** `audit-deps.md` (dependencies), Bun advisories and release notes (below), and a read of
zun's code. **Status column:** `open` until a commit lands; then record the commit and the test.

## Where fixes can come from

- **Dependency pins** (`scripts/build/deps/*.ts`): bump to the commit Bun 1.4.5 uses where possible, since it has been
  through Bun's CI with Bun's bindings.
- **C / C++ in the tree** (`packages/bun-uws`, `packages/bun-usockets`, `src/jsc/bindings`): Bun 1.4.5 is **still C++**
  here, so diff `bun-1.3.14` against `bun-1.4.5` and cherry-pick.
- **Zig code** (`src/http`, `src/runtime`, `src/boringssl`, …): Bun 1.4.x is a **Rust port**, so its fixes can't be
  cherry-picked. Re-implement them in Zig, with the 1.4.5 `.rs` file as the specification. Cite it in the commit.
- **JS builtins** (`src/js/node/*.ts`): still TypeScript in 1.4.5, so cherry-pick.

Reference trees for the diffs: `bun-v1.3.14`, `bun-v1.4.5` (`a7733435`) and canary (`e13b16bc`). See `AGENTS.md` for clone commands.

## Bun security fixes after 1.3.14, and whether zun has the bug

**Advisories:** `GET https://api.github.com/repos/oven-sh/bun/security-advisories`, 4 published (checked 2026-11-26).

| Advisory | Severity | Bun fix | Bug present in zun? |
|---|---|---|---|
| [GHSA-663w-cv8g-jj2p](https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p): brotli OOB write (CVE-2026-111497) | high | 1.4.4 (#46392) | **Yes**: brotli v1.1.0 is affected → C1 |
| [GHSA-26q8-h657-pf84](https://github.com/oven-sh/bun/security/advisories/GHSA-26q8-h657-pf84): compromised eMudhra intermediates | high | 1.4.4 (#46159, #46300) | **Yes**: emSign roots are at `packages/bun-usockets/src/crypto/root_certs.h:2042,2057,2078` → C2 |
| [GHSA-cf8x-9m69-3gg3](https://github.com/oven-sh/bun/security/advisories/GHSA-cf8x-9m69-3gg3): HTTP/3 QPACK amplification | high | 1.4.4 (#46392) | **Yes**, when `http3: true`: only a per-field limit in `packages/bun-usockets/src/quic.c:408-455` → H3 |
| [GHSA-p268-p2w7-qr8x](https://github.com/oven-sh/bun/security/advisories/GHSA-p268-p2w7-qr8x): lsquic UAF in QPACK header decoding | high (8.1) | 1.4.5 (#49288) | **Yes**, when `http3: true`: lsquic 4.6.2 → H3 |

**Release notes** (https://bun.com/blog/bun-v1.4.0 … `bun-v1.4.5`). Bun 1.4.0 says "Advisories will go up on GitHub once
people have had time to upgrade", so **more advisories are expected for fixes already shipped**. The items below are the
"Security" / "Security hardening" entries checked against zun's code. A status in *italics* comes from reading the code
without running a test.

| # | Bun fix (version) | zun location | zun status |
|---|---|---|---|
| 1 | Wildcard certs no longer match across labels (1.4.0) | `src/boringssl/boringssl.zig:119-150`, `src/js/node/tls.ts:256-306` | *Not present*: zun already limits `*` to one label. The 1.4 bug appears to have come in with the Rust port. |
| 2 | Cert name matching accepts only valid host names / canonical IPs, CVE-2026-48618 (1.4.3) | `src/js/node/tls.ts:346-390` | ***Vulnerable***: no hostname character validation, e.g. `*.evil.test` vs `localhost/.evil.test`. → H6 |
| 3 | Verify the server during the TLS handshake; `checkServerIdentity` runs before any bytes are sent (1.4.0, 1.4.3) | `packages/bun-usockets/src/crypto/openssl.c:430-435`, `src/http/http.zig:113-134`, `src/http_jsc/websocket_client/WebSocketUpgradeClient.zig:512-541` | ***Vulnerable***: with a custom `checkServerIdentity`, `fetch` writes the request before the JS callback runs. WebSocket queues the upgrade request (cookies / auth) on open. → H6 |
| 4 | `Bun.connect` / `upgradeTLS` / `Bun.listen` enforce `rejectUnauthorized` (1.4.0) | `src/runtime/socket/SSLConfig.zig:399-401`, `src/runtime/socket/socket.zig:616-684` | ***Vulnerable***: default is true, but `onHandshake` only records `authorized=false`; data still flows and there is no hostname check. → H6 |
| 5 | `tls.Server` default reject gated on `requestCert` (1.4.0) | `src/js/node/net.ts:415-425` | *Already fine* |
| 6 | Cert checks on TLS session / pooled connection reuse (1.4.3) | `src/http/HTTPContext.zig:624-700`, `src/http/http.zig:1146` | ***Vulnerable***: a socket opened with `rejectUnauthorized:false` can be reused by a strict request. → H2 |
| 7 | `statusMessage` / `writeEarlyHints` CRLF validation (1.4.0) | `src/js/node/_http_server.ts:1287-1311`, `src/js/internal/validators.ts:25` | *Partly*: `statusMessage` is checked; the `writeEarlyHints` Link regex allows CR/LF. → M4 |
| 8 | `fetch` drops caller `Transfer-Encoding` for fixed bodies; Content-Length vs stream check (1.4.0, 1.4.3) | `src/http/http.zig:946-993, 1048-1076` | ***Vulnerable***: CL and TE are both sent upstream. The header-count cap (256) is the same as 1.4.5. → M5 |
| 9 | `fetch` strict chunked parsing; evict idle keep-alive socket that gets data (1.4.3) | `scripts/build/deps/picohttpparser.ts:13`, `src/http/HTTPContext.zig:524-526` | ***Vulnerable***: old picohttpparser; unexpected data is only `log()`ged and the socket stays pooled. → H1, H2 |
| 10 | `Bun.serve` stricter CL / TE / chunked parsing (1.3.4, so already in 1.3.14) plus later RFC 9112 tightening (1.4.x) | `packages/bun-uws/src/HttpParser.h:241-305, 869-960`, `ChunkedEncoding.h:73-130` | *Partly*: differing duplicate CL, CL+TE, TE not ending in chunked, chunk-size overflow, obs-fold and bare LF are rejected. Still accepted: `gzip, chunked` / split TE fields / `chunked, chunked`, an **empty TE value (falls back to CL framing: CL.TE smuggling)**, TE on HTTP/1.0, unbounded chunk extensions. (`chunked,` is accepted as chunked by 1.4.5 too; trailer fields were already rejected.) → H5 |
| 11 | `Bun.serve` stops after `Connection: close` (RFC 9112) (1.4.3) | `packages/bun-uws/src/HttpContext.h:304-306, 432-441` | ***Vulnerable***: pipelined requests after `Connection: close` are still dispatched. → H5 |
| 12 | TLS `Bun.serve` idle timeout before the handshake completes (1.4.3) | `packages/bun-uws/src/HttpContext.h:186-190, 556-566` | *Fine for `Bun.serve`* (10 s timer from accept). UNVERIFIED for `Bun.listen` and `tls.Server`. → M8 |
| 13 | `node:http2` rapid-reset limits, CVE-2023-44487 and CVE-2025-8671 (1.4.3); padding zero-fill and validation; pseudo-header checks (1.4.0) | `src/runtime/api/bun/h2_frame_parser.zig:668, 1921-1950, 2227-2260, 1008-1012` | ***Vulnerable***: no RST_STREAM rate limit (only `maxRejectedStreams`, `:668`). Outgoing padding comes from a reused buffer, not zeroed. Incoming padding is validated. → H4, M7 |
| 14 | HTTP/3 header-byte limit and client-cert rules (1.4.0, 1.4.4) | `packages/bun-usockets/src/quic.c:408-455` | ***Vulnerable*** when `http3: true` → H3 |
| 15 | WebSocket option wraparound (`2**32+16` → 16) (1.4.4) | `src/runtime/server/WebSocketServerContext.zig:210,238` (`@truncate`) | ***Vulnerable***, but config is app-controlled. Control-frame limit and inflate cap are fine (`PerMessageDeflate.h:282-307`). → L1 |
| 16 | WebSocket client hardening (1.4.4) | `WebSocketUpgradeClient.zig:1012`, `websocket_client.zig:295`, `WebSocketDeflate.zig:80,150` | *Mostly fine*: Accept, UTF-8 and a 128 MB inflate cap are checked. The TLS ordering issue is under #3. |
| 17 | Zstandard output limit (1.4.5) | `src/zstd/zstd.zig:40-76, 175-240` | ***Vulnerable***: the streaming path has no output limit. → H7 |
| 18 | `fetch` decompression limits (1.4.x) | `src/http/InternalState.zig:119-181`, `src/http/Decompressor.zig:103` | ***Vulnerable***: gzip, br and zstd all inflate without an output budget. → H7 |
| 19 | `Bun.Archive` / tarball extraction (1.3.6, 1.4.3) | — | *Not present*: Archive and install are removed. Re-check when they are restored. |
| 20 | `v8.deserialize` / IPC / `structuredClone` crafted records (1.4.0, 1.4.3) | `src/jsc/bindings/webcore/SerializedScriptValue.cpp:5395-5470` | *UNVERIFIED, likely vulnerable*: identical to 1.3.14, and 1.4.5 changed ~3,100 lines. → M9 |
| 21 | `formData()` NUL truncation (1.4.0) | `src/runtime/webcore/FormData.zig:96-101` | *Already fine* |
| 22 | `fetch("file://host/…")` host check (1.4.3) | `src/runtime/webcore/fetch.zig:376` | ***Vulnerable***: host ignored → L2 |
| 23 | BoringSSL to upstream `606d3a344` (1.4.0) → `fe703e9f` (1.4.5) | `scripts/build/deps/boringssl.ts:27` | ***Old pin*** → M3 |
| 24 | c-ares 1.34.8 → 1.34.9, SQLite → 3.54.1, llhttp → 9.4.4, lsquic → 4.11.2 (1.4.5 "security release") | deps | ***Old pins*** → H8, M1, M2, H3 |
| 25 | `bun install` registry-token scoping, bin-link escapes, tarball traversal, integrity on migrated lockfiles (1.4.0) | — | *Not present* (install is stripped). Must be ported when `bun install` is restored. |

## Prioritised backport list

Severity uses zun's threat model (`README.md`): reachability from the network × impact.
**Counts: Critical 2 · High 9 · Medium 10 · Low 5.**

### Critical (fix before any production traffic; target: this week)

| ID | What | zun file / dep | Upstream reference | Approach | Test that proves it | Status |
|---|---|---|---|---|---|---|
| **C1** | brotli OOB write (CVE-2026-111497, RCE class). Reachable from any server `fetch` calls (`Accept-Encoding: br` is sent by default), and from `node:zlib` / `DecompressionStream`. | `scripts/build/deps/brotli.ts:15` (tag `v1.1.0`) | brotli v1.2.1; Bun GHSA-663w-cv8g-jj2p, #46392 | **Bump the pin** to commit `db24a98aed38a16de78cc05ca15cdd8dc2a0d92d` (v1.2.1, as in Bun 1.4.5), not a tag. Check whether the file list in `brotli.ts` changed in 1.2.x (compare with `bun-1.4.5/scripts/build/deps/brotli.ts`). | Bun's `test/js/node/zlib/*brotli*` and `test/js/web/fetch/fetch.brotli.test.ts` pass; add a regression test that a crafted stream from brotli 1.2.1's tests fails with `BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH`; ASAN run of the decoder on the oss-fuzz brotli corpus. | **fixed** (commit `security: C1 …`, 2026-11-26): pinned `db24a98a…` (v1.2.1, resolved with `git ls-remote`), file list from 1.4.5 (+`dec/prefix`, `dec/static_init`, `enc/static_dict_lut`, `enc/static_init`); unused `OS_*` defines dropped, `-fno-lto` kept. **Also fixed a latent crash** the bump would have exposed: the Zig enums for decoder errors were exhaustive and lacked the new `-17` (`FORMAT_BLOCK_SWITCH`), and `NativeBrotli.code_for_error` ended in `unreachable`; now non-exhaustive with an unknown-code fallback. Evidence: 10 Node zlib/brotli tests pass before and after; new `test-zun-brotli.js` (round trips, `person.jpg.br`, `fetch` `br` decode, 2,000 corrupted streams → errors with codes) passes; the binary contains v1.2.1's `_ERROR_FORMAT_BLOCK_SWITCH` string. **Not done:** a regression vector that yields `-17` (upstream fix `google/brotli@0ed4268a` ships none, and I could not craft one with confidence), and the oss-fuzz corpus run. |
| **C2** | Compromised eMudhra intermediates trusted, so any on-path attacker can MITM every outbound TLS connection. | `packages/bun-usockets/certdata.txt`, `src/crypto/root_certs.h:2042,2057,2078` | Bun GHSA-26q8-h657-pf84, #46159 (NSS 3.131.1), #46300 (public-key blocklist) | (1) Regenerate the bundle from **NSS 3.131.1** with the existing generator (header comment `root_certs.h:6-21`). (2) Port the **SPKI blocklist** of the eight keys into the verify callback in `packages/bun-usockets/src/crypto/openssl.c`, failing with `CERT_REVOKED`. That's C, so it can be cherry-picked from 1.4.5 if the patch is in C; otherwise re-implement. It must apply to system / extra CAs, the `ca` option, client-cert verification and QUIC. | A test with the 8 published intermediate certs (Node, Go and Chrome ship them) chained to a test root: expect `CERT_REVOKED`. Assert `emSign ECC Root CA - G3` is absent from `tls.rootCertificates`. | **fixed** (`security: C2` commit; NSS 3.131.1 + SPKI blocklist on all uSockets contexts and the QUIC client; `docs/security/root-certs.md`; test `test-zun-tls-blocked-spki.mjs`) |

### High (fix before production, or keep the feature disabled; target: 2–4 weeks)

| ID | What | zun file / dep | Upstream reference | Approach | Test | Status |
|---|---|---|---|---|---|---|
| **H1** | `fetch` chunked-response parsing too lax (desync, CPU DoS) | `scripts/build/deps/picohttpparser.ts:13` | h2o/picohttpparser #78, #81, #82; Bun 1.4.5 `picohttpparser.ts:13-31` + `patches/picohttpparser/chunked-decoder.patch` | **Bump** to `f4d94b48b31e0abae029ebeafcfd9ca0680ede58` and copy Bun's patch into `patches/picohttpparser/` | Bun `test/js/web/fetch/fetch-chunked*.test.ts`; new cases: bare-LF chunk header, `5;` garbage after size, 1-byte chunks with huge extensions, all rejected | **fixed** (`security: H1` commit; RCA `docs/rca/H1-picohttpparser-abi-drift.md`; test `test-zun-fetch-chunked.mjs`) |
| **H2** | `fetch` keep-alive pool: (a) a socket that receives unexpected bytes while idle stays pooled (response poisoning); (b) a pooled socket opened with weaker TLS settings is reused by a strict request without re-checking the host name or running `checkServerIdentity` | `src/http/HTTPContext.zig:515-526` (a), `:624-700` and `src/http/http.zig:1146` (b) | Bun 1.4.3 notes; 1.4.5 `src/http/HTTPContext.rs:1545` (`terminate_socket`), `:178-198` (`PeerVerification::admits`) | **Re-implement in Zig**: call `terminateSocket` on unexpected data (a). Store the verification mode, CA identity and server name on the pooled socket, and only reuse it when they `admit` the new request (b). | (a) a server that writes `HTTP/1.1 200` after the response on an idle socket: the next `fetch` gets a fresh connection. (b) request 1 with `rejectUnauthorized:false` to a wrong-name cert, request 2 strict to the same host: request 2 rejects. | open; (b) fix prepared with TLS-ID-1 (`PeerVerification` on pooled sockets, tunnels and h2 sessions; branch `t3/fix-fetch-tls-identity`), unverified |
| **H3** | HTTP/3: lsquic UAF (RCE class), QPACK amplification (CVE-2026-115482), path-overwrite GHSA-fg6p-g89q-65wr, ls-qpack UAF #87; **C2-2 (confirmed 2026-11-26):** a strict-mTLS `Bun.serve({http3:true})` dispatches requests from clients whose certificate failed verification (untrusted or blocked key); 1.4.5 checks it (`us_quic_server_peer_verified`) | `lsquic.ts:17`, `lsqpack.ts:10`, `packages/bun-usockets/src/quic.c:408-455` | Bun GHSA-p268-p2w7-qr8x (#49288), GHSA-cf8x-9m69-3gg3 (#46392); 1.4.5 `quic.c:58-79, 499, 863-865` | **Until fixed, `http3: true` and `node:quic` must not face untrusted clients (production rule).** Then bump lsquic to `f52c00172e04f9b889ab9e28d21e5d1805133cfb` (4.11.2) and ls-qpack to `91567706c41c0d97ab8dc576873ecd472d7869fa`, and cherry-pick the C limit logic from 1.4.5 `quic.c` (total decoded header-set size per RFC 9114 §4.2.2, field-count cap, 431 / close). Re-apply `patches/lsquic/*`. | An h3 client (`packages/h3blast`) sending a dynamic-table entry referenced 10k times: 431 / close with bounded RSS. Bun's `test/js/bun/http/http3*.test.ts` pass. C2-2: `test-zun-http3-mtls.mjs`. | open; C2-2 fix prepared (branch `fix/c2-2`), unverified (RCA `docs/rca/C2-2-http3-mtls-not-enforced.md`) |
| **H4** | `node:http2` server: no RST_STREAM rate limit (rapid reset CVE-2023-44487, MadeYouReset CVE-2025-8671). Remote DoS with almost no effort. | `src/runtime/api/bun/h2_frame_parser.zig:668, 1921-1950, 2227-2260` | Bun 1.4.3 notes; 1.4.5 `h2_frame_parser.rs:1139-1140, 3692`, `h2/connection.rs` (`DEFAULT_STREAM_RESET_BURST`, `streamResetRate`) | **Re-implement in Zig**: a token bucket for peer RST_STREAM *and* for server-side resets caused by peer protocol errors (MadeYouReset). Over the limit → GOAWAY(ENHANCE_YOUR_CALM) and close. Honour the `streamResetBurst` / `streamResetRate` options like Node. | h2load-style test: 10k HEADERS+RST pairs → connection closed with ENHANCE_YOUR_CALM, CPU bounded; Node's `test-http2-reset-flood` ported. | open |
| **H5** | `Bun.serve` HTTP/1.1 parser gaps (smuggling behind a proxy): TE `chunked,`, `gzip, chunked`, TE on HTTP/1.0, unbounded chunk extensions and trailers, pipelined requests processed after `Connection: close` | `packages/bun-uws/src/HttpParser.h:241-305, 869-960`, `ChunkedEncoding.h:73-130`, `HttpContext.h:304-306, 432-441` | Bun 1.4.5 C++ `HttpParser.h` (TE rewrite, `sawConnectionClose` `:722, 1295-1330`), `ChunkedEncoding.h` (`chunkExtensionsConsumed`, `MAX_TRAILER_SECTION_SIZE`); uWS v20.80–81 | **Cherry-pick the C++** from `bun-1.4.5/packages/bun-uws/src/` (diff against 1.3.14, take only the parsing hunks) | Bun `test/js/bun/http/request-smuggling*.test.ts` and `serve-*` tests; add raw-socket tests for each listed input (expect 400 + close); http-garden / Http11Probe pass | **fixed 2026-11-27** (built and verified: `test-zun-serve-smuggling.mjs` 28 cases pass; the close-after-async-response gap is open as H5-1; RCA `docs/rca/H5-serve-http1-smuggling.md`). `chunked,` is accepted as chunked like 1.4.5 (RFC 9110 empty list element); trailers were already rejected by `Bun.serve` |
| **H6** | TLS client verification: (a) `Bun.connect` / `upgradeTLS` don't close on a failed verify, and don't check host names; (b) `fetch` with a custom `checkServerIdentity` sends the request before the callback; (c) the WebSocket upgrade request is queued before verification; (d) CVE-2026-48618; (e) **review C2-1, confirmed:** `Bun.connect` reports `authorized:true` after a failed verify and stays connected with `rejectUnauthorized:true` (1.4.5: `authorized:false`, handshake fails); **TLS-ID-1** (review F-3/F-4/F-5): fetch sends the request before `checkServerIdentity` decides, and pooled H1 sockets skip it hostname validation in `checkServerIdentity` | `src/runtime/socket/socket.zig:616-684`, `SSLConfig.zig:399-401`, `src/http/http.zig:113-134`, `WebSocketUpgradeClient.zig:512-541`, `src/js/node/tls.ts:346-390`, `openssl.c:430-435` | Bun 1.4.0 / 1.4.3 notes; 1.4.5 `openssl.c:1135,1222`, `HTTPContext.rs:1331-1416`, `socket_body.rs:1835-2013`, `src/js/node/tls.ts:~395-420` | `openssl.c` / `tls.ts` → **cherry-pick**. Zig parts → **re-implement**: hold writes until verification (including the JS callback) completes, and close on failure when `rejectUnauthorized`. | Self-signed / wrong-name server that records bytes received: with default options it must receive **zero** application bytes from `fetch`, `WebSocket` and `Bun.connect`; Node's `test-tls-check-server-identity` cases including `localhost/.evil.test`. | open; (b) fix prepared with TLS-ID-1 (branch `t3/fix-fetch-tls-identity`), unverified; (c) still open |
| **H7** | Decompression bombs: `fetch` auto-decompression (gzip / br / zstd) and the zstd streaming API have no output limit, so one response can exhaust memory. | `src/http/InternalState.zig:119-181`, `src/http/Decompressor.zig:103`, `src/zstd/zstd.zig:40-76, 175-240` | Bun 1.4.5 "Zstandard / Bun.zstdDecompress" security item; 1.4.5 `src/zstd/lib.rs:340-356, 438, 506` (`max_output_size`), `src/http/Decompressor.rs:71-96`, `InternalState.rs:281-412` | **Re-implement in Zig**: an output budget per decode call and per body; reject with a typed error over the limit. Use the same defaults as 1.4.5 (read them from the `.rs` file). | A 10 MB → 10 GB zstd / br / gzip bomb served to `fetch` and passed to `Bun.zstdDecompress`: rejects with RSS under 100 MB. | open |
| **H8** | c-ares UAF / DoS (CVE-2026-33630, -69184, -69186 and 11 GHSAs in 1.34.9) | `scripts/build/deps/cares.ts:15` | c-ares v1.34.9; Bun 1.4.5 pin `0b88066f79ac9745d6819899f1794df91b73c873` | **Bump the pin**. Check that the file list and `ares_config.h` template in `cares.ts` still match. | Bun `test/js/node/dns/*.test.ts`; a fake DNS server sending a pointer-chain bomb and inflated ANCOUNT: resolver stays responsive. | **fixed** (commit `security: H8 …`): pinned commit `bc91829c…` (v1.34.9; Bun 1.4.5's `0b88066f…` is the annotated *tag object*, not a commit). The previous pin was **1.34.6** (`3ac47ee4`), not 1.34.8 as row 24 assumed. Same `.c` list and no new `HAVE_*` config macros, so `cares.ts`'s file list and `ares_config.h` template are unchanged. Evidence: binary has `process.versions.ares = bc91829c…` and the string `1.34.9`; Node DNS tests 18/23 pass, identical to before the bump (`test-dns-resolveany-bad-ancount`, an inflated-ANCOUNT fake server, passes; the 5 failures are pre-existing: 3 need CLI flags, 2 answer-format diffs). **Not done:** pointer-chain-bomb fake-server test. |
| **H9** | JavaScriptCore: at least 29 CVE fixes missing (24 are in Bun 1.4.5's WebKit) | `scripts/build/deps/webkit.ts:6` | see `audit-deps.md` §WebKit | **WebKit upgrade (decision below)**. Until then: no `new RegExp()` from request data, no untrusted Wasm, no `eval`. | Bun's JSC-facing tests (`test/js/web`, `test/js/bun/jsc`) pass on the new WebKit; ASAN debug build runs the suite. | open |

### Medium (target: within 1–2 months; all before the production gate re-check)

| ID | What | zun file / dep | Reference | Approach | Test |
|---|---|---|---|---|---|
| **M1** | SQLite FTS5 heap overflows and 8 more CVEs | `src/jsc/bindings/sqlite/sqlite3.c` (3.53.0) | SQLite 3.54.1 (Bun 1.4.5) | **Replace the amalgamation** (`sqlite3.c`, `sqlite3.h`) with 3.54.1. Check the sha3-256 against sqlite.org's published hash. | `test/js/bun/sqlite/*.test.ts`; SQLite's published PoCs for CVE-2026-11824 / -119373 return errors, not ASAN reports |
| **M2** | llhttp 9.3.0: empty TE accepted, status-line CRLF | `src/jsc/bindings/node/http/llhttp/` | llhttp 9.4.4 (Bun 1.4.5) | **Replace the vendored files** with 9.4.4's `llhttp.{c,h}`, `api.c`, `http.c` (copy from `bun-1.4.5`) | Node `test-http-parser*` cases for an empty TE |
| **M3** | BoringSSL hardening (PEM overflow, TLS 1.3 extension parsing, RC2, AEAD bounds) | `scripts/build/deps/boringssl.ts:27` | Bun 1.4.5 pin `fe703e9faa3bfd22b04eb192066856557b7e015c` | **Bump**. Update the large source list in `boringssl.ts` from 1.4.5's file, and check for API changes used by `src/boringssl*` and `ncrypto.patch`. | Full TLS / crypto test dirs; `test/js/node/test/parallel/test-tls-*` |
| **M4** | `writeEarlyHints` Link-header CRLF injection | `src/js/node/_http_server.ts:1287-1311`, `src/js/internal/validators.ts:25` | 1.4.5 `_http_server.ts:3413` (`checkInvalidHeaderChar(link)`) | **Cherry-pick** (TS) | `res.writeEarlyHints({ link: "</a>\r\nSet-Cookie: x=1" })` throws `ERR_INVALID_CHAR` |
| **M5** | `fetch` sends caller `Transfer-Encoding` together with the computed `Content-Length` (CL+TE upstream, smuggling via proxies); stream body vs user Content-Length not checked | `src/http/http.zig:946-993, 1048-1076` | 1.4.5 `src/http/lib.rs:2632-2668` | **Re-implement in Zig**: drop user TE for fixed-size bodies, and reject on a CL mismatch | Raw TCP server records request bytes: exactly one framing header |
| **M6** | zstd 1.6.0 decoder fixes (uninitialised memory #5023) | `scripts/build/deps/zstd.ts:15` | zstd v1.6.0 | **Bump** after Bun or upstream CI shows no API break (Bun 1.4.5 still uses 1.5.7). Confirm legacy decoders are compiled out. | zstd tests + `fetch` zstd tests under ASAN/MSan |
| **M7** | `node:http2` outgoing padding not zeroed (heap data leak when `paddingStrategy` ≠ none); weak pseudo-header validation on the server side | `h2_frame_parser.zig:1008-1012, 1921` | Bun 1.4.0 notes | **Re-implement**: zero the padding, validate the required pseudo-headers (`:method`, `:path`, `:scheme`, no duplicates, no uppercase) | Capture frames: padding bytes are 0; malformed HEADERS → RST_STREAM PROTOCOL_ERROR |
| **M8** | Possibly no handshake timeout on `Bun.listen({tls})` / `tls.Server` (slowloris). UNVERIFIED. | `src/runtime/socket/*.zig`, `src/js/node/tls.ts` | Bun 1.4.3 notes | Verify first; if missing, add a handshake timer like `HttpContext.h:186-190` | Open 10k TCP connections that never send ClientHello: closed after the timeout |
| **M9** | `structuredClone` / `v8.deserialize` / advanced IPC crafted-record hardening | `src/jsc/bindings/webcore/SerializedScriptValue.cpp` | 1.4.5 same file (`:4102-4180`, ~3,100 lines changed) | **Cherry-pick the C++** hunks that add validation (Map/Set pooling, exception checks). Only matters if IPC peers are untrusted. | Fuzz `v8.deserialize` with libFuzzer for 1 h under ASAN, no crashes |
| **M10** | lol-html comment-text injection; libjpeg-turbo 3.2.1 overruns; mimalloc v3.3.1 → v3.7.x hardening | `lolhtml.ts:12`, `libjpeg-turbo.ts:20`, `mimalloc.ts:15` | lol-html 3.0.x (Bun 1.4.5 `725ce499`), libjpeg-turbo 3.2.1, mimalloc (Bun 1.4.5 `92ef6587`) | **Bump** each (lol-html 3.x has API changes; check `src/lolhtml_sys/lol_html.zig`) | HTMLRewriter `comment.text = "--!><script>"` is escaped or rejected; `Bun.Image` tests under ASAN |
| **M11** | `Bun.markdown`: O(n²) on unmatched `[` / `[a](` runs and superlinear link reference definitions (DoS on untrusted markdown). Inherited from 1.3.14 | `src/md/inlines.zig`, `links.zig`, `ref_defs.zig` | `known-issues.md` MD-1; check Bun 1.4.5 `src/md` (Rust) for a bound | Port the 1.4.x fix if any, else bound the opener search as md4c does | `"[".repeat(1e5)` and `"[a](".repeat(5e4)` render in linear time (scale test in `test-zun-markdown.js`) |

### Low

| ID | What | Where | Approach |
|---|---|---|---|
| **L1** | WebSocket `maxPayloadLength` / `backpressureLimit` silently wrap on `@truncate` (config is app-controlled) | `src/runtime/server/WebSocketServerContext.zig:210,238` | Clamp to `maxInt(u32)` or throw `RangeError`, as 1.4.5 does (`WebSocketServerContext.rs:302-345`) |
| **L2** | `fetch("file://host/path")` ignores the host | `src/runtime/webcore/fetch.zig:376` | Reject unless the host is empty or `localhost` (`ERR_INVALID_FILE_URL_HOST`) |
| **L3** | libarchive is built but has no caller | `scripts/build/deps/index.ts` | Remove it from `allDeps` until Archive / install are restored, then add it back at ≥ v3.8.11 with Bun's extraction hardening |
| **L4** | c-ares: hostnames containing NUL may be truncated in `dns.resolve*` (Node CVE-2026-105482; UNVERIFIED in zun) | `src/runtime/dns*`, `src/cares_sys` | Verify, then reject NUL in hostnames |
| **L5** | Telemetry / third-party contact (see the next section) | `src/crash_handler`, `src/js/eval/feedback.ts`, `src/options_types/CompileTarget.zig` | Handled by the telemetry task (T3). Cross-reference only. |

## Third-party contact in zun's code (cross-reference for the telemetry task)

- **Crash upload to `https://bun.report`:** `src/crash_handler/crash_handler.zig:26` (default URL), `:812-815`
  (`BUN_CRASH_REPORT_URL`), `:1426-1460` (`isReportingEnabled`), and an upload that spawns `curl` (~`:1466-1540`).
  On a **Linux release** build it is **off by default**. It turns on with `BUN_CRASH_REPORT_URL` or
  `BUN_ENABLE_CRASH_REPORTING`, and always on canary builds (`:1450`) unless `DO_NOT_TRACK` is set. The crash message
  always *prints* a `bun.report` URL (which encodes the stack and feature flags) without sending it.
- **Feature counters:** `src/analytics/analytics.zig` has no network sender; it only feeds the crash URL.
- **`bun feedback`:** `src/js/eval/feedback.ts:630` POSTs to `bun.report/v1/feedback` when invoked. Whether it is reachable in zun is UNVERIFIED.
- **Cross-compile download:** `src/options_types/CompileTarget.zig:75, 164-187` fetches a Bun binary from
  `registry.npmjs.org` **without a checksum**. It has no callers today (dormant), but it is both a supply-chain and a third-party issue.
- No auto-update or version check was found.

## The WebKit / JSC upgrade decision

**Facts** (`audit-deps.md` §WebKit):

- zun's WebKit is from 2026-05-12.
- Bun 1.4.5's WebKit is 11,917 commits newer (1,874 touching JSC). Canary's is 14,545 newer.
- At least **29 JSC CVEs** are fixed upstream and missing in zun. Bun 1.4.5's WebKit has 24 of them; 5 are only in canary.
- The count is a lower bound, and Apple and WebKitGTK publish more every month.

**Threat-model weighting:**

- zun runs only the owner's JavaScript, so most of these (JIT and Wasm) need attacker-shaped *code* and are not reachable from the network.
- The realistic data paths are YARR / RegExp (CVE-2026-28847, -65335, -65340, -28904), and only if a pattern is built from request data.
- TypedArray `sort` (CVE-2026-28902) is reachable with attacker-chosen data in some apps.

So engine CVEs are **High as a class, but rarely network-reachable**. That is why they rank below C1–H8, whose bugs any remote peer can trigger.

**Cost:**

- A WebKit bump is not just a pin change. The C++ bindings in `src/jsc/bindings` must match the JSC API of the new
  WebKit, and Bun changed them together with each bump.
- Bun 1.4.5 keeps those bindings in C++, so `bun-1.4.5/src/jsc/bindings` is a usable reference. How much churn there
  is, and how much of it is entangled with the Rust port, is UNVERIFIED.
- The Phase 4 restore copies Zig and C++ from 1.3.14 against the *current* WebKit. Changing WebKit in the middle of the restore doubles the moving parts.

**Recommendation:**

1. **Now (Phase 4):** keep WebKit pinned. Do C1–H8 first: they are cheap pin bumps or local patches, and they close the network-reachable holes.
2. **As soon as the Phase 4 restore reaches "the runtime builds and the HTTP/fetch/WebSocket tests pass", and before
   any production traffic:** upgrade WebKit to **Bun 1.4.5's pin `d6375c72`**, porting binding changes from
   `bun-1.4.5/src/jsc/bindings`. Make this a **production gate**: with 24+ known engine CVEs, the gate "no known
   critical/high CVE unpatched in shipped code" cannot be met on the current pin.
3. **After that:** follow Bun's WebKit pin monthly, or on any WebKitGTK / Apple advisory with a JSC CVE. Prefer Bun's
   prebuilt `autobuild-*` tags, which come with sha256 sums in canary (`scripts/build/deps/webkit.sha256`), over building WebKit ourselves.
4. **Until the upgrade:** document the app-level mitigations (no `RegExp` built from request data, no untrusted Wasm,
   no `eval` / `new Function` on input), and run zun behind a reverse proxy, which the production gates require anyway.

## New findings while backporting (2026-11-26)

| ID | Issue | Status |
|----|-------|--------|
| **FETCH-1** | High. `fetch` ignores per-request TLS options (`tls.ca`, likely `cert`/`key`/`checkServerIdentity`) and loses TLS error codes, because cruller's rt host bridge doesn't serialize them. With a pinned private CA, any publicly trusted certificate is accepted. RCA `docs/rca/FETCH-1-fetch-bridge-drops-tls-config.md` | **fixed** (`security: FETCH-1` commit; direct fetch path restored; tests `test-zun-fetch-tls-options.mjs`, `test-zun-fetch-streaming.mjs`) |

