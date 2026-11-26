# H1: fetch's chunked decoding was too lax, and the fix carried a hidden memory-corruption trap

- **Status:** fixed in the `security: H1` commit (picohttpparser `066d2b1e` → `f4d94b48` + Bun 1.4.5's `chunked-decoder.patch`)
- **Severity:** High, security-relevant (response desync/smuggling through `fetch`, CPU DoS; the trap was an out-of-bounds write)
- **Found by / date:** SEC1 audit (lax parsing); SEC2 + integration owner while backporting (ABI trap), 2026-11-26

## Symptom
`fetch` accepted malformed chunked responses and returned a body instead of failing.
Reproduction: `test/js/node/test/parallel/test-zun-fetch-chunked.mjs` against the pre-fix binary (`build/debug017/bun-debug`, `84057ad`):

```
'bare LF after chunk size: expected rejection, got body "hello"'
'whitespace after chunk size: expected rejection, got body "hello"'
'non-hex chunk size: expected rejection, got body "hello"'
```

Bun 1.4.5 rejects all three. A lenient chunk parser is a desync primitive: a proxy and the client can disagree on
where a body ends.

## Root cause
1. **Lax parser.** zun pinned picohttpparser `066d2b1e`, which predates h2o/picohttpparser #78 (strict chunk-size),
   #81 (chunk overhead) and #82 (bare LF in chunk headers). Bun 1.4.x bumped it and added its own patch (reject BWS
   after the chunk size; drop the server-side overhead limit, which wrongly hits clients; export
   `phr_decode_chunked_is_in_trailers`). The pin was inherited unchanged from Bun 1.3.14 through cruller.
2. **The hidden trap in the obvious fix.** `src/picohttp_sys/picohttpparser.zig` declares `struct phr_chunked_decoder`
   **by hand** as a Zig `extern struct`, and the HTTP client embeds it in `InternalState`. The new picohttpparser
   **added two `uint64_t` fields** (`_total_read`, `_total_overhead`; size 16 → 32 bytes) and **renumbered its
   private state enum** by splitting the old `CHUNKED_IN_CHUNK_CRLF` (3) in two: `CHUNKED_IN_CHUNK_DATA` 2 → 3,
   new `CHUNKED_IN_CHUNK_DATA_EXPECT_CR` = 4 and `CHUNKED_IN_CHUNK_DATA_EXPECT_LF` = 5, `CHUNKED_IN_TRAILERS_LINE_HEAD`
   4 → 6 and `_MIDDLE` 5 → 7 (old Zig mirror vs `picohttpparser.c` enum at `f4d94b48`; corrected after review
   H1-3, an earlier version of this RCA said 4 meant "inside chunk data").
   Bumping only the pin would have caused:
   - an **out-of-bounds write**: C writes `_total_read` on every call, past the end of the 16-byte Zig struct,
     into whatever follows it in `InternalState`;
   - a **silent truncation bug**: `http.zig` and `ProxyTunnel.zig` matched `_state` against the old numbers in
     `onClose` (4/5 = trailers, body complete), so a connection closed *after a chunk's data but before or inside
     its CRLF* (new states 4/5) would have been reported as a complete body. A close in the middle of the data
     (state 3) would still have failed correctly, because 3 was the old `CHUNK_CRLF`.

   Neither produces a compile error: the Zig and C views of the struct are never compared.

## Why it wasn't caught
- No test sent malformed chunked responses to `fetch`.
- No compile-time check ties hand-written Zig mirrors of C structs to the real C headers. Debug builds don't flag a
  write past a struct *inside* a larger struct (ASAN sees valid memory).

## Fix
- Bump picohttpparser to `f4d94b48` (pinned by commit) and apply Bun 1.4.5's `chunked-decoder.patch` **verbatim**
  (`cmp`-identical).
- Update the Zig mirror to the new layout and stop reading the decoder's private `_state`; ask the decoder through
  `phr_decode_chunked_is_in_trailers()` instead (`http.zig`, `ProxyTunnel.zig`).
- Pin the layout **on both sides**: Zig `comptime` checks and C `_Static_assert`s in
  `patches/picohttpparser/zun-abi-check.patch`. A future bump that changes the struct now fails the build.
  (Originally size + the two last offsets only; after review H1-4 every field's offset and size, the field count
  (Zig) and the alignment are pinned, so a field moving inside the 16-byte prefix also fails.)

## Regression test
`test/js/node/test/parallel/test-zun-fetch-chunked.mjs`: 11 raw responses from a TCP server. Valid (incl. trailers,
extensions, 20,000 one-byte chunks) must decode exactly; bare LF, whitespace after the size, non-hex size, size
overflow, missing CRLF, truncated mid-chunk, **truncated after the full chunk data before / inside its CRLF**, and
truncated before the terminal chunk must reject. Fails on the old binary (3 cases), passes on the new one and on Bun 1.4.5.
The two "after the full chunk data" cases (added after review H1-3) are the ones that end in C states 4 and 5, i.e.
the cases a stale state mirror would accept; "truncated mid-chunk" ends in state 3 and could not catch it. Verified
with a C probe against the pinned decoder (`docs/security/review-2026-11-26-verify-H1.md`). The CONNECT-tunnel
(`ProxyTunnel.zig`) path has no equivalent test yet.

## Sibling search
Same class: **Zig hand-mirrors of C types from vendored dependencies, unchecked against the C headers.**

| Binding | `extern struct`s | Layout checks | Status |
|---|---:|---:|---|
| `picohttp_sys` | 2 | 4 | fixed here |
| `cares_sys/c_ares.zig` | 22 | 1 | **safe for H8**: public headers of 1.34.6 vs 1.34.9 differ only by an enum alias (`ARES_CLASS_HESIOD`). Open for future bumps |
| `boringssl_sys/boringssl.zig` | 53 | 0 | **open**, re-check on the C2 / any BoringSSL bump |
| `uws_sys/*` (in-tree C++, changes with H5/H6 backports) | ~14 | 3 | **open**, check whenever uWS/usockets code is cherry-picked |
| `lolhtml_sys`, `zlib_sys`, `libdeflate_sys` | 4 / 2 / 1 | 0 / 0 / 1 | open, low churn |

Exhaustive Zig enums fed from C are the same class (see `C1-brotli-exhaustive-error-enum.md`).

## Lessons
- **Every dependency bump includes a header diff** of the public headers the Zig side mirrors, recorded in the commit
  message. (Done for c-ares H8 retroactively in this RCA.)
- **Structural fix (proposed, open):** generate these mirrors with translate-c from the real headers (the build already
  translates `c-headers-for-zig.h`) or, where hand-written mirrors stay, add `comptime` size/offset checks plus C
  `_Static_assert`s like this patch. Track as a hardening item.
- Never read a C library's private state from Zig; ask through its API.
