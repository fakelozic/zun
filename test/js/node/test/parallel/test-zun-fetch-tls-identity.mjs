// zun TLS-ID-1 (review F-3, F-4 HTTP/1.1, F-5 unix): fetch must apply its TLS identity policy before any
// application byte leaves the process, must not hand a pooled socket to a request whose identity policy that
// socket never satisfied, and must honour `tls` on unix sockets. Bun 1.4.5 passes every case.
//
// The servers record every byte received per connection, so "rejected" means "the server saw nothing", not only
// "the promise rejected". Certs: ../fixtures/zun-review-F (server.pem names DNS:localhost only, no IP SAN).
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "zun-review-F");
const read = name => fs.readFileSync(path.join(fixtures, name), "utf8");
const CA = read("ca.pem");

// HTTP/1.1 TLS server: logs bytes and parsed requests per connection, answers each request with a keep-alive 200
// whose body names the connection ("conn<N>").
function h1Server({ requestCert = false } = {}) {
  const conns = [];
  const sockets = new Set();
  const server = tls.createServer(
    {
      cert: read("server.pem"),
      key: read("server.key"),
      ca: CA,
      requestCert,
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    },
    socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      const peer = socket.getPeerCertificate();
      const entry = { id: conns.length + 1, bytes: 0, requests: [], clientCert: peer?.subject?.CN ?? null };
      conns.push(entry);
      let buf = Buffer.alloc(0);
      socket.on("data", chunk => {
        entry.bytes += chunk.length;
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = buf.subarray(0, end).toString("latin1");
          const len = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
          if (buf.length < end + 4 + len) return;
          buf = buf.subarray(end + 4 + len);
          entry.requests.push({ auth: /\r\nauthorization:\s*([^\r]*)/i.exec(head)?.[1] ?? null });
          const out = `conn${entry.id}`;
          socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${out.length}\r\nConnection: keep-alive\r\n\r\n${out}`);
        }
      });
      socket.on("error", () => {});
    },
  );
  server.conns = conns;
  // Close the listener and the server side of any keep-alive connection, so nothing keeps the process alive.
  server.shutdown = () => {
    for (const s of sockets) s.destroy();
    server.close();
  };
  return server;
}

const listen = (server, ...args) => new Promise(r => server.listen(...args, () => r(server)));
const settle = () => new Promise(r => setTimeout(r, 200)); // let late bytes reach the server log

async function attempt(url, init) {
  try {
    const res = await fetch(url, init);
    return { ok: true, status: res.status, body: await res.text() };
  } catch (err) {
    return { ok: false, code: err?.code ?? null, message: String(err?.message ?? err) };
  }
}

const authsSeen = server => server.conns.flatMap(c => c.requests.map(r => r.auth));
const totalBytes = server => server.conns.reduce((n, c) => n + c.bytes, 0);

async function withServer(opts, fn) {
  const server = await listen(h1Server(opts), 0, "127.0.0.1");
  try {
    await fn(server, server.address().port);
  } finally {
    server.shutdown();
  }
}

// F-3: a rejecting checkServerIdentity on a fresh connection. Zero application bytes may reach the server.
await withServer({}, async (server, port) => {
  const calls = [];
  const r = await attempt(`https://localhost:${port}/secret-path`, {
    method: "POST",
    headers: { authorization: "Bearer F3-SECRET" },
    body: "F3-BODY",
    keepalive: false,
    tls: { ca: CA, checkServerIdentity: h => (calls.push(h), new Error("F3 identity rejected")) },
  });
  await settle();
  assert.strictEqual(r.ok, false, "F-3: request with a rejecting checkServerIdentity succeeded");
  assert.deepStrictEqual(calls, ["localhost"], "F-3: checkServerIdentity was not called exactly once");
  assert.strictEqual(totalBytes(server), 0, `F-3: server received ${totalBytes(server)} application bytes`);
});

// F-3 control: the same request with an accepting callback reaches the server (the byte log works).
await withServer({}, async (server, port) => {
  const calls = [];
  const r = await attempt(`https://localhost:${port}/secret-path`, {
    method: "POST",
    headers: { authorization: "Bearer F3-SECRET" },
    body: "F3-BODY",
    keepalive: false,
    tls: { ca: CA, checkServerIdentity: h => (calls.push(h), undefined) },
  });
  assert.deepStrictEqual([r.ok, r.status], [true, 200], `F-3 control failed: ${JSON.stringify(r)}`);
  assert.deepStrictEqual(calls, ["localhost"]);
  assert.deepStrictEqual(authsSeen(server), ["Bearer F3-SECRET"]);
});

