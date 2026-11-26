// F-5 (unix): TLS over a unix socket with tls.ca = test CA and a client cert. The server's cert chains only to the
// test CA, so success means tls.ca was used; the server log shows whether the client cert was presented.
import fs from "node:fs";
import path from "node:path";
import { attempt, CA, done } from "./common.mjs";
const dir = path.dirname(new URL(import.meta.url).pathname);
const cert = fs.readFileSync(path.join(dir, "client.pem"), "utf8");
const key = fs.readFileSync(path.join(dir, "client.key"), "utf8");
const r1 = await attempt("ca-only", "https://localhost/u1", { unix: process.env.SOCK, tls: { ca: CA } });
const r2 = await attempt("ca+client-cert", "https://localhost/u2", { unix: process.env.SOCK, tls: { ca: CA, cert, key }, keepalive: false });
done({ r1, r2 });
