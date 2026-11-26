"use strict";

// zun identity (docs/identity.md):
// - process.versions.zun is zun's own version; Bun.version / process.versions.bun stay Bun-compatible.
// - ZUN_<X> wins over BUN_<X> for zun's own env reads: BUN_PORT (env-map path, every build)
//   and BUN_DEBUG_QUIET_LOGS (process-env path through bun.getenvZ, debug builds only).
// - zunfig.toml wins over bunfig.toml in the cwd (debug builds only: checked through the
//   `zun` debug log, because the config parser is still cut until the CLI restore).

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

assert.match(process.versions.zun, /^\d+\.\d+\.\d+$/);
assert.strictEqual(typeof Bun.version, "string");
assert.match(Bun.version, /^1\.\d+\.\d+/);
assert.strictEqual(process.versions.bun, Bun.version);
assert.strictEqual(globalThis.Zun, undefined);

const isDebug = Bun.version.endsWith("-debug");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zun-identity-"));
const portScript = path.join(tmp, "port.js");
fs.writeFileSync(portScript, "const s = Bun.serve({ fetch: () => new Response('ok') }); console.log('port=' + s.port); s.stop(true);\n");
const noopScript = path.join(tmp, "noop.js");
fs.writeFileSync(noopScript, "\n");

function baseEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ZUN_") && !(key in extra)) delete env[key];
  }
  return env;
}

async function run(args, env, cwd) {
  const child = Bun.spawn({ cmd: [process.execPath, ...args], env, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.strictEqual(code, 0, `exit ${code}\n${stdout}\n${stderr}`);
  return stdout + stderr;
}

async function freePort() {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = s.port;
  s.stop(true);
  return port;
}

async function main() {
  const [p1, p2] = [await freePort(), await freePort()];

  const bunOnly = await run([portScript], baseEnv({ BUN_PORT: String(p1) }));
  assert.ok(bunOnly.includes(`port=${p1}`), "BUN_PORT alone must still work:\n" + bunOnly);

  const both = await run([portScript], baseEnv({ BUN_PORT: String(p1), ZUN_PORT: String(p2) }));
  assert.ok(both.includes(`port=${p2}`), "ZUN_PORT must win over BUN_PORT:\n" + both);

  if (isDebug) {
    const quiet = await run([noopScript], baseEnv({ BUN_DEBUG_QUIET_LOGS: "1" }));
    assert.ok(!quiet.includes("[sys]"), "BUN_DEBUG_QUIET_LOGS=1 must still silence logs:\n" + quiet);
    const loud = await run([noopScript], baseEnv({ BUN_DEBUG_QUIET_LOGS: "1", ZUN_DEBUG_QUIET_LOGS: "0" }));
    assert.ok(loud.includes("[sys]"), "ZUN_DEBUG_QUIET_LOGS=0 must override BUN_DEBUG_QUIET_LOGS=1");

    const env = baseEnv({ ZUN_DEBUG_ZUN: "1" });
    fs.writeFileSync(path.join(tmp, "bunfig.toml"), "");
    fs.writeFileSync(path.join(tmp, "zunfig.toml"), "");
    const bothConfigs = await run([noopScript], env, tmp);
    assert.ok(bothConfigs.includes(path.join(tmp, "zunfig.toml")), "zunfig.toml must win:\n" + bothConfigs);

    fs.rmSync(path.join(tmp, "zunfig.toml"));
    const bunfigOnly = await run([noopScript], env, tmp);
    assert.ok(bunfigOnly.includes(path.join(tmp, "bunfig.toml")), "bunfig.toml is the fallback:\n" + bunfigOnly);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch(error => {
  fs.rmSync(tmp, { recursive: true, force: true });
  throw error;
});
