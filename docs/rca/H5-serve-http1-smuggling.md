# H5: Bun.serve's HTTP/1.1 parser allowed request smuggling (TE lists, empty TE, TE on HTTP/1.0, pipelining after close, unbounded chunk extensions)

- **Status:** **prepared, not yet built/verified.** The fix is on branch `t3/h5-serve-smuggling-backport` (C++ hunks in
  `c1f12c6`, test in `b92654c`). The integration owner still has to compile zun with it and run
  `test-zun-serve-smuggling.mjs`. The C++ was checked only with the standalone ASan/UBSan harness
  `docs/rca/H5/parser-harness.cpp` (results below).
- **Severity:** High, security-relevant. Request smuggling or desync behind a reverse proxy, a request-queue/ACL bypass
  (`GET /admin` smuggled inside the body of an allowed request), and unmetered inbound bytes that `maxRequestBodySize`
  never sees.
- **Found by / date:** SEC audit (docs/security/backports.md rows 10–11), backport prepared 2026-11-26.

## Symptom
Run `test/js/node/test/parallel/test-zun-serve-smuggling.mjs` against the unfixed snapshot
`build/snap-0a5b26b/zun-debug` (run with `ASAN_OPTIONS=detect_leaks=0` to see the list; under `scripts/runner.node.mjs`
the exit-time LSan report turns the run into SIGABRT, a separate, pre-existing leak). One `Bun.serve` server; raw bytes
on a fresh TCP connection for each case:

| Input | Unfixed zun (1.3.14 parser) | Bun 1.4.5 / zun with H5 |
|---|---|---|
| `Transfer-Encoding: gzip, chunked` (also `x, chunked`, `identity, chunked`, `gzip,\tchunked`) | 200, chunked body handed to the app with the `gzip` coding silently dropped, keep-alive | 400 + close, handler not called |
| `Transfer-Encoding: chunked, chunked` | 200 | 400 + close |
| `Transfer-Encoding: gzip` + `Transfer-Encoding: chunked` (two fields) | 200 | 400 + close |
| `Transfer-Encoding: ` (empty) + `Content-Length: 4` + body `ABCD` + `GET /admin …` (either field order) | **two** 200s: the body is framed by CL and **`GET /admin` runs** (CL.TE smuggling) | 400 + close, nothing dispatched |
| `Transfer-Encoding: ` (empty), no CL, followed by `GET /admin …` | **two** 200s, `/admin` runs | 400 + close |
| `POST … HTTP/1.0` + `Transfer-Encoding: chunked` (with or without `Connection: keep-alive`) | 200, body decoded as chunked | 400 + close |
| `2;` + 32 KiB of extension bytes + `\r\nhi\r\n0\r\n\r\n` | 200, body `hi`; any amount of extension bytes is accepted and `idleTimeout` is reset as they trickle | **413** + close at 16 KiB per chunk |
| `GET /a` + `Connection: close`, then `GET /b` in the same write (also `Close`, `keep-alive, close`, a second `Connection: close` field, HTTP/1.0, a close-flagged POST with a body) | **both** handled, two 200s, connection left open (for HTTP/1.0 it is closed after both) | `/a` only, one 200, then close |
| `GET /slow` (async handler) + `Connection: close`, then `GET /b` | **no response at all**: `/b` finds `/slow` still pending, and the "async pipelining" guard closes the socket | `/slow` gets its 200, then close |

Not a gap (pinned by the test): trailer fields after the last chunk, and arbitrary bytes in place of the final CRLF,
are already rejected by 1.3.14 (`ChunkedEncoding.h` "drop trailer mode" requires exactly `\r\n`). The "unbounded
trailers" entry in backports.md does not apply to `Bun.serve`: Bun 1.4.5's `MAX_TRAILER_SECTION_SIZE` only bounds
node:http's trailer *capture* mode, which zun does not have.

Not a gap either: `Transfer-Encoding: chunked,`. RFC 9110 5.6.1 says empty list elements are ignored, so it means
`chunked`. Bun 1.4.5 `Bun.serve` treats it as chunked too, which this backport keeps (positive control in the test).
llhttp (Node) treats it as not chunked and rejects the request, so a Node-based proxy in front of zun returns 400 rather
than desyncing. This is a divergence, not a smuggling vector. backports.md row 10 is corrected.

