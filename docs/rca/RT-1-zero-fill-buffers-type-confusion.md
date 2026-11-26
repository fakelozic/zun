# RT-1: `Bun__Node__ZeroFillBuffers` defined as a function, read as a bool

- **Status:** fixed in the same commit as RT-2 (`security: RT-2 …`).
- **Severity:** low (fails safe), but undefined behaviour at a C/Zig boundary; security-relevant because it decides
  whether `Buffer.allocUnsafe` memory is zeroed.
- **Found by / date:** md restore review, 2026-11-26 (`docs/security/known-issues.md`). RCA by SEC2.

## Symptom

`Buffer.allocUnsafe(n)` was always zero-filled. Not observable as a crash; seen by reading the code and with `nm`:
the symbol was an `export fn`, i.e. a **code** symbol, where C++ expects data.

## Root cause

- `src/jsc/bindings/JSBuffer.cpp:86` declares `extern "C" bool Bun__Node__ZeroFillBuffers;` and l.505 reads it:
  `if (Bun__Node__ZeroFillBuffers) memset(...)`.
- Upstream Bun 1.3.14 defines it in `src/cli/Arguments.zig:1709` as `export var Bun__Node__ZeroFillBuffers = false;`
  and sets it for `--zero-fill-buffers` (l.1034).
- cruller's strip (`a1c009d`, "bzrt: strip Bun 1.3.14 …") brought the tree in without `src/cli/`. cruller commit
  `05f7094` ("fixes", Alex Storm, 2026-07-16; found with `git log -S`), to satisfy the linker, added
  `pub export fn Bun__Node__ZeroFillBuffers(_: *JSGlobalObject, _: *jsc.CallFrame) JSValue` to
  `src/jsc/vm_exports_stub.zig` (the same shape as the other host-function stubs in that file). The linker resolves a
  name, not a type, so C++ took the address of the function's machine code and read its first byte as a `bool`
  (non-zero → "true").

## Why it wasn't caught

C and Zig don't share type information across `extern`; the link succeeds. No test checks `allocUnsafe` contents
(they would be "uninitialised", so a test can only check the flag's effect, not its absence), and the symptom is the
safe direction.

## Fix

`src/jsc/vm_exports_stub.zig`: `pub export var Bun__Node__ZeroFillBuffers: bool = false;`, exactly upstream. Now `nm`
shows `b Bun__Node__ZeroFillBuffers` (BSS data). Behaviour now matches Bun 1.3.14 without `--zero-fill-buffers`:
`allocUnsafe` is not zeroed (as in Node and Bun). The definition moves back to `src/cli/Arguments.zig` with the CLI
restore, which also brings back the flag.

## Regression test

- `docs/zig/probes/rt2-launcher/coerce.zig`: `export var` produces a `B` symbol; `export fn` would be `T`.
- Symbol check (see Sibling search) can be re-run on any build.

## Sibling search

Every `extern "C" <type> <name>;` **data** declaration in `src/jsc/bindings` (20 names) and plain `extern` data in
`packages/bun-usockets`, `packages/bun-uws` (2: `environ`, `Bun__lock__size`) was checked with `nm` on the fixed
binary: all are `b`/`d`/`r` (data) except libc's `environ`. No other function-for-data stub.
Command:

```sh
grep -rhoE 'extern "C" [A-Za-z_:<>* ]+ [A-Za-z0-9_]+;' src/jsc/bindings | sort -u   # names
nm build/debug/zun-debug | grep -E ' <name>$'                                         # must not be T/t
```

## Lessons

When stubbing a symbol for a removed module, copy the upstream *declaration* (`export var` vs `export fn`), not the
shape of the neighbouring stubs. Lesson and cheatsheet entry: `docs/zig/lessons.md`, `cheatsheet-0.17.md` § C interop.
