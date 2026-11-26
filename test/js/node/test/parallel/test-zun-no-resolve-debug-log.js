"use strict";

// TQ-2 regression (docs/rca/TQ-2-resolver-debug-print-ungated.md):
// a plain run that resolves modules (require, import, a bare package, a node: builtin)
// must not print the resolver's `DEBUG: Resolving …` line on stdout or stderr.
// Debug builds printed it on every resolve, even with BUN_DEBUG_QUIET_LOGS=1, because the
// print had lost its `hasResolveBreakpoint` gate. It must only appear when the operator opts
// in with BUN_DEBUG_BREAK_ON_RESOLVE (which also traps, so we don't exercise that here).

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zun-tq2-"));
fs.writeFileSync(path.join(tmp, "dep.js"), "module.exports = 41;\n");
fs.writeFileSync(path.join(tmp, "esm-dep.mjs"), "export default 1;\n");
fs.writeFileSync(
  path.join(tmp, "main.js"),
  "const dep = require('./dep.js');\n" +
    "require('node:path');\n" +
    "import('./esm-dep.mjs').then(m => console.log('ok', dep + m.default));\n",
);

const env = { ...process.env };
delete env.BUN_DEBUG_BREAK_ON_RESOLVE;
delete env.ZUN_DEBUG_BREAK_ON_RESOLVE;

for (const quiet of [undefined, "1"]) {
  const e = { ...env };
  if (quiet === undefined) {
    delete e.BUN_DEBUG_QUIET_LOGS;
    delete e.ZUN_DEBUG_QUIET_LOGS;
  } else {
    e.BUN_DEBUG_QUIET_LOGS = quiet;
  }
  const r = spawnSync(process.execPath, [path.join(tmp, "main.js")], { env: e, encoding: "utf8", cwd: tmp });
  assert.strictEqual(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  // Without BUN_DEBUG_QUIET_LOGS a debug build also writes its scoped `[sys]`/`[fs]` logs, so only
  // look for our line there; with it, stdout must be exactly the program's output.
  if (quiet === "1") assert.strictEqual(r.stdout.trim(), "ok 42");
  else assert.match(r.stdout, /^ok 42$/m);
  assert.doesNotMatch(r.stdout + r.stderr, /DEBUG:?\s*(\x1b\[[0-9;]*m)*\s*Resolving/, `quiet=${quiet}\n${r.stderr}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
