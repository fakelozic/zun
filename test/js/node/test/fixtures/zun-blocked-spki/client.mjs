// Child process for test-zun-tls-blocked-spki.mjs. Serves TLS with a leaf <- intermediate <- root chain and connects
// to it with fetch (default store + NODE_EXTRA_CA_CERTS) and node:tls (`ca` option), trusting the test root. Prints one JSON line with what each client saw.
// ZUN_DEBUG_BLOCKED_SPKI_SHA256 (debug builds) may block one of the chain's keys; the parent decides which.
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const dir = path.dirname(new URL(import.meta.url).pathname);
const read = name => fs.readFileSync(path.join(dir, name), "utf8");
const root = read("root.pem");
const chain = read("leaf.pem") + read("inter.pem");

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  tls: { cert: chain, key: read("leaf.key") },
  fetch: () => new Response("ok"),
});

const result = {};
try {
  // fetch trusts the test root through NODE_EXTRA_CA_CERTS (set by the parent), not `tls: { ca }`: zun's fetch currently
  // drops per-request TLS options (open bug FETCH-1, docs/rca/FETCH-1-fetch-bridge-drops-tls-config.md).
  const res = await fetch(`https://localhost:${server.port}/`);
  result.fetch = { ok: true, body: await res.text() };
} catch (err) {
  result.fetch = { ok: false, code: err.code ?? null, message: String(err.message ?? err) };
}

result.tls = await new Promise(resolve => {
  const socket = tls.connect({ host: "127.0.0.1", servername: "localhost", port: server.port, ca: root }, () => {
    resolve({ ok: true, authorized: socket.authorized });
    socket.end();
  });
  socket.on("error", err => resolve({ ok: false, code: err.code ?? null, message: String(err.message ?? err) }));
});

server.stop(true);
console.log(JSON.stringify(result));
