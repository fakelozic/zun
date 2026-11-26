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

### RT-1: `Bun__Node__ZeroFillBuffers` type confusion, open

- C++ declares `extern "C" bool Bun__Node__ZeroFillBuffers;` (`src/jsc/bindings/JSBuffer.cpp:86`) and reads it in
  `Buffer.allocUnsafe` paths (l.505). Upstream defines it as `export var … = false` in `src/cli/Arguments.zig:1709`
  (set by `--zero-fill-buffers`). zun's stub defines a **function** with that name
  (`src/jsc/vm_exports_stub.zig:40`), so C++ reads the first byte of machine code as the bool: in practice always
  true, so every `allocUnsafe` buffer is zero-filled. Fails safe (no uninitialised memory leaks out), but it is
  undefined behaviour and a silent divergence from Bun.
- **Fix:** `export var Bun__Node__ZeroFillBuffers: bool = false;` (exactly upstream). Deferred to the CLI restore
  (item 3), which brings back the real definition and the flag. Owner decides whether to fix earlier.

## RT-2 (open, High for production): CommonJS entry errors are swallowed

Found by T4.1, reproduced 2026-11-26 at `c98d508`: a CJS entry file that throws (e.g. `assert.strictEqual(1, 2)` after
`require("assert")`) makes `zun` exit **0** with **no output**. ESM files and plain top-level throws exit 1 correctly. In production,
a CJS app that crashes at startup would look successful to a supervisor. Cause: cruller's minimal launcher
(`src/main.zig` → `rt.monolith`). Also: `__filename` ends in `[eval]`, and script arguments don't reach `process.argv`.

