// zun security H5: Bun.serve's HTTP/1.1 parser must not let a request be smuggled behind a proxy.
// Each case writes raw bytes on a fresh TCP connection to one Bun.serve server and checks the
// status lines it gets back, whether the server closed the connection, and which requests reached
// the handler. Malformed framing must be answered with 400 (413 for oversized chunk extensions)
// and a close; requests pipelined behind `Connection: close` / HTTP/1.0 must never reach the
// handler. Positive controls make sure the test cannot pass by rejecting everything.
// Cases ported from Bun 1.4.5 test/js/bun/http/request-smuggling.test.ts,
// http-server-chunking.test.ts and serve.test.ts ("does not dispatch a pipelined request after
// Connection: close"). See docs/rca/H5-serve-http1-smuggling.md.
import assert from "node:assert";
import net from "node:net";

const entered = []; // requests whose head reached the handler
const seen = []; // requests whose body was read completely
let settled = 0; // handler invocations that have finished (resolved or thrown)
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  development: false,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    entered.push(`${req.method} ${path}`);
    try {
      if (path.startsWith("/slow")) await Bun.sleep(50); // an async handler, not a wait
      const body = await req.text();
      seen.push(`${req.method} ${path} body=${body}`);
      return new Response("ok:" + path);
    } finally {
      settled++;
    }
  },
  error() {
    return new Response("handler error", { status: 500 });
  },
});

const H = "Host: x\r\n";
const get = (path, extra = "") => `GET ${path} HTTP/1.1\r\n${H}${extra}\r\n`;
const post = (path, headers, body) => `POST ${path} HTTP/1.1\r\n${H}${headers.map(h => h + "\r\n").join("")}\r\n${body}`;
const chunked = "5\r\nhello\r\n0\r\n\r\n";

function send(raw) {
  return new Promise(resolve => {
    const socket = net.connect(server.port, "127.0.0.1");
    let out = "";
    let done = false;
    const finish = closed => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ statuses: [...out.matchAll(/HTTP\/1\.[01] (\d{3})/g)].map(m => m[1]), closed, out });
    };
    // A server that keeps the connection open after a framing error (or after Connection: close)
    // is itself a failure; do not wait for it forever.
    const timer = setTimeout(() => finish(false), 3000);
    socket.on("connect", () => socket.write(Buffer.from(raw, "latin1")));
    socket.on("data", d => (out += d.toString("latin1")));
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
  });
}

