#!/bin/sh
# Review C2-2 repro: does a strict-mTLS listener dispatch requests from a client whose certificate it rejects?
# Usage: c2-2-run.sh /path/to/zun-debug   (needs curl built with HTTP/3, e.g. ngtcp2/nghttp3).
# Cases, each over TCP (HTTP/1.1) and QUIC (--http3-only): valid client cert, no cert, untrusted self-signed cert,
# and (second server run, ZUN_DEBUG_BLOCKED_SPKI_SHA256 = client.pem's key) a trusted but blocked cert.
set -u
ZUN=$1
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$HERE/../zun-blocked-spki/root.pem
OUT=$(mktemp -d)
BLOCK=$(sed -n 's/.*"client":"\([0-9a-f]*\)".*/\1/p' "$HERE/spki.json")

run_server() { # $1 = blocked key or empty
  if [ -n "$1" ]; then
    BUN_DEBUG_QUIET_LOGS=1 ZUN_DEBUG_BLOCKED_SPKI_SHA256=$1 "$ZUN" "$HERE/c2-2-server.mjs" > "$OUT/server.log" 2>&1 &
  else
    BUN_DEBUG_QUIET_LOGS=1 "$ZUN" "$HERE/c2-2-server.mjs" > "$OUT/server.log" 2>&1 &
  fi
  SERVER_PID=$!
  i=0; while [ $i -lt 100 ] && ! grep -q '^PORT ' "$OUT/server.log"; do sleep 0.1; i=$((i+1)); done
  PORT=$(sed -n 's/^PORT //p' "$OUT/server.log")
}

probe() { # $1 = case name, $2 = transport flag, rest = curl cert args
  name=$1; flag=$2; shift 2
  res=$(curl -sS --max-time 5 --cacert "$ROOT" $flag -H "x-case: $name" "$@" -o /dev/null -w '%{http_code} %{http_version}' \
    "https://localhost:$PORT/" 2>&1 | tr '\n' ' ')
  echo "client $name: $res"
}

run_server ""
for t in tcp:--http1.1 h3:--http3-only; do
  tn=${t%%:*}; tf=${t#*:}
  probe "$tn-valid" "$tf" --cert "$HERE/client.pem" --key "$HERE/client.key"
  probe "$tn-nocert" "$tf"
  probe "$tn-untrusted" "$tf" --cert "$HERE/untrusted.pem" --key "$HERE/untrusted.key"
done
kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null
grep '^DISPATCHED' "$OUT/server.log" | sed 's/^/server /'

run_server "$BLOCK"
for t in tcp:--http1.1 h3:--http3-only; do
  tn=${t%%:*}; tf=${t#*:}
  probe "$tn-blocked" "$tf" --cert "$HERE/client.pem" --key "$HERE/client.key"
done
kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null
grep '^DISPATCHED' "$OUT/server.log" | sed 's/^/server /'
rm -rf "$OUT"
