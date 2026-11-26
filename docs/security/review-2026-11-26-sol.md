# Independent security review of bootstrap

Reviewed `0a5b26b` on Linux, including the six commits below. Findings come from source, history, and local copies
of the pinned dependencies and Bun 1.4.5. I used no build, network, or runtime probes. The report marks
runtime-dependent claims as unconfirmed where source inspection leaves a prerequisite unresolved.

## C1 — Brotli pin and error ABI (`acc46d5`, RCA in `2eb78ec`)

The cached archive matches the pin in `scripts/build/deps/sha256sums.txt` and its `c/common/version.h` reports
1.2.1. The pinned C decoder returns `FORMAT_BLOCK_SWITCH` and both Zig C-ABI enums represent `-17` and unnamed
`c_int` values (`src/brotli_sys/brotli_c.zig:25,133–196`). The HTTP reader uses optional `std.enums.tagName`
(`src/brotli/brotli.zig:147–152`), and Node zlib has an explicit fallback
(`src/runtime/node/zlib/NativeBrotli.zig:261–273`). I found no remaining exhaustive conversion or unchecked tag
lookup in these error paths.

- **Low · C1-1 — The gate misses the new decoder error and the unknown-code fallback.**
  `test/js/node/test/parallel/test-zun-brotli.js:36–55,98–104` requires a string code from any errors and more than
  100 errors overall. The `/bad` case accepts either outcome. A build with the fix removed can still satisfy those
  assertions if the inputs never reach the affected branches. The RCA acknowledges the missing `-17` case at
  `docs/rca/C1-brotli-exhaustive-error-enum.md:39–43`. The round trips and fixture are genuine functional tests.
  Add deterministic coverage that asserts `ERR_BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH` and exercise the
  production mapping with an injected unknown integer. The standalone enum probe establishes Zig semantics only.

## C2 — NSS roots and blocked SPKIs (`413dec6`)

`certdata.txt` hashes to `3ec2b4d240dc12c747eaf450061db84af757c483bbda302f9e29ceb5d70be510`, identical to Bun
1.4.5. I counted 118 PEM entries in `packages/bun-usockets/src/crypto/root_certs.h`. G1 is the only emSign entry.
The eight hashes in `blocked_spkis.cpp:17–54` match Bun 1.4.5. The checker covers the built chain and, on a
verification error, the remaining peer-supplied chain (`blocked_spkis.cpp:115–121`).

- **High · C2-1 — A blocked key is treated as an ordinary overridable verification error.**
  `packages/bun-usockets/src/crypto/openssl.c:430–460` writes `CERT_REVOKED`, then returns the result of the
  per-SSL callback. `us_verify_callback` and the callback installed by
  `src/runtime/socket/tls_socket_functions.zig:566–583` both return `1`. With `rejectUnauthorized:false`, fetch
  proceeds to `firstCall` (`src/http/HTTPContext.zig:397–421`). `node:tls` likewise permits the connection and
  skips its identity callback when `verifyError` is present (`src/js/node/net.ts:253–276,410–436,570–591`). A
  caller combining permissive verification with a custom identity check can therefore get neither enforcement.
  Strict fresh TCP fetch and `node:tls` stop on chain errors before that callback can override them. Raw
  `Bun.connect` and `Bun.listen` also inherit the open H6 enforcement gap. Their exposed `authorized` flag reflects
  handshake success, so it can read `true` with a recorded revocation error
  (`src/runtime/socket/socket.zig:616–626,669–679,815–817`). QUIC clients with verification disabled return
  `ssl_verify_ok` before looking at the chain (`packages/bun-usockets/src/quic.c:1079–1104`). Decide and document
  whether the incident blocklist is unconditional. To implement the documented hard block, give it a dedicated
  fatal path ahead of ordinary certificate policy and ensure BoringSSL's `SSL_VERIFY_NONE` handling cannot turn it
  into a soft failure.

