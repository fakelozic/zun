/**
 * Brotli — high-ratio compression. Backs the `br` Content-Encoding in fetch
 * and bun's --compress bundler flag.
 *
 * DirectBuild: one archive containing common + dec + enc. The cmake build
 * splits these into three libs purely so dec-only consumers can avoid the
 * encoder; we link everything anyway, so a single .a is simpler and drops
 * the "common must come last" link-order footgun.
 */

import type { Dependency, DirectBuild } from "../source.ts";

// zun (security C1, CVE-2026-111497 / GHSA-663w-cv8g-jj2p): v1.2.1, pinned by
// commit (tags are mutable). Same commit as Bun 1.4.5. Resolved with
// `git ls-remote https://github.com/google/brotli.git refs/tags/v1.2.1`.
const BROTLI_COMMIT = "db24a98aed38a16de78cc05ca15cdd8dc2a0d92d"; // v1.2.1

// prettier-ignore
const SOURCES = [
  "common/constants", "common/context", "common/dictionary", "common/platform",
  "common/shared_dictionary", "common/transform",
  "dec/bit_reader", "dec/decode", "dec/huffman", "dec/prefix", "dec/state",
  "dec/static_init",
  "enc/backward_references", "enc/backward_references_hq", "enc/bit_cost",
  "enc/block_splitter", "enc/brotli_bit_stream", "enc/cluster", "enc/command",
  "enc/compound_dictionary", "enc/compress_fragment", "enc/compress_fragment_two_pass",
  "enc/dictionary_hash", "enc/encode", "enc/encoder_dict", "enc/entropy_encode",
  "enc/fast_log", "enc/histogram", "enc/literal_cost", "enc/memory",
  "enc/metablock", "enc/static_dict", "enc/static_dict_lut", "enc/static_init",
  "enc/utf8_util",
];

export const brotli: Dependency = {
  name: "brotli",

  source: () => ({
    kind: "github-archive",
    repo: "google/brotli",
    commit: BROTLI_COMMIT,
  }),

  build: cfg => {
    const spec: DirectBuild = {
      kind: "direct",
      sources: SOURCES.map(s => `c/${s}.c`),
      includes: ["c/include"],
      // log2 exists everywhere we target; the cmake check only exists for
      // ancient bionic (enc/fast_log.h still reads BROTLI_HAVE_LOG2 in v1.2.1).
      // v1.2.x no longer reads OS_LINUX/OS_MACOSX/OS_FREEBSD, so they're gone.
      defines: {
        BROTLI_HAVE_LOG2: 1,
      },
      pic: true,
    };

    // LTO miscompile: on linux-x64 with AVX (non-baseline), BrotliDecompress
    // errors out mid-stream. Root cause unknown — likely an alias-analysis
    // issue around brotli's ring-buffer copy hoisting. -fno-lto sidesteps it.
    // Linux-only: clang's LTO on darwin/windows has a different codepath.
    // x64+non-baseline only: the SSE/AVX path is where the miscompile lives;
    // baseline (SSE2-only) doesn't hit it.
    if (cfg.linux && cfg.x64 && !cfg.baseline) {
      spec.cflags = ["-fno-lto"];
    }

    return spec;
  },

  provides: () => ({
    libs: [],
    includes: ["c/include"],
  }),
};
