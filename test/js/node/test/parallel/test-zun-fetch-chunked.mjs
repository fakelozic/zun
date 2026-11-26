// zun security H1: fetch must decode chunked responses strictly.
// Each case is a raw HTTP response written by a TCP server; fetch must either return the exact
// body or reject. A truncated body must never be reported as complete (picohttpparser renumbered
// its private decoder states; reading the old numbers would have accepted a cut-off body).
// The new C enum is 3 = CHUNK_DATA, 4 = DATA_EXPECT_CR, 5 = DATA_EXPECT_LF, 6/7 = TRAILERS_LINE_*;
// the old Zig mirror treated 4 and 5 as "in trailers" (body complete). The two "after full chunk
// data" cases below end in exactly states 4 and 5, so they are the ones that catch a stale mirror.
import assert from "node:assert";
import net from "node:net";

const head = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";

const cases = [
  { name: "valid", raw: head + "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n", body: "hello world" },
  { name: "valid with trailers", raw: head + "5\r\nhello\r\n0\r\nX-T: 1\r\n\r\n", body: "hello" },
  { name: "valid chunk extension", raw: head + "5;name=value\r\nhello\r\n0\r\n\r\n", body: "hello" },
  { name: "many one-byte chunks", raw: head + "1\r\na\r\n".repeat(20000) + "0\r\n\r\n", body: "a".repeat(20000) },
  { name: "bare LF after chunk size", raw: head + "5\nhello\r\n0\r\n\r\n", reject: true },
  { name: "whitespace after chunk size", raw: head + "5 \r\nhello\r\n0\r\n\r\n", reject: true },
  { name: "non-hex chunk size", raw: head + "5g\r\nhello\r\n0\r\n\r\n", reject: true },
  { name: "chunk size overflow", raw: head + "ffffffffffffffffff\r\nhello\r\n0\r\n\r\n", reject: true },
  { name: "missing CRLF after data", raw: head + "5\r\nhelloXX0\r\n\r\n", reject: true },
  { name: "truncated mid chunk then close", raw: head + "5\r\nhel", reject: true },
  { name: "truncated after full chunk data, before CRLF", raw: head + "5\r\nhello", reject: true },
  { name: "truncated after full chunk data, inside CRLF", raw: head + "5\r\nhello\r", reject: true },
  { name: "truncated before terminal chunk", raw: head + "5\r\nhello\r\n", reject: true },
];

function serve(raw) {
  return new Promise(resolve => {
    const server = net.createServer(socket => {
      socket.once("data", () => {
        socket.end(raw);
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function run(c) {
  const server = await serve(c.raw);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const text = await res.text();
    return { ok: true, text };
  } catch (err) {
    return { ok: false, err };
  } finally {
    server.close();
  }
}

const failures = [];
for (const c of cases) {
  const r = await run(c);
  if (c.reject) {
    if (r.ok) failures.push(`${c.name}: expected rejection, got body ${JSON.stringify(r.text.slice(0, 40))}`);
  } else if (!r.ok) {
    failures.push(`${c.name}: expected ${JSON.stringify(c.body.slice(0, 20))}…, got error ${r.err?.code ?? r.err?.message}`);
  } else if (r.text !== c.body) {
    failures.push(`${c.name}: wrong body (${r.text.length} bytes)`);
  }
}
assert.deepStrictEqual(failures, []);
