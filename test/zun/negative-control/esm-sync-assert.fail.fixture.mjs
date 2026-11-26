// Negative control: an ESM test whose assertion fails synchronously.
import assert from "node:assert";
assert.strictEqual(1, 2);
