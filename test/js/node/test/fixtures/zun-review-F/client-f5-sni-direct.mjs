// F-5 control: same as f5-proxy-sni without the proxy.
import { attempt, CA, done } from "./common.mjs";
const r = await attempt("direct", `https://127.0.0.1:${process.env.PORT}/s`, { tls: { ca: CA, serverName: "localhost" } });
done({ r });
