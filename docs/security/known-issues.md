# Known security issues

Issues found in code zun ships, open until fixed. Each entry: what, impact, where, how found, plan.
Fixed entries move to the bottom with the commit that fixed them.

## md (`Bun.markdown`, `.md` imports): restored 2026-11-26

Threat model: markdown passed to `Bun.markdown.*` or imported as `.md` may be **untrusted** (user content
rendered by a server). Review scope: `src/md/*.zig`, `src/runtime/api/MarkdownObject.zig`.

### MD-1: quadratic time on unmatched link brackets (DoS), open

- `Bun.markdown.html("[".repeat(n))` and `"[a](".repeat(n)` are **O(n²)**. ASAN debug build:
  `[` ×20k = 3.0 s, ×40k = 11.9 s; `[a](` ×10k = 4.3 s, ×20k = 17 s (80 KB of input). A release build is
  faster by a constant factor only, so a few hundred KB of crafted input still pins a CPU core for seconds,
  and the call is synchronous on the JS thread.
- Link reference definitions are superlinear too (~×2.7 per doubling): 10k `[rN]: /uN` lines = 3.6 s (debug).
- Same code as upstream Bun 1.3.14 (inherited, not introduced by the port). Emphasis, backticks, HTML, entities,
  tables and deep nesting were measured linear (`test/js/node/test/parallel/test-zun-markdown.js`).
- **Mitigation now:** cap the input size before calling `Bun.markdown` on untrusted text, or render off the request
  path (a Worker with a timeout).
- **Plan:** check whether a later Bun (1.4.x Rust port, `src/md`) bounded this, else bound the bracket/opener
  search (md4c keeps opener stacks to stay linear). Track in `backports.md`.

### MD-2: offsets are u32; unchecked casts on huge input, fixed in the port

- The parser stores offsets as `u32` (`types.OFF`). Upstream does `@intCast(text.len)` (`parser.zig`) and
  `@intCast(block_bytes.items.len)` (`containers.zig`), and computes `n_lines * @sizeOf(VerbatimLine)` in
  `u32` right before a bounds check (`containers.zig`, `ref_defs.zig`). With input > 4 GiB, or a few hundred MB of
  very short lines (the block buffer grows ~12–16 bytes per line), safe builds panic and **ReleaseFast builds
  truncate or wrap, which can defeat the bounds check and read out of bounds**.
- zun fix (marked `// zun:` in the source): input > 4 GiB returns `error.OutOfMemory` (JS sees an out-of-memory
  error), the block-buffer casts are checked (`std.math.cast … orelse error.OutOfMemory`), and the line-array size
  is computed in `usize`. Upstream behaviour is otherwise unchanged.
- Not tested at that size (needs > 4 GiB of RAM per case); reviewed by reading.

### MD-3: Bun.markdown is not an HTML sanitizer (by design), documented

- Default options follow CommonMark: raw HTML blocks/spans pass through unchanged (`<script>` included) and link
  destinations are not filtered (`[x](javascript:alert(1))` → `href="javascript:alert(1)"`).
- Options that help: `tagFilter: true` (GFM tag filter), `noHtmlBlocks` / `noHtmlSpans`. None of them filter URL
  schemes. **Rendering untrusted markdown into a page needs a real sanitizer** on the output. Same as Bun.

### Reviewed, no finding

- No `@setRuntimeSafety(false)`, no `catch unreachable` / `orelse unreachable`. The one
  `error.JSError => unreachable` (`parser.zig`, `renderToHtml`) is an invariant: the HTML renderer never calls JS.
- 29 `@ptrCast`: renderer vtables (`*anyopaque` → own type) and reads of block headers/line arrays packed into
  `block_bytes`; each packed read is preceded by an `off + size > bytes.len` check.
- Recursion is guarded by `bun.StackCheck` (deep `>` / list nesting throws `RangeError` or renders, no crash).
- Remaining `@intCast`/`@truncate` are on small bounded values (codepoints < 128, digit chars, heading level,
  terminal columns clamped to `u16`, JS array lengths ≤ 2³²−1).
- ANSI renderer column counters are `u32` and reset per line; an overflow needs a single > 4 G-column line.

## Runtime (found during the md restore)

### RT-3: ASAN `CHECK failed` at Web Worker thread teardown (debug build), open

- Every `new Worker(...)` (Web Worker API), even one that only `postMessage`s, makes the ASAN debug build print
  `AddressSanitizer: CHECK failed: asan_thread.cpp:369 "((ptr[0] == kCurrentStackFrameMagic)) != (0)"` from the worker
  thread at exit (`ASAN_OPTIONS=log_path=…` shows the full line; on stderr it is cut off after the `====` banner).
  The main process still exits 0 (a racing `Die()` in the worker thread). `worker_threads` workers behave the same way
  only when they exit normally; untested.
- Found 2026-11-26 by the RT-2 sibling search (`docs/rca/RT-2-cjs-entry-errors-swallowed.md`). Not related to RT-2
  (no worker code was touched). Not yet known whether a release build is affected or whether it is real stack
  corruption vs. an ASAN/fake-stack interaction with how the worker thread exits (e.g. `pthread_exit` / stack switch).
- **Plan:** reproduce on Bun 1.3.14's own ASAN build if possible; check how `WebWorker.zig` ends the thread. Until
  then, treat Web Workers as untested in zun.

### RT-4: `__crullerHandle` SSR dispatch drops JS exceptions (dormant), open

- `src/rt/jsc_engine.zig` `callHandler` / `src/rt/server_dispatch.zig:59`: a throw in `globalThis.__crullerHandle`
  becomes `error.JSError` → `sendError(-2)`; the exception is neither reported nor cleared from the VM.
  `sourceLoaded` does `get(…) catch return` (same), and if a script defines `__crullerHandle` it busy-polls before the
  event loop runs.
- Dormant: nothing in zun sends `server_request` commands (that host was cruller's QuickJS/V8 SSR path). A script that
  happens to define `globalThis.__crullerHandle` would hang, though.
- **Plan:** delete with `src/rt` during the CLI restore (Phase 4 item 3). Found by the RT-2 sibling search.

## Fixed

### RT-2: CommonJS entry errors were swallowed (exit 0, no output), fixed

- Cause: `JSC::evaluate`'s 3-argument overload clears the exception into a discarded `NakedPtr`
  (`JSCommonJSModule.cpp`, inherited from Bun 1.3.14, fixed upstream by 1.4.5), and cruller's launcher (`1a78c80`) ran
  every entry file as `-e` eval source, which takes that path. Fixed both: the binding (backport of 1.4.5's out-param
  pattern) and the launcher (runs the file like `bun file.js`; real `__filename`, `import.meta.dir`, `process.argv`).
- RCA: `docs/rca/RT-2-cjs-entry-errors-swallowed.md`. Regression test: `scripts/zun-negative-controls.sh`.

### RT-1: `Bun__Node__ZeroFillBuffers` type confusion, fixed

- C++ reads `extern "C" bool Bun__Node__ZeroFillBuffers`; cruller (`05f7094`) defined a function with that name, so
  C++ read a code byte. Now `export var … : bool = false` as upstream (`nm`: `b`). RCA:
  `docs/rca/RT-1-zero-fill-buffers-type-confusion.md`. `--zero-fill-buffers` itself comes back with the CLI restore.
