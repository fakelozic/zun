// Review C2-3 driver: run with Node (not zun): `node c2-3-driver.mjs /path/to/zun-debug`.
// A Node TLS server (fixed ticket keys, leaf <- intermediate chain from ../zun-blocked-spki) stays up across three zun
// client processes per TLS version:
//   1. no extra blocked key, save the session;
//   2. ZUN_DEBUG_BLOCKED_SPKI_SHA256 = leaf key, no session (control: must be CERT_REVOKED);
//   3. no blocked key, resume the saved session (control: resumption works);
//   4. blocked key, resume the saved session (strict, then rejectUnauthorized:false to see isSessionReused).
// If 4 reports authorized:true while 2 reports CERT_REVOKED, the resumed connection skipped the blocklist.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const zun = process.argv[2];
const here = path.dirname(new URL(import.meta.url).pathname);
const dir = path.join(here, "..", "zun-blocked-spki");
const read = name => fs.readFileSync(path.join(dir, name), "utf8");
const spki = JSON.parse(read("spki.json"));
const blockKey = process.env.C2_3_BLOCK ?? "leaf";

// The server pins the TLS version (the snapshot's client did not honour maxVersion).
function listen(maxVersion) {
  const server = tls.createServer(
    {
      cert: read("leaf.pem") + read("inter.pem"),
      key: read("leaf.key"),
      ticketKeys: Buffer.alloc(48, 7),
      minVersion: maxVersion,
      maxVersion,
    },
    s => s.write("ok"), // the client closes; ending here would close the socket before it can export the session
  );
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}
let port;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zun-c2-3-"));

function run(maxVersion, blocked, sessionIn, sessionOut, mode = "strict") {
  const env = { ...process.env, BUN_DEBUG_QUIET_LOGS: "1" };
  delete env.ZUN_DEBUG_BLOCKED_SPKI_SHA256;
  if (blocked) env.ZUN_DEBUG_BLOCKED_SPKI_SHA256 = blocked;
  return new Promise(resolve => {
    const p = spawn(zun, [path.join(here, "c2-3-client.mjs"), String(port), maxVersion, sessionIn, sessionOut, mode], { env });
    let out = "";
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", () => {});
    p.on("close", code => {
      const line = out.trim().split("\n").filter(l => l.startsWith("{")).pop();
      resolve(line ? JSON.parse(line) : { exit: code, out });
    });
  });
}

const report = { blocked: blockKey };
for (const v of ["TLSv1.2", "TLSv1.3"]) {
  const server = await listen(v);
  port = server.address().port;
  const file = path.join(tmp, `${v}.session`);
  report[v] = {
    first: await run(v, null, "-", file),
    blockedFresh: await run(v, spki[blockKey], "-", "-"),
    resumedUnblocked: await run(v, null, file, "-"), // control: does the saved session resume at all?
    blockedResumed: await run(v, spki[blockKey], file, "-"),
    blockedResumedPermissive: await run(v, spki[blockKey], file, "-", "permissive"),
  };
  server.close();
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 1));
