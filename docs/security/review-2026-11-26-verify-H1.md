# Verification of review findings H1-1 … H1-4

Checks the H1 section of `review-2026-11-26-sol.md` (strict chunked decoding, picohttpparser `f4d94b48` + Bun 1.4.5's
`chunked-decoder.patch` + `zun-abi-check.patch`). Date 2026-11-26.

- **zun:** snapshot `build/snap-0a5b26b/zun-debug` (debug + ASAN, includes the H1 commit `c17a851`).
- **Reference:** Bun 1.4.5 (release) and Node 26, same scripts.
- **Decoder source:** pinned, patched `vendor/picohttpparser/picohttpparser.c` of the integration checkout.
- **Scripts:** `docs/security/verify-H1/`. All servers are local (127.0.0.1).

| Finding | Verdict | Action here |
|---|---|---|
| H1-1 unbounded framing work | **SHARED** with Bun 1.4.5 (no spin, no memory growth, but there is no end) | open; fix described |
| H1-2 lax trailer terminator, surplus discarded | **CONFIRMED, SHARED** with Bun 1.4.5; no desync reproduced | open; fix described |
| H1-3 RCA mislabels C states, test misses them | **CONFIRMED** | RCA corrected, 2 test cases added, passing |
| H1-4 ABI asserts incomplete | **CONFIRMED**; full per-field check is a pure assertion addition | added on both sides (**not yet built** in zun) |

## H1-1: endless chunk extensions / trailer lines: SHARED

`verify-H1/server1.mjs` (Node) answers with `1;x=` followed by endless extension bytes (`ext`), or with a valid one-byte
body, `0\r\n` and then an endless trailer line (`trailer`). It writes 64 KiB every 20 ms (~3 MB/s), which keeps the
idle timer alive. `verify-H1/client1.mjs` runs `fetch().text()` and reports process CPU and RSS every 5 s.

| run | CPU after 20 s | RSS (5 s → 20 s) | data received | result |
|---|---:|---|---:|---|
| zun `ext` | 0.95 s | 308 → 306 MB | ~59 MB | still pending |
| Bun 1.4.5 `ext` | 0.09 s | 27 → 27 MB | ~61 MB | still pending |
| zun `trailer` | 0.74 s | 308 → 307 MB | ~59 MB | still pending |
| Bun 1.4.5 `trailer` | 0.14 s | 27 → 27 MB | ~60 MB | still pending |

(zun is a debug + ASAN build, so its absolute CPU and RSS are not comparable with release Bun. What matters is the
trend.)

- **No spin:** CPU grows linearly with the bytes received (~16 ms of debug CPU per MB), and is idle between reads.
- **No memory growth:** RSS is flat. The multi-packet path appends each read to the body buffer and then trims the
  undecoded framing (`src/http/http.zig:2672–2689`), so capacity stays at one read.
- **What is real:** the request **never ends** while the peer keeps trickling framing. The review is right that
  nothing bounds extension length, trailer length or framing per decoded byte. Bun 1.4.5 behaves the same, since the
  decoder is byte-identical. Severity: a slow-loris against a client, bounded only by the caller's `AbortSignal`.
