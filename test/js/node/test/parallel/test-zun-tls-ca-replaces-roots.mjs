// zun security TLS-CA-1 (review F-1): an explicit `ca` must REPLACE the default trust store (bundled + system +
// NODE_EXTRA_CA_CERTS roots), as in Node and Bun 1.4.5, not be added to it. Otherwise a client that pins a private CA
// still accepts any publicly trusted certificate for the host.
//
// Needs one outbound connection to https://example.com (a publicly trusted peer the default store accepts).
// Runs under zun, Bun and Node; the `fetch(..., { tls })` cases are Bun-only (Node's fetch has no `tls` option).
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "zun-blocked-spki");
const read = name => fs.readFileSync(path.join(fixtures, name), "utf8");
const root = read("root.pem");
const otherRoot = read("other-root.pem"); // valid, self-signed, unrelated to example.com and to the local chain
const isBun = typeof globalThis.Bun !== "undefined";
const certError = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|certificate/i;

function tlsConnect(opts) {
  return new Promise(resolve => {
    const socket = tls.connect(opts, () => {
      resolve({ ok: true, authorized: socket.authorized });
      socket.end();
    });
    socket.on("error", err => resolve({ ok: false, code: err.code ?? null, message: String(err.message ?? err) }));
  });
}

async function fetchResult(url, init) {
  try {
    const res = await fetch(url, init);
    await res.arrayBuffer();
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, code: err.code ?? null, message: String(err.message ?? err) };
  }
}

const results = {};

// (b) Control: no `ca`, the default store trusts example.com.
results.tlsDefault = await tlsConnect({ host: "example.com", port: 443, servername: "example.com" });
assert.deepStrictEqual(results.tlsDefault, { ok: true, authorized: true }, JSON.stringify(results.tlsDefault));
if (isBun) {
  results.fetchDefault = await fetchResult("https://example.com/");
  assert.strictEqual(results.fetchDefault.ok, true, JSON.stringify(results.fetchDefault));
}

// (a) An unrelated valid `ca` must replace the defaults, so example.com no longer verifies.
results.tlsOtherCa = await tlsConnect({ host: "example.com", port: 443, servername: "example.com", ca: otherRoot });
assert.strictEqual(results.tlsOtherCa.ok, false, `tls.connect trusted default roots despite ca: ${JSON.stringify(results.tlsOtherCa)}`);
assert.match(`${results.tlsOtherCa.code} ${results.tlsOtherCa.message}`, certError);
if (isBun) {
  results.fetchOtherCa = await fetchResult("https://example.com/", { tls: { ca: otherRoot } });
  assert.strictEqual(results.fetchOtherCa.ok, false, `fetch trusted default roots despite tls.ca: ${JSON.stringify(results.fetchOtherCa)}`);
  assert.match(`${results.fetchOtherCa.code} ${results.fetchOtherCa.message}`, certError);
}

// (c) The explicit `ca` is still used: a local server with leaf <- intermediate <- root verifies with `ca: root`,
// and fails with the unrelated root.
const server = tls.createServer({ cert: read("leaf.pem") + read("inter.pem"), key: read("leaf.key") }, socket => {
  socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
try {
  results.tlsLocalRoot = await tlsConnect({ host: "127.0.0.1", port, servername: "localhost", ca: root });
  assert.deepStrictEqual(results.tlsLocalRoot, { ok: true, authorized: true }, JSON.stringify(results.tlsLocalRoot));
  results.tlsLocalOther = await tlsConnect({ host: "127.0.0.1", port, servername: "localhost", ca: otherRoot });
  assert.strictEqual(results.tlsLocalOther.ok, false, JSON.stringify(results.tlsLocalOther));
  if (isBun) {
    results.fetchLocalRoot = await fetchResult(`https://localhost:${port}/`, { tls: { ca: root } });
    assert.deepStrictEqual(results.fetchLocalRoot, { ok: true, status: 200 }, JSON.stringify(results.fetchLocalRoot));
  }
} finally {
  server.close();
}

// (d) NODE_EXTRA_CA_CERTS extends the defaults only: with an explicit `ca` it is not trusted either (Node, Bun 1.4.5).
{
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: path.join(fixtures, "root.pem") };
  const proc = spawnSync(process.execPath, [path.join(fixtures, "extra-ca-client.mjs")], { env, encoding: "utf8" });
  assert.strictEqual(proc.status, 0, `child exited ${proc.status}: ${proc.stderr}`);
  results.extraCa = JSON.parse(proc.stdout.trim().split("\n").filter(l => l.startsWith("{")).pop());
  assert.deepStrictEqual(results.extraCa.noCa, { ok: true, authorized: true }, JSON.stringify(results.extraCa));
  assert.strictEqual(results.extraCa.otherCa.ok, false, `NODE_EXTRA_CA_CERTS trusted despite ca: ${JSON.stringify(results.extraCa)}`);
}

console.log(JSON.stringify(results));
