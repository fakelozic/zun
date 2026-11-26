// zun FETCH-1: fetch must honour per-request TLS options. Before the fix, cruller's rt host bridge dropped `tls.ca`
// (a pinned CA was ignored and public roots were trusted instead) and reported TLS failures as `FetchHostFailure`.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "zun-blocked-spki");
const read = name => fs.readFileSync(path.join(fixtures, name), "utf8");
const root = read("root.pem");
const otherRoot = read("other-root.pem");

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  tls: { cert: read("leaf.pem") + read("inter.pem"), key: read("leaf.key") },
  fetch: () => new Response("ok"),
});
const url = `https://localhost:${server.port}/`;

async function attempt(opts) {
  try {
    const res = await fetch(url, opts);
    return { ok: true, body: await res.text() };
  } catch (err) {
    return { ok: false, code: err.code ?? null };
  }
}

try {
  // The chain's own root, given as `tls.ca`: trusted.
  assert.deepStrictEqual(await attempt({ tls: { ca: root } }), { ok: true, body: "ok" });
  // An unrelated root as `tls.ca`: must be rejected (a pinned CA is the only trust anchor for this request),
  // with the real verification error rather than a generic failure.
  const wrongCa = await attempt({ tls: { ca: otherRoot } });
  assert.strictEqual(wrongCa.ok, false, "fetch accepted a server whose chain does not reach the pinned tls.ca");
  assert.notStrictEqual(wrongCa.code, "FetchHostFailure", "TLS error detail was lost");
  // No CA option and the test root isn't trusted by default: rejected.
  assert.strictEqual((await attempt({})).ok, false);
  // Explicitly disabled verification still works.
  assert.deepStrictEqual(await attempt({ tls: { rejectUnauthorized: false } }), { ok: true, body: "ok" });
} finally {
  server.stop(true);
}
