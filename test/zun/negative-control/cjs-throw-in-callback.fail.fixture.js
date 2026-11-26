"use strict";
// Negative control: an uncaught exception thrown from a timer callback in a CJS entry.
setTimeout(() => {
  throw new Error("negative control: thrown from a timer");
}, 10);
module.exports = {};
