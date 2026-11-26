// F-4 (H1, concurrent then sequential): A and B started together, then B again after both finish.
import { attempt, CA, done } from "./common.mjs";
const url = `https://localhost:${process.env.PORT}/`;
const calls = [];
const strict = { ca: CA, checkServerIdentity: h => (calls.push(h), new Error("F4 B rejected")) };
const [a, b] = await Promise.all([
  attempt("A", url, { tls: { ca: CA } }),
  attempt("B", url, { headers: { authorization: "Bearer F4-B" }, tls: strict }),
]);
const b2 = await attempt("B2", url, { headers: { authorization: "Bearer F4-B2" }, tls: strict });
done({ a, b, b2, callbackCalls: calls });
