# Plan: native dependencies (T9)

Research only. Goal: for each C/C++/Rust library zun links, decide whether to **keep** it,
use **Zig std**, **port canary's Rust crate** to Zig, or **port the C** to Zig. See
`docs/GAP.md` §4 for the summary table this expands.

Sources read (2026-11-26):

| Tree | Version | Notes |
|------|---------|-------|
| cruller (zun's base) | `f7002b1` | call sites; deps in `scripts/build/deps/*.ts` |
| Bun 1.3.14 | tag `bun-v1.3.14` | for modules cruller cut (libarchive users) |
| Bun canary | `main @ e13b16b` (2026-11-25) | the Rust rewrites under `src/<crate>/` |
| Zig std | 0.17.1, `$(dirname $(readlink -f $(which zig)))/lib/std` | verified with `docs/zig/probes/native-deps.zig` (10 tests, all pass) |

Conventions: line counts are `wc -l` of `*.rs` / `*.zig` and **include tests**. "Canary
removed X" means X is gone from canary's `scripts/build/deps/` and its `LICENSE.md` says
"not linked: `src/…` is derived from parts of it". Anything I did not check by reading
code or running a probe is marked **UNVERIFIED**.

---

## 1. Summary

| Library (cruller) | zun uses it for | Canary replacement | Zig std 0.17.1 | Recommendation | Order |
|---|---|---|---|---|---|
| hdrhistogram | `perf_hooks` histograms (C++) | `src/histogram`, 346 lines | nothing | **port canary** (tiny) | 1 |
| rust-argon2 | — (zun already uses std) | vendored rust-argon2 3.0.0 | `crypto.pwhash.argon2` ✅ matches Node | **keep std** | done |
| crc32/adler32 (from zlib) | `Bun.hash.crc32`, checksums | `bun_highway::crc/adler` | `hash.Crc32`, `Adler32` ✅ | **use std** (+SIMD later) | 1 |
| picohttpparser | HTTP client response head, `Headers` | `src/http1` 7.7k (also replaces uWS's C++ parser) | `http.HeadParser` (finds end only) | **port C → Zig now**, canary's `http1` later | 2 |
| lshpack | HTTP/2 (`node:http2`, fetch h2) | `src/hpack` 3.0k | nothing | **port canary** | 3 |
| libdeflate | one-shot gzip in fetch, WebSocket client | `src/deflate` 5.9k (from libdeflate 1.26) | `compress.flate` (slower, different bytes) | **keep C**, then port canary | 5 |
| zlib (zlib-ng) | `node:zlib`, `Bun.gzipSync`, fetch, WS, crash reports | `src/zlib` 10.1k (from zlib-ng) | `compress.flate` (no sync flush, no dict, no windowBits) | **keep C**; port canary late | 6 |
| zstd | `node:zlib` zstd, `Bun.zstd*`, fetch | `src/zstd` 20.5k (from zstd 1.5.7, reproduces its output) | decoder only, ~6× slower, no dict, no checksum | **keep C**; std decoder only as fallback | 7 |
| brotli | `node:zlib` brotli, fetch `br` | `src/brotli` 14.7k (parts from google/brotli) | nothing | **keep C**; port canary late | 8 |
| libarchive | nothing live (bindings cut; restore needs it for `bun install`, `Bun.Archive`, `pm pack`) | `src/tar` 5.4k + `src/archive` 0.9k | `tar.Iterator` / `tar.Writer` (basic) | **port canary `tar`** at Phase 4 install restore; drop libarchive | 4 |
| c-ares | `dns.resolve*`, `dns.lookup` default backend | `src/dns/client` 9.5k stub resolver (modelled on c-ares) | A/AAAA lookup only | **keep C**; port canary when touching `node:dns` | 9 |
| libjpeg-turbo, libspng, libwebp | `Bun.Image` | `src/jpeg` 4.9k, `src/png` 1.2k, `src/webp` 13.5k | nothing | **png: port canary early**; jpeg/webp keep C | png 4, others 10 |
| ICU | inside the WebKit prebuilt | own `src/icu` 54.8k (ICU C API subset) | nothing | **keep** (comes with WebKit) | — |
| WebSocket framing | uWS C++ + Zig client | `src/websocket` 1.9k | `http.Server.WebSocket` (toy) | port with `http1` | with 2 |

"Order" is a suggested sequence for Phase 6 (and earlier where a restore forces it); lower is
sooner. Rationale: start with small, self-contained, testable crates; leave compression codecs
(large, hot, byte-exactness matters) until a Zig test harness against the C library exists.

---

## 2. What Zig 0.17.1 std provides (verified)

All rows below are exercised by `docs/zig/probes/native-deps.zig` unless they say "read".

| Area | std API | Verified behaviour | Gaps that matter to zun |
|---|---|---|---|
| DEFLATE | `std.compress.flate.{Compress,Decompress,Container}` (`.raw/.gzip/.zlib`) | round-trips all three containers; inflates zlib-ng output | **output bytes differ from zlib-ng** at level 6 (probe); `flush()` is *not* `Z_SYNC_FLUSH` (no guaranteed `00 00 ff ff`, probe) → unusable for permessage-deflate as is; no preset dictionary, no `windowBits` < 15, no `memLevel`/`strategy` (read `flate/Compress.zig:275`); compressor statically ~224 KiB (`Compress.zig:1`) |
| zstd | `std.compress.zstd.Decompress` | decodes a `zstd -19` frame | **no encoder** (`@hasDecl(zstd,"Compress") == false`); `verify_checksum = true` panics, "not implemented yet" (`zstd/Decompress.zig:30`); dictionaries → `error.DictionaryIdFlagUnsupported` (`:931`); needs an 8 MiB window buffer by default |
| xz / lzma / lzma2 | `std.compress.{xz,lzma,lzma2}` | read only | Bun doesn't use these |
| tar | `std.tar.Iterator`, `std.tar.Writer`, `std.tar.pipeToFileSystem` | Writer → Iterator round trip | "not comprehensive … only file types needed for the Zig package manager" (`tar.zig:11`): file/dir/symlink, name/size/mode; no hardlinks, no mtime on extract, no npm `package/` quirks, no gzip in-stream |
| checksums | `std.hash.Crc32`, `std.hash.Adler32` | equal zlib's check values for `"123456789"` | scalar; zlib-ng / highway use SIMD (CRC32 via PCLMUL) — speed **UNVERIFIED** |
| argon2 | `std.crypto.pwhash.argon2.{kdf,strHash,strVerify}` | argon2id output equals Node 26 `crypto.argon2Sync`; PHC string round trip | rejects `m < 8·p` with `WeakParameters` (`argon2.zig:501`); canary patched rust-argon2 to *accept* such old hashes (`patches/rust-argon2/legacy-low-memory.patch`) |
| bcrypt | `std.crypto.pwhash.bcrypt` | read | already used by zun's `Bun.password` |
| HTTP/1 | `std.http.HeadParser`, `ChunkParser`, `HeaderIterator`, `Client`, `Server` | `HeadParser.feed` finds the end of a head | finds the boundary only; no strict tokenizer, no request-smuggling rules; `Server` is blocking `std.Io` style, not usable under uWS |
| HPACK / QPACK | none | `grep -ri hpack lib/std` → nothing | — |
| DNS | `std.Io.net.HostName.lookup`, `.expand`, `DnsResponse`, `ResolvConf` | read (`Io/Threaded.zig:13942`) | A/AAAA only, `/etc/hosts` + `/etc/resolv.conf`, its own UDP client unless glibc; no MX/TXT/SRV/NS/PTR/CAA/NAPTR/SOA, no `setServers`, no TTLs; tied to `std.Io`, not to zun's event loop |
| Images | none | — | — |
| WebSocket | `std.http.Server.WebSocket` | read | small messages only, no permessage-deflate |

Rough speed, one run each on a 13.4 MB corpus (std sources concatenated), `ReleaseFast`,
script in the session scratchpad (not committed), so treat as indicative only:

| Operation | Zig std | C (zlib-ng via Python / zstd CLI) |
|---|---|---|
| gzip level 6 | 233 ms, 2 504 811 B | 152 ms, 2 464 341 B |
| gunzip | 25 ms | 18 ms |
| zstd decompress | 87 ms | ~13 ms (whole CLI process) |

Conclusion: std is a fine **correct fallback** for decompression and checksums, and the right
home for argon2/bcrypt. It is not a drop-in for zlib, zstd or brotli in a runtime that has to
match Node byte-for-byte and be fast.

---

## 3. Per library

### 3.1 zlib (zlib-ng) — keep C for now

**(a) zun use.** Biggest compression surface. `src/zlib/zlib.zig` (966 lines) wraps the
zlib stream API (`deflateInit2`, `inflateInit2`, `deflate`, `inflate`, `crc32`,
`compress2`…, ~25 distinct functions); `src/zlib_sys/posix.zig` (132). Callers:
`node:zlib` (`src/runtime/node/zlib/NativeZlib.zig` 369, `node_zlib_binding.zig` 396),
`Bun.gzipSync/deflateSync/inflateSync/gunzipSync` (`src/runtime/api/BunObject.zig:1349`),
fetch body decoding (`src/http/Decompressor.zig`), WebSocket client permessage-deflate
(`src/http_jsc/websocket_client/WebSocketDeflate.zig`), `Bun.hash.crc32`
(`src/runtime/api/HashObject.zig:15`), crash-report compression
(`src/crash_handler/crash_handler.zig:1361`), `--compile` target download
(`src/options_types/CompileTarget.zig:231`). `node:zlib` exposes everything: `windowBits`,
`memLevel`, `strategy`, dictionaries, `params()`, every flush mode.

**(b) canary.** `src/zlib` (`bun_zlib`), 10 105 lines, "Derived from zlib-ng" (zlib licence),
`#![forbid(unsafe_code)]`, streaming `Deflater`/`Inflater`, gzip/zlib/raw. I/O-free. It calls
C++ Highway kernels for checksums (`bun_highway::{crc,adler,zlib}`), so it is not free of C++.
Missing features vs zlib-ng: not checked in depth (**UNVERIFIED**); test suite at
`src/zlib/tests/`.

**(c) std.** See §2: different output bytes, no sync flush, no dictionaries, no small
windows, ~1.5× slower compression. Node tests compare compressed bytes in places
(`test/js/node/test/parallel/test-zlib-*.js`, **UNVERIFIED** which ones), so swapping
compressors changes observable behaviour.

**(d) Recommendation.** Keep zlib-ng until Phase 6. Then port `bun_zlib` (≈10k lines of safe
Rust, mechanical) with a differential test harness that runs the C and Zig versions on the
same inputs and flush sequences. Use `std.hash.Crc32` for `Bun.hash.crc32` now if convenient.
Risk: high (hot path, byte-exact output, big API). Size: L.

### 3.2 libdeflate — keep C, then port canary's `deflate`

**(a)** `src/libdeflate_sys/libdeflate.zig` (150 lines, ~20 functions). One-shot fast path for
fetch when the whole gzip body is in memory (`src/http/InternalState.zig:129`) and the
WebSocket client (`WebSocketDeflate.zig:15`). Gated by `feature_flags.libdeflate_supported`.

**(b)** `src/deflate` (`bun_deflate`), 5 859 lines, "One-shot DEFLATE, gzip and zlib, derived
from libdeflate 1.26" (MIT), safe Rust, I/O-free, uses `bun_highway`. Canary keeps both
`deflate` (one-shot, fast) and `zlib` (streaming), as Bun did with C.

**(c)** `flate.Decompress` covers the decode side correctly but slower (§2).

**(d)** Easiest codec to port after the image/http work: self-contained, one-shot API,
6k lines. Until then keep C. Alternative cheap step: drop libdeflate and use zlib-ng for the
fast path (one less dep, small speed cost, **UNVERIFIED** how much). Risk: medium. Size: M.

### 3.3 brotli — keep C

**(a)** `src/brotli/brotli.zig` (287) + `src/brotli_sys/brotli_c.zig` (334), ~30 functions:
`node:zlib` Brotli streams (`NativeBrotli.zig` 282) and fetch `Content-Encoding: br`.

**(b)** Not dropped: canary **replaced** the C library with `src/brotli` (`bun_brotli`),
14 708 lines, "Brotli (RFC 7932), with large windows and raw dictionaries (RFC 9841). Parts
derive from google/brotli" (MIT). Encoder **and** decoder (qualities 0–11,
`encoder/params.rs:9`), streaming decoder, `dictionary.bin` built in. Safe Rust, uses
`bun_highway::brotli`. So "brotli removal" = the C library is gone, not the feature.

**(c)** std has no brotli at all.

**(d)** Keep C. Porting 15k lines of encoder heuristics is large and the output must match
google/brotli for Node parity. Do it after zlib, or never if C brotli is not in the way.
Risk: high. Size: L.

### 3.4 zstd — keep C; std decoder as fallback only

**(a)** `src/zstd/zstd.zig` (275, ~25 `ZSTD_*` functions): `Bun.zstdCompress[Sync]` /
`zstdDecompress[Sync]` (`BunObject.zig:42`), `node:zlib` zstd (`NativeZstd.zig` 281), fetch
`zstd` encoding.

**(b)** `src/zstd` = `bun_zstd_decoder` + `bun_zstd_encoder` (20 116 lines together) + glue.
"Derived from zstd 1.5.7 … whose output it reproduces, and whose numbers it uses"
(`src/zstd/encoder/lib.rs:1`), BSD/GPLv2 dual. Safe Rust. Canary also uses it to compress
embedded assets (`src/zstd/embed.rs`) and ICU data (`src/icu_data`).

**(c)** std: decompression only, no checksum verification, no dictionaries, ~6× slower in my
one-run benchmark.

**(d)** Keep C. If a pure-Zig fallback is wanted (e.g. for a minimal build), std's decoder
works for `Bun.zstdDecompress`. A full port is the largest of the codecs. Risk: high. Size: XL.

### 3.5 libarchive — replace with canary's `tar` at the install restore

**(a)** Cruller cut the bindings (`src/bun.zig:294` "bzrt-cut", `src/jsc/Task.zig:8`) but
still builds and links libarchive (`scripts/build/deps/index.ts:54`) and reports its version
(`BunProcess.cpp:225`). `CompileTarget.zig:225` still calls `bun.libarchive` in a function
Zig never analyses. In Bun 1.3.14, `src/libarchive/libarchive.zig` (688 lines) served
`bun install` (`install/extract_tarball.zig`, `TarballStream.zig`, `NetworkTask.zig`),
`bun pm pack`/`publish`, `bun create`, `bun upgrade`, `Bun.Archive`
(`runtime/api/Archive.zig`) and `--compile` cross targets.

**(b)** `src/tar` (`bun_tar`) 5 352 lines, "tar and gzip framing without I/O, behaving as
libarchive did. Parts derive from it" + `src/archive` (`bun_archive`) 919 lines that extracts
to disk (the only crate here without `forbid(unsafe_code)`). Handles npm quirks
(`tar/npm.rs`), charsets and Windows name composition (`tar/compose.rs`), writing
(`tar/writer.rs`), gzip through `bun_zlib`/`bun_deflate`.

**(c)** `std.tar` is enough for Zig's package manager, not for npm tarballs (§2). Useful as a
reference and for tests.

**(d)** Until install comes back (Phase 4), **drop libarchive from the build** (it is dead
weight; keep the version string or remove it). When restoring `bun install`, port `bun_tar` +
`bun_archive` (~6k lines, I/O-free, good tests) instead of re-wiring libarchive. Risk: medium
(npm edge cases: long names, pax, odd modes, symlinks escaping the target). Size: M.

### 3.6 c-ares — keep C until `node:dns` work

**(a)** `src/cares_sys/c_ares.zig` (1 553 lines, ~60 `ares_*` functions incl. every
`ares_parse_*_reply`), `src/runtime/dns_jsc/cares_jsc.zig` (612), `dns.zig` (3 648).
`dns.resolve4/6/Mx/Txt/Srv/Ns/Ptr/Caa/Naptr/Soa/Cname/Any`, `Resolver#setServers`,
`dns.reverse`, and the default backend of `dns.lookup`/`Bun.dns.lookup` (`src/dns/dns.zig:163`,
backends `c-ares`/`system`/`libc`). uSockets also references it (`uws_sys/libuwsockets.cpp`).

**(b)** Canary uses its own stub resolver: `src/dns/client` (`bun_dns_client`), "A DNS stub
resolver without I/O of its own. It is modeled on c-ares, and parts derive from it" (MIT):
message codec, `/etc/hosts`, `resolv.conf`, server rotation, cache, RFC 6724 sorting. Total
`src/dns` 9 535 lines + `runtime/dns_jsc` 3 591. The label `"c-ares"` still selects a backend
(`src/dns/lib.rs:363`), now served by this crate. `getaddrinfo` remains for the `libc`/`system`
backends.

**(c)** `std.Io.net.HostName.lookup` does A/AAAA with hosts + resolv.conf and has a DNS name
decompressor (`expand`) and answer iterator (`DnsResponse`). Useful building blocks; far from
c-ares's API.

**(d)** Keep c-ares now. Port `bun_dns_client` when `node:dns` parity work starts (it is
I/O-free, so it plugs into zun's own event loop). Risk: medium-high (Node's error codes and
ordering). Size: L.

### 3.7 picohttpparser (+ uWS's HTTP parser) — port early

**(a)** `src/picohttp_sys` (30 lines, `phr_parse_request/response/headers`, chunked decoder)
and `src/picohttp/picohttp.zig` (386) used by 16 Zig files: fetch/HTTP client, S3, h2/h3
client header plumbing (`src/http/*.zig`, `runtime/webcore/fetch*.zig`). The **server** side
parses with uWS's C++ `packages/bun-uws/src/HttpParser.h`, not picohttpparser.

**(b)** `src/http1` (`bun_http1`) 7 708 lines, "HTTP/1.1 framing without I/O. Parts derive
from picohttpparser, llhttp and uWebSockets": request + response + chunked parsers with RFC
9110 byte sets. It replaces both the client parser and the uWS server parser.

**(c)** `std.http.HeadParser` only finds `\r\n\r\n`; no tokenizer worth reusing.

**(d)** Two steps. (1) Port picohttpparser's C (~700 lines in upstream, **UNVERIFIED**) to Zig
behind the existing `picohttp.zig` API: small, well-tested, removes one C dep, teaches SIMD in
Zig (`@Vector`). (2) Later port `bun_http1` when replacing the uWS server parser (that is part
of the bigger uWS question). Risk: low (1), high (2: request smuggling). Size: S then L.

### 3.8 lshpack — port canary's `hpack`

**(a)** `src/http/lshpack.zig` (75 lines, ~13 functions, plus C shim in
`jsc/bindings/c-bindings.cpp`) used by `node:http2` (`runtime/api/bun/h2_frame_parser.zig`,
4 879 lines) and the fetch HTTP/2 client (`http/h2_client/*`).

**(b)** `src/hpack` (`bun_hpack`) 3 040 lines, RFC 7541, "Parts derive from ls-hpack" (MIT),
I/O-free, safe Rust, decoder + encoder + Huffman + dynamic table, `tests/codec.rs`.

**(c)** Nothing in std.

**(d)** Good early port: small, a pure function of bytes, RFC test vectors exist (RFC 7541
appendix C). Risk: low-medium. Size: S–M.

### 3.9 libjpeg-turbo, libspng, libwebp (`Bun.Image`)

**(a)** `src/runtime/image/codec_{jpeg,png,webp}.zig` (176/197/168 lines) — thin `extern fn`
wrappers (`runtime/image/README.md`). BMP and GIF are already Zig (`codec_bmp.zig`,
`codec_gif.zig`).

**(b)** Canary: `src/jpeg` 4 853 lines ("derives from libjpeg-turbo 3.2.0", IJG/BSD/zlib;
baseline, progressive, arithmetic, lossless decode; `Error::Unsupported` for other kinds),
`src/png` 1 202 lines ("Parts derive from libspng"; "byte for byte what libspng wrote with the
same zlib", `src/png/encoder.rs`; uses `bun_zlib` and highway filter kernels), `src/webp`
13 483 lines ("Derived from libwebp", BSD-3; **still images only**, "animations are not
supported"). All decode/encode 8-bit RGBA only.

**(c)** Nothing in std (PNG would use `std.compress.flate` + `Crc32`).

**(d)** PNG: port canary now-ish (1.2k lines; with std flate the encoder output will differ
from libspng+zlib-ng, acceptable for images but note it). JPEG and WebP: keep C until a
reason appears; JPEG decode is a well-bounded port later (5k), WebP encoder is big (13k).
Risk: medium (fuzzing needed: images are untrusted input). Size: S (png), M (jpeg), L (webp).

### 3.10 hdrhistogram — port canary's `histogram` first

**(a)** C++ only: `jsc/bindings/JSNodePerformanceHooksHistogram.cpp` (285 lines, 19 `hdr_*`
calls) and one call in `webcore/SerializedScriptValue.cpp` for `perf_hooks.createHistogram()`
and `monitorEventLoopDelay()`.

**(b)** `src/histogram/lib.rs`, 346 lines, single file, no dependencies, "The layout and the
results are those of HdrHistogram" (CC0/BSD-2), deliberately differs where Node/the C lib
overflow (marked "Node.js:"). Sparse 4 KiB chunks instead of one big array.

**(c)** Nothing in std.

**(d)** Ideal first port: small, pure, needs a C ABI export for the C++ caller. Good
learning task for Zig (integer math, `@clz`, exporting `callconv(.c)` functions). Risk: low.
Size: S.

### 3.11 argon2 — already Zig std; keep it

**(a)** `src/runtime/crypto/PasswordObject.zig` uses `std.crypto.pwhash.{argon2,bcrypt}` (as
Bun 1.3.14 did).

**(b)** Canary is Rust, so it vendored rust-argon2 3.0.0 with two patches: accept `m < 8·lanes`
for old hashes and return an error on allocation failure
(`scripts/build/deps/rust-argon2.ts`).

**(c)** Verified: std argon2id equals Node's `crypto.argon2Sync`; `strHash`/`strVerify` PHC
strings work. std refuses `m < 8·p` (`argon2.zig:501`).

**(d)** Keep std. Open question: did any Bun version emit hashes with `m < 8`? Canary's patch
says yes; if those hashes must verify in zun, we need a small wrapper or a std patch
(**UNVERIFIED** which version produced them).

### 3.12 ICU

**(a)** Comes inside the WebKit prebuilt (`scripts/build/deps/webkit.ts`); used by JSC for
`Intl`, normalisation, collation; zun has no direct calls.

**(b)** Canary ships its own `src/icu` (54 821 lines, "A part of ICU's C API … Derived from
ICU4C 79.1"; macOS uses the system ICU) plus `src/icu_data` (zstd-compressed ICU data).
Canary needed this because its WebKit build no longer bundles ICU (**UNVERIFIED** exact
reason; see `src/icu/README.md`).

**(d)** Keep whatever the WebKit prebuilt provides. Revisit only if zun builds WebKit itself.

### 3.13 WebSocket framing

Not a C library in cruller (server: uWS C++; client: Zig + libdeflate/zlib). Canary's
`src/websocket` (1 861 lines, RFC 6455/7692, shares deflate contexts) is the reference when
the uWS server is replaced. Note: permessage-deflate needs real `Z_SYNC_FLUSH` semantics,
which std flate lacks (probe test 4).

---

## 4. Dependencies nobody replaced

Canary still lists these in `scripts/build/deps/` (plus rust-argon2, nodejs-headers).

| Dep | Outlook for zun |
|---|---|
| WebKit / JavaScriptCore | Stays C++ for the foreseeable future (ROADMAP Phase 6, maybe forever). Prebuilt from oven-sh/WebKit. |
| BoringSSL | Keep. `std.crypto.tls` is client-focused and lacks Node's `crypto` surface (X.509 APIs, ciphers, engines); rewriting a TLS/crypto library is not worth the risk. |
| lsquic | Keep (HTTP/3, QUIC). Huge, protocol-heavy; Bun itself kept it. |
| lsqpack | Keep with lsquic (only `uws_sys/quic/Header.zig` touches it). Possibly port later alongside an hpack port since QPACK shares ideas. |
| mimalloc | Keep. JSC and Bun's allocator story depend on it; a Zig allocator replacement is a research project of its own. |
| sqlite | Keep (`bun:sqlite`, amalgamation in-tree). Rewriting SQLite is not a goal. |
| tinycc | Keep while `bun:ffi` `cc()` exists (`src/tcc_sys`); LGPL — consider making it optional. |
| highway | Keep. Note canary's Rust codecs **call highway's C++ kernels** (crc/adler/brotli/webp/png filters), so porting a codec from canary means either keeping highway or writing those kernels with Zig `@Vector`. |
| lolhtml | Keep (`HTMLRewriter`). It is **Rust**, and the only cargo-built dep in cruller (`scripts/build/deps/lolhtml.ts:5`): the last reason zun's build needs a Rust toolchain. Long term, a Zig HTML rewriter would remove cargo entirely (large: streaming HTML tokenizer + CSS selectors). |
| libuv | Windows only; unused on zun's Linux target. Matters again only if T10 restores Windows. |
| simdutf (not in the list but linked) | Keep; Bun kept it. |

---

## 5. Suggested order and checkpoints

1. **Remove dead weight**: stop building libarchive (and libuv on Linux, if it is built). Checkpoint: binary links, `process.versions` adjusted.
2. **hdrhistogram → Zig** (port of `src/histogram`, ~350 lines). Learn C-ABI exports. Checkpoint: `perf_hooks` histogram tests.
3. **picohttpparser → Zig** (port the C). Checkpoint: fetch tests.
4. **lshpack → Zig** (port `src/hpack`). Checkpoint: `node:http2` + RFC 7541 vectors.
5. **PNG → Zig** (port `src/png` on std flate). Checkpoint: `Bun.Image` PNG tests; document byte differences.
6. **libarchive → Zig `tar`** when Phase 4 restores `bun install`.
7. Build a **differential test harness** (C vs Zig, same inputs, all flush modes) before touching any codec.
8. **libdeflate → Zig**, then **zlib**, then **c-ares** (with `node:dns` work), then **brotli/zstd/jpeg/webp** only if worth it.

Each port: copy the canary crate's tests first, keep the C library linked behind a build
flag until the Zig version passes them plus Bun's JS tests, and keep attribution
(`LICENSE.md` rows saying "derived from").

## 6. Open questions

- Which Node tests depend on exact compressed bytes? (Decides whether std flate is ever acceptable for `node:zlib`.)
- Do we accept keeping highway's C++ kernels, or write SIMD kernels in Zig?
- Old `Bun.password` hashes with `m < 8`: real or theoretical? (§3.11)
- Removing lolhtml is the only way to a cargo-free build; is that a goal?
