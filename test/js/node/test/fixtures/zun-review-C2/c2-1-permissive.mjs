// Review C2-1 repro (zun debug builds): with rejectUnauthorized:false, is a chain holding a blocked key still accepted,
// and what do authorized / authorizationError / checkServerIdentity show? Run once with nothing extra blocked and once
// with ZUN_DEBUG_BLOCKED_SPKI_SHA256 set to the leaf's (or intermediate's) key from ../zun-blocked-spki/spki.json.
// C2_1_UNTRUSTED=1 trusts other-root.pem instead, so every runtime (Bun 1.4.5, and Node for node:tls) can be compared on
// the same soft-error path with a non-blocklist verify error. Prints one JSON line.
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "zun-blocked-spki");
const read = name => fs.readFileSync(path.join(dir, name), "utf8");
const root = read(process.env.C2_1_UNTRUSTED ? "other-root.pem" : "root.pem");

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  tls: { cert: read("leaf.pem") + read("inter.pem"), key: read("leaf.key") },
  fetch: () => new Response("ok"),
});
const port = server.port;
const result = { blocked: process.env.ZUN_DEBUG_BLOCKED_SPKI_SHA256 ?? null, untrusted: !!process.env.C2_1_UNTRUSTED };
const err = e => ({ ok: false, code: e?.code ?? null, message: String(e?.message ?? e) });

for (const [name, opts] of [
  ["fetchStrict", { ca: root }],
  ["fetchPermissive", { ca: root, rejectUnauthorized: false }],
]) {
  try {
    const res = await fetch(`https://localhost:${port}/`, { tls: opts });
    result[name] = { ok: true, body: await res.text() };
  } catch (e) {
    result[name] = err(e);
  }
}

for (const [name, rejectUnauthorized] of [["tlsStrict", true], ["tlsPermissive", false]]) {
  result[name] = await new Promise(resolve => {
    let identityCalls = 0;
    const socket = tls.connect(
      {
        host: "127.0.0.1",
        servername: "localhost",
        port,
        ca: root,
        rejectUnauthorized,
        checkServerIdentity: () => {
          identityCalls++;
          return undefined;
        },
      },
      () => {
        resolve({
          ok: true,
          authorized: socket.authorized,
          authorizationError: String(socket.authorizationError ?? null),
          identityCalls,
        });
        socket.end();
      },
    );
    socket.on("error", e => resolve({ ...err(e), identityCalls }));
  });
}

for (const [name, rejectUnauthorized] of [["bunConnectStrict", true], ["bunConnectPermissive", false]]) {
  result[name] = await new Promise(resolve => {
    let done = false;
    const finish = v => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      tls: { ca: root, serverName: "localhost", rejectUnauthorized },
      socket: {
        handshake(socket, success, authorizationError) {
          finish({
            ok: true,
            handshakeSuccess: success,
            authorizationError: String(authorizationError ?? null),
            authorized: socket.authorized,
          });
          socket.end();
        },
        data() {},
        error(_s, e) {
          finish(err(e));
        },
        connectError(_s, e) {
          finish(err(e));
        },
        close() {
          finish({ ok: false, closedBeforeHandshake: true });
        },
      },
    }).catch(e => finish(err(e)));
  });
}

server.stop(true);
console.log(JSON.stringify(result));
