// Review C2-3 client (run by c2-3-driver.mjs under zun). argv: port, maxVersion, sessionIn|-, sessionOut|-, strict|permissive.
// Connects with node:tls trusting the zun-blocked-spki test root, optionally offering a saved session, and prints one
// JSON line: authorized, authorizationError, isSessionReused, and whether the connect succeeded.
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const [port, maxVersion, sessionIn, sessionOut, mode = "strict"] = process.argv.slice(2);
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "zun-blocked-spki");
const ca = fs.readFileSync(path.join(dir, "root.pem"), "utf8");
const opts = { host: "127.0.0.1", servername: "localhost", port: +port, ca, rejectUnauthorized: mode === "strict" };
if (sessionIn !== "-") opts.session = fs.readFileSync(sessionIn);

const result = await new Promise(resolve => {
  let session = null;
  const socket = tls.connect(opts, () => {
    const r = {
      ok: true,
      authorized: socket.authorized,
      authorizationError: socket.authorizationError ?? null,
      isSessionReused: socket.isSessionReused(),
      protocol: socket.getProtocol(),
    };
    const atConnect = socket.getSession();
    r.sessionAtConnect = atConnect ? atConnect.length : null;
    // TLS 1.3 tickets arrive after the handshake; wait for them (or the 1.2 session) before exporting.
    setTimeout(() => {
      r.sessionEvent = !!session;
      session ??= socket.getSession() ?? atConnect;
      if (sessionOut !== "-" && session) fs.writeFileSync(sessionOut, session);
      r.savedSession = !!session;
      socket.end();
      resolve(r);
    }, 300);
  });
  socket.on("session", s => (session = s));
  socket.on("error", e => resolve({ ok: false, code: e.code ?? null, message: String(e.message ?? e) }));
});
console.log(JSON.stringify(result));
