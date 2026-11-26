// TODO: use translate-c for this
pub const struct_phr_header = extern struct {
    name: [*c]const u8,
    name_len: usize,
    value: [*c]const u8,
    value_len: usize,
};
pub extern fn phr_parse_request(buf: [*c]const u8, len: usize, method: [*c][*c]const u8, method_len: [*c]usize, path: [*c][*c]const u8, path_len: [*c]usize, minor_version: [*c]c_int, headers: [*c]struct_phr_header, num_headers: [*c]usize, last_len: usize) c_int;
pub extern fn phr_parse_response(_buf: [*c]const u8, len: usize, minor_version: [*c]c_int, status: [*c]c_int, msg: [*c][*c]const u8, msg_len: [*c]usize, headers: [*c]struct_phr_header, num_headers: [*c]usize, last_len: usize) c_int;
pub extern fn phr_parse_headers(buf: [*c]const u8, len: usize, headers: [*c]struct_phr_header, num_headers: [*c]usize, last_len: usize) c_int;
/// Mirrors `struct phr_chunked_decoder` in picohttpparser.h (h2o/picohttpparser f4d94b48 + Bun's patch).
/// zun (security H1): upstream added `_total_read` / `_total_overhead` and renumbered the decoder states.
/// The C side writes `_total_read` on every call, so a missing field here is an out-of-bounds write into
/// whatever follows the decoder in `InternalState`. The layout is pinned on both sides: comptime checks
/// below and `_Static_assert`s in `patches/picohttpparser/zun-abi-check.patch`. `_state` is the C
/// decoder's private enum; don't read it from Zig, use `phr_decode_chunked_is_in_trailers` / `_is_in_data`.
pub const struct_phr_chunked_decoder = extern struct {
    bytes_left_in_chunk: usize = 0,
    consume_trailer: u8 = 0,
    _hex_count: u8 = 0,
    _state: u8 = 0, // CHUNKED_IN_CHUNK_SIZE; picohttpparser expects a zero-initialized decoder
    _total_read: u64 = 0,
    _total_overhead: u64 = 0,

    comptime {
        // Same numbers as the C `_Static_assert`s (x86_64 / aarch64 Linux).
        if (@sizeOf(@This()) != 32 or @offsetOf(@This(), "_total_read") != 16 or @offsetOf(@This(), "_total_overhead") != 24)
            @compileError("struct_phr_chunked_decoder no longer matches picohttpparser.h");
    }
};
pub extern fn phr_decode_chunked(decoder: *struct_phr_chunked_decoder, buf: [*]u8, bufsz: *usize) isize;
pub extern fn phr_decode_chunked_is_in_data(decoder: *struct_phr_chunked_decoder) c_int;
/// Added by Bun's `chunked-decoder.patch`: true once the terminal zero-size chunk was read (only trailers remain).
pub extern fn phr_decode_chunked_is_in_trailers(decoder: *const struct_phr_chunked_decoder) c_int;
pub const phr_header = struct_phr_header;
pub const phr_chunked_decoder = struct_phr_chunked_decoder;

