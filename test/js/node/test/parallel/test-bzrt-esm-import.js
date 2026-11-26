// Regression test: a static ESM `import` used to crash debug builds
// (`opts.macro_context = undefined` in src/bundler/transpiler.zig).
import assert from "node:assert";
import path from "node:path";
import label, { add, Kind } from "../fixtures/bzrt/esm-lib.ts";

assert.strictEqual(path.basename("/a/b/c.txt"), "c.txt");
assert.strictEqual(path.join("a", "b"), "a/b");
assert.strictEqual(label, "esm-lib");
assert.strictEqual(add({ a: 2, b: 3 }), 5);
assert.strictEqual(Kind.Sum, 1);
