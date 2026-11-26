// F-4 (H1, Host header vs transport name): server.pem names only DNS:localhost (no IP SAN).
// A: https://127.0.0.1 with Host: localhost -> verified as "localhost", passes.
// B: https://127.0.0.1 with no Host override -> must be verified as 127.0.0.1 and fail; reusing A's socket hides it.
// C: control, run first on a fresh connection: B's exact request fails when nothing is pooled.
import { attempt, CA, done } from "./common.mjs";
const url = `https://127.0.0.1:${process.env.PORT}/`;
const c = await attempt("C-fresh-no-host", url, { tls: { ca: CA }, keepalive: false });
const a = await attempt("A-host-localhost", url, { headers: { host: "localhost" }, tls: { ca: CA } });
const b = await attempt("B-no-host", url, { tls: { ca: CA } });
done({ c, a, b });