- **High · C2-2 — An HTTP/3 listener can accept a blocked or untrusted client certificate in strict mTLS mode.**
  `packages/bun-usockets/src/quic.c:662–714` uses a raw uSockets context, which requests the client certificate but
  allows certificate errors via `us_verify_callback`. The H3 connection and stream handlers dispatch without
  consulting `SSL_get_verify_result` (`quic.c:479–503,541–570`). TCP `Bun.serve` checks the result before dispatch
  (`packages/bun-uws/src/HttpContext.h:152–163`). A configured H3 listener can therefore complete a handshake with
  a presented but rejected certificate and still dispatch the request. This is the client-auth enforcement part of
  open H3. Enforce client-auth failures inside the QUIC server's TLS verification and cover both an untrusted and a
  blocked client certificate.

- **Medium · C2-3 — Resumed node:tls sessions use the old verification result.**
  `src/runtime/socket/tls_socket_functions.zig:497–506` deserializes and installs a caller-supplied session. The
  pinned BoringSSL TLS 1.2 client branches directly to reading the ticket on resumption unless `reverify_on_resume`
  is enabled (`ssl/handshake_client.cc:819–829`), and TLS 1.3 likewise gates re-verification
  (`ssl/tls13_client.cc:749–757`). There is no zun call enabling it. `ssl/ssl_asn1.cc:195–198,570` persists
  `verify_result`, and `openssl.c:768–784` trusts it. An application reusing an exported, still-valid session
  across the C2 upgrade can retain an old OK result for a now-blocked peer. The mechanism is present. Resumption of
  a pre-upgrade ticket remains **unconfirmed** on the snapshot. Ordinary resumed TCP sessions with a retained peer
  certificate and an existing `CERT_REVOKED` result retain that error. Re-check the cached chain against current
  policy before accepting resumed authentication, or force a full handshake for sessions created under an older or
  different policy. The QUIC client supplies no TLS resumption blob to lsquic (`quic.c:1240–1242`).

- **Low · C2-4 — The test proves only strict TCP client enforcement and fails by design on release.**
  `test/js/node/test/parallel/test-zun-tls-blocked-spki.mjs:15–45` has a meaningful unblocked control and asserts
  revocation for a leaf and an intermediate in both strict clients. It exercises the injected hashes only, so it
  passes if the production table is removed. It also always runs the debug-only checks, so a correctly compiled
  release fails the assertions. Split the debug handshake cases from release-safe assertions. Add a native unit
  test that checks hashes from the real certificates, plus coverage for permissive mode, strict client
  authentication, QUIC, and resumed sessions.

`node:tls` `SecureContext` goes through `NativeSecureContext.intern` and `SSLContextCache` to the same uSockets
constructor (`src/js/node/tls.ts:410–471`, `src/runtime/api/bun/SecureContext.zig:54–56,81–103`,
`src/runtime/api/bun/SSLContextCache.zig:91–95`). The duplex wrapper keeps that context and changes only the
per-SSL verification callback (`src/runtime/socket/ssl_wrapper.zig:57–113`). I found no live connection caller of
the independent `ncrypto.cpp:3102–3124` constructors or the accept-all `src/boringssl/boringssl.zig:24` helper. The
release guard for the **environment hook** is present at `blocked_spkis.cpp:63–87,115–118`. Standard release
profiles omit `BUN_DEBUG` (`scripts/build/config.ts:554–555`, `scripts/build/flags.ts:631–635`). The native
`us_add_blocked_spki_for_testing` and `us_clear_blocked_spkis_for_testing` functions and their vector still compile
(`blocked_spkis.cpp:61,100–102,124–132`). They have no callers in zun, so I found no release environment or JS
route to those mutations. Removing the unused mutators or gating them with the test hook would also remove their
unsynchronized mutation hazard.

## H1 — Strict chunked decoding and the picohttpparser ABI (`c17a851`)

