// H1-2: bare-LF trailer terminator, and surplus bytes after the terminal chunk in the same write,
// followed by a keep-alive follow-up request. Runs on the runtime under test; server is in-process (net).
import net from "node:net";
const head = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
const smuggled = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nEVIL!";
const cases = {
  "bare LF terminator": head + "5\r\nhello\r\n0\r\n\n",
  "bare LF after trailer": head + "5\r\nhello\r\n0\r\nX-T: 1\n\n",
  "CR CR LF terminator": head + "5\r\nhello\r\n0\r\n\r\r\n",
  "surplus response after terminal chunk": head + "5\r\nhello\r\n0\r\n\r\n" + smuggled,
  "surplus junk after terminal chunk": head + "5\r\nhello\r\n0\r\n\r\nGARBAGE",
  "bare LF terminator + surplus response": head + "5\r\nhello\r\n0\r\n\n" + smuggled,
};
for (const [name, raw] of Object.entries(cases)) {
  let conns = 0; const log = [];
  const srv = net.createServer(s => {
    const id = ++conns; let n = 0;
    s.on("error", () => {});
    s.on("data", d => {
      n++; log.push(`conn${id}#${n}`);
      if (id === 1 && n === 1) s.write(raw);
      else s.write("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecond");
    });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const r1 = await fetch(url).then(r => r.text()).then(t => "body " + JSON.stringify(t), e => "error " + (e.code ?? e.message));
  const r2 = await fetch(url).then(r => r.text()).then(t => "body " + JSON.stringify(t), e => "error " + (e.code ?? e.message));
  console.log(`${name}: first=${r1} second=${r2} server=[${log.join(",")}]`);
  srv.close(); for (const s of []) s;
}
process.exit(0);
