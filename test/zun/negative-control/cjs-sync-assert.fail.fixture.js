"use strict";
// Negative control (RT-2): a CommonJS test whose assertion fails synchronously.
// The runner must report FAIL. Before the RT-2 fix zun exited 0 with no output here.
const assert = require("node:assert");
assert.strictEqual(1, 2);
