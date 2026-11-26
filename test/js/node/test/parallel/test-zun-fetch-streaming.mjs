// zun FETCH-1 / TQ-1: fetch must resolve when the response *headers* arrive and stream the body as it comes.
// The server sends the headers and a first chunk, then waits until the client has read that chunk before sending the
// rest. A fetch that buffers the whole body before resolving deadlocks here, so a guard turns that into a failure.
import assert from "node:assert";
import net from "node:net";

const { promise: firstChunkRead, resolve: onFirstChunkRead } = Promise.withResolvers();

const server = net.createServer(socket => {
  socket.on("error", () => {});
  socket.once("data", async () => {
    socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
    socket.write("5\r\nfirst\r\n");
    await firstChunkRead;
    socket.end("6\r\nsecond\r\n0\r\n\r\n");
  });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

let guard;
const deadlock = new Promise((_, reject) => {
  guard = setTimeout(() => reject(new Error("fetch did not stream: no headers/first chunk before the body completed")), 10_000);
});

try {
  const body = await Promise.race([
    (async () => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
      assert.strictEqual(res.status, 200);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const first = await reader.read();
      assert.strictEqual(first.done, false);
      let text = decoder.decode(first.value, { stream: true });
      assert.ok(text.startsWith("first"), `first read: ${JSON.stringify(text)}`);
      onFirstChunkRead();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text;
    })(),
    deadlock,
  ]);
  assert.strictEqual(body, "firstsecond");
} finally {
  clearTimeout(guard);
  onFirstChunkRead();
  server.close();
}
