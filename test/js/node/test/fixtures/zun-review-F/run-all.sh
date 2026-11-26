#!/bin/sh
# Run every case on zun (snapshot binary, or $ZUN) and on Bun ($BUN, default `bun`), one process at a time.
# Bun gets its caches redirected so it never writes to ~/.bun.
set -u
here=$(dirname "$0")
ZUN=${ZUN:-/home/fak3/.t3/projects/zun/build/snap-0a5b26b/zun-debug}
BUN=${BUN:-bun}
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 BUN_INSTALL_CACHE_DIR=${BUN_INSTALL_CACHE_DIR:-/tmp/zun-review-F-bun-cache}
cases=${*:-"f3-nocheck f3 f4-h1-seq f4-h1-conc f4-h1-host f4-h2-seq f4-h2-conc f5-unix f5-proxy f5-proxy-ca-only f5-proxy-sni f5-sni-direct"}
for c in $cases; do
  for rt in "$ZUN" "$BUN"; do
    timeout 60 node "$here/run.mjs" "$(command -v "$rt")" "$c"
  done
done
