// Review C2-2 server (run under zun by c2-2-run.sh). Strict mTLS: requestCert + rejectUnauthorized, client CA =
// client-ca.pem. Serves HTTP/1.1 over TCP and HTTP/3 on the same port; prints the port, then each dispatched request.
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const spkiDir = path.join(here, "..", "zun-blocked-spki");
const read = (d, n) => fs.readFileSync(path.join(d, n), "utf8");

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  http3: true,
  tls: {
    cert: read(spkiDir, "leaf.pem") + read(spkiDir, "inter.pem"),
    key: read(spkiDir, "leaf.key"),
    ca: read(here, "client-ca.pem"),
    requestCert: true,
    rejectUnauthorized: true,
  },
  fetch(req) {
    console.log(`DISPATCHED ${req.headers.get("x-case")}`);
    return new Response("dispatched\n");
  },
});
console.log(`PORT ${server.port}`);
setTimeout(() => server.stop(true), Number(process.env.C2_2_SERVER_MS ?? 20000));
