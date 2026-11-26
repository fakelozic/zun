// zun H5-1 (open, docs/security/known-issues.md): after an *async* handler answers a request that carried
// `Connection: close`, Bun.serve must close the connection (RFC 9112 9.6), and a request pipelined behind it must
// never reach the handler. Bun 1.4.5 passes. zun with the H5 backport discards /b (smuggling fixed) but keeps the
// connection open: the close-after-uncork logic from Bun #42986 is not backported. Expected to FAIL until fixed.
import assert from "node:assert";
import net from "node:net";

const entered = [];
let settled = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  development: false,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    entered.push(`${req.method} ${path}`);
    try {
      if (path === "/slow") await Bun.sleep(50); // makes the handler async; not a wait for a condition
      return new Response("ok:" + path);
    } finally {
      settled++;
    }
  },
});

const raw = "GET /slow HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\nGET /b HTTP/1.1\r\nHost: x\r\n\r\n";
try {
  const result = await new Promise(resolve => {
    const socket = net.connect(server.port, "127.0.0.1");
    let out = "";
    let done = false;
    const finish = closed => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ statuses: [...out.matchAll(/HTTP\/1\.[01] (\d{3})/g)].map(m => m[1]), closed });
    };
    // A server that keeps the connection open after Connection: close is the failure being tested; bound the wait.
    const timer = setTimeout(() => finish(false), 3000);
    socket.on("connect", () => socket.write(raw));
    socket.on("data", d => (out += d.toString("latin1")));
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
  });
  for (let i = 0; i < 400 && settled < entered.length; i++) await Bun.sleep(5);
  assert.deepStrictEqual({ ...result, entered }, { statuses: ["200"], closed: true, entered: ["GET /slow"] });
} finally {
  server.stop(true);
}
