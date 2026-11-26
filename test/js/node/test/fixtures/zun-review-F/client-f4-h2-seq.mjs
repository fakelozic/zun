// F-4 (H2, sequential): like f4-h1-seq but forcing HTTP/2 so B can join A's live session.
import { attempt, CA, done } from "./common.mjs";
const url = `https://localhost:${process.env.PORT}/`;
const calls = [];
const a = await attempt("A", url, { protocol: "http2", tls: { ca: CA } });
const b = await attempt("B", url, {
  protocol: "http2",
  headers: { "x-req": "B" },
  tls: { ca: CA, checkServerIdentity: h => (calls.push(h), new Error("F4 B rejected")) },
});
done({ a, b, callbackCalls: calls });
