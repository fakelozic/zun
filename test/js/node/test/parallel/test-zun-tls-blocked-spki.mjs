// zun security C2: TLS chains holding a blocked public key must be rejected (CERT_REVOKED), and the bundled root
// store must be NSS 3.131.1 (no compromised emSign roots). The eight real blocked keys belong to eMudhra intermediates
// whose private keys we don't have, so debug builds accept one extra blocked key from ZUN_DEBUG_BLOCKED_SPKI_SHA256;
// that exercises the same verify path (blocked_spkis.cpp via openssl.c's cert verify callback).
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "zun-blocked-spki");
const spki = JSON.parse(fs.readFileSync(path.join(fixtures, "spki.json"), "utf8"));

function runClient(blocked) {
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: path.join(fixtures, "root.pem") };
  delete env.ZUN_DEBUG_BLOCKED_SPKI_SHA256;
  if (blocked) env.ZUN_DEBUG_BLOCKED_SPKI_SHA256 = blocked;
  const proc = spawnSync(process.execPath, [path.join(fixtures, "client.mjs")], { env, encoding: "utf8" });
  assert.strictEqual(proc.status, 0, `client exited ${proc.status}: ${proc.stderr}`);
  const line = proc.stdout.trim().split("\n").filter(l => l.startsWith("{")).pop();
  return JSON.parse(line);
}

// 1. Control: nothing extra blocked, the chain is trusted through the test root.
const control = runClient(null);
assert.deepStrictEqual(control.fetch, { ok: true, body: "ok" });
assert.deepStrictEqual(control.tls, { ok: true, authorized: true });

// 2. Blocked intermediate key, and 3. blocked leaf key: both clients must refuse with CERT_REVOKED.
for (const which of ["intermediate", "leaf"]) {
  const r = runClient(spki[which]);
  assert.strictEqual(r.fetch.ok, false, `fetch accepted a chain with a blocked ${which} key`);
  // The control run differs only by the blocked key, so this rejection is the blocklist's. fetch should also report
  // CERT_REVOKED, but the rt host bridge drops the TLS error detail (FETCH-1); tighten this when FETCH-1 is fixed.
  assert.match(`${r.fetch.code} ${r.fetch.message}`, /CERT_REVOKED|revoked|FetchHostFailure/i, `fetch (${which}): ${JSON.stringify(r.fetch)}`);
  assert.strictEqual(r.tls.ok, false, `node:tls accepted a chain with a blocked ${which} key`);
  assert.match(`${r.tls.code} ${r.tls.message}`, /CERT_REVOKED|revoked/i, `tls (${which}): ${JSON.stringify(r.tls)}`);
}

// 4. Bundled root store: NSS 3.131.1 (118 roots). The three emSign roots NSS removed are gone; G1 stays.
const subjects = tls.rootCertificates.map(pem => new X509Certificate(pem).subject);
assert.strictEqual(tls.rootCertificates.length, 118);
for (const removed of ["emSign ECC Root CA - G3", "emSign Root CA - C1", "emSign ECC Root CA - C3"]) {
  assert.ok(!subjects.some(s => s.includes(`CN=${removed}`)), `root store still contains ${removed}`);
}
assert.ok(subjects.some(s => s.includes("CN=emSign Root CA - G1")));