I checked the pinned C header against `src/picohttp_sys/picohttpparser.zig:18–33`. The existing layout agrees at 32
bytes with the new counters at offsets 16 and 24. Both TCP and CONNECT EOF handlers query the C decoder for trailer
state (`src/http/http.zig:385–399`, `src/http/ProxyTunnel.zig:237–247`). The chunk patch is byte-identical to Bun
1.4.5 and the current ABI matches. The malformed chunk-size cases in the test can fail on the old parser. The valid
cases check exact output and prevent an always-reject implementation from passing.

- **Medium · H1-1 — Framing-only responses still use unbounded work.**
  `patches/picohttpparser/chunked-decoder.patch:16–27` deletes upstream's decoded-payload-relative framing budget.
  The pinned decoder loops through chunk extensions and trailer lines until a delimiter arrives
  (`vendor/picohttpparser/picohttpparser.c:587–608,658–678` in the integration checkout). An upstream endpoint can
  keep sending framing while delivering no body bytes. `src/http/http.zig:2067–2073` resets the idle timeout on
  receipt, so it does not cap the work or time spent by a normally active peer. The old pin also lacked a budget,
  so this part of H1 remains open. Bound extension bytes per line, trailer bytes per response and aggregate framing
  with a budget that still admits legitimate one-byte chunks. Test framing delivered over multiple reads.

- **Medium · H1-2 — Trailer termination still accepts malformed framing, and same-read surplus is discarded.** In
  the pinned C decoder, `CHUNKED_IN_TRAILERS_LINE_HEAD` skips carriage returns and accepts a bare LF as the trailer
  terminator (`vendor/picohttpparser/picohttpparser.c:658–678`). Both callers set `consume_trailer = 1` and treat
  every nonnegative return as successful completion, although a positive return explicitly means undecoded bytes
  remain (`src/http/http.zig:2676–2693,2712–2726,2744–2769,2794–2805`). A peer can supply a malformed trailer
  terminator and additional bytes in the same read and fetch will finish the body while discarding the extra bytes.
  This precedes the idle-socket data handler tracked in H2. Validate trailer line endings, reject or retire the
  connection on unexplained surplus, and cover both cases in the strict parser suite.

- **Low · H1-3 — The EOF test misses the specific state collision.** The pinned C enum orders
  `CHUNKED_IN_CHUNK_DATA`, `CHUNKED_IN_CHUNK_DATA_EXPECT_CR`, and `CHUNKED_IN_CHUNK_DATA_EXPECT_LF` as 3, 4, and 5
  (`vendor/picohttpparser/picohttpparser.c:521–530`). The old Zig mirror interpreted 4 and 5 as trailers. The RCA
  misidentifies 4 as the mid-data state (`docs/rca/H1-picohttpparser-abi-drift.md:25–33`). The mid-chunk test in
  `test/js/node/test/parallel/test-zun-fetch-chunked.mjs:17–23` ends in state 3 and can pass with the stale check.
  Add TCP and CONNECT cases that end after the full data bytes at the missing or partial chunk terminator, and
  correct the RCA. The current predicate handles these states correctly by inspection.

- **Low · H1-4 — The ABI assertions give incomplete drift coverage.**
  `patches/picohttpparser/zun-abi-check.patch:10–12` and `src/picohttp_sys/picohttpparser.zig:25–28` assert size
  and the two final offsets only. A future layout could move `consume_trailer` within the prefix and pass both
  guards while Zig writes the old offset (`src/http/http.zig:2676–2678,2744–2746`). Generate the binding from the
  patched header or compare alignment and all field offsets that cross the ABI. This is a future-bump guard gap.
  The pinned layout is correct.

## H8 — c-ares (`739e27b`)

