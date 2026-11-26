// Positive control: must PASS, and checks what the launcher passes to an ESM entry.
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
assert.strictEqual(import.meta.path, fileURLToPath(import.meta.url));
assert.strictEqual(import.meta.dir, path.dirname(import.meta.path));
assert.ok(path.isAbsolute(import.meta.dir));
assert.strictEqual(process.argv[1], import.meta.path);
assert.strictEqual(import.meta.main, true);
await new Promise(resolve => setTimeout(resolve, 5));