## Root cause
All in `packages/bun-uws/src/`. zun's copy is byte-identical to Bun 1.3.14's (`diff -r` is empty), so there were no
cruller/zun-specific changes to keep. The code came in with the initial import `a1c009d` and is upstream uWS/Bun code.

1. **TE verdict built from the last token of the last field only** (`HttpParser.h` `getTransferEncoding`, 1.3.14
   lines 245–305). Each TE field overwrote `te.has = lastTokenLen > 0` and `te.chunked = (last token == "chunked")`.
   So:
   - `gzip, chunked` and split `gzip` / `chunked` fields counted as plain chunked. `Bun.serve` implements no other
     coding, so the gzip layer was dropped and an encoded body was handed to the app as if decoded. A proxy that
     honours the list (or rejects it) frames the message differently.
   - `chunked, chunked` was accepted, while llhttp and RFC 9112 6.1 reject it.
   - An **empty** TE value gave `te.has = false`, so the field was treated as absent and Content-Length (or "no body")
     framed the message. Any proxy that treats the field as present frames it as chunked or rejects it, which is
     the classic CL.TE desync. The harness reproduces it at the parser level: `[REQ /a]<ABCD>{fin}[REQ /admin]{fin}`.
2. **No HTTP/1.0 check.** `fenceAndConsumePostPadded` never looked at `ancientHttp` when choosing the framing, so an
   HTTP/1.0 request with TE was decoded as chunked. RFC 9112 6.1 says that framing MUST be treated as faulty. HTTP/1.0
   intermediaries do not know TE.
3. **No "closed" state in the parser.** The parser loop in `fenceAndConsumePostPadded` dispatches every complete
   request in a read. Close was tracked only as a per-response bit (`HTTP_CONNECTION_CLOSE`, `HttpContext.h:304-306`),
   which the next dispatch overwrote (`state = HTTP_RESPONSE_PENDING`). The detection,
   `getHeader("connection").length() == 5`, read only the **first** `Connection` field, matched any 5-byte value
   (`nope!`), and missed token lists (`keep-alive, close`). RFC 9112 9.6: the server MUST NOT process further
   requests after `close`.
4. **Chunk extensions were drained without a limit** (`ChunkedEncoding.h` `consumeHexNumber`, the drain loop). Bytes
   after `;` were skipped one by one with no counter. They never count against `maxRequestBodySize`, and each read
   resets the idle timer, so one connection can stream unlimited data. llhttp caps them at 16 KiB per chunk.