I found no pin or binding problem in H8. `scripts/build/deps/cares.ts:15–20,60–73` uses the peeled commit
`bc91829cce983a35ec01f5dbc05465858a3df469`. The local cached archive hashes to
`35a5dea65375c6050695cbea5c670f13f215af13c06b9d3918b99ac7a8ea9fa7`, as pinned in `sha256sums.txt`, and
`include/ares_version.h` reports 1.34.9. All 91 listed source files exist, and the release adds no C source under
`src/lib`. The public-header diff changes version macros, comments, and adds the `ARES_CLASS_HESIOD` alias at the
existing value 4.

- **Low · H8-1 — The DNS smoke suite does not prove the security bump.** `git show 739e27b` changes the pin and
  documentation only. There is no `test-zun-*` regression for H8. The recorded 18/23 DNS passes on both versions
  cannot detect a linked rollback. Add a gate for the linked library version and, where practical, port the
  corresponding upstream c-ares regression tests.

## Supply chain (`eaca93d`)

The ordinary fresh fetch path requires the original URL's pin before network access, verifies network and copied
`by-url` bytes before rename, and uses the verified digest for the stamp (`scripts/build/download.ts:203–246`). I
found no redirect-based content-verification bypass. The digest is checked against the original URL even if the
transport follows a redirect. `tryPrefetchExtracted()` always returns false (`download.ts:175–182`). Ordinary
download and extraction are separated by checksum verification, subject to the cache and pathname issues below.

- **High · SC-1 — Writable extracted trees are trusted by stamp.** `scripts/build/fetch-cli.ts:159–174` and
  `scripts/build/download.ts:367–378` compare stamp text to the public archive pin and skip content verification. A
  writer with access to an extracted WebKit cache can change an input library or header while leaving valid stamps.
  The subsequent build can link those bytes even if the fetch rule runs. Ninja's pins input and stamp output
  (`scripts/build/source.ts:974–983,1030–1042`) do not authenticate tree contents. Keep extracted outputs within
  the build user's trust boundary, and verify contents against a trusted manifest or extract the verified archive
  in private storage before a production build consumes it. The prebuilt concurrent-winner branch checks only
  `.identity` (`download.ts:425–437`), so check the same complete provenance there.

- **High · SC-2 — Archive verification and extraction use separate pathname lookups.**
  `scripts/build/download.ts:212–215,230–245` verifies a named temporary file then renames by path.
  `scripts/build/fetch-cli.ts:183–207` verifies the shared cached tarball, awaits deletion and creation of `dest`,
  then `download.ts:286–293` opens the tarball by name again. A process with write access to that cache can replace
  the verified file between those operations, with no corresponding change to the stamp. In addition,
  `createWriteStream(tmpPath)` lacks exclusive creation. Create files exclusively in a private directory, copy
  shared inputs into it, and verify and extract the same protected bytes. Stage and publish the tree as a unit and
  serialize publication where checkouts share a destination.

- **Medium · SC-3 — The prefetch producer extracts existing archives without verifying them.**
  `scripts/prefetch-deps.ts:150–174` skips verification on a `by-url` hit, then calls `extractZip` or
  `extractTarGz` at `:176–198` if a fresh extracted tree is needed. The inherited warm-image bootstrap invokes the
  helper from a separate upstream checkout (`scripts/bootstrap.sh:1844–1862`). The normal build ignores these
  extracted outputs, but the bake has already processed the unverified archive. The post-extract hoist assumes the
  sole top-level entry is a directory (`prefetch-deps.ts:195–198`, `download.ts:412–423`). If it is a symlink,
  cleanup and stamp paths can resolve outside staging even with GNU tar's ordinary member-path protections. Drop
  pre-extraction from the producer, or verify every input before extracting and reject link-based escapes and
  non-directory hoist entries. I did not identify a remotely supplied traversal that survives normal pinned
  verification on a private cache.

