# Triage queue

Problems observed but not yet root-caused. Per AGENTS.md rule 7, each one gets an RCA (`docs/rca/`) before
it is fixed. When an item gets an RCA or a known-issue ID, move it there and delete it here.

| # | Seen by | Symptom | First lead | Why it matters |
|---|---------|---------|------------|----------------|
| TQ-1 | parity harness (2026-11-26) | `fetch` doesn't stream: a response resolves only once its body is complete; 21 http/https/http2 client tests time out | cruller's `src/rt` host bridge in front of upstream's direct HTTP client path (`FetchTasklet.zig`) | **Production**: streaming responses, SSE and large bodies are broken or held in memory; possible memory DoS |
| TQ-2 | parity harness | `src/resolver/resolver.zig:658` prints `DEBUG: Resolving …` to stderr on every resolve in debug builds | cruller removed upstream's breakpoint condition | Breaks every debug test that checks a child's stderr; check whether release builds also print it |
| TQ-3 | parity harness | Worker threads under ASAN: bad `memcpy` inside the JSC allocator, then ASAN's own report crashes; timing-dependent (11 crashes + 12 report-but-exit-0) | possibly the same as RT-3 (ASAN CHECK at Web Worker teardown, found by SEC2) | **Security**: a memory error; confirm whether it's one bug or two |
| TQ-4 | parity harness | Child processes started with `-e`, `-p` or `--expose-gc` panic with `FileNotFound` (38 tests) | the minimal launcher has no flag parsing; full fix is the CLI restore | Node tests re-spawn themselves with `// Flags:` |
| TQ-5 | parity harness | `bun:test` import crashes in UBSan on a null JSC pointer (72 tests) | `bun:test` is cut, and the module stub returns null instead of throwing a clear error | A crash, not a clean "not available" error |
| TQ-6 | integration owner | The parity harness counts a run that printed a sanitizer report but exited 0 as a pass (30 runs) | follows Bun's runner semantics | For a production-bound project, any ASAN/UBSan report must count as a failure in our gates |
| TQ-7 | parity harness | 33 behaviour differences (zlib size-limit `RangeError` missing, dns/net results, child_process exit codes, stdio redirected to files) | see `docs/status/parity.json` | Triage after the launcher fix, since some may be launcher artefacts |
