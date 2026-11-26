// Surplus in a later read (after the body completed) on a pooled keep-alive socket (relates to review H2).
import net from "node:net";
const head = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
let conns = 0; const log = [];
const srv = net.createServer(s => {
  const id = ++conns; let n = 0; s.on("error", () => {});
  s.on("data", () => { n++; log.push(`conn${id}#${n}`);
    if (id === 1 && n === 1) { s.write(head + "5\r\nhello\r\n0\r\n\r\n"); setTimeout(() => s.write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nEVIL!"), 100); }
    else s.write("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecond"); });
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/`;
const f = () => fetch(url).then(r => r.text()).then(t => "body " + JSON.stringify(t), e => "error " + (e.code ?? e.message));
const r1 = await f(); await new Promise(r => setTimeout(r, 300)); const r2 = await f();
console.log(`late surplus: first=${r1} second=${r2} server=[${log.join(",")}]`); process.exit(0);
