# Dependency audit (native + in-tree third-party code)

**Date:** 2026-11-26. **Re-check:** monthly (production gate, `docs/ROADMAP.md` "Production gates").
**Scope:** every dependency in `scripts/build/deps/*.ts` plus vendored third-party code in the tree.
Bun's own (non-dependency) fixes since 1.3.14 are in `backports.md`; build downloads are in `supply-chain.md`.

## How this was produced

- Pins read from `scripts/build/deps/*.ts` (zun = Bun 1.3.14: every pin is byte-identical to `bun-v1.3.14`).
  Bun 1.4.5 (`a7733435`, 2026-11-19) and canary (`e13b16bc`, 2026-11-25) pins read from their trees for comparison.
- Pin → release tag resolved with `git ls-remote --tags` on the upstream repo.
- [OSV](https://api.osv.dev/v1/query) queried by **commit** for every pin (only package names, versions and public
  commit hashes were sent). OSV only knows git ranges for some projects, so an empty result is *not* proof of absence.
- [NVD](https://services.nvd.nist.gov/rest/json/cves/2.0) keyword search per project, 2025-06-01 → 2026-11-26.
- GitHub Security Advisories (repo advisories), project CHANGELOG / release notes.
- "UNVERIFIED" = not confirmed from a primary source; treat as a lead, not a fact.

### Relevance scale (from the threat model in `README.md`)

zun runs the owner's own server code; the attacker is on the **network**.

| Tag | Meaning |
|-----|---------|
| **NET** | reachable by any remote client of `Bun.serve` / `node:http(s)` / WebSocket, or by any upstream server `fetch` talks to, or by DNS answers |
| **OPT** | reachable from the network only when an opt-in feature is on (`http3: true`, `node:quic`, `Bun.Image` on uploads, `HTMLRewriter` on proxied HTML, `bun:sqlite` on attacker-supplied data) |
| **DEV** | build-time / developer-only input (bun:ffi `cc()`, codegen) |
| **NONE** | not compiled into the Linux binary, or no caller in zun |

## Summary

| Dependency | zun pin | Upstream latest | Bun 1.4.5 pin | Known fixes after zun pin | Relevance | Worst |
|---|---|---|---|---|---|---|
| brotli | tag `v1.1.0` | v1.2.1 | v1.2.1 (`db24a98a`) | **CVE-2026-111497** OOB write (RCE) | NET | **Critical** |
| c-ares | `3ac47ee4` = v1.34.6 | v1.34.9 | v1.34.9 (`0b88066f`) | **CVE-2026-33630** UAF, CVE-2026-69184, CVE-2026-69186, 11 GHSAs in 1.34.9 | NET (DNS) | **High** |
| lsquic | `31819113` = v4.6.2 | v4.12.0 | v4.11.2 (`f52c0017`) | **UAF (Bun GHSA-p268-p2w7-qr8x)**, CVE-2026-115482, GHSA-fg6p-g89q-65wr | OPT (`http3`) | **High** (Critical if `http3` on) |
| ls-qpack | `1e9c5b8e` = v2.6.2 | v2.7.1 | `91567706` | UAF (#87), double free, 32-bit overflows (no CVE) | OPT (`http3`) | High if `http3` on |
| ls-hpack | `8905c024` = v2.3.4 | v2.3.5 | `cf0f70dd` | none (RFC compliance only) | NET (HTTP/2) | — |
| picohttpparser | `066d2b1e` (no tag) | master | `f4d94b48` + chunked patch | strict chunked parsing (PR #78, #81, #82, no CVE) | NET (`fetch` responses) | **High** |
| SQLite (in-tree amalgamation) | 3.53.0 | 3.54.1 | 3.54.1 | CVE-2026-11824, -119373, -119374 (FTS5 heap overflow, 7.8), +8 more | OPT | Medium |
| zstd | `f8745da6` = v1.5.7 | v1.6.0 | v1.5.7 | decoder uninit memory (#5023), UAF (#4848), no CVE | NET (`Content-Encoding: zstd`) | Medium |
| llhttp (in-tree) | 9.3.0 | 9.4.4 | 9.4.4 | empty `Transfer-Encoding` accepted (smuggling), status-line CRLF (no CVE) | NET (`node:http` parser binding) | Medium |
| BoringSSL | `oven-sh/boringssl@0c5fce43` (2026-04-15) | `247f93d` (2026-11-25) | `fe703e9f` (2026-11-18) | ~12 hardening commits (no CVE) | NET (TLS) | Medium |
| lol-html | `77127cd2` = crate 2.7.2 | 3.0.3 | `725ce499` | comment-text HTML injection ("security fix" in 3.0.0, no CVE) | OPT (`HTMLRewriter`) | Medium |
| libjpeg-turbo | `e352b02f` = 3.1.4 | 3.2.1 | 3.2.0 (`c85e6b90`) | OSV-2026-1068, 3.2.1 overrun fixes, CVE-2026-75466 | OPT (`Bun.Image`) | Medium |
| mimalloc | `oven-sh/mimalloc@f15aecb9` (= v3.3.1) | v3.7.1 | `92ef6587` | "bug and security fixes through LLM audit" (no CVE, UNVERIFIED detail) | indirect | Low |
| libarchive | `ded82291` = v3.8.7 | v3.8.11 | `27cbc782` | CVE-2026-5745, -14164, -15028, -17591, -16517, -45308, more | **NONE today** (no caller) | Low (High once restored) |
| zlib-ng | `12731092` = 2.3.3 | 2.3.3 | 2.3.3 | none found | NET | — |
| libdeflate | `c8c56a20` = v1.25 | v1.26 | `92e6a0db` | none (build/perf only) | NET (WebSocket deflate) | — |
| libwebp | `b7e29b9d` = v1.6.0 | v1.6.0 | v1.6.0 | none found | OPT (`Bun.Image`) | — |
| libspng | `fb768002` = v0.7.4 | v0.7.4 | v0.7.4 | none found | OPT (`Bun.Image`) | — |
| highway | `2607d3b5` = 1.4.0 | 1.4.0 | same | none | NONE (no untrusted input) | — |
| hdrhistogram | `be60a998` = 0.11.9 | 0.12.1 | `18c7a324` | none (the 2026 CVE is the Java library) | NONE | — |
| tinycc | `oven-sh/tinycc@12882eee` | — | `05f0fafa` | none found (UNVERIFIED) | DEV (`bun:ffi cc()`) | — |
| libuv | `oven-sh/libuv@4dcfac47` | v1.53.0 | `80235811` | n/a | NONE (`enabled: cfg => cfg.windows`, `scripts/build/deps/libuv.ts:35`) | — |
| Node.js headers | 24.3.0 | — | 26.3.0 | headers only, no code compiled | NONE | — |
| uWebSockets / uSockets (in-tree fork) | Bun 1.3.14 copy | uWS v20.81.0 | Bun 1.4.5 copy | RFC 9112 hardening; see Bun fixes in `backports.md` | NET | High (via Bun fixes) |
| Root CA bundle (in-tree `certdata.txt`) | NSS pre-3.124 (145 roots) | NSS 3.131.1 | NSS 3.131.1 | **compromised emSign intermediates (Bun GHSA-26q8-h657-pf84)** | NET (every TLS client) | **Critical** |
| WebKit / JSC (prebuilt) | `5488984d` (2026-05-12) | — | `d6375c72` (2026-10-21) | **≥ 29 JSC CVEs** | see below | High (see `backports.md`) |

## Per dependency

### brotli (`scripts/build/deps/brotli.ts:15`, tag `v1.1.0`)

Used by: `fetch` automatic decoding of `Content-Encoding: br` (`src/http/Decompressor.zig`), `node:zlib`
(`src/runtime/node/zlib/NativeBrotli.zig`), `DecompressionStream`. **NET**: any upstream server that `fetch` calls,
or anyone on the path of a plain-HTTP request, controls the decoder input.

| ID | Fixed in | Description | Severity | Source |
|---|---|---|---|---|
| CVE-2026-111497 (GHSA-9v8h-qqgm-4m35, Bun GHSA-663w-cv8g-jj2p) | 1.2.1 (also 1.0.10, 1.1.1) | Out-of-bounds write in `c/dec/decode.c`. Affects 1.0.3–1.2.0 except 1.0.10 and 1.1.1, so **v1.1.0 is affected**. Upstream says it permits RCE. | High / RCE | https://github.com/google/brotli/releases/tag/v1.2.1 , https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p |
| CVE-2025-6176 | 1.2.0 (Python binding only) | Decompression bomb. The C library has no output cap; callers must bound output themselves (zun doesn't, see `backports.md`). | 7.5 | https://github.com/google/brotli/commit/67d78bc41db1a0d03f2e763497748f2f69946627 |

The pin is a **tag**, which is mutable (`brotli.ts:13-14` says so). Bun 1.4.5 pins commit `db24a98aed38a16de78cc05ca15cdd8dc2a0d92d` (v1.2.1).

### c-ares (`scripts/build/deps/cares.ts:15`, `3ac47ee4` = v1.34.6)

Used by `dns.*`, `Bun.dns`, and hostname lookups for `fetch` / `Bun.connect` (`src/cares_sys/c_ares.zig`). **NET**:
any DNS server or on-path attacker for UDP DNS. Release notes: https://github.com/c-ares/c-ares/blob/v1.34.9/RELEASE-NOTES.md

| ID | Fixed in | Description | CVSS |
|---|---|---|---|
| CVE-2026-33630 / [GHSA-6wfj-rwm7-3542](https://github.com/c-ares/c-ares/security/advisories/GHSA-6wfj-rwm7-3542) | 1.34.7 | UAF / double free in query completion, remotely triggerable over TCP (1.32.3–1.34.6) | 7.5 |
| CVE-2026-69184 / [GHSA-pjmc-gx33-gc76](https://github.com/c-ares/c-ares/security/advisories/GHSA-pjmc-gx33-gc76) | 1.34.7 | Unbounded compression-pointer chains → quadratic CPU, stalls the event loop (OSV confirms the pin is affected) | 7.5 |
| CVE-2026-69186 / [GHSA-jv8r-gqr9-68wj](https://github.com/c-ares/c-ares/security/advisories/GHSA-jv8r-gqr9-68wj) | 1.34.7 | Record counts trusted before validation → large allocations from tiny replies (OSV confirms) | 5.3 |
| GHSA-wpr3-8q3r-4q8c | 1.34.9 | Memory corruption when lookups are cancelled after a connection failure | 7.5 |
| GHSA-fqh5-3x7m-wp44 | 1.34.9 | Accepts replies from a server other than the one queried (UDP port now checked) — cache-poisoning aid | 5.9 |
| GHSA-97vq-4mxv-7vhm, GHSA-rf6g-ww74-97qh, GHSA-mw23-pfg6-2x9r, GHSA-v33j-65h4-4ch8, GHSA-pj7p-v3cw-hq66, GHSA-grv7-fq5q-9vfc | 1.34.9 | Six use-after-free bugs around cancellation, socket-state / server-state callbacks and the answer cache. zun uses the socket-state callback, so GHSA-mw23 applies. | 5.5–5.9 |
| GHSA-ph6c-3cvx-mq6v | 1.34.9 | Buffer overflow when `ares_dup` / `ares_save_options` race with a server change | 5.3 |
| GHSA-cfcv-8v2j-qj6r | 1.34.9 | Uninitialised memory for a numeric IPv6 name with a prefix length | 4.8 |
| GHSA-wrgc-prmw-27xh | 1.34.9 | Query cache can return an answer obtained with different EDNS options | 3.7 |

The 1.34.9 GHSAs had no CVE IDs when checked. 1.34.8 was a non-security API revert. CVE-2025-62408 (fixed in 1.34.6) is
already in zun's pin. CVE-2026-105482 is a **Node.js** bug (hostnames containing NUL truncated in `dns.resolve*`); whether
zun's `dns` binding has the same issue is **UNVERIFIED** (see `backports.md`).

### lsquic / ls-qpack / ls-hpack (`lsquic.ts:17`, `lsqpack.ts:10`, `lshpack.ts:13`)

lsquic + ls-qpack back HTTP/3 in `Bun.serve({ http3: true })` (`src/runtime/server/ServerConfig.zig:55,761`,
`packages/bun-usockets/src/quic.c`), `node:quic`, and opt-in HTTP/3 `fetch`. HTTP/3 is **off by default**. ls-hpack backs HTTP/2 (NET).

| ID | Fixed in | Description | Severity | Source |
|---|---|---|---|---|
| Bun [GHSA-p268-p2w7-qr8x](https://github.com/oven-sh/bun/security/advisories/GHSA-p268-p2w7-qr8x) (upstream GHSA-5vg5-79mr-8863, unpublished) | lsquic 4.11.2 | QPACK-blocked stream + RST_STREAM → use-after-free. An lsquic maintainer demonstrated RCE in another server. Bun lists `>= 1.3.14` as affected. | CVSS 8.1 | advisory |
| CVE-2026-115482 / Bun [GHSA-cf8x-9m69-3gg3](https://github.com/oven-sh/bun/security/advisories/GHSA-cf8x-9m69-3gg3) | lsquic 4.9.0 + Bun-side header-set limit | QPACK "Header Accordions" amplification: 6 MB of traffic OOM-kills a 2 GB server; one 20 KB request stalls it for over a minute (OSV confirms the pin is affected) | 7.5 | https://github.com/litespeedtech/lsquic/pull/666 , https://foxio.io/blog/header-accordions-qpack-amplification-attacks-against-http-3-servers |
| GHSA-fg6p-g89q-65wr | lsquic 4.11.2 (≤ 4.10.2 affected) | An undecryptable datagram overwrites the current path | 5.8 | https://github.com/litespeedtech/lsquic/security/advisories/GHSA-fg6p-g89q-65wr |
| (changelog) | lsquic 4.6.3–4.10.2 | Overlapping header sends, Content-Length checks, RST_STREAM stream-limit enforcement, 32-bit parser bounds, conflicting Content-Length, STOP_SENDING on a critical stream, UB fixes | — | https://raw.githubusercontent.com/litespeedtech/lsquic/v4.12.0/CHANGELOG |
| (changelog) | ls-qpack 2.6.3 / 2.6.5 / 2.6.6 / 2.7.1 | 32-bit overflows and Huffman padding (2.6.3), **UAF #87** (2.6.5), encoder-init double free (2.6.6), duplicate header-block contexts (2.7.1) | — | https://raw.githubusercontent.com/litespeedtech/ls-qpack/v2.7.1/CHANGELOG |
| CVE-2025-54939 | lsquic 4.3.1 | `lsquic_engine_packet_in` memory leak — already fixed in the zun pin (4.6.2) | 5.3 | NVD |

ls-hpack v2.3.5 only permits empty names and names ending in whitespace (RFC 7541 compliance). Nothing to backport.

### picohttpparser (`picohttpparser.ts:13`, `066d2b1e`, no tag)

Used by the `fetch` HTTP/1.1 client to parse response heads and **chunked bodies** (`src/http/`). **NET**: any upstream server.
Bun 1.4.5 pins `f4d94b48` and adds `patches/picohttpparser/chunked-decoder.patch`
(`bun-1.4.5/scripts/build/deps/picohttpparser.ts:13-31`).

| Upstream change | Date | Description |
|---|---|---|
| [h2o/picohttpparser#78](https://github.com/h2o/picohttpparser/pull/78) (`d2360946`) | 2023-09 | Reject a chunk size followed by characters that aren't allowed |
| [#81](https://github.com/h2o/picohttpparser/pull/81) (`36652411`) | 2024-01 | Reject chunked encoding with too much overhead (CPU DoS) |
| [#82](https://github.com/h2o/picohttpparser/pull/82) (`a875a017`) | merged 2025-07 | Require CRLF in chunk headers; bare CR/LF rejected (response smuggling / desync) |

No CVE IDs. The PR numbers and commits come from the GitHub compare `066d2b1e...f4d94b48`.

### SQLite (in-tree amalgamation `src/jsc/bindings/sqlite/sqlite3.c:472`, 3.53.0)

Built statically on Linux (`scripts/build/deps/sqlite.ts`) with FTS3 (+`FTS3_PARENTHESIS`), FTS5 and R-Tree; no SESSION.
**OPT**: matters when the app opens attacker-supplied database files or lets untrusted input reach FTS `MATCH` /
SQL text. Source: https://www.sqlite.org/changes.html , NVD.

| ID | Fixed in | Description | CVSS | Built in zun |
|---|---|---|---|---|
| CVE-2026-11822 | 3.53.2 | FTS5 OOB read from a malformed leaf page | 5.5 | yes |
| CVE-2026-11824 | 3.53.2 | FTS5 heap overflow from a crafted database | 7.8 | yes |
| CVE-2026-119373 | 3.54.0 | FTS5 `fts5MergeRowidLists` heap overflow (detail=none) | 7.8 | yes |
| CVE-2026-119374 | 3.54.0 | FTS5 `fts5DoSecureDelete` heap overflow | 7.8 | yes |
| CVE-2026-119372 | 3.54.0 | FTS3 `fts3BestSnippet` UAF (with `PARENTHESIS`) | 5.5 | yes |
| CVE-2026-119378 | 3.54.0 | R-Tree `%_node` shadow-table UAF | 5.5 | yes |
| CVE-2026-119375 | 3.54.0 | Uninitialised page-cache read from a WAL with an undersized page | 5.5 | yes |
| CVE-2026-119371, -119376, -119591 | 3.54.0 | Stack exhaustion past `EXPR_DEPTH` (CTE / COLLATE chains, view optimisation) | 5.5 | yes |
| CVE-2026-119377 | 3.54.0 | Authorizer bypass for a `USING` column in a RIGHT JOIN | 2.5 | yes |
| CVE-2026-50812, -50813, -119379 | 3.53.x / 3.54.0 | Session extension bugs | 5.5–7.8 | **no** (SESSION off) |
| CVE-2026-119586 | not fixed | CLI `.recover` command injection | 7.8 | **no** (CLI not built) |

### zstd (`zstd.ts:15`, `f8745da6` = v1.5.7)

Used by `fetch` (`Content-Encoding: zstd` is advertised and auto-decoded), `node:zlib` zstd, `Bun.zstdDecompress`,
`DecompressionStream`. **NET**. v1.6.0 (Nov 2026) has no CVE/GHSA, but its CHANGELOG
(https://github.com/facebook/zstd/blob/v1.6.0/CHANGELOG) lists decoder fixes:

| Item | Description | Reachable in zun |
|---|---|---|
| #5023 | Streaming decompression of malformed data could expose uninitialised memory | yes (streaming decode of `fetch` bodies) |
| #4848 | UAF of a `ZSTD_DCtx_refPrefix` prefix after reset following a malformed frame header | only if prefixes are used (UNVERIFIED; zun doesn't seem to use them) |
| #4731 | OOB read/write in the DDict hash table with `refMultipleDDicts` | no (not used) |
| #4943, #4871, #4918, #4989, #5004, #4981, #4915 | Compression-side OOB / UAF with API misuse or unusual parameters | unlikely |
| #4555, #4815–4817, #4913, #4955, #4957 | Legacy-format decoders OOB reads | only if legacy support is compiled in (UNVERIFIED) |

Bun 1.4.5 keeps zstd v1.5.7. Its "Zstandard" security item is a Bun-side output limit (see `backports.md`).

### llhttp (in-tree `src/jsc/bindings/node/http/llhttp/llhttp.h:5-7`, 9.3.0)

Backs the `node:http` parser binding (`JSHTTPParser*`, `NodeHTTPParser.cpp`). `Bun.serve` itself uses uWS, not llhttp.
Bun 1.4.5 upgraded 9.4.2 → 9.4.4 in its security release (`bun.com/blog/bun-v1.4.5`).

| Change | Fixed in | Description | Source |
|---|---|---|---|
| PR #865, #866 | 9.4.2 | Require CRLF in the status line; tab after a `connection: close` value | https://github.com/nodejs/llhttp/releases/tag/release/v9.4.2 |
| PR #874 | 9.4.3 | Reject an empty `Transfer-Encoding` (request smuggling) | https://github.com/nodejs/llhttp/releases/tag/release/v9.4.3 |
| — | 9.4.4 | Relaxed-header fast-scanner fix | https://github.com/nodejs/llhttp/releases/tag/release/v9.4.4 |

Node shipped 9.4.3 in its July 2026 security release "to address public vulnerabilities" without a CVE for llhttp
(https://nodejs.org/en/blog/vulnerability/july-2026-security-releases). CVE-2026-123864 (NVD: llhttp keyword) is a Node
HTTPS/TLSWrap re-entrancy bug, not llhttp; zun has no TLSWrap, so **not applicable** (UNVERIFIED that no equivalent exists).

### BoringSSL (`boringssl.ts:27`, `oven-sh/boringssl@0c5fce43`, 2026-04-15)

**NET**: every TLS server and client. No CVE/GHSA and nothing in OSV. 832 upstream commits separate zun from Bun 1.4.5.
Security-relevant commit messages (from `git log` on a blobless clone of google/boringssl):

| Commit | Date | Description |
|---|---|---|
| `580f428` | 2026-04-23 | Output bounds check in `EVP_AEAD_CTX_seal_scatter` (regression with `extra_in`) |
| `40e356a`, `1cd0994` | 04-25/27 | Reject malformed / trailing `certificate_authorities` and `trust_anchors` in TLS 1.3 |
| `5ba5963`, `a328f4f` | 05-06/08 | Integer overflow in `CollapseWhitespaceASCII` (PEM > 2 GiB corrupts memory); cap PEM at 1 GiB |
| `a7481f3` | 05-13 | `max_early_data_size` > 2^16 (TLS 0-RTT) |
| `41e8190` | 05-26 | RC2 heap overflow with huge key lengths (Bun 1.4.0 notes: "upstream fixes to RC2") |
| `d15aa29` | 05-27 | Uninitialised read in AES-GCM-SIV asm (no impact) |
| `e2a57cf`, `1f70b5b`, `30c5c99` | 05-27 → 11-10 | GCM IV length validation |
| `d7e0f73` | 06-24 | `SSLBuffer::EnsureCap` offset overflow (defensive) |
| `bee4438` | 10-20 | `rand`: double free when thread-local storage fails |
| `f3ba8e4` | 11-24 | Reject trailing data in TLS 1.3 CertificateRequest `signature_algorithms` (after Bun 1.4.5) |

None is reported as remotely exploitable. The NVD hits for "boringssl" in this period (CVE-2026-48040, -43823, -69247,
-100665, -61798) are in Netty / Python `cryptography` wrappers, not BoringSSL.

### lol-html (`lolhtml.ts:12`, `77127cd2` = crate 2.7.2, built with cargo)

**OPT**: `HTMLRewriter`. [CHANGELOG](https://github.com/cloudflare/lol-html/blob/v3.0.3/CHANGELOG.md):

| Fixed in | Description |
|---|---|
| 3.0.0 ("security fix", no CVE) | `Comment::set_text` only rejected `-->`; `--!>` or a leading `>` / `->` in attacker-influenced text breaks out of the comment and injects HTML |
| 3.0.1–3.0.3 | Stricter attribute memory limit; CPU fixes for deep nesting, stray end tags and tags with many attributes |

RustSec / OSV: nothing for `lol_html` 2.7.2. An OSV batch query of the 43 crates in the pin's `c-api/Cargo.lock` found nothing.

### libjpeg-turbo / libspng / libwebp (Bun.Image only)

Only reachable through `Bun.Image` (`src/runtime/image/codec_{jpeg,png,webp}.zig`). **OPT**: matters only if the app
decodes images from untrusted users.

| ID | Library | Fixed in | Description | Source |
|---|---|---|---|---|
| OSV-2026-1068 | libjpeg-turbo | commit `76b7feab` (2026-10-07), **not an ancestor of 3.2.1 (UNVERIFIED whether released)** | UNKNOWN READ in `jpeg_abort` via `tj3Compress8` (encode path). OSV confirms 3.1.4 is affected. | https://bugs.chromium.org/p/oss-fuzz/issues/detail?id=537793912 |
| (3.2.1 #7) | libjpeg-turbo | 3.2.1 | Buffer overrun on partial decompression of a crafted 4:2:0 JPEG (merged upsampling, SIMD off) | https://github.com/libjpeg-turbo/libjpeg-turbo/blob/3.2.1/ChangeLog.md |
| (3.2.1 #10, #14, #15) | libjpeg-turbo | 3.2.1 | Header-reuse dimension mismatch, transform UAF, RGB565 overrun (API misuse / edge cases) | same |
| CVE-2026-75466 | libjpeg-turbo | 3.2.1 | Division by zero in the `tj3LoadImage*` PNG loader (3.2.0 only; zun 3.1.4 and Bun.Image likely don't use it) | NVD |

libspng v0.7.4 and libwebp v1.6.0 are the latest releases, and nothing was found for them in 2026. The NVD "libwebp"
hits (CVE-2026-110635, -125204, -58586) are in webp-converter, FFmpeg and Perl Image::WebP, not libwebp.

### mimalloc (`mimalloc.ts:15`, `oven-sh/mimalloc@f15aecb9`)

`MI_MALLOC_VERSION 30301` → based on upstream **v3.3.1** (2026-04-20). Upstream v3.3.2, v3.4.1 and v3.4.4 describe
"various bug and security fixes through LLM audit" (issue #1271); v3.7.0 seals metadata; v3.7.1 ignores env options in
elevated processes and stops infinite loops on corrupted free lists. No CVE. Individual fixes UNVERIFIED.
Source: https://github.com/microsoft/mimalloc/blob/v3.7.1/readme.md

### libarchive (`libarchive.ts:22`, `ded82291` = v3.8.7)

**Still fetched and compiled, but has no caller in zun**: `archive_read_new` doesn't appear in `src/` or `packages/`
(`Bun.Archive` was removed, `src/runtime/api/BunObject.zig:1131`; `bun install` is stripped). With `--gc-sections` it
should not end up in the binary (UNVERIFIED). Upstream fixes after 3.8.7 include CVE-2026-5745 (3.8.8), CVE-2026-14164
RAR5 double free (3.8.8, mapping UNVERIFIED), CVE-2026-45308 ZIP writer OOB write (3.8.8), CVE-2026-15028 PAX heap
overflow (3.8.9, https://github.com/libarchive/libarchive/pull/3253), CVE-2026-17591 UAF (3.8.9), CVE-2026-16517 (3.8.9?,
UNVERIFIED), private symlink-traversal fixes (3.8.9), and unpublished heap overflow / double free fixes (3.8.10, possibly
Microsoft's "Windows Libarchive" CVE-2026-69639, -69985, -70062; UNVERIFIED). Earlier 2026 CVEs (CVE-2026-4111, -4424,
-4426, -5121) predate the 3.8.7 pin; whether 3.8.7 contains them is UNVERIFIED.
**Action:** drop it from `allDeps` until `Bun.Archive` / `bun install` are restored, then restore at ≥ 3.8.11.

### zlib-ng, libdeflate, highway, hdrhistogram, tinycc, libuv, Node headers

- **zlib-ng** 2.3.3 is the latest release, and nothing was found. `zlib.ts:21-26` records two *regressions* on `develop` after
  2.3.3 (one hits `__builtin_unreachable()` in `deflateBound`). Keep the pin and re-audit before bumping.
- **libdeflate** v1.26 has only build and performance changes (https://github.com/ebiggers/libdeflate/blob/v1.26/NEWS.md).
- **highway** 1.4.0 and **hdrhistogram** 0.11.9 have no input-facing use. CVE-2026-14683 is the *Java* HdrHistogram.
- **tinycc** is only for `bun:ffi` `cc()` on developer-supplied C. Not network-reachable.
- **libuv** is Windows-only in zun (`libuv.ts:35`).
- **Node headers** 24.3.0 are headers only. Their supply-chain issue is covered in `supply-chain.md`.

### uWebSockets / uSockets (in-tree `packages/bun-uws`, `packages/bun-usockets`)

zun's copies are identical to Bun 1.3.14. Upstream uWS has no repository advisories. v20.78.0 fixed PROXY v2 spoofing of
`getProxiedRemoteAddress` (only with `UWS_WITH_PROXY`; UNVERIFIED whether Bun builds it), and v20.80.0–v20.81.0 add
RFC 9112 hardening (bare LF in trailers, non-ASCII targets, Host with a path, any TE ending in chunked).
Source: https://github.com/uNetworking/uWebSockets/releases. Bun's fork has diverged; **Bun 1.4.5's C++ copy is the
better backport source** (still C++, so patches apply). The concrete gaps are in `backports.md` (#H5, #M4).

### Root CA bundle (`packages/bun-usockets/certdata.txt`, `src/crypto/root_certs.h`)

145 roots, including `emSign ECC Root CA - G3` (`root_certs.h:2042`), `emSign Root CA - C1` (`:2057`) and
`emSign ECC Root CA - C3` (`:2078`). Bun [GHSA-26q8-h657-pf84](https://github.com/oven-sh/bun/security/advisories/GHSA-26q8-h657-pf84):
eight eMudhra intermediates were revoked in October 2026 for key compromise, and the private keys are public. **Any
on-path attacker can impersonate any TLS server to zun's `fetch`, WebSocket, `node:https` and `Bun.connect`.** Bun 1.4.4
moved to NSS 3.131.1 and blocks the eight public keys whatever root they chain to.

## WebKit / JavaScriptCore (`scripts/build/deps/webkit.ts:6`)

| | Commit | Date | Commits ahead of zun | …touching `Source/JavaScriptCore` |
|---|---|---|---|---|
| zun | `5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b` | 2026-05-12 | — | — |
| Bun 1.4.5 | `d6375c72affe0f70222cdcb45012b10f0bf3a9d5` | 2026-10-21 | 11,917 | 1,874 |
| canary | `32300d4d274b67f5cd3b3f109da0f0589aff742f` | 2026-11-24 | 14,545 | 2,398 |

Source: GitHub compare API on `oven-sh/WebKit`.

**Method:** bug IDs from Apple security notes (Safari 26.5, 26.5.2, 26.6, 26.6.1, 27, 27.2; iOS 26.7.3, 27.2.1) and WebKitGTK
advisories WSA-2026-0003 … -0007 (https://webkitgtk.org/security.html) were matched to `show_bug.cgi?id=` in commits in
the zun..canary range that touch JSC. Advisories without bug IDs, and fixes landed without a bug link, are missed, so these
counts are a **lower bound**.

**At least 29 JSC CVE fixes are missing from zun. Bun 1.4.5 has 24 of them; the other 5 are only in canary.**

- **In Bun 1.4.5's WebKit:**
  - RegExp / YARR:
    - CVE-2026-28847: YARR heap overflow with duplicate named groups.
    - CVE-2026-28904: a RegExp stress bug.
    - CVE-2026-65335: DFG RegExp strength reduction.
    - CVE-2026-65340: YarrJIT non-BMP backtracking.
  - JIT:
    - CVE-2026-28903: Air `FixObviousSpills`.
    - CVE-2026-28984: array rematerialisation.
    - CVE-2026-64715: B3 ReduceStrength UAF.
    - CVE-2026-64780: OMG SIMD inlining.
    - CVE-2026-65331: DFG IRO range proofs.
    - CVE-2026-65333: BackwardsGraph.
    - CVE-2026-65337: CallLinkInfo after `handleHostCall`.
    - CVE-2026-65338: OSR availability across LoadVarargs.
  - Runtime:
    - CVE-2026-28902: TypedArray sort length.
    - CVE-2026-64757: `ScopedArgumentsTable` memory corruption.
    - CVE-2026-64784: `UnlinkedMetadataTable` overflow.
  - Wasm:
    - CVE-2026-28947, CVE-2026-43658, CVE-2026-43663, CVE-2026-43716, CVE-2026-43745.
    - CVE-2026-65332, CVE-2026-65334, CVE-2026-65336, CVE-2026-86872.
- **Only in canary:**
  - CVE-2026-112653: GC UAF in `operationNewArrayBuffer`.
  - CVE-2026-112673: `GetByStatus` type confusion.
  - CVE-2026-113903: Wasm tail-call UAF.
  - CVE-2026-86974: `jsToWasmICEntrypoint` type confusion.
  - CVE-2026-86986: DFG/FTL DirectTailCall UAF.

Apple describes most as "processing maliciously crafted web content may lead to memory corruption / unexpected crash".
**Under zun's threat model** (no untrusted JS), exploitation needs an attacker to steer engine behaviour through data. The
realistic paths are the **YARR / RegExp** bugs, but only if the app builds `RegExp` from request data, and the **TypedArray
/ JSON / string** paths. Wasm and most JIT bugs need attacker-shaped code. The decision is in `backports.md`.
