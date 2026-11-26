# C1-a: brotli decoder error enums were exhaustive; the v1.2.1 bump would have turned a crafted stream into a crash

- **Status:** fixed in `acc46d5` (same commit as the brotli bump, so the hazard never shipped).
- **Severity:** high if it had shipped (remote crash / undefined behaviour from a `fetch` response body or
  `node:zlib` input); security-relevant.
- **Found by / date:** SEC2, 2026-11-26, while bumping brotli for backport C1 (diffing the public headers first).

## Symptom

Would-be symptom, not observed in a build: brotli v1.2.1 adds `BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH = -17`
(`c/include/brotli/decode.h`), returned by `DecodeBlockTypeAndLength` (`c/dec/decode.c:1189-1191`) exactly for the
malformed streams the CVE fix rejects. Header diff v1.1.0 → v1.2.1: this is the only new enum value.

## Root cause

- `src/brotli_sys/brotli_c.zig`: `BrotliDecoderErrorCode` and `BrotliDecoderErrorCode2` were **exhaustive**
  `enum(c_int)` lists of the v1.1.0 codes. `BrotliDecoderGetErrorCode` is declared as an `extern fn` returning
  `BrotliDecoderErrorCode2` directly, and `getErrorCode` does `@enumFromInt(@intFromEnum(...))`.
- `src/runtime/node/zlib/NativeBrotli.zig` `code_for_error`: `inline for` over the named values, then `unreachable`.
- `src/brotli/brotli.zig:148` (assert builds, the `fetch` decoder): `@tagName(code)`.
- In Zig 0.17.1, `@enumFromInt` of an unnamed value in an exhaustive enum is "invalid enum value" (safety panic in
  Debug/ReleaseSafe, undefined in ReleaseFast); probe `docs/zig/probes/nonexhaustive-enum/enum.zig`. A C function
  returning such a value through an exhaustive enum type is undefined too.
- Origin: identical in upstream Bun 1.3.14 (`src/brotli_sys/brotli_c.zig`), imported by cruller `a1c009d`. It was
  harmless as long as the C library's code set matched the enum; the dependency bump is what breaks the assumption.

## Why it wasn't caught

No test drives the decoder into each error code, and nothing ties the Zig enum to the C header. A pin bump that builds
and passes the round-trip tests would have shipped it.

## Fix

Both enums get `FORMAT_BLOCK_SWITCH = -17` **and** a `_` member (non-exhaustive), so any future code is a valid value.
`code_for_error` returns `ERR_BROTLI_DECODER_UNKNOWN_ERROR` instead of `unreachable`; the debug log uses
`std.enums.tagName(…) orelse "unknown"`. This removes the assumption ("the C library's codes equal our list") rather
than just adding the one missing value.

## Regression test

`test/js/node/test/parallel/test-zun-brotli.js` (2,000 corrupted/truncated streams must throw an `Error` with a
string `code`). Honest limit: no input that yields `-17` specifically was found or crafted, so the new path is
covered by the probe and by reading, not by an end-to-end test.

## Sibling search

`grep -n "enum(c_int)\|enum(c_uint)\|enum(i32)" src/brotli_sys src/zlib_sys src/zstd src/cares_sys src/libdeflate_sys`:

| Enum | Fed from C? | Risk |
|---|---|---|
| `BrotliDecoderResult` | yes | 4 values fixed by the API contract; low |
| `BrotliEncoderMode`, `…Parameter`, `BrotliDecoderParameter` | no (inputs to C) | none |
| `zlib_sys.ReturnCode` (exhaustive) | yes, 5 `extern fn … ReturnCode` | zlib's `Z_*` codes (-6…2) are frozen API; zlib-ng returns only those. Low, **open** (make non-exhaustive on the next zlib-ng bump) |
| `libdeflate.Status` (exhaustive) | yes | 4 codes, stable since libdeflate 1.0. Low, **open** (same) |
| `c_ares.Error` | via `Error.get(rc)`, range-checked to `1…ARES_ENOSERVER` before `@enumFromInt` | re-checked with the H8 bump: 1.34.9 still ends at `ARES_ENOSERVER = 26` and all 26 are named. But `Error.get` ends in `else => unreachable` for any other value, so a future c-ares code would crash: **open** (needs a decision on what unknown codes map to; check on the next c-ares bump) |

A tree-wide audit of exhaustive enums fed from C (BoringSSL, usockets, lsquic, …) is **open**; do it per dependency
when each is bumped.

## Lessons

Before building a dependency bump, diff its public headers (`diff -r old/include new/include`) for new enum values and
changed structs. Knowledge bank: `docs/zig/lessons.md` (non-exhaustive C enums), `cheatsheet-0.17.md` § C interop.
