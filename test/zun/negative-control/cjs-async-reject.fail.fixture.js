"use strict";
// Negative control (RT-2): a CommonJS test that fails later, in a promise chain
// (the shape of test-bzrt-runtime-smoke.js). The runner must report FAIL.
const assert = require("node:assert");
Promise.resolve()
  .then(() => new Promise(resolve => setTimeout(resolve, 10)))
  .then(() => {
    assert.strictEqual("ok", "not ok");
  });
