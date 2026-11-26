// F-5 (HTTPS proxy): the origin's tls {ca, cert, key} must reach the origin, not the proxy hop. The proxy requests a
// client certificate; the log shows which hop was offered client.pem.
import fs from "node:fs";
import path from "node:path";
import { attempt, CA, done } from "./common.mjs";
const dir = path.dirname(new URL(import.meta.url).pathname);
const cert = fs.readFileSync(path.join(dir, "client.pem"), "utf8");
const key = fs.readFileSync(path.join(dir, "client.key"), "utf8");
const r = await attempt("via-proxy", `https://localhost:${process.env.PORT}/p`, {
  proxy: `https://localhost:${process.env.PROXY_PORT}`,
  tls: { ca: CA, cert, key },
});
done({ r });
