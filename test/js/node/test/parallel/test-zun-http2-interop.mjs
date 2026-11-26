// zun H2C-1: HTTP/2 must interoperate with a *different* implementation. Before the fix both zun HTTP/2 stacks
// (fetch's client and node:http2) wrote and read every frame header, PRIORITY block and SETTINGS payload
// byte-reversed (Zig 0.16+ `std.mem.byteSwapAllFields` swaps a packed struct's whole backing integer). zun talking to
// zun is symmetric, so every zun<->zun test passed; a real peer rejects the first frame. This test uses Node as the peer.
// RCA: docs/rca/H2C-1-http2-frame-byte-order.md
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http2 from "node:http2";
import path from "node:path";

const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "zun-blocked-spki");
const read = name => fs.readFileSync(path.join(fixtures, name), "utf8");
const ca = read("root.pem");
const cert = read("leaf.pem") + read("inter.pem");
const key = read("leaf.key");

// The peer must be real Node, not zun (or Bun) answering to `node`.
const NODE = process.env.ZUN_INTEROP_NODE || "node";
const probe = spawnSync(NODE, ["-p", "JSON.stringify({bun: process.versions.bun ?? null, node: process.versions.node})"], {
  encoding: "utf8",
});
if (probe.error?.code === "ENOENT") {
  console.log(`1..0 # SKIP no Node binary (${NODE}) to act as the HTTP/2 peer; set ZUN_INTEROP_NODE`);
  process.exit(0);
}
assert.strictEqual(probe.status, 0, `could not run ${NODE}: ${probe.stderr}`);
assert.strictEqual(JSON.parse(probe.stdout).bun, null, `${NODE} is Bun/zun, not Node: the test would be zun<->zun`);

const childEnv = { ...process.env, FIX_DIR: fixtures };

// Starts a Node child that prints one JSON line, returns [child, parsed line].
function startNode(source) {
  const child = spawn(NODE, ["-e", source], { env: childEnv, stdio: ["pipe", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let out = "";
    child.on("error", reject);
    child.on("exit", code => reject(new Error(`node child exited early (${code}): ${out}`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", d => {
      out += d;
      const nl = out.indexOf("\n");
      if (nl >= 0) {
        child.removeAllListeners("exit");
        resolve([child, JSON.parse(out.slice(0, nl))]);
      }
    });
  });
}

function runNode(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, ["-e", source], { env: childEnv, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", d => (out += d));
    child.on("error", reject);
    child.on("exit", code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`node client exited ${code}: ${out}`))));
  });
}

const withTimeout = (p, what, ms = 10_000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms).unref())]);

// ---- Node HTTP/2 server (TLS, ALPN h2 only) --------------------------------------------------------------------
const NODE_SERVER = `
const http2 = require("node:http2"), fs = require("node:fs"), path = require("node:path");
const r = n => fs.readFileSync(path.join(process.env.FIX_DIR, n), "utf8");
const server = http2.createSecureServer({ cert: r("leaf.pem") + r("inter.pem"), key: r("leaf.key"), allowHTTP1: false });
server.on("stream", (stream, headers) => {
  const chunks = [];
  stream.on("data", c => chunks.push(c));
  stream.on("end", () => {
    stream.respond({ ":status": 200, "content-type": "application/json", "x-peer": "node" });
    stream.end(JSON.stringify({ method: headers[":method"], path: headers[":path"],
      body: Buffer.concat(chunks).toString(), from: "node" }));
  });
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port })));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;

const [nodeServer, { port: nodePort }] = await withTimeout(startNode(NODE_SERVER), "node h2 server start");
try {
  // 1. zun node:http2 client -> Node server: SETTINGS exchange, HEADERS, DATA both ways.
  {
    const client = http2.connect(`https://localhost:${nodePort}`, { ca });
    try {
      const request = (method, body) =>
        new Promise((resolve, reject) => {
          const req = client.request({ ":method": method, ":path": "/zun?x=1" });
          let status, data = "";
          req.on("response", h => (status = h[":status"]));
          req.setEncoding("utf8");
          req.on("data", d => (data += d));
          req.on("end", () => resolve({ status, json: JSON.parse(data) }));
          req.on("error", reject);
          req.end(body);
        });
      const get = await withTimeout(request("GET"), "zun http2 client GET to node");
      assert.deepStrictEqual(get, { status: 200, json: { method: "GET", path: "/zun?x=1", body: "", from: "node" } });
      const big = Buffer.alloc(40_000, "z").toString(); // several DATA frames and WINDOW_UPDATEs
      const post = await withTimeout(request("POST", big), "zun http2 client POST to node");
      assert.strictEqual(post.status, 200);
      assert.strictEqual(post.json.body, big);
    } finally {
      client.close();
    }
  }

  // 2. fetch(…, {protocol: "http2"}) -> Node server (fetch's separate HTTP/2 client, src/http/h2_client/).
  //    Bun-only options; the guard just lets the test's own logic be sanity-checked under Node.
  if (typeof Bun !== "undefined") {
    const res = await withTimeout(
      fetch(`https://localhost:${nodePort}/fetch`, { protocol: "http2", tls: { ca }, method: "POST", body: "hello" }),
      "fetch h2 to node",
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("x-peer"), "node");
    assert.deepStrictEqual(await res.json(), { method: "POST", path: "/fetch", body: "hello", from: "node" });
  }
} finally {
  nodeServer.stdin.end();
}

// 3. Node http2 client -> zun node:http2 server.
{
  const server = http2.createSecureServer({ cert, key, allowHTTP1: false });
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", d => (body += d));
    stream.on("end", () => {
      stream.respond({ ":status": 201, "x-peer": "zun" });
      stream.end(JSON.stringify({ method: headers[":method"], path: headers[":path"], length: body.length }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const result = await withTimeout(
      runNode(`
const http2 = require("node:http2"), fs = require("node:fs"), path = require("node:path");
const ca = fs.readFileSync(path.join(process.env.FIX_DIR, "root.pem"), "utf8");
const client = http2.connect("https://localhost:${port}", { ca });
client.on("error", e => { console.error(e); process.exit(2); });
const req = client.request({ ":method": "POST", ":path": "/from-node" });
let status, peer, data = "";
req.on("response", h => { status = h[":status"]; peer = h["x-peer"]; });
req.setEncoding("utf8");
req.on("data", d => (data += d));
req.on("end", () => { console.log(JSON.stringify({ status, peer, json: JSON.parse(data) })); client.close(); });
req.on("error", e => { console.error(e); process.exit(3); });
req.end("n".repeat(40000));
`),
      "node http2 client to zun server",
    );
    assert.deepStrictEqual(result, { status: 201, peer: "zun", json: { method: "POST", path: "/from-node", length: 40000 } });
  } finally {
    server.close();
  }
}

console.log("ok");
