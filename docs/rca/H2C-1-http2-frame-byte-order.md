# H2C-1: both HTTP/2 stacks write and read frame headers byte-reversed

- **Status:** fix prepared on branch `t3/fix-http2-frame-byte-order`, **not yet built or verified** (the build slot
  is owned by another agent). Only the standalone wire tests and `zig ast-check` have run.
- **Severity:** high, functional (HTTP/2 doesn't interoperate with any non-zun peer). Security-relevant in that
  it blocks testing F-4's H2 half, and parsing hostile frames went through the wrong decoder.
- **Found by / date:** F-4 verification, 2026-11-26 (`docs/security/review-2026-11-26-verify-F.md`).

## Symptom

- `fetch(url, { protocol: "http2" })` against Node's `http2.createSecureServer` fails every time with
  `HTTP2ProtocolError`. A TLS server with ALPN `h2` captures the 9 header bytes after the preface **in reverse order**.
- node:http2 is broken the same way in both directions: zun's `http2.connect` to a Node server times out or gets a
  stream error, and Node's `http2.connect` to zun's `http2.createSecureServer` fails with
  `ERR_HTTP2_ERROR: Protocol error`.
- Reproduction: `test/js/node/test/parallel/test-zun-http2-interop.mjs` on the unfixed snapshot
  `build/snap-0a5b26b/zun-debug`. All three directions fail (checked one at a time):
  - zun node:http2 client → Node: `JSON Parse error: Unexpected EOF`, then `timed out: zun http2 client GET to node`
  - fetch h2 → Node: `HTTP2ProtocolError fetching "https://localhost:…/fetch"`
  - Node client → zun node:http2 server: `Error [ERR_HTTP2_ERROR]: Protocol error`; the client exits with 3.

## Root cause

HTTP/2's wire structs are `packed struct`s:

- `FrameHeader` is `packed struct(u72) { length: u24, type: u8, flags: u8, streamIdentifier: u32 }`.
- `StreamPriority` is `packed struct(u40)`.
- `SettingsPayloadUnit` is `packed struct(u48)`.
- `FullSettingsPayload` is `packed struct(u336)`.

The code converted them to and from network order by `@memcpy`-ing raw bytes into the struct and calling
`std.mem.byteSwapAllFields`.

- In Bun 1.3.14's pinned Zig (`oven-sh/zig@04e7f6ac`), `byteSwapAllFields` loops over the fields, so each field was
  swapped on its own and the result was correct.
- Since Zig 0.16, `byteSwapAllFields` is an alias of `std.mem.byteSwap`. For a struct with a backing integer it does
  `@byteSwap` on the **whole** `uN` (`docs/zig/lessons.md`, probe `docs/zig/probes/byteswap-packed/byteswap.zig`).
  A 9-byte header therefore comes out as the 9 bytes reversed.

cruller's Zig 0.16 port, commit `a1c009d` ("bzrt: strip Bun 1.3.14 to thin zig 0.16 runtime"), kept every call. No
compile error appears, because the function still exists with the same signature; only its meaning changed. The affected
call sites were:

- `src/http/H2FrameParser.zig:117,132,144`: the wire types for fetch's client. Decoding used them in
  `h2_client/dispatch.zig`, and `h2_client/ClientSession.zig:222` used them in `writeFrame`.
- `src/runtime/api/bun/h2_frame_parser.zig:156,163,176,184,196,245,517`: node:http2, for reading and writing frame
  headers, priority, settings units and the full SETTINGS payload (including `getPackedSettings`).

A second bug was found in the same code, and Bun 1.3.14 already had it. `UInt31WithReserved.toUInt32` did `@bitCast`
on `packed struct(u32) { reserved: bool, uint31: u31 }`. The first field of a packed struct is bit 0, so the
exclusive/E flag landed at bit 0 and the stream dependency was shifted left by one. Every PRIORITY frame and every
HEADERS priority block sent by node:http2 had the wrong dependency (`setStreamPriority`, `request(…, {parent,
exclusive})`). Bun 1.4.5's Rust port fixed this (`(reserved << 31) | uint31`). The probe has a test for it.

The node:http2 reader cleared the reserved bit of the stream id only on its buffered (split-header) path and not on
the direct path (`h2_frame_parser.zig` `readBytes`). This is an RFC 9113 §4.1 deviation inherited from upstream. The
new `FrameHeader.decode` always clears it.

## Why it wasn't caught

- Every HTTP/2 test runs zun against zun. Both ends use the same wrong transform, so the reversed bytes are read back
  as the original values. Writing and reading are symmetric, and the round trip is the identity.
- Parity, from `docs/status/parity.json`: 163 http2 tests pass, and **none of them is evidence of interoperability**.
  - 148 use only zun's `node:http2` on both ends.
  - 12 add `net`/`tls`/a pipe only as socket plumbing, with HTTP/2 framing still zun↔zun:
    `client-port-80`, `compat-serverrequest`, `compat-serverresponse-finished`, `connect-tls-with-delay`,
    `connect`, `pipe-named-pipe`, `respond-file-error-pipe-offset`, `respond-file-fd-range`, `respond-file-with-pipe`,
    `respond-with-file-connection-abort`, `socket-close` and `unbound-socket-proxy`.
  - `tls-disconnect` spawns `h2load` and skips when it's missing.
  - Only two send independently built RFC frames: `premature-close` (raw bytes) and `malformed-altsvc`
    (`common/http2.js`). Both only assert that the session closes or errors, so they pass even when zun rejects
    every frame.
  - Full list: every `PASS` line matching `http2` in `docs/status/parity.json` (161 in `node/parallel`, 1 in
    `node/sequential`, plus the worker test).
- The non-passing tests are suspicious and should be re-run once the fix is built. `test-http2-misbehaving-flow-control.js`
  and `-paused.js` send hand-built frames through `common/http2.js` and **TIMEOUT**. The byte-reversed reader is a
  likely cause (unverified). `test-http2-forget-closed-streams.js` (TIMEOUT) and `test-http2-clean-output.js` (FAIL)
  have not been looked at.
- No test pinned the wire bytes of a single frame. No test talked to Node, curl, nghttp2 or a browser.

## Fix

- New `src/http/h2_wire.zig`, which depends only on `std`. It holds `FrameHeader`, `StreamPriority` and
  `SettingsPayloadUnit`, each with explicit big-endian `decode(*const [N]u8)` and `encode(*[N]u8)` built from
  `std.mem.readInt`/`writeInt(..., .big)` field by field, plus a writer-based `write()` for node:http2. The packed
  structs are now only the in-memory form; their layout is never used as the wire layout.
  - `FrameHeader.decode` clears R (RFC 9113 §4.1 "MUST be ignored"), and `encode` never sets it.
  - `StreamPriority` keeps the raw 32 bits including E (bit 31); callers split them with `UInt31WithReserved.from`.
  - `uint31WithReserved(value, reserved)` puts the flag at bit 31.
- Both stacks import it: `H2FrameParser.zig` re-exports the three types and adds `encodeSetting` for
  `h2_client/encode.zig`, and `h2_frame_parser.zig` aliases them. There is now one implementation, and the code
  under test is the same code that ships. A `comptime` assert keeps the default frame type equal to each file's
  `FrameType.HTTP_FRAME_SETTINGS`.
- Callers changed:
  - `h2_client/ClientSession.zig` `writeFrame` encodes into a `[9]u8`.
  - `h2_client/dispatch.zig` parses headers and SETTINGS with `decode`.
  - In `h2_frame_parser.zig`, the split-header path builds a `[9]u8` from the buffered prefix and the new bytes and then
    decodes it; the direct path decodes too.
  - `handlePriorityFrame` and both SETTINGS readers use `decode`.
  - `FullSettingsPayload.encode` writes seven explicit `SettingsPayloadUnit`s and is used by `write` and
    `getPackedSettings`.
  - `UInt31WithReserved.toUInt32` and `write` use bit 31 for E/R.
- This addresses the cause because no code converts a packed struct to or from wire bytes by reinterpreting memory
  any more. Every field is read and written at its RFC offset with an explicit byte order, so the result doesn't depend
  on how std defines `byteSwap` or on the packed-struct bit layout.

## Regression test

- `src/http/h2_wire.zig` has tests. Run `zig test src/http/h2_wire.zig`: 8/8 pass. They decode and re-encode known RFC 9113 bytes:
  - a SETTINGS header (`00 00 12 04 00 00 00 00 00`) and a SETTINGS ACK
  - HEADERS with PRIORITY|END_HEADERS and a 3-byte length
  - the R bit ignored on read and cleared on write
  - an exclusive PRIORITY block (`80 00 00 05 c8`)
  - SETTINGS_INITIAL_WINDOW_SIZE
  - a WINDOW_UPDATE frame
  - the writer path
- `test/js/node/test/parallel/test-zun-http2-interop.mjs` uses **Node** as the peer, in three parts: zun's node:http2
  client → Node server (GET plus a 40 KB POST, which brings in DATA and WINDOW_UPDATE), fetch `protocol: "http2"` → Node
  server, and Node client → zun's node:http2 server. It fails on `snap-0a5b26b` as shown above. It hasn't been run on a
  fixed build yet. Under plain Node, with the fetch part guarded off, it passes, which shows the test logic is sound.

## Sibling search

Searches over `src/`: `byteSwapAllFields`, `mem.byteSwap`, `@byteSwap`, `takeStruct/readStruct/writeStruct/peekStruct`
(std's endian struct readers call `byteSwapAllFields`), `bigToNative/nativeToBig`, and every `packed struct(uN)`
definition.

- **HTTP/2:** all 10 `byteSwapAllFields` calls were in the two H2 stacks, and all are fixed.
- **Fixed:** `UInt31WithReserved.toUInt32` in both H2 files (the `@bitCast` with the flag at bit 0, from upstream).
- **Not affected:**
  - The scalar `@byteSwap(u32)` + `asBytes` writes for RST_STREAM, GOAWAY and WINDOW_UPDATE
    (`h2_client/Stream.zig:76`, `ClientSession.zig:369`, `h2_frame_parser.zig` near 1298/1328/1361) are correct on
    little-endian targets, which is all zun supports (Linux x86_64/aarch64). They are endian-dependent, though: convert
    them to `writeInt(.big)` before any big-endian port.
  - `src/http/websocket.zig` `WebsocketHeader` is `packed struct(u16)`, laid out so that the whole `u16` is the
    big-endian 2-byte header, and it explicitly byte-swaps the whole u16 (`slice`/`fromSlice`, `writeInt(u16, …, .big)`).
    That is the intended semantics and is correct.
  - `websocket_client.zig:991` swaps a scalar close code.
  - `runtime/node/net/BlockList.zig` and `node_os.zig` swap scalar IPs and masks.
  - `rt/http_wire.zig` `RequestFlags`/`ResponseFlags` are an in-process bridge format with no endianness conversion.
  - DNS (c-ares), TLS records (BoringSSL) and zip/tar (libarchive) are parsed in C. The DNS, socket, dns_jsc, http
    and router `packed struct`s are in-memory flags only.
  - `Blob.zig:579` `readStruct(bun.FD)` is native-endian and in-process.
- No other `byteSwapAllFields`, endian `readStruct`/`takeStruct` or packed-struct `@bitCast` to wire bytes found.

## Lessons

- A symmetric self-test can't find an encoding bug. Every wire protocol needs at least one test against an
  independent implementation (here Node) or against fixed RFC bytes.
- Packed struct layout is not a wire format. Use explicit `readInt`/`writeInt` per field (`docs/zig/lessons.md`).
- When upgrading Zig, a std function that keeps its name and signature can still change meaning silently. Diff the
  semantics of std calls on network-input paths, not just whether they compile.
