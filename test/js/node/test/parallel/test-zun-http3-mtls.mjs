// zun security C2-2 (docs/rca/C2-2-http3-mtls-not-enforced.md): a strict-mTLS `Bun.serve({ http3: true })`
// (requestCert + rejectUnauthorized + ca) must not run the handler for an HTTP/3 client whose certificate failed
// verification. It must behave like the TCP listener on the same port and like Bun 1.4.5.
// The client is system curl with HTTP/3 (zun's own H3 client can't present a client certificate). Without one,
// the test is skipped.
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures");
const c2 = path.join(fixtures, "zun-review-C2");
const root = path.join(fixtures, "zun-blocked-spki", "root.pem");

const version = spawnSync("curl", ["--version"], { encoding: "utf8" });
if (version.status !== 0 || !/\bHTTP3\b/.test(version.stdout)) {
  console.log("1..0 # SKIP needs curl built with HTTP/3 (ngtcp2/nghttp3)");
  process.exit(0);
}

async function startServer(extraEnv) {
  const env = { ...process.env, BUN_DEBUG_QUIET_LOGS: "1", C2_2_SERVER_MS: "30000", ...extraEnv };
  const child = spawn(process.execPath, [path.join(c2, "c2-2-server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", d => (out += d));
  child.stderr.setEncoding("utf8").on("data", d => (err += d));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${err}`)), 20000);
    child.stdout.on("data", () => {
      const m = /^PORT (\d+)$/m.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", code => reject(new Error(`server exited ${code}: ${err}`)));
  });
  const dispatched = () => out.split("\n").filter(l => l.startsWith("DISPATCHED ")).map(l => l.slice(11));
  return {
    port,
    dispatched,
    // Resolves once the server has printed `name` (its stdout is ordered, so every earlier line is in too).
    waitFor: name =>
      new Promise(r => {
        const check = () => dispatched().includes(name) && (child.stdout.off("data", check), r());
        child.stdout.on("data", check);
        check();
      }),
    async stop() {
      child.kill();
      await new Promise(r => (child.exitCode !== null ? r() : child.on("exit", r)));
    },
  };
}

// Returns the HTTP status curl saw ("000" when the connection was refused or closed).
async function probe(port, name, transport, certArgs) {
  const args = ["-sS", "--max-time", "5", "--cacert", root, transport, "-H", `x-case: ${name}`, ...certArgs];
  args.push("-o", "/dev/null", "-w", "%{http_code}", `https://localhost:${port}/`);
  const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", d => (out += d));
  await new Promise(r => child.on("exit", r));
  return out.trim();
}

const valid = ["--cert", path.join(c2, "client.pem"), "--key", path.join(c2, "client.key")];
const untrusted = ["--cert", path.join(c2, "untrusted.pem"), "--key", path.join(c2, "untrusted.key")];

{
  const server = await startServer({});
  try {
    const status = {};
    for (const [transport, flag] of [["tcp", "--http1.1"], ["h3", "--http3-only"]]) {
      // The trusted client goes last, so its DISPATCHED line orders after any line a rejected client caused.
      status[`${transport}-nocert`] = await probe(server.port, `${transport}-nocert`, flag, []);
      status[`${transport}-untrusted`] = await probe(server.port, `${transport}-untrusted`, flag, untrusted);
      status[`${transport}-valid`] = await probe(server.port, `${transport}-valid`, flag, valid);
    }
    // Control: a trusted client certificate works over both transports.
    assert.strictEqual(status["tcp-valid"], "200", JSON.stringify(status));
    assert.strictEqual(status["h3-valid"], "200", JSON.stringify(status));
    for (const name of ["tcp-nocert", "tcp-untrusted", "h3-nocert", "h3-untrusted"]) {
      assert.notStrictEqual(status[name], "200", `${name} got a response: ${JSON.stringify(status)}`);
    }
    // Only the trusted clients reached the handler.
    await server.waitFor("h3-valid");
    assert.deepStrictEqual(server.dispatched().sort(), ["h3-valid", "tcp-valid"]);
  } finally {
    await server.stop();
  }
}

// A trusted chain whose key is on the blocklist (C2). Only debug zun builds take an extra blocked key from the env.
if (process.versions.zun && Bun.version.endsWith("-debug")) {
  const spki = JSON.parse(fs.readFileSync(path.join(c2, "spki.json"), "utf8"));
  const server = await startServer({ ZUN_DEBUG_BLOCKED_SPKI_SHA256: spki.client });
  try {
    const tcp = await probe(server.port, "tcp-blocked", "--http1.1", valid);
    const h3 = await probe(server.port, "h3-blocked", "--http3-only", valid);
    assert.notStrictEqual(tcp, "200", "tcp-blocked got a response");
    assert.notStrictEqual(h3, "200", "h3-blocked got a response");
  } finally {
    await server.stop();
  }
  // No client succeeded here, so read the log after the server exited.
  assert.deepStrictEqual(server.dispatched(), []);
}
