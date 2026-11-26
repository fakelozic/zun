// Negative control: an ESM test that fails through a rejected top-level await.
import assert from "node:assert";
await new Promise(resolve => setTimeout(resolve, 10));
assert.deepStrictEqual({ a: 1 }, { a: 2 });
