// H1-1 server: endless framing, no body bytes. mode=ext | trailer. Prints port.
import net from "node:net";
const mode = process.argv[2];
const head = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
const blob = Buffer.alloc(64 * 1024, "a");
let sent = 0;
const srv = net.createServer(s => {
  s.on("error", () => {});
  s.once("data", () => {
    s.write(head + (mode === "ext" ? "1;x=" : "1\r\nz\r\n0\r\nX-T: "));
    const t = setInterval(() => {
      if (s.destroyed) return clearInterval(t);
      if (mode === "trailer") s.write(Buffer.concat([blob, Buffer.from("\r\nX-T: ")]));
      else s.write(blob);
      sent += blob.length;
    }, 20);
  });
});
srv.listen(0, "127.0.0.1", () => console.log(srv.address().port));
setInterval(() => console.error("server sent MB", (sent / 1048576).toFixed(0)), 5000).unref();
