// Child process for test-zun-tls-ca-replaces-roots.mjs, run with NODE_EXTRA_CA_CERTS=root.pem. Serves the fixture chain
// and connects without `ca` (default store + NODE_EXTRA_CA_CERTS: trusted) and with `ca: other-root` (the explicit `ca`
// replaces the defaults including NODE_EXTRA_CA_CERTS: rejected). Prints one JSON line.
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const dir = path.dirname(new URL(import.meta.url).pathname);
const read = name => fs.readFileSync(path.join(dir, name), "utf8");
const server = tls.createServer({ cert: read("leaf.pem") + read("inter.pem"), key: read("leaf.key") }, s => s.end());
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const connect = extra =>
  new Promise(resolve => {
    const opts = { host: "127.0.0.1", port: server.address().port, servername: "localhost", ...extra };
    const socket = tls.connect(opts, () => {
      resolve({ ok: true, authorized: socket.authorized });
      socket.destroy();
    });
    socket.on("error", err => resolve({ ok: false, code: err.code ?? null }));
  });
const result = { noCa: await connect({}), otherCa: await connect({ ca: read("other-root.pem") }) };
server.close();
console.log(JSON.stringify(result));