- **Fix (described, not implemented):** `patches/picohttpparser/chunked-decoder.patch` / `picohttpparser.c` in the
  `CHUNKED_IN_CHUNK_EXT` loop (~`:587`) and the `CHUNKED_IN_TRAILERS_LINE_*` loops (~`:658–678`): count bytes per
  extension line and total trailer bytes in the decoder (a new field means updating the ABI checks below on both
  sides), and return -1 above a cap (for example 4 KiB per extension line and 16 KiB of trailers, which is generous
  next to llhttp's header limits). Keep upstream's dropped per-payload overhead ratio dropped, so the 20,000 one-byte
  chunk case still passes. Add a test that delivers the framing over several reads.

## H1-2: bare-LF trailer terminator and same-read surplus: CONFIRMED, SHARED

The decoder behaviour, from `verify-H1/probe.c` built against the pinned source:

```
bare LF terminator        "…0\r\n\n"          ret=0 (complete)
CR CR LF terminator       "…0\r\n\r\r\n"      ret=0 (complete)
surplus after terminator  "…0\r\n\r\nGARBAGE" ret=7 (7 undecoded bytes, treated as success)
```

`CHUNKED_IN_TRAILERS_LINE_HEAD` skips any number of CRs and accepts a bare LF. `TRAILERS_LINE_MIDDLE` ends a trailer
line on a bare LF. Both callers treat every `pret >= 0` as done (`src/http/http.zig:2712`, `:2794`) and never look at
the positive count.

End to end with `verify-H1/h12.mjs` (keep-alive; the first response is a single write; the follow-up request goes to the
same server):

| case | zun | Bun 1.4.5 | Node 26 |
|---|---|---|---|
| `0\r\n\n` (bare LF) | body "hello", socket reused | same | **error** "terminated", new socket |
| `0\r\nX-T: 1\n\n` | body, reused | same | error, new socket |
| `0\r\n\r\r\n` | body, reused | same | error, new socket |
| surplus full response after `0\r\n\r\n` | body, **reused**, follow-up gets the real "second" | same | body, new socket |
| surplus junk after `0\r\n\r\n` | body, reused | same | body, new socket |

- **No desync was reproduced.** The surplus is dropped, and the next response is parsed from fresh bytes. zun matches
  Bun 1.4.5 exactly. The remaining risk is the leniency itself: when a strict intermediary (Node/llhttp-like) and zun
  disagree on where a message ends, that disagreement is a smuggling primitive, and keeping a socket that sent
  unexplained bytes is unsafe.
- **Related to H2:** surplus that arrives in a *later* read on the idle pooled socket (`verify-H1/h12b.mjs`) makes
  Bun 1.4.5 and Node open a new connection for the next request. **zun reuses the same socket** (`conn1#2`). The late
  bytes were discarded, so there was still no desync, but this differs from Bun and belongs to H2's idle-socket data
  handler.
- **Fix (described, not implemented):**
  1. In `picohttpparser.c`, `CHUNKED_IN_TRAILERS_LINE_HEAD` (~`:658`): accept exactly `\r\n`. A bare LF or extra CRs
     returns -1. `TRAILERS_LINE_MIDDLE` (~`:670`): require `\r` before the `\n`. This goes in a zun patch, with the
     Bun-patch caveat recorded.
  2. At `src/http/http.zig:2712` and `:2794`, the "Done" arm: when `pret > 0`, set
     `this.state.flags.allow_keepalive = false`, so the socket is retired rather than pooled. Optionally fail on a
     non-empty surplus. Do the same in the `ProxyTunnel.zig` path.
  3. Add both cases to `test-zun-fetch-chunked.mjs` with a keep-alive follow-up that checks for a new connection.

## H1-3: enum states and the missing EOF cases: CONFIRMED, fixed

The pinned enum (`picohttpparser.c:521–530`) runs `CHUNK_SIZE`=0, `CHUNK_EXT`=1, `CHUNK_HEADER_EXPECT_LF`=2,
`CHUNK_DATA`=3, `CHUNK_DATA_EXPECT_CR`=4, `CHUNK_DATA_EXPECT_LF`=5, `TRAILERS_LINE_HEAD`=6, `TRAILERS_LINE_MIDDLE`=7. The
old Zig mirror (`git show c17a851^:src/picohttp_sys/picohttpparser.zig`) had `CHUNK_DATA`=2, `CHUNK_CRLF`=3,
`TRAILERS_LINE_HEAD`=4 and `TRAILERS_LINE_MIDDLE`=5. The RCA's claim "4 now means inside chunk data" was wrong.

The probe output for each EOF point:

```
"5\r\nhel"        state=3   old mirror reads CHUNK_CRLF  → rejects (existing test, cannot catch a stale mirror)
"5\r\nhello"      state=4   old mirror reads TRAILERS_LINE_HEAD   → "complete" body "hello"   ← missed
"5\r\nhello\r"    state=5   old mirror reads TRAILERS_LINE_MIDDLE → "complete" body "hello"   ← missed
```

So with a pin-only bump, `onClose` (`http.zig:384`, `ProxyTunnel.zig:237`) would have set `received_last_chunk` for
exactly these two truncations. The current code asks `phr_decode_chunked_is_in_trailers()` (6/7 only), which handles
them correctly.

- **Test:** two cases added to `test-zun-fetch-chunked.mjs` ("truncated after full chunk data, before CRLF" and
  "… inside CRLF"). They pass on the zun snapshot, on Bun 1.4.5 and on Node 26 (exit 0, 13 cases). They could not be
  run against a stale-mirror build, because that would need a build. The negative evidence is the probe above.
- **RCA:** `docs/rca/H1-picohttpparser-abi-drift.md` now has the corrected state mapping, the exact truncation window
  and the test note. The misleading comment at `src/http/http.zig:387` was also corrected (comment only).
- **Still open:** the CONNECT-tunnel path (`ProxyTunnel.zig`) has no equivalent test. It needs a local CONNECT proxy
  in the test.

## H1-4: per-field ABI check: CONFIRMED, added (pure assertions, **not yet built**)

Negative control: a header that inserts `char _x;` before `consume_trailer` keeps the size at 32 and the offsets at
16/24. **The old three `_Static_assert`s pass on it** (checked with `cc -fsyntax-only`), while Zig would write
`consume_trailer` at the wrong offset.

Added, with no behaviour change:
- `patches/picohttpparser/zun-abi-check.patch`: offset **and** size of all six fields, the struct size and
  `_Alignof == 8`. The patch applies with `git apply --check` to the post-`chunked-decoder.patch` source. The patched
  file compiles (`cc -std=c11`; the build uses gnu17). On the moved-field header it fails with
  `struct_phr_chunked_decoder.consume_trailer …`.
- `src/picohttp_sys/picohttpparser.zig`: comptime check of each field's offset and `@sizeOf(@FieldType)`, the field
  count, the size and the alignment. A standalone copy of the struct passes `zig test`. Inserting a field or widening
  `_state` fails with the named message (probe `docs/zig/probes/abi-field-check/check.zig`). **The zun build itself
  was not run.**

Generating the binding from the header with translate-c, the review's other option, is the structural fix. It remains
the open hardening item listed in the RCA.
