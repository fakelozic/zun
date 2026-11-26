"use strict";
// Positive control: must PASS, and checks what the launcher passes to a CJS entry.
const assert = require("node:assert");
const path = require("node:path");
assert.ok(path.isAbsolute(__filename), __filename);
assert.ok(!__filename.endsWith("[eval]"), __filename);
assert.strictEqual(path.dirname(__filename), __dirname);
assert.strictEqual(process.argv[1], __filename);
assert.strictEqual(require.main, module);
