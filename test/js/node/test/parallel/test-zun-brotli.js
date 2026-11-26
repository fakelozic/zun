"use strict";

// zun security backport C1 (brotli v1.1.0 -> v1.2.1, CVE-2026-111497): decoding must keep working on
// every path that uses brotli, and malformed input must produce an error, never a crash.
// - node:zlib sync + stream round trips at several sizes and qualities
// - a brotli file produced by the reference encoder (Node's fixture person.jpg.br)
// - fetch() auto-decoding a `Content-Encoding: br` response from Bun.serve
// - corrupted / truncated streams: every failure is an Error with a string `code`
//   (NativeBrotli used to hit `unreachable` for error codes its enum didn't name; v1.2.1 adds -17)

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// 1. Sync round trips.
for (const size of [0, 1, 1000, 65536, 1 << 20, 5 * (1 << 20)]) {
  const input = Buffer.alloc(size);
  for (let i = 0; i < size; i++) input[i] = (i * 2654435761) >>> 24; // mixed, semi-compressible
  for (const quality of [0, 5, 11]) {
    if (size > 1 << 20 && quality === 11) continue; // q11 on 5 MB is slow under ASAN
    const compressed = zlib.brotliCompressSync(input, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality } });
    const output = zlib.brotliDecompressSync(compressed);
    assert.ok(output.equals(input), `round trip size=${size} q=${quality}`);
  }
}

// 2. Reference-encoder output (fixture shared with Node's own tests).
{
  const fixtures = path.join(__dirname, "..", "fixtures");
  const original = fs.readFileSync(path.join(fixtures, "person.jpg"));
  const compressed = fs.readFileSync(path.join(fixtures, "person.jpg.br"));
  assert.ok(zlib.brotliDecompressSync(compressed).equals(original), "person.jpg.br");
}

// 3. Corrupted and truncated streams: an Error with a code, never a crash or a hang.
{
  const good = zlib.brotliCompressSync(Buffer.from("hello brotli ".repeat(5000)));
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  let errors = 0;
  for (let iter = 0; iter < 2000; iter++) {
    const bad = Buffer.from(good);
    const flips = 1 + Math.floor(rand() * 8);
    for (let j = 0; j < flips; j++) bad[Math.floor(rand() * bad.length)] ^= 1 + Math.floor(rand() * 255);
    const input = iter % 4 === 0 ? bad.subarray(0, Math.floor(rand() * bad.length)) : bad;
    try {
      zlib.brotliDecompressSync(input);
    } catch (err) {
      errors++;
      assert.ok(err instanceof Error, "error is an Error");
      assert.strictEqual(typeof err.code, "string", `error code is a string: ${err.code}`);
    }
  }
  assert.ok(errors > 100, `most corrupted inputs fail (${errors}/2000)`);
}

// 4. Streaming decode, and fetch() decoding Content-Encoding: br.
const body = Buffer.from(JSON.stringify({ items: Array.from({ length: 20000 }, (_, i) => ({ i, s: "x" + i })) }));
const encoded = zlib.brotliCompressSync(body);

const streamDone = new Promise((resolve, reject) => {
  const chunks = [];
  const d = zlib.createBrotliDecompress();
  d.on("data", c => chunks.push(c));
  d.on("error", reject);
  d.on("end", () => {
    try {
      assert.ok(Buffer.concat(chunks).equals(body), "stream decode");
      resolve();
    } catch (e) {
      reject(e);
    }
  });
  for (let i = 0; i < encoded.length; i += 977) d.write(encoded.subarray(i, i + 977));
  d.end();
});

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/bad") {
      const bad = Buffer.from(encoded);
      bad[bad.length >> 1] ^= 0xff;
      return new Response(bad, { headers: { "content-encoding": "br" } });
    }
    return new Response(encoded, { headers: { "content-encoding": "br", "content-type": "application/json" } });
  },
});

streamDone
  .then(() => fetch(server.url))
  .then(async res => {
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.strictEqual(text, body.toString());
    // A corrupted br body must reject (or, if the flip happens to keep the stream valid, decode to something);
    // what matters is that the process neither crashes nor hangs.
    try {
      await (await fetch(new URL("/bad", server.url))).arrayBuffer();
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  })
  .finally(() => server.stop(true));
