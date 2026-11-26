// F-4 (H2, concurrent): B starts while A's handshake is pending, so it may wait on A's PendingConnect.
import { attempt, CA, done } from "./common.mjs";
const url = `https://localhost:${process.env.PORT}/`;
const calls = [];
const [a, b] = await Promise.all([
  attempt("A", url, { protocol: "http2", headers: { "x-req": "A" }, tls: { ca: CA } }),
  attempt("B", url, {
    protocol: "http2",
    headers: { "x-req": "B" },
    tls: { ca: CA, checkServerIdentity: h => (calls.push(h), new Error("F4 B rejected")) },
  }),
]);
done({ a, b, callbackCalls: calls });
