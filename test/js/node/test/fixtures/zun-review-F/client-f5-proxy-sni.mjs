// F-5 (inner SNI vs serverName through a proxy): URL host is 127.0.0.1, tls.serverName is "localhost".
// Expected: inner SNI "localhost" and verification against "localhost" -> success (same as direct).
import { attempt, CA, done } from "./common.mjs";
const r = await attempt("via-proxy", `https://127.0.0.1:${process.env.PORT}/s`, {
  proxy: `https://localhost:${process.env.PROXY_PORT}`,
  tls: { ca: CA, serverName: "localhost" },
});
done({ r });