// expect: statuses (in order) or lastStatus, closed, entered (handler heads), seen (complete bodies).
// Only the keys present in `expect` are compared.
const reject400 = { statuses: ["400"], closed: true, entered: [], seen: [] };
const cases = [
  // --- Transfer-Encoding lists (Bun #35295): only a single, final "chunked" is implemented.
  { name: "TE gzip, chunked", raw: post("/a", ["Transfer-Encoding: gzip, chunked"], chunked), expect: reject400 },
  { name: "TE x, chunked", raw: post("/a", ["Transfer-Encoding: x, chunked"], chunked), expect: reject400 },
  { name: "TE identity, chunked", raw: post("/a", ["Transfer-Encoding: identity, chunked"], chunked), expect: reject400 },
  { name: "TE gzip,<tab>chunked", raw: post("/a", ["Transfer-Encoding: gzip,\tchunked"], chunked), expect: reject400 },
  { name: "TE chunked, chunked", raw: post("/a", ["Transfer-Encoding: chunked, chunked"], chunked), expect: reject400 },
  {
    name: "TE split fields gzip + chunked",
    raw: post("/a", ["Transfer-Encoding: gzip", "Transfer-Encoding: chunked"], chunked),
    expect: reject400,
  },
  // --- Empty Transfer-Encoding must not fall back to Content-Length framing (CL.TE, Bun #31339).
  {
    name: "TE empty before CL, smuggled GET /admin",
    raw: post("/a", ["Transfer-Encoding: ", "Content-Length: 4"], "ABCD" + get("/admin")),
    expect: reject400,
  },
  {
    name: "TE empty after CL, smuggled GET /admin",
    raw: post("/a", ["Content-Length: 4", "Transfer-Encoding: "], "ABCD" + get("/admin")),
    expect: reject400,
  },
  {
    name: "TE empty, no CL, smuggled GET /admin",
    raw: post("/a", ["Transfer-Encoding: "], get("/admin")),
    expect: reject400,
  },
  // --- Transfer-Encoding on HTTP/1.0 (RFC 9112 6.1, Bun #35864).
  {
    name: "HTTP/1.0 + TE chunked",
    raw: `POST /a HTTP/1.0\r\n${H}Transfer-Encoding: chunked\r\n\r\n${chunked}`,
    expect: reject400,
  },
  {
    name: "HTTP/1.0 keep-alive + TE chunked",
    raw: `POST /a HTTP/1.0\r\n${H}Connection: keep-alive\r\nTransfer-Encoding: chunked\r\n\r\n${chunked}`,
    expect: reject400,
  },
  // --- Chunk extensions are capped at 16 KiB per chunk (Bun #34504). The head is dispatched
  // before the body is parsed, so the handler is entered, but the body never completes.
  {
    name: "chunk extension > 16 KiB",
    raw: post("/a", ["Transfer-Encoding: chunked"], "2;" + Buffer.alloc(32 * 1024, "e").toString() + "\r\nhi\r\n0\r\n\r\n"),
    expect: { statuses: ["413"], closed: true, entered: ["POST /a"], seen: [] },
  },
  // --- Trailer fields are not accepted at all (already true in 1.3.14; pinned here). The parser
  // emits the end of the body on "0\r\n" before it checks the final CRLF (same in Bun 1.4.5), so a
  // 200 for /a may precede the 400; what matters is the 400, the close, and that /admin never runs.
  {
    name: "trailer field after last chunk",
    raw: post("/a", ["Transfer-Encoding: chunked"], "5\r\nhello\r\n0\r\nX-Trailer: 1\r\n\r\n"),
    expect: { lastStatus: "400", closed: true, entered: ["POST /a"] },
  },
  {
    name: "smuggled request in place of final CRLF",
    raw: post("/a", ["Transfer-Encoding: chunked"], "0\r\nX:" + post("/admin", ["Content-Length: 5"], "admin")),
    expect: { lastStatus: "400", closed: true, entered: ["POST /a"] },
  },
  // --- No request is processed after Connection: close / HTTP/1.0 (RFC 9112 9.6, Bun #33005).
  {
    name: "pipelined after Connection: close",
    raw: get("/a", "Connection: close\r\n") + get("/b"),
    expect: { statuses: ["200"], closed: true, entered: ["GET /a"], seen: ["GET /a body="] },
  },
  {
    name: "pipelined after Connection: Close",
    raw: get("/a", "Connection: Close\r\n") + get("/b"),
    expect: { statuses: ["200"], closed: true, entered: ["GET /a"], seen: ["GET /a body="] },
  },
  {
    name: "pipelined after Connection: keep-alive, close",
    raw: get("/a", "Connection: keep-alive, close\r\n") + get("/b"),
    expect: { statuses: ["200"], closed: true, entered: ["GET /a"], seen: ["GET /a body="] },
  },
  {
    name: "pipelined after second Connection field close",
    raw: get("/a", "Connection: keep-alive\r\nConnection: close\r\n") + get("/b"),
    expect: { statuses: ["200"], closed: true, entered: ["GET /a"], seen: ["GET /a body="] },
  },
  {
    name: "pipelined after HTTP/1.0",
    raw: `GET /a HTTP/1.0\r\n${H}\r\n` + get("/b"),
    expect: { statuses: ["200"], closed: true, entered: ["GET /a"], seen: ["GET /a body="] },
  },
  {
    name: "close in the middle of a pipeline",
    raw: get("/0") + get("/1", "Connection: close\r\n") + get("/2") + get("/3"),
    expect: {
      statuses: ["200", "200"],
      closed: true,
      entered: ["GET /0", "GET /1"],
      seen: ["GET /0 body=", "GET /1 body="],
    },
  },
  {
    name: "pipelined after close-flagged POST with body",
    raw: post("/a", ["Connection: close", "Content-Length: 3"], "abc") + get("/b"),
    expect: { statuses: ["200"], closed: true, entered: ["POST /a"], seen: ["POST /a body=abc"] },
  },
  {
    name: "pipelined after close-flagged async handler",
    raw: get("/slow", "Connection: close\r\n") + get("/b"),
    expect: { statuses: ["200"], closed: true, entered: ["GET /slow"], seen: ["GET /slow body="] },
  },
  // --- Positive controls.
  {
    name: "control: valid chunked body",
    raw: post("/a", ["Connection: close", "Transfer-Encoding: chunked"], chunked),
    expect: { statuses: ["200"], closed: true, entered: ["POST /a"], seen: ["POST /a body=hello"] },
  },
  {
    name: "control: OWS around chunked",
    raw: post("/a", ["Connection: close", "Transfer-Encoding: \tchunked "], chunked),
    expect: { statuses: ["200"], closed: true, entered: ["POST /a"], seen: ["POST /a body=hello"] },
  },
  {
    // RFC 9110 5.6.1: empty list elements are ignored, so "chunked," is "chunked". Bun 1.4.5
    // accepts it the same way (llhttp does not; see the RCA).
    name: "control: TE chunked, (empty list element)",
    raw: post("/a", ["Connection: close", "Transfer-Encoding: chunked,"], chunked),
    expect: { statuses: ["200"], closed: true, entered: ["POST /a"], seen: ["POST /a body=hello"] },
  },
  {
    name: "control: chunk extensions within the per-chunk cap",
    raw: post(
      "/a",
      ["Connection: close", "Transfer-Encoding: chunked"],
      Array.from({ length: 10 }, () => "1;" + Buffer.alloc(8000, "e").toString() + "\r\nx\r\n").join("") + "0\r\n\r\n",
    ),
    expect: { statuses: ["200"], closed: true, entered: ["POST /a"], seen: ["POST /a body=" + "x".repeat(10)] },
  },
  {
    name: "control: keep-alive pipelining",
    raw: get("/a") + get("/b") + get("/c", "Connection: close\r\n"),
    expect: {
      statuses: ["200", "200", "200"],
      closed: true,
      entered: ["GET /a", "GET /b", "GET /c"],
      seen: ["GET /a body=", "GET /b body=", "GET /c body="],
    },
  },
  {
    name: "control: chunked body then pipelined request",
    raw: post("/a", ["Transfer-Encoding: chunked"], chunked) + get("/b", "Connection: close\r\n"),
    expect: {
      statuses: ["200", "200"],
      closed: true,
      entered: ["POST /a", "GET /b"],
      seen: ["POST /a body=hello", "GET /b body="],
    },
  },
  {
    // A 5-byte Connection value that is not "close" (the old length() == 5 test matched it).
    name: "control: Connection: nope! keeps the connection",
    raw: get("/a", "Connection: nope!\r\n") + get("/b", "Connection: close\r\n"),
    expect: {
      statuses: ["200", "200"],
      closed: true,
      entered: ["GET /a", "GET /b"],
      seen: ["GET /a body=", "GET /b body="],
    },
  },
];

const failures = [];
try {
  for (const c of cases) {
    entered.length = 0;
    seen.length = 0;
    settled = 0;
    const r = await send(c.raw);
    // Wait for every handler that was entered to finish (the async-handler case finishes after
    // the client already saw the close). Bounded so a stuck handler fails instead of hanging.
    for (let i = 0; i < 400 && settled < entered.length; i++) await Bun.sleep(5);
    const all = {
      statuses: r.statuses,
      lastStatus: r.statuses.at(-1),
      closed: r.closed,
      entered: [...entered],
      seen: [...seen],
    };
    const got = Object.fromEntries(Object.keys(c.expect).map(k => [k, all[k]]));
    try {
      assert.deepStrictEqual(got, c.expect);
    } catch {
      failures.push(`${c.name}: expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}`);
    }
  }
} finally {
  server.stop(true);
}
if (failures.length) console.error(failures.join("\n"));
assert.deepStrictEqual(failures, []);
