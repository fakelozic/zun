// zun security H6 (a)/(e), review C2-1: `Bun.connect({ tls })` must report the real verification result and, when
// `rejectUnauthorized` is on (the default), close the connection without letting any application data reach the
// server. Before the fix zun reported `authorized: true` after a failed verify and stayed connected in strict mode.
// Expected behaviour is Bun 1.4.5's (socket_body.rs on_handshake). RCA: docs/rca/H6a-bun-connect-verify.md.
//
// The blocked-key case needs zun's debug-only ZUN_DEBUG_BLOCKED_SPKI_SHA256 hook, so it runs only under zun.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "zun-blocked-spki");
const read = f => fs.readFileSync(path.join(fixtures, f), "utf8");
const root = read("root.pem");
const otherRoot = read("other-root.pem");
const spki = JSON.parse(read("spki.json"));
const isZun = path.basename(process.execPath).startsWith("zun");

// Server: the test chain (leaf for localhost/127.0.0.1 ← intermediate ← root). Counts application bytes received.
async function withServer(fn) {
  let received = 0;
  const server = tls.createServer({ key: read("leaf.key"), cert: read("leaf.pem") + read("inter.pem") }, s => {
    s.on("data", d => (received += d.length));
    s.on("error", () => {});
    s.write("from-server");
  });
  server.on("tlsClientError", () => {});
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const result = await fn(server.address().port);
    // Give the server a moment to read anything the client may have sent.
    await new Promise(r => setTimeout(r, 150));
    return { ...result, serverReceived: received };
  } finally {
    server.close();
  }
}

// One Bun.connect; `useOpen` registers only `open` (no `handshake`), the other common callback shape.
function connect(port, tlsOpts, useOpen = false) {
  return new Promise(resolve => {
    const r = { events: [], clientData: 0 };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const onReady = (socket, success, authError) => {
      r.events.push(useOpen ? "open" : "handshake");
      r.success = success;
      r.authorized = socket.authorized;
      const e = useOpen ? socket.getAuthorizationError() : authError;
      r.authorizationError = e ? e.code || String(e) : null;
      r.wrote = socket.write("from-client");
      setTimeout(() => {
        socket.end();
        finish();
      }, 200);
    };
    const handlers = {
      data(_s, d) {
        r.clientData += d.length;
      },
      error(_s, e) {
        r.events.push(`error:${e?.code ?? e}`);
      },
      connectError(_s, e) {
        r.events.push(`connectError:${e?.code ?? e}`);
        finish();
      },
      close() {
        r.events.push("close");
        setTimeout(finish, 50);
      },
    };
    if (useOpen) handlers.open = s => onReady(s);
    else handlers.handshake = onReady;
    Bun.connect({ hostname: "127.0.0.1", port, tls: tlsOpts, socket: handlers }).catch(e => {
      r.events.push(`reject:${e?.code ?? e}`);
      finish();
    });
  });
}

function assertRejected(r, label, codeRe) {
  assert.strictEqual(r.authorized, false, `${label}: authorized ${JSON.stringify(r)}`);
  assert.match(String(r.authorizationError), codeRe, `${label}: authorizationError ${JSON.stringify(r)}`);
  assert.ok(r.events.includes("close"), `${label}: connection must be closed ${JSON.stringify(r)}`);
  assert.strictEqual(r.serverReceived, 0, `${label}: server received application bytes ${JSON.stringify(r)}`);
  assert.strictEqual(r.clientData, 0, `${label}: client received application bytes ${JSON.stringify(r)}`);
}

function assertPermissive(r, label, codeRe) {
  assert.strictEqual(r.authorized, false, `${label}: authorized ${JSON.stringify(r)}`);
  assert.match(String(r.authorizationError), codeRe, `${label}: authorizationError ${JSON.stringify(r)}`);
  assert.ok(r.serverReceived > 0, `${label}: permissive client must still talk ${JSON.stringify(r)}`);
}

const UNTRUSTED = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED/;

if (process.argv[2] === "blocked-child") {
  // Runs with ZUN_DEBUG_BLOCKED_SPKI_SHA256 set by the parent.
  for (const useOpen of [false, true]) {
    const label = `blocked ${process.env.ZUN_DEBUG_BLOCKED_SPKI_SHA256.slice(0, 8)} ${useOpen ? "open" : "handshake"}`;
    const strict = await withServer(p => connect(p, { ca: root, serverName: "localhost" }, useOpen));
    assertRejected(strict, `${label} strict`, /CERT_REVOKED/);
    const loose = await withServer(p => connect(p, { ca: root, serverName: "localhost", rejectUnauthorized: false }, useOpen));
    assertPermissive(loose, `${label} permissive`, /CERT_REVOKED/);
  }
  console.log("blocked-child ok");
  process.exit(0);
}

// 1. Control: trusted chain, right name.
for (const useOpen of [false, true]) {
  const r = await withServer(p => connect(p, { ca: root, serverName: "localhost" }, useOpen));
  assert.strictEqual(r.authorized, true, `control: ${JSON.stringify(r)}`);
  assert.strictEqual(r.authorizationError, null, `control: ${JSON.stringify(r)}`);
  assert.ok(r.serverReceived > 0 && r.clientData > 0, `control: ${JSON.stringify(r)}`);
}

// 2. Untrusted chain (the client trusts a different root): strict default, explicit strict, permissive.
for (const useOpen of [false, true]) {
  const label = `untrusted ${useOpen ? "open" : "handshake"}`;
  assertRejected(await withServer(p => connect(p, { ca: otherRoot, serverName: "localhost" }, useOpen)), `${label} default`, UNTRUSTED);
  assertRejected(
    await withServer(p => connect(p, { ca: otherRoot, serverName: "localhost", rejectUnauthorized: true }, useOpen)),
    `${label} strict`,
    UNTRUSTED,
  );
  assertPermissive(
    await withServer(p => connect(p, { ca: otherRoot, serverName: "localhost", rejectUnauthorized: false }, useOpen)),
    `${label} permissive`,
    UNTRUSTED,
  );
}

// 3. Trusted chain, wrong name (H6 (a) host-name check). Bun 1.4.5 checks `serverName` (else the host) natively.
if (process.env.ZUN_TEST_HOSTNAME_CHECK !== "0") {
  for (const useOpen of [false, true]) {
    const label = `wrong-name ${useOpen ? "open" : "handshake"}`;
    assertRejected(await withServer(p => connect(p, { ca: root, serverName: "wrong.test" }, useOpen)), `${label} strict`, /ERR_TLS_CERT_ALTNAME_INVALID/);
    assertPermissive(
      await withServer(p => connect(p, { ca: root, serverName: "wrong.test", rejectUnauthorized: false }, useOpen)),
      `${label} permissive`,
      /ERR_TLS_CERT_ALTNAME_INVALID/,
    );
  }
}

// 4. Blocked intermediate / leaf key (zun debug hook only).
if (isZun) {
  for (const which of ["intermediate", "leaf"]) {
    const env = { ...process.env, ZUN_DEBUG_BLOCKED_SPKI_SHA256: spki[which] };
    const proc = spawnSync(process.execPath, [new URL(import.meta.url).pathname, "blocked-child"], { env, encoding: "utf8" });
    assert.strictEqual(proc.status, 0, `blocked ${which}: ${proc.stdout}\n${proc.stderr}`);
  }
}
console.log("ok");
