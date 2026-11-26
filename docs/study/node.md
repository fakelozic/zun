# Node.js, and how Bun (and so zun) imitates it

## Node's architecture (for reference)

- **V8** runs JS. **libuv** is the event loop plus a thread pool for fs, DNS and crypto.
- `lib/*.js` holds the public modules (`fs`, `http`, `stream`, …) in JS, on top of
  `internalBinding(...)` C++ bindings in `src/`.
- Native addons use **N-API** (stable C ABI) or raw V8/`nan` APIs.
- Node's own test suite (`test/parallel`, `test/sequential`, …) is the de facto compatibility spec.

## How Bun does Node compatibility (true in 1.3.14 and in cruller)

| Layer | Where | Notes |
|-------|-------|-------|
| JS engine | JavaScriptCore, not V8 | V8-only APIs are emulated (`bindings/v8/` shims some V8 C++ API for addons) |
| Event loop | Bun's own (`src/event_loop`, `src/io`, uSockets) | libuv only on Windows |
| `node:*` modules | `src/js/node/*.ts` | 62 modules written in TS (fs, http, net, stream, crypto, …), compiled into the binary by codegen |
| Native parts | C++ in `bindings/node/` (crypto, …) + Zig in `src/runtime/node/` | |
| Addons | `src/napi` (Zig) + `bindings/napi*.cpp` (C++) | cruller removed the **Zig side** only; the C++ is still there. Addons are not expected to work until `src/napi` is restored |
| Reported version | `process.version` = 24.3.0 | upstream: `NODEJS_VERSION` in `scripts/build/deps/nodejs-headers.ts`, passed to `build.zig` via `-D` (its default is `0.0.0-unset`); cruller hard-codes the 24.3.0 default in `build.zig` |

## Test strategy we inherit

- Node's own tests are vendored at `test/js/node/test/parallel/*.js`. `scripts/runner.node.mjs --exec-path <binary>`
  runs them against any runtime, and cruller already passes a few `node:path` ones this way.
- Bun's tests (`test/js/bun/**`, `test/cli/**`, …) are written with **`bun:test`**. Bringing the
  test runner back early lets zun run upstream's whole test suite as its spec.

## Open questions

- Which Node version should zun target? Bun 1.3.14 reports 24.3.0. Local `node` is v26.13.1.
- N-API: restore early (many npm packages need it) or late?