- **Medium · SC-4 — Two compiler acquisition paths still bypass mandatory verification.**
  `scripts/build/zig.ts:433–448,662–684` neither tracks the pins file nor requires a pin before accepting a
  matching `.zig-commit`. An existing pre-change `vendor/zig` can be used without checking the archive, although a
  fresh unpinned network download fails. Separately, the LLVM instructions in `docs/build.md:13–18` put the failing
  `sha256sum -c` and `tar` on independent lines. Executing that block in an ordinary shell can continue to unpack
  and subsequently use a mismatching compiler. Remove the obsolete auto-Zig path or verify it on both cache and
  fresh paths. Make LLVM extraction conditional on successful verification, as the adjacent Perl setup already
  does.

- **Medium · SC-5 — Pin recording and legacy provisioning escape the advertised build guarantee.**
  `ZUN_PIN_RECORD=1` lets `requirePin` accept an unknown URL, and `verifyPinnedFile` appends the observed digest
  and returns success to the same build (`scripts/build/download.ts:71–107`). A CI environment carrying that
  setting could compile a previously unreviewed artifact. The musl build also downloads and extracts Zig directly
  (`musl.Containerfile:22–29`), and the inherited bootstrap installs a downloaded Bun and runs a downloaded LLVM
  installer (`scripts/bootstrap.sh:1028–1035,1168–1172`). None of those paths uses the new manifest. `BUN_ZIG_PATH`
  and local WebKit remain explicit trust inputs (`scripts/build/zig.ts:413–426`,
  `scripts/build/deps/webkit.ts:157–205`). Move pin generation into a command that records candidates without
  building with them. Require reviewed compiler artifacts for production and retire or integrity-pin the legacy
  provisioning paths. Existing toolchain and package-manager provenance gaps are already recorded in
  `supply-chain.md`.

No `test-zun-*` test covers this build change. Its documented wrong-pin, missing-pin, and correct-pin checks cover
the selected fetch rule, but leave SC-1 through SC-5 untested. Add negative tests for a replaced extracted artifact
with valid stamps and a reused unverified prefetch archive, alongside the fresh-pin and raw-cache cases.
`docs/security/supply-chain.md` should clearly label its pre-change gaps and describe stamps as download metadata.

## FETCH-1 — Direct fetch and per-request TLS (`825ac11`)

The restored tasklet forwards `reject_unauthorized`, `tls_props` and the identity signal to `AsyncHTTP`
(`src/runtime/webcore/fetch/FetchTasklet.zig:1146–1178`). On direct TCP, `cert` and `key` enter the custom SSL
context (`src/http/HTTPThread.zig:256–304`, `src/runtime/socket/SSLConfig.zig:92–103,410–416`,
`packages/bun-usockets/src/crypto/openssl.c:518–539`), and `serverName` reaches SNI and hostname verification
(`src/http/http.zig:60–77,207–226`). Ordinary TCP H1 and H2 reuse compare the interned SSL configuration, so
different explicit CA, key, cert, or server-name configurations get different pool entries. The H1 error and tunnel
guards are at `src/http/HTTPContext.zig:647–685`.

- **High · F-1 — `tls.ca` augments trust instead of restricting it.** Custom TCP contexts enter
  `us_ssl_ctx_build_raw`. Both CA branches initialize the store from `us_get_default_ca_store`, and in-memory CAs
  are added with `X509_STORE_add_cert` (`packages/bun-usockets/src/crypto/openssl.c:350–370,546–582`). The default
  store already contains bundled and extra roots and may contain system roots (`root_certs.cpp:210–253`). A strict
  request to a service pinned to a private CA can therefore accept a certificate from a different default-trusted
  CA for the same host. This also affects the CONNECT inner TLS context and the sibling `node:tls` constructor. Use
  an empty store for explicit CA replacement wherever the API promises that behavior, and preserve default roots
  only when no override was supplied. Test with a valid-name peer trusted by the default store and a different
  explicit `ca` on the request.

