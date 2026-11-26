// F-3: a fresh TLS connection whose checkServerIdentity rejects. The server must see zero request bytes.
// F3_ACCEPT=1 is the control (callback accepts), proving the request bytes would otherwise arrive.
import { attempt, CA, done } from "./common.mjs";
const calls = [];
const r = await attempt("A", `https://localhost:${process.env.PORT}/secret-path`, {
  method: "POST",
  headers: { authorization: "Bearer F3-SECRET" },
  body: "F3-BODY",
  keepalive: false,
  tls: {
    ca: CA,
    checkServerIdentity(host) {
      calls.push(host);
      return process.env.F3_ACCEPT ? undefined : new Error("F3 identity rejected");
    },
  },
});
done({ result: r, callbackCalls: calls });
