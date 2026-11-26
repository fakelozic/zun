// F-4 (H1, sequential): A verifies normally and goes back to the keep-alive pool; B has the same tls config plus a
// rejecting checkServerIdentity. Safe outcome: B rejects (callback ran) or at least does not reuse A's socket.
import { attempt, CA, done } from "./common.mjs";
const url = `https://localhost:${process.env.PORT}/`;
const calls = [];
const a = await attempt("A", url, { tls: { ca: CA } });
const b = await attempt("B", url, {
  headers: { authorization: "Bearer F4-B" },
  tls: { ca: CA, checkServerIdentity: h => (calls.push(h), new Error("F4 B rejected")) },
});
done({ a, b, callbackCalls: calls });