// F-4 sequential: A (native verification) is pooled; B carries a rejecting callback. B must not inherit A's
// socket: its callback runs on a fresh connection and nothing of B's request is sent.
await withServer({}, async (server, port) => {
  const url = `https://localhost:${port}/`;
  const calls = [];
  const a = await attempt(url, { tls: { ca: CA } });
  assert.deepStrictEqual([a.ok, a.status], [true, 200], `F-4 seq A: ${JSON.stringify(a)}`);
  const b = await attempt(url, {
    headers: { authorization: "Bearer F4-B" },
    tls: { ca: CA, checkServerIdentity: h => (calls.push(h), new Error("F4 B rejected")) },
  });
  await settle();
  assert.strictEqual(b.ok, false, `F-4 seq: B reused a pooled socket without its callback: ${JSON.stringify(b)}`);
  assert.deepStrictEqual(calls, ["localhost"]);
  assert.ok(!authsSeen(server).includes("Bearer F4-B"), "F-4 seq: B's credentials reached the server");
});

// F-4 concurrent: A and B together, then B2 (B's options). The socket whose callback rejected must never be
// pooled, so B2 runs its callback again and is rejected too.
await withServer({}, async (server, port) => {
  const url = `https://localhost:${port}/`;
  const calls = [];
  const strict = { ca: CA, checkServerIdentity: h => (calls.push(h), new Error("F4 B rejected")) };
  const [a, b] = await Promise.all([
    attempt(url, { tls: { ca: CA } }),
    attempt(url, { headers: { authorization: "Bearer F4-B" }, tls: strict }),
  ]);
  const b2 = await attempt(url, { headers: { authorization: "Bearer F4-B2" }, tls: strict });
  await settle();
  assert.deepStrictEqual([a.ok, a.status], [true, 200], `F-4 conc A: ${JSON.stringify(a)}`);
  assert.strictEqual(b.ok, false, `F-4 conc B: ${JSON.stringify(b)}`);
  assert.strictEqual(b2.ok, false, `F-4 conc: B2 reused the socket whose callback rejected: ${JSON.stringify(b2)}`);
  assert.deepStrictEqual(calls, ["localhost", "localhost"]);
  const auths = authsSeen(server);
  assert.ok(!auths.includes("Bearer F4-B") && !auths.includes("Bearer F4-B2"), `F-4 conc: credentials sent: ${auths}`);
});

// F-4 Host header: the certificate names only "localhost" and the URL host is 127.0.0.1. The Host header must not
// change the verified name (Bun 1.4.5 verifies the URL host), so neither request may succeed, and a request
// without the header can never inherit a verdict from one with it.
await withServer({}, async (server, port) => {
  const url = `https://127.0.0.1:${port}/`;
  const a = await attempt(url, { headers: { host: "localhost" }, tls: { ca: CA } });
  const b = await attempt(url, { tls: { ca: CA } });
  assert.strictEqual(a.ok, false, `F-4 host: Host header changed the verified name: ${JSON.stringify(a)}`);
  assert.strictEqual(b.ok, false, `F-4 host: B succeeded against a cert without its name: ${JSON.stringify(b)}`);
  assert.strictEqual(authsSeen(server).length, 0);
});

// F-5 unix: TLS over a unix socket must use the request's tls.ca and client certificate.
{
  const sock = path.join(os.tmpdir(), `zun-tls-id-1-${process.pid}.sock`);
  try {
    fs.unlinkSync(sock);
  } catch {}
  const server = await listen(h1Server({ requestCert: true }), sock);
  try {
    const r1 = await attempt("https://localhost/u1", { unix: sock, tls: { ca: CA } });
    assert.deepStrictEqual([r1.ok, r1.status], [true, 200], `F-5 unix: tls.ca ignored: ${JSON.stringify(r1)}`);
    const r2 = await attempt("https://localhost/u2", {
      unix: sock,
      keepalive: false,
      tls: { ca: CA, cert: read("client.pem"), key: read("client.key") },
    });
    assert.deepStrictEqual([r2.ok, r2.status], [true, 200], `F-5 unix (mTLS): ${JSON.stringify(r2)}`);
    assert.strictEqual(server.conns.at(-1).clientCert, "zun review-F client", "F-5 unix: client cert not sent");
  } finally {
    server.shutdown();
    try {
      fs.unlinkSync(sock);
    } catch {}
  }
}