- **High · F-2 — HTTP/3 discards four per-request TLS controls.** Forced H3 and Alt-Svc use `ClientContext.connect`
  before `HTTPThread.connect` (`src/http/http.zig:1247–1286`). `src/http/h3_client/ClientContext.zig:40–64` uses
  the URL hostname for SNI and keys reuse only on host, port and the reject flag. The single QUIC client context
  loads default CAs and performs native name checks (`packages/bun-usockets/src/quic.c:1085–1129`). Consequently
  `ca`, `cert`/`key`, `serverName`, and `checkServerIdentity` have no effect. Even a fresh H3 connection can accept
  a default-trusted peer that the request's own policy would reject. Keep `rejectUnauthorized` in the H3 session
  key and add the full supported TLS policy. Until then, keep policy-bearing requests on TCP when eligible for
  Alt-Svc and reject unsupported combinations with forced H3.

- **High · F-3 — A fresh TCP fetch can send data before custom identity verification.** `src/http/http.zig:112–135`
  queues the certificate for JS and returns `true`. `src/http/HTTPContext.zig:408–421` proceeds to `firstCall`;
  CONNECT likewise calls its write path (`src/http/ProxyTunnel.zig:159–192`). The asynchronous JS result later
  rejects the promise (`FetchTasklet.zig:535–553`), but the remote endpoint may already have received authorization
  headers or body bytes. This is the known H6 ordering problem, reachable on the restored path. Wait for a
  successful JS identity result before writing any application bytes. A regression should assert the server sees no
  request on rejection, as well as checking the client's promise.

- **High · F-4 — H2 joining and H1 reuse bypass per-request identity policy.** Beyond H2's recorded idle-socket
  case, `src/http/HTTPContext.zig:746–759` can join a live session or pending handshake before ordinary pool
  admission. Both H2 matchers compare only host, port and the interned context
  (`src/http/h2_client/ClientSession.zig:137–151`, `src/http/h2_client/PendingConnect.zig:7–14`).
  `src/http/http.zig:2128–2135` enqueues waiters after the leader's handshake. A strict request with its own
  `checkServerIdentity` can attach to a normal leader with the same TLS config, since the callback is stored on the
  tasklet separately. H1 also omits the callback and uses the transport hostname in its key, while fresh validation
  can use the `Host` header override (`http.zig:60–77`, `HTTPContext.zig:689–705,771–809`). Two requests for the
  same address can therefore have different effective identities while sharing a verified socket. Use a common
  admission check for pending, active and idle connections. Include effective verification name and verification
  policy, retain the original verdict through repooling, and run per-request identity callbacks before sending
  data.

- **Medium · F-5 — Special TCP paths apply TLS settings to the wrong hop or skip the context.**
  `src/http/HTTPThread.zig:256–276,312–316` routes TLS over Unix sockets to the shared context before looking at
  `tls_props`, and uses the request's custom context for the outer HTTPS proxy connection. The former skips the
  configured CA and client credentials (`src/http/HTTPContext.zig:723–732`). The latter makes origin client
  credentials available to the proxy's TLS layer if it requests a client certificate. `ProxyTunnel.zig:34–60` also
  sends the Host/URL name in inner SNI while `http.zig:60–77` verifies against `serverName`. These paths cause a
  pinned local endpoint to be checked with default trust, or select the wrong proxy tunnel certificate or client
  identity. Select the custom context before Unix dialing, separate proxy and origin TLS configuration, and share
  the effective server-name calculation between direct and tunneled TLS.

`test/js/node/test/parallel/test-zun-fetch-tls-options.mjs:29–40` can fail on the original bridge because private
CA success is mandatory. The wrong-CA control uses a peer already rejected by default, so it cannot distinguish an
exclusive store from an additive one. It also accepts a missing error code, since it only excludes
`FetchHostFailure`. The test covers neither mTLS, server-name selection, identity callbacks, nor connection reuse.
`test-zun-fetch-streaming.mjs:7–48` has an actual dependency between the first body read and completion of the
server response, so it can fail on the original buffering behavior. Add controls for F-1 through F-5 and assert
exact TLS errors where the implementation promises them.
