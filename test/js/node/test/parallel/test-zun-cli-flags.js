"use strict";

// TQ-4 / TQ-8 regression (docs/rca/TQ-4-cli-flags-taken-as-entry.md): zun parses its command line
// with Bun 1.3.14's restored CLI. Before the CLI restore, the launcher took the first argument as
// the entry file (`zun -e …` → "Module not found '<cwd>/-e'"), `zun run` skipped and ignored
// leading flags (a missing `--config` was silently accepted), and `fork()` children, which get
// `process.execArgv` (`--config=…`) in front of the script, died the same way.

const assert = require("node:assert");
const { spawnSync, fork } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.argv[2] === "fork-child") {
  process.send({ argv: process.argv.slice(3), execArgv: process.execArgv });
  return;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zun-cli-flags-"));
const env = { ...process.env, BUN_DEBUG_QUIET_LOGS: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
delete env.BUN_DEBUG_BREAK_ON_RESOLVE;

function zun(args, opts = {}) {
  const r = spawnSync(process.execPath, args, { env, encoding: "utf8", cwd: tmp, ...opts });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr };
}
function ok(r, what) {
  assert.strictEqual(r.status, 0, `${what}: exit ${r.status} ${r.signal ?? ""}\n${r.all}`);
  assert.doesNotMatch(r.all, /Module not found/, what);
}

const script = path.join(tmp, "main.js");
fs.writeFileSync(script, "console.log(JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv, gc: typeof gc, pre: globalThis.PRE ?? null }));\n");
const pre = path.join(tmp, "pre.js");
fs.writeFileSync(pre, "globalThis.PRE = 'loaded';\n");
const parse = r => JSON.parse(r.stdout.trim().split("\n").pop());

// -e / --eval and -p / --print
let r = zun(["-e", "console.log('eval-ok', 6 * 7)"]);
ok(r, "-e");
assert.match(r.stdout, /^eval-ok 42$/m);
r = zun(["--print", "'p' + (40 + 2)"]);
ok(r, "--print");
assert.match(r.stdout, /^p42$/m);

// runtime flags before the entry file, with and without `run`
for (const prefix of [[], ["run"]]) {
  r = zun([...prefix, "--expose-gc", "--smol", "-r", pre, script, "a", "--b"]);
  ok(r, `${prefix.join(" ")} flags`);
  const out = parse(r);
  assert.deepStrictEqual(out.argv, ["a", "--b"], "script args stay with the script");
  assert.strictEqual(out.gc, "function", "--expose-gc applies");
  assert.strictEqual(out.pre, "loaded", "-r/--preload applies");
  assert.deepStrictEqual(out.execArgv, ["--expose-gc", "--smol", "-r", pre]);
}

// a config the user asked for must exist (Bun: error, exit 1), with and without `run`
for (const prefix of [[], ["run"]]) {
  const missing = path.join(tmp, "does-not-exist.toml");
  r = zun([...prefix, `--config=${missing}`, script]);
  assert.strictEqual(r.status, 1, `${prefix.join(" ")} --config=<missing> must fail:\n${r.all}`);
  assert.match(r.stderr, /does-not-exist\.toml/);
}
// …and an existing one is read: a [define] from it reaches the script
const cfg = path.join(tmp, "custom.toml");
fs.writeFileSync(cfg, '[define]\n"process.env.ZUN_CFG" = "\'from-config\'"\n');
const cfgScript = path.join(tmp, "cfg.js");
fs.writeFileSync(cfgScript, "console.log(process.env.ZUN_CFG);\n");
r = zun(["run", `--config=${cfg}`, cfgScript]);
ok(r, "--config=<file>");
assert.match(r.stdout, /^from-config$/m);

// a subcommand whose module isn't restored says so instead of running something else
r = zun(["install"]);
assert.strictEqual(r.status, 1, r.all);
assert.match(r.stderr, /not available in this zun build yet/);

// fork(): the child gets execArgv (here `--config=…`) before the script, as cluster does
const child = fork(__filename, ["fork-child", "x"], {
  env,
  execArgv: [`--config=${cfg}`],
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let childOut = "";
child.stdout.on("data", d => (childOut += d));
child.stderr.on("data", d => (childOut += d));
let msg;
child.on("message", m => (msg = m));
child.on("exit", code => {
  assert.strictEqual(code, 0, `fork child exit ${code}\n${childOut}`);
  assert.deepStrictEqual(msg && msg.argv, ["x"], childOut);
  assert.deepStrictEqual(msg.execArgv, [`--config=${cfg}`]);
  fs.rmSync(tmp, { recursive: true, force: true });
});
