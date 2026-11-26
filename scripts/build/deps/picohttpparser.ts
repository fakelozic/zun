/**
 * picohttpparser — tiny HTTP parser. Single .c file, no build system.
 *
 * No `.a` produced — bun compiles `picohttpparser.c` directly into its
 * binary. `provides.sources` tells the build system which files; they're
 * declared as implicit outputs of the fetch rule so ninja knows they
 * exist once fetch completes (otherwise: "missing and no known rule to
 * make it" on fresh checkouts).
 */

import type { Dependency } from "../source.ts";

// zun (security H1): h2o/picohttpparser #78 (strict chunk-size), #81 (chunk
// overhead), #82 (bare LF in chunk headers). Same commit as Bun 1.4.5.
const PICOHTTPPARSER_COMMIT = "f4d94b48b31e0abae029ebeafcfd9ca0680ede58";

export const picohttpparser: Dependency = {
  name: "picohttpparser",
  versionMacro: "PICOHTTPPARSER",

  source: () => ({
    kind: "github-archive",
    repo: "h2o/picohttpparser",
    commit: PICOHTTPPARSER_COMMIT,
  }),

  // phr_decode_chunked, as fetch's response decoder (Bun 1.4.5's patch, verbatim):
  // - reject BWS after chunk-size, like llhttp;
  // - drop the chunk-overhead limit, which protects a server from its
  //   clients; a long response made of one-byte chunks is legitimate;
  // - add phr_decode_chunked_is_in_trailers() so src/http does not mirror
  //   the decoder's private state enum.
  // zun-abi-check.patch: _Static_asserts pinning struct phr_chunked_decoder's
  // layout to the hand-written Zig mirror (src/picohttp_sys/picohttpparser.zig).
  patches: ["patches/picohttpparser/chunked-decoder.patch", "patches/picohttpparser/zun-abi-check.patch"],

  build: () => ({ kind: "none" }),

  provides: () => ({
    libs: [],
    includes: ["."],
    sources: ["picohttpparser.c"],
  }),
};