## Why it wasn't caught
zun has no raw-socket tests for `Bun.serve` framing. Bun 1.3.14's `request-smuggling.test.ts` *expected*
`gzip, chunked` and split TE fields to be accepted ("accepts valid Transfer-Encoding: gzip, chunked"), so the inherited
suite encoded the bug as correct behaviour. Bun only reversed that in 1.4.x (#35295). The parity runner runs Node's
`test-http-*` against node:http, not `Bun.serve`.

## Fix (upstream sources, what was taken)
Hunks were picked from the Bun 1.3.14 → 1.4.5 diff of `packages/bun-uws/src/`. Attribution comes from
`git log` on a blobless `bun-v1.4.5` history clone.

| # | Hunk | Upstream | Why included |
|---|---|---|---|
| 1 | `getTransferEncoding` rewrite: `te.has = true` for every TE field, even empty; a TE field after one that ended in `chunked` → invalid; any token after `chunked` → invalid; new `multipleCodings` bit | Bun #31339 (`cd1ad599`, hardening round 4: empty TE is present) + #35295 (`af63b8a1`, single final chunked) | causes 1 (CL.TE, TE lists) |
| 2 | `fenceAndConsumePostPadded`: `ancientHttp && te.has` → 400 `INVALID_TRANSFER_ENCODING`; `invalid \|= multipleCodings` | #35864 (`bdb73822`) + #35295 | causes 1, 2 |
| 3 | `HttpRequest::hasConnectionClose()` (case-insensitive token scan of every `Connection` field); `HttpParser::sawConnectionClose` latch set **before** the handler runs; at the loop top a latched parser discards the rest of the input (`success(consumedTotal + length)`, no 400, so earlier responses still go out); `HttpContext.h` reads the latch instead of `length() == 5` | #33005 (`da60a4ba`), the `da60a4ba` version of `hasConnectionClose` (1.4.5's later `fieldHasToken`/Proxy-Connection variant is node:http-specific) | cause 3 |
| 4 | Per-chunk extension counter in `consumeHexNumber` / `getNextChunk` / `ChunkIterator` (reset on a fresh size line, like llhttp's `on_chunk_header`); `MAX_CHUNK_EXTENSION_SIZE = 16 KiB`, checked before every chunk dispatch and after each loop at all three chunk-decoding sites; `HTTP_ERROR_413_PAYLOAD_TOO_LARGE`; `HTTP_PARSER_ERROR_CHUNK_EXTENSIONS_OVERFLOW = 12` | counter from #32488 (`4bbe0751`), Bun.serve cap from #34504 (`39c70a35`) | cause 4 |

Deviation, kept minimal: upstream keeps the counter in `HttpResponseData` and passes a pointer through a reshaped
`consumePostPadded`. zun keeps it as a private `HttpParser` member (`HttpResponseData` derives from `HttpParser`, so it
is still per connection). That avoids importing 1.4.5's `IsNodeHttp` template split and signature changes. The enum value
11 (`LF_EXPECTED` in 1.4.5) is left unused so numbering matches upstream.

**Left out on purpose:**
- node:http-only behaviour: the `IsNodeHttp` template, `nonEmptyValue`/`afterContentLength`/`lenientChunked`,
  trailer capture (`STATE_IS_TRAILERS`, `MAX_TRAILER_SECTION_SIZE`, `validateNodeTrailerSection`),
  `HPE_CLOSED_CONNECTION`, the CR/LF skip and the timeouts.
- The `STATE_IS_CHUNK_TERMINATOR_ERROR` / `TRAILER_OVERFLOW` sentinels: they only change which error code is
  reported. Both inputs are already 400.
- #42986 (`2dee3bd6`, a *response* `Connection: close` header stops later pipelined requests). It depends on #42762's
  cork-for-the-whole-read change and `isDrainingBeforeClose`, neither of which zun has. Per that PR, pre-#42762 builds
  close in `internalEnd`, and the "close in the middle of a pipeline" case passes on the unfixed snapshot. Listed
  as a follow-up, not done.
- Unrelated refactors: `getUrlForRouting`, `WHOLE_READ`, HTTP/2 preface, `inline constexpr`, `MAX_HEADER_FRAMING_SLACK`.

**Why this removes the cause:** the framing decision now uses every TE field and every token, and anything other than
one final `chunked` on HTTP/1.1 is a hard 400 *before* dispatch. An empty field can no longer change the framing.
"Closed" is now parser state that outlives the per-response bits, so no later byte on that connection can become a
request. Extension bytes are counted and capped where they are consumed.

**Zig-side follow-ups:** none required. The C ABI is unchanged. The ext size comes from
`sizeof(HttpResponseData<SSL>)` in C++, so the new members need no Zig change. Optional, not done:
- `src/js/node/_http_server.ts` `HttpParserError` enum: add `HTTP_PARSER_ERROR_CHUNK_EXTENSIONS_OVERFLOW = 12` →
  `HPE_CHUNK_EXTENSIONS_OVERFLOW`. Until then node:http's `clientError` reports `HPE_INTERNAL` for it. This needs a new
  entry in `src/jsc/bindings/ErrorCode.ts` (codegen), so it waits for a build.
- Bun #40215 (`a8581291`): with `Transfer-Encoding:` (empty) followed by `Transfer-Encoding: chunked`, the parser
  frames the chunked body correctly, but the Zig has-body test (`server.zig:2070`, `NodeHTTPResponse.zig:295`) reads
  only the first TE field, so the body is dropped. It is a correctness bug, not a desync (framing is right), and it
  exists before and after H5. The upstream fix adds `uws_req_has_transfer_encoding` (C shim + Zig extern + 3 call
  sites). Listed as open.

**Behaviour change for zun's node:http server:** in 1.3.14 it shares this parser, and there is no `IsNodeHttp` split.
It now also rejects `gzip, chunked` and HTTP/1.0 + TE, which is stricter than Node/llhttp. After `Connection: close`
it now discards later bytes silently, where Node emits `clientError` `HPE_CLOSED_CONNECTION`. Both changes are in the
safe direction. Note them if a node parity test changes.

### Harness check (`docs/rca/H5/parser-harness.cpp`, ASan+UBSan, no zun build)
```
case                                     unfixed (1.3.14 headers)                     with H5
TE gzip, chunked                         [REQ /a]<hello>{fin}                          ERR status=3(400) code=3
TE empty + CL (CL.TE)                    [REQ /a]<ABCD>{fin}[REQ /admin]{fin}          ERR 400
TE empty only                            [REQ /a]{fin}[REQ /admin]{fin}                ERR 400
HTTP/1.0 + TE chunked                    [REQ /a]<hello>{fin}                          ERR 400
chunk ext 17000 B (one read / split)     [REQ /a]<hi>{fin}                             [REQ /a]ERR status=4(413) code=12
10 chunks x 8000 B ext                   accepted                                      accepted (cap is per chunk)
pipelined after Connection: close        [REQ /a]{fin}[REQ /b]{fin}                    [REQ /a]{fin} (close-latched)
  … same for keep-alive, Close / 2nd read / HTTP/1.0 / close-flagged POST body
Connection: nope! / keep-alive pipelining both dispatched                              both dispatched
TE chunked, / TE empty then chunked / OWS accepted                                     accepted (unchanged)
```

## Regression test
`test/js/node/test/parallel/test-zun-serve-smuggling.mjs` (29 cases). On the unfixed snapshot: **19 fail**, which are
exactly the rows marked unfixed in the Symptom table. **10 pass**: 8 positive controls (valid chunked, OWS, `chunked,`,
extensions within the per-chunk cap, keep-alive pipelining, chunked + pipelined, `Connection: nope!`), the 2
trailer/terminator cases 1.3.14 already rejects, and the mid-pipeline close. Expected with H5: all 29 pass.
**Not yet run against a fixed build.**

Run: `node scripts/runner.node.mjs --quiet --exec-path <zun-debug> js/node/test/parallel/test-zun-serve-smuggling.mjs`
(from `test/`'s parent). Under the runner, the debug build's exit-time LeakSanitizer report (150 small allocations,
unrelated to H5) aborts the process; use `ASAN_OPTIONS=detect_leaks=0` to read the assertion output.

## Sibling search
HTTP/1 parsers in zun (`grep -rn "Transfer-Encoding\|phr_decode_chunked\|llhttp"` over `src/`, `packages/`):

| Parser | Shares the code? | Status per weakness |
|---|---|---|
| node:http **server** (`src/js/node/_http_server.ts` → `Bun.serve` internals) | yes, the same uWS `HttpParser` | fixed by H5 (stricter than Node, see above) |
| fetch / node:http **client** response parser (`src/http/http.zig:2820-2880` `handleResponseMetadata`, picohttpparser `phr_decode_chunked`; `_http_client.ts` uses `nodeHttpClient` from `fetch.zig`) | no | **TE lists:** single-value exact match; anything else, including `gzip, chunked` and `chunked,`, is `error.UnsupportedTransferEncoding`, so it is safe, but strict (`Chunked` in another case is rejected). **Several TE fields:** the last one wins, so `chunked` + `gzip` makes the response close-delimited, and keep-alive is turned off (`http.zig:2942`). **TE + CL:** both are kept, chunked framing wins and **keep-alive is not turned off** (RFC 9112 6.3 says close). **Content-Length:** `parseInt(...) catch 0` turns an invalid CL into **0**, and duplicate CLs are last-wins, which can leave body bytes on a pooled connection. **Connection:** exact `close` match on one field (`keep-alive, close` is missed, the same class as cause 3). **Chunk extensions/trailers:** streamed and discarded by picohttpparser (H1 bumped it); no buffer growth, no byte cap. All of these need a malicious or compromised origin and only affect that origin's own connection pool. **Open, listed** as SIB-H5-a (fetch CL/TE/Connection strictness) for a follow-up; not fixed here. |
| `process.binding('http_parser')` / `JSHTTPParser` (`src/jsc/bindings/node/http/`, vendored llhttp) | no | llhttp is the reference behaviour for all five checks. Nothing to do. |
| HTTP/2 / HTTP/3 server paths | n/a | no TE (h3 rejects a TE header, `server.zig:1961`); not in scope |

## Lessons
- An inherited test suite can assert the bug: Bun 1.3.14 tested that `gzip, chunked` was *accepted*. When
  backporting security behaviour, diff the upstream tests too, not just the code.
- Connection state that must outlive one response belongs in the parser, not in per-response bits that the next
  dispatch resets.
- The standalone `HttpParser` harness (`docs/rca/H5/parser-harness.cpp`) can check uWS parser changes in seconds
  without the full build. Reuse it for later uWS backports.
