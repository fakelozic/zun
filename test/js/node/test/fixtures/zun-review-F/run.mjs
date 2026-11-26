// Driver for the review F-3 / F-4 / F-5 runtime checks (docs/security/review-2026-11-26-verify-F.md).
// Runs under Node: starts the TLS server(s) in this process so they log exactly what arrives on the wire, then runs
// the client script under the runtime being tested (zun, bun or node) and prints one JSON line with both sides.
//
//   node run.mjs <runtime-binary> <case>
//
// Certs: ca.pem signs server.pem (DNS:localhost only, no IP SAN), proxy.pem (DNS:localhost) and client.pem (clientAuth).
// ca.pem is a throwaway test CA; it is never trusted outside these runs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http2 from "node:http2";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const dir = path.dirname(new URL(import.meta.url).pathname);
const read = name => fs.readFileSync(path.join(dir, name), "utf8");
const [runtime, caseName] = process.argv.slice(2);
if (!runtime || !caseName) {
  console.error("usage: node run.mjs <runtime> <case>");
  process.exit(2);
}

const log = { connections: [] };
const sockets = new Set();

// HTTP/1.1 TLS server that records every byte it receives per connection, and answers each complete request
// ("\r\n\r\n"-terminated header block; bodies are only Content-Length and are consumed) with a keep-alive 200.
function h1Server({ requestCert = false, cert = "server" } = {}) {
  const server = tls.createServer(
    {
      cert: read(`${cert}.pem`),
      key: read(`${cert}.key`),
      ca: read("ca.pem"),
      requestCert,
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    },
    socket => {
      sockets.add(socket);
      const peer = socket.getPeerCertificate();
      const entry = {
        id: log.connections.length + 1,
        kind: "h1",
        sni: socket.servername || null,
        alpn: socket.alpnProtocol || null,
        clientCert: peer && peer.subject ? peer.subject.CN : null,
        bytes: 0,
        requests: [],
      };
      log.connections.push(entry);
      let buf = Buffer.alloc(0);
      socket.on("data", chunk => {
        entry.bytes += chunk.length;
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = buf.subarray(0, end).toString("latin1");
          const m = /\r\ncontent-length:\s*(\d+)/i.exec(head);
          const len = m ? Number(m[1]) : 0;
          if (buf.length < end + 4 + len) return;
          const body = buf.subarray(end + 4, end + 4 + len).toString("latin1");
          buf = buf.subarray(end + 4 + len);
          const [line] = head.split("\r\n");
          const host = /\r\nhost:\s*([^\r]*)/i.exec(head)?.[1] ?? null;
          const auth = /\r\nauthorization:\s*([^\r]*)/i.exec(head)?.[1] ?? null;
          entry.requests.push({ line, host, auth, body });
          const out = `conn${entry.id}`;
          socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${out.length}\r\nConnection: keep-alive\r\n\r\n${out}`);
        }
      });
      socket.on("error", e => (entry.error = e.code || String(e)));
    },
  );
  server.on("tlsClientError", e => log.connections.push({ kind: "tlsClientError", error: e.code || e.message }));
  return server;
}

function h2Server() {
  const server = http2.createSecureServer({
    cert: read("server.pem"),
    key: read("server.key"),
    allowHTTP1: true,
  });
  server.on("secureConnection", socket => {
    sockets.add(socket);
    socket.__entry = {
      id: log.connections.length + 1,
      kind: "h2",
      sni: socket.servername || null,
      alpn: socket.alpnProtocol || null,
      requests: [],
    };
    log.connections.push(socket.__entry);
  });
  server.on("request", (req, res) => {
    const entry = req.socket.__entry ?? req.stream?.session?.socket?.__entry;
    entry?.requests.push({ path: req.url, auth: req.headers.authorization ?? null, xreq: req.headers["x-req"] ?? null });
    res.end(`conn${entry?.id}`);
  });
  return server;
}

// Minimal HTTPS forward proxy (CONNECT only). Records the proxy-hop TLS details (SNI, client cert offered) and the
// CONNECT target, then pipes bytes to the target.
function httpsProxy() {
  const server = tls.createServer(
    {
      cert: read("proxy.pem"),
      key: read("proxy.key"),
      ca: read("ca.pem"),
      requestCert: true,
      rejectUnauthorized: false,
    },
    socket => {
      sockets.add(socket);
      const peer = socket.getPeerCertificate();
      const entry = {
        id: log.connections.length + 1,
        kind: "proxy",
        sni: socket.servername || null,
        clientCert: peer && peer.subject ? peer.subject.CN : null,
        connect: null,
      };
      log.connections.push(entry);
      let buf = Buffer.alloc(0);
      const onData = chunk => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", onData);
        const head = buf.subarray(0, end).toString("latin1");
        entry.connect = head.split("\r\n")[0];
        const [, target] = entry.connect.split(" ");
        const [host, port] = target.split(":");
        const up = net.connect(Number(port), host === "localhost" ? "127.0.0.1" : host, () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          const rest = buf.subarray(end + 4);
          if (rest.length) up.write(rest);
          socket.pipe(up).pipe(socket);
        });
        sockets.add(up);
        up.on("error", () => socket.destroy());
        socket.on("error", () => up.destroy());
      };
      socket.on("data", onData);
    },
  );
  return server;
}

const listen = (server, ...args) => new Promise(r => server.listen(...args, () => r(server)));

const env = { ...process.env, BUN_DEBUG_QUIET_LOGS: "1", CA: read("ca.pem") };
delete env.NODE_EXTRA_CA_CERTS;
let client;
const servers = [];

switch (caseName) {
  case "f3": // fresh connection + rejecting checkServerIdentity
  case "f3-nocheck": // control: same request, accepting callback
  case "f4-h1-seq":
  case "f4-h1-conc":
  case "f4-h1-host": {
    const s = await listen(h1Server(), 0, "127.0.0.1");
    servers.push(s);
    env.PORT = String(s.address().port);
    client = `client-${caseName.startsWith("f3") ? "f3" : caseName}.mjs`;
    env.F3_ACCEPT = caseName === "f3-nocheck" ? "1" : "";
    break;
  }
  case "f4-h2-seq":
  case "f4-h2-conc": {
    const s = await listen(h2Server(), 0, "127.0.0.1");
    servers.push(s);
    env.PORT = String(s.address().port);
    client = `client-${caseName}.mjs`;
    break;
  }
  case "f5-unix": {
    const sock = path.join(os.tmpdir(), `zun-review-f5-${process.pid}.sock`);
    try {
      fs.unlinkSync(sock);
    } catch {}
    const s = await listen(h1Server({ requestCert: true }), sock);
    servers.push(s);
    env.SOCK = sock;
    client = "client-f5-unix.mjs";
    break;
  }
  case "f5-proxy":
  case "f5-proxy-ca-only": // proxy hop trusted only through the origin's tls.ca: does that CA apply to the proxy hop?
  case "f5-proxy-sni": {
    const o = await listen(h1Server({ requestCert: true }), 0, "127.0.0.1");
    const p = await listen(httpsProxy(), 0, "127.0.0.1");
    servers.push(o, p);
    env.PORT = String(o.address().port);
    env.PROXY_PORT = String(p.address().port);
    // The proxy hop must be trusted somehow; give every runtime the test CA in its default store so the
    // proxy hop does not depend on which TLS context the runtime picks for it.
    if (caseName !== "f5-proxy-ca-only") env.NODE_EXTRA_CA_CERTS = path.join(dir, "ca.pem");
    client = `client-${caseName === "f5-proxy-ca-only" ? "f5-proxy" : caseName}.mjs`;
    break;
  }
  case "f5-sni-direct": {
    const o = await listen(h1Server(), 0, "127.0.0.1");
    servers.push(o);
    env.PORT = String(o.address().port);
    client = "client-f5-sni-direct.mjs";
    break;
  }
  default:
    console.error(`unknown case ${caseName}`);
    process.exit(2);
}

const child = spawn(runtime, [path.join(dir, client)], { env, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
let err = "";
child.stdout.on("data", d => (out += d));
child.stderr.on("data", d => (err += d));
const code = await new Promise(r => child.on("exit", r));
await new Promise(r => setTimeout(r, 300)); // let late bytes land in the server log
for (const s of sockets) s.destroy();
for (const s of servers) s.close();

let clientResult = null;
try {
  clientResult = JSON.parse(out.trim().split("\n").pop());
} catch {
  clientResult = { raw: out.slice(-2000), stderr: err.slice(-2000) };
}
console.log(JSON.stringify({ runtime: path.basename(runtime), case: caseName, exit: code, client: clientResult, server: log }));
process.exit(0);
