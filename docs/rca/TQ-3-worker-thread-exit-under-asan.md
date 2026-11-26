# TQ-3: Worker threads end with `pthread_exit` inside live C++ frames; Zig's per-thread signal stack fights ASAN's

- **Status:** **fixed and verified 2026-11-27**: re-ran all 82 Worker / sanitizer-flagged parity tests under ASAN: all 47 that ASAN flagged (35 SANITIZER + 11 CRASH:asan-check + 1 SANITIZER:asan) now pass with no ASAN report; the 21 earlier passes still pass; the 12 FAIL / 1 panic / 1 timeout are unchanged (behaviour gaps, TQ-7). Nested-worker tests (`test-worker-nested-uncaught`, `-nested-on-process-exit`, `-terminate-nested`) pass under ASAN. **Unconfirmed lead** from an interrupted independent review: a possible lifetime issue when a nested Worker's parent context goes away first; not reproduced, worth a targeted test.
  Fixes A and B below are implemented as described in "Implementation"; `zig ast-check` passes on the changed Zig
  files. The regression test fails on the unfixed snapshot `build/snap-0a5b26b/zun-debug` and passes on Node 26.
  Also closes the investigation part of RT-3 (`docs/security/known-issues.md`).
- **Severity:** medium, security-relevant. The two ASAN reports themselves are **not** an out-of-bounds copy (proof
  below), but they come from a real defect: every Worker thread ends by jumping out of live C++ frames, skipping
  their destructors (the worker's `JSC::VM` is never freed, its API lock is never released) and, when an uncaught error
  ends the worker, tearing the VM down while that VM's JS frames are still live on the same stack. It also blinds ASAN
  on every Worker test (47 parity tests), so real memory errors in Worker code would go unseen.
- **Found by / date:** parity harness, re-run 2026-11-26 (TQ-3 in `docs/status/triage.md`); RT-3 by the RT-2 sibling
  search. RCA 2026-11-26, on the snapshot `build/snap-0a5b26b/zun-debug` (debug + ASAN, LLVM 21 compiler-rt, prebuilt
  WebKit `5488984d20e0dbfe` debug-asan).

## Symptom

Smallest reproduction (any Worker, even one that does nothing):

```sh
cat > w1.js <<'EOF'
const { Worker } = require('worker_threads');
new Worker('1+1', { eval: true }).on('exit', c => console.log('exit', c));
EOF
ASAN_OPTIONS=log_path=/tmp/asan zun-debug w1.js; echo $?     # 1
```

`/tmp/asan.<pid>` holds `AddressSanitizer: CHECK failed: asan_thread.cpp:369 "((ptr[0] == kCurrentStackFrameMagic))
!= (0)"`. Symbolized (`vendor/llvm-21.1.8/bin/llvm-symbolizer`) the CHECK is reached from
`AsanThread::GetStackFrameAccessByAddr` ← `AddressDescription` ← `ReportGenericError` ← `memcpy` interceptor ←
`pas_segregated_size_directory_local_allocator_size_for_config`: ASAN found a bad stack access and then crashed while
describing it.

`test-worker-nested-uncaught.js` gets through the description and prints the full report:

```
ERROR: AddressSanitizer: stack-buffer-underflow on address 0x7b2c705f5240
WRITE of size 1064 at 0x7b2c705f5240 thread T12 (Worker)
  #0 __interceptor_memcpy
  #1 pas_deallocate(void*, pas_heap_config)                 pas_deallocate.h:206
  #2 bmalloc_deallocate_inline                              bmalloc_heap_inlines.h:387
  #3 bmalloc::api::free / WTF::fastFree                     FastMalloc.cpp:395
  #4 WTF::ThreadSpecific<WTF::RunLoop::Holder>::Data::operator delete
  #5 WTF::ThreadSpecific<WTF::RunLoop::Holder>::destroy     ThreadSpecific.h:187
  #6,#7 libc (__nptl_deallocate_tsd / start_thread)
Address … is located in stack of thread T12 (Worker) at offset 0 in frame
  #0 WebCore::EventTarget::fireEventListeners               EventTarget.cpp:264
     [32, 48) 'firingEventListenersScope' <== Memory access … partially underflows this variable
HINT: this may be a false positive if your program uses some custom stack unwind mechanism, swapcontext or vfork
Thread T12 (Worker) created by T0 here: pthread_create ← std.Thread.spawn ← WebWorker__create (web_worker.zig:342)
```

## Root cause

Two separate mechanisms. The first produces both reports above; the second is what ASAN hits next once the first is
out of the way.

### 1. `pthread_exit` from Zig, inside live ASAN-instrumented C++ frames (inherited from Bun 1.3.14)

`src/jsc/web_worker.zig`:

- `threadMain` (`:435`) runs the whole worker inside `JSC__VM__holdAPILock` (`src/jsc/bindings/bindings.cpp`), a C++
  frame holding a `JSC::JSLockHolder` (whose `RefPtr<VM> m_vm` is released in `~JSLockHolder`).
- `spin()` "always ends by calling `shutdown()`" (`:541`, calls at `:554 :573 :580 :587 :595 :641`), and
  `shutdown()` is `noreturn` (`:660`): it runs exit handlers, `WebWorker__teardownJSCVM` (GC + `vm.deref()` ×2),
  `vm.deinit()`, frees the arena, then `bun.exitThread()` (`:738`) → `pthread_exit(null)` (`src/bun.zig:2850`).
- `onUnhandledRejection` (`:781`) is called **from inside the running JS** (`uncaughtException` ← JSC ← microtask
  drain or event dispatch, `fireEventListeners` …) and calls `worker.shutdown()` right there (`:819`). gdb at
  `pthread_exit` for `test-worker-nested-uncaught.js` shows exactly that:
  `pthread_exit ← bun.exitThread ← web_worker.shutdown ← web_worker.onUnhandledRejection ← …`.

glibc's `pthread_exit` unwinds back to `start_thread` (forced unwind, then the `setjmp` buffer in `start_thread`) and
then runs the pthread TSD destructors from `start_thread`'s frame, near the **top** of the same stack. None of the C++
frames in between get their epilogue run. Two consequences:

1. **The ASAN reports (stale shadow).** An ASAN-instrumented frame poisons its redzones on entry and clears them on
   return. The skipped frames never clear them. Clang avoids exactly this by emitting `__asan_handle_no_return()`
   (which unpoisons the stack from the current `sp` to the top) before every call to a `noreturn` function, and the
   runtime does the same for `longjmp`/`swapcontext`/C++ throw. Here the `noreturn` call is made **from Zig**, which is
   not ASAN-instrumented, so nobody unpoisons. The TSD destructor `WTF::ThreadSpecific<RunLoop::Holder>::destroy` →
   `fastFree` → `pas_deallocate` then passes the 1064-byte `pas_heap_config` by value (debug `-O0`: a `memcpy` into
   its **own new frame**). That frame lies on top of the stale redzones of the abandoned `fireEventListeners` frame,
   so ASAN reports a write into a redzone. Where the old frame's header has since been overwritten, the describer no
   longer finds `kCurrentStackFrameMagic` and fails its own CHECK instead (RT-3 and the "CHECK" half of TQ-3: same
   bug, two outputs).
2. **A real defect, independent of ASAN.** Skipped destructors include `~JSLockHolder` (VM never unlocked, its
   `RefPtr<VM>` never dropped, so after `teardownJSCVM`'s two derefs the `JSC::VM` is still referenced and leaks per
   Worker; upstream Bun lists ~40 worker tests in `test/no-validate-leaksan.txt`). On the uncaught-error path the
   whole `JSC::VM` (GC, `deleteAllCode`, derefs) and the Bun `VirtualMachine` are torn down while that VM is still
   entered (VM entry scope, API lock, `DeferGC`/scopes and raw cell pointers in the live frames below). Today this
   stays a leak rather than a use-after-free only because `pthread_exit` guarantees those frames are never resumed.
   Bun 1.4.5's port says the same in `src/jsc/web_worker.rs` (`on_unhandled_rejection`): returning there after
   `shutdown()` would run JSC frames "operating on a destroyed `JSC::VM`" and call `shutdown()` twice.

**Introduced by:** upstream Bun. `web_worker.zig` (`shutdown() noreturn`, `bun.exitThread()`, `worker.shutdown()` in
`onUnhandledRejection`) and `JSC__VM__holdAPILock` are the same in Bun 1.3.14 (`diff` of `src/jsc/web_worker.zig`
against `bun-v1.3.14` shows only Zig 0.16/0.17 API and `execArgv`/standalone-graph changes). Brought into this tree
by cruller `a1c009d` ("strip Bun 1.3.14 to thin zig 0.16 runtime"). Fixed upstream in the 1.4.x Rust port:
`shutdown()` returns, the thread function returns normally ("never `pthread_exit`"), `on_unhandled_rejection`
requests termination and unwinds to `spin()`, and the API lock is taken with the raw `JSC__VM__getAPILock` (no RAII
frame) and abandoned together with the destroyed VM.

### 2. Zig std's per-thread signal stack replaces ASAN's (introduced by the Zig 0.16 port)

Zig 0.16 and 0.17 std give every thread an alternate signal stack: `std.options.signal_stack_size` defaults to
`1 << 18` (`lib/std/std.zig:132`), `std.Thread.callFn` calls `maybeAttachSignalStack()` (`lib/std/Thread.zig:407`),
which does `sigaltstack()` on a `threadlocal var signal_stack: [size]u8` (`Thread.zig:1744`). `start.zig` does the
same for the main thread. Verified in the installed std of 0.16.0, 0.17.0 and 0.17.1.

ASAN's `pthread_create` interceptor has already given the thread its own `mmap`ed alt stack
(`AsanThread::ThreadStart` → `SetAlternateSignalStack`, `use_sigaltstack=1` is the default), and at thread exit
`AsanThread::Destroy` → `UnsetAlternateSignalStack` `munmap`s **whatever the current alt stack is**, assuming it is
its own. After Zig has replaced it, that is a TLS buffer.

Evidence: with mechanism 1 neutralised (below), `test-worker-nested-uncaught.js` gets past the TSD destructors and
dies in `AsanThread::Destroy` → `UnsetAlternateSignalStack` → `UnmapOrDie`:
`ERROR: AddressSanitizer failed to deallocate 0x40000 (262144) bytes at address 0x7bff58db7540 (error code: 22)`.
`0x40000` is exactly `1 << 18`; the address is not page aligned (EINVAL), as a TLS array would be and an `mmap` would
not. gdb on `sigaltstack` shows the main thread's sequence: ASAN installs its stack, then
`Thread.maybeAttachSignalStack` replaces it with a 262144-byte buffer. (Tracing the call on the Worker thread itself
under gdb hung gdb; the size match and unaligned address are the evidence for the Worker thread.) In ASAN builds,
an alt stack that happened to be page aligned would get **unmapped from under the thread's TLS**, so this is not
cosmetic.

zun's own crash handler already avoids this conflict: `crash_handler.resetOnPosix` and `resetSegfaultHandler` return
early under `bun.Environment.enable_asan` and never call `sigaltstack`. Only the Zig std one slipped in.

**Introduced by:** the port to Zig ≥ 0.16 (cruller `a1c009d`, where `src/main.zig`'s `std_options` lost Bun's
settings and std's new default started applying). Bun 1.3.14 used oven-sh's Zig fork (`ZIG_COMMIT 04e7f6ac`); not
checked whether that std attached signal stacks.

### Why it is not (b) "ASAN doesn't know the stack" or (c) "WebKit ASAN flag mismatch"

- The Worker runs on a normal `pthread_create` stack created through ASAN's interceptor (report: "Thread T12 (Worker)
  created by T0 here: pthread_create ← std.Thread.spawn"); ASAN knows its bounds and describes the address as "in
  stack of thread T12".
- The prebuilt WebKit uses the same sanitizer (`-fsanitize=address`, clang 21, from its `compile_commands.json`);
  the report's frames (`pas_deallocate`, `fireEventListeners`) are WebKit/our C++ with normal frame layouts.
- **Decisive experiment:** run the same test under gdb with a breakpoint on `pthread_exit` that calls
  `__asan_handle_no_return()` (what clang would have emitted before the `noreturn` call) and continues. The
  `stack-buffer-underflow` disappears and the thread gets through all TSD destructors; only mechanism 2 remains.
  So the memory being "overflowed" is the new frame of `pas_deallocate`, the poison is left over from abandoned frames,
  and there is no out-of-frame copy in libpas.

## Why it wasn't caught

- Upstream's ASAN CI runs a **release** ASAN build (`bun-asan`). With optimisation, `pas_deallocate` does not copy the
  1064-byte config to the stack, so the stale redzones are rarely touched before ASAN's thread teardown. And upstream's
  Zig had no per-thread alt stack. Upstream did see the leak side: about 40 worker tests are in
  `test/no-validate-leaksan.txt`.
- The Worker exit path has no test of its own; Worker tests check JS-visible behaviour, which is correct, because the
  damage is in frames that are never resumed.
- In zun the RT-3 report was cut off on stderr after the `====` banner until `log_path` was used.

## Fix (proposed; implemented, see "Implementation")

**A. Let the Worker thread return normally** (port of Bun 1.4.5's design to `src/jsc/web_worker.zig`):

1. `threadMain` (`:435`): replace `holdAPILock(this, spin)` with a raw `JSC__VM__getAPILock(vm)` followed by a direct
   call to `this.spin()`. Never release it: `shutdown()` destroys the VM that owns the lock, so a `JSLockHolder`
   destructor would unlock freed memory. Same at the other entry (`:427`, `:478`): call `shutdown()` and `return`.
2. `shutdown()` (`:660`): return type `void`, and remove `bun.exitThread()` (`:738`). `dispatchExit` stays the last
   thing that touches `this`. The thread function then returns into `std.Thread`'s trampoline and `start_thread`, so
   TSD destructors run on a clean stack.
3. `spin()`: each `this.shutdown();` (`:554 :573 :580 :587 :595 :641`) becomes `return this.shutdown();`. Comments
   saying "unreachable" after `shutdown()` go away.
4. `onUnhandledRejection` (`:781`): dispatch the error (inside a `fromJSHostCallGeneric` scope, as 1.4.5 does),
   `setRequestedTerminate()`, `vm.jsc_vm.notifyNeedTermination()`, then **return**. The termination exception unwinds
   the JS frames normally, and `spin()`'s loop (`:625-630`, it checks `hasRequestedTerminate()` after every tick) falls
   through to `shutdown()` at the top of the stack. Keep the 1.4.5 detail that the worker's process `'exit'`
   handlers run before termination is requested (exit code 1).
5. After this, `bun.exitThread()` has no callers on POSIX; delete it, or keep it Windows-only if something needs it.

This removes the cause: no C++ frame is ever abandoned, so there is no stale shadow, no skipped `~JSLockHolder`, and
no VM teardown under live frames. It is not a suppression: nothing is hidden from ASAN, and ASAN keeps checking the
whole exit path.

**B. Don't give threads a Zig signal stack under ASAN** (`src/main.zig` `std_options`):

```zig
pub const std_options = std.Options{
    .enable_segfault_handler = false,
    // ASAN installs and later munmaps its own per-thread sigaltstack; a second owner makes it unmap our TLS.
    .signal_stack_size = if (_bun.Environment.enable_asan) null else (std.Options{}).signal_stack_size,
};
```

(Verified on 0.17.1: `docs/zig/probes/signal-stack/options.zig` prints `262144`, or `null` when the condition is true.) Release
builds keep the per-thread alt stack, which lets the crash handler run on Zig-spawned threads after a stack overflow.
ASAN builds use ASAN's per-thread alt stack, which ASAN owns from creation to `munmap`. This gives the resource a
single owner, as the crash handler already does under ASAN. It does not silence any report.

## Implementation (prepared, unverified)

Branch `t3/fix-worker-thread-exit`.

- **A, `src/jsc/web_worker.zig`.**
  - `threadMain`: the early-terminate path is `return this.shutdown();`. `startVM()` now returns `!bool`; `false`
    means its first checkpoint (before the VM exists) already ran `shutdown()`, and `threadMain` returns without
    touching `this`. Otherwise `threadMain` takes the API lock with `vm.getAPILock()` (raw `JSC__VM__getAPILock`, no
    C++ frame stays live) and calls `spin()` directly, then returns into `std.Thread`'s trampoline.
  - `spin()`: every exit is `return this.shutdown();`. New check after the entry point has loaded: if termination
    was requested during top-level evaluation (`process.exit()`, `terminate()`, or an uncaught error, which now only
    requests termination) it shuts down before `'online'`, as the old `noreturn` path did.
  - `shutdown()`: returns `void`; `bun.exitThread()` removed.
  - `onUnhandledRejection`: dispatches the error inside `fromJSHostCallGeneric` (the C++ throw scope in
    `SerializedScriptValue::create` must be checked now that we return through C++ frames, as in 1.4.5), then
    `setRequestedTerminate()` + `vm.jsc_vm.notifyNeedTermination()` and returns. The termination exception unwinds
    the JS; `spin()` checks `hasRequestedTerminate()` after every tick and after the entry point, and `shutdown()`
    runs the worker's `'exit'` handlers once (it clears the termination request first, as for `terminate()`).
    Exit codes are unchanged (`uncaughtException` sets 1 before calling the handler; the default
    unhandled-rejection path leaves the code as it was, as before).
- **A, `src/jsc/bindings/webcore/Worker.cpp` `WebWorker__teardownJSCVM`.** The API lock is released **exactly
  once**, here, in `~JSLockHolder`'s order: `RELEASE_ASSERT` that this thread holds it, keep a `RefPtr<JSLock>`,
  drop every remaining `VM` reference (count-independent loop, as 1.4.5's `destroyVM`; the old code assumed two
  derefs plus the abandoned `JSLockHolder`'s), so `~VM` runs with the lock held, then `apiLock->unlock()` (which
  also restores the thread's `AtomStringTable`). Bun 1.4.5 instead abandons the lock together with the VM; releasing
  it in the destructor order is what WebKit's own `JSLockHolder` does and leaves no locked `JSLock` behind.
- **B, `src/main.zig`.** `.signal_stack_size = if (_bun.Environment.enable_asan) null else (std.Options{}).signal_stack_size`
  (`Environment.enable_asan` = `build_options.enable_asan`, `src/bun_core/env.zig:58`).
  Crash reporting under ASAN: `crash_handler.resetOnPosix`/`resetSegfaultHandler` return early under
  `enable_asan`, so zun installs no SEGV handler and no alt stack there; ASAN's own SEGV handler reports stack
  overflows on the per-thread alt stack ASAN creates in its `pthread_create` interceptor (`use_sigaltstack=1`
  default) and on the main thread at init. So ASAN builds keep stack-overflow reports. Release builds keep std's
  per-thread alt stack, which the crash handler relies on for Zig-spawned threads (the crash handler's own 512 KiB
  `sigaltstack` is installed only on the thread that calls `init`).

### Exit paths after the fix

All paths end with `threadMain` returning. "Lock" = the API lock taken in `threadMain`.

| Path | Who reaches `shutdown()` | Lock released by | VM destroyed by | Worker (`this`) freed by |
|---|---|---|---|---|
| Terminated before start (`threadMain` check) | `threadMain` | never taken | no VM | parent, on the close task from `dispatchExit` |
| Terminated in `startVM` before `initWorker` | `startVM` (returns `false`) | never taken | no VM | parent, close task |
| Terminated after `initWorker`, `configureDefines` error | `spin()` first check | `teardownJSCVM` | `teardownJSCVM` (`~VM`), then `vm.deinit()` (Zig VM) + arena | parent, close task |
| Entry point fails to resolve or load | `spin()` | `teardownJSCVM` | same | parent, close task |
| Normal end (event loop drains) | `spin()` after the loop | `teardownJSCVM` | same | parent, close task |
| `process.exit(n)` in the worker | `exit()` requests termination; `spin()` loop break, or the new post-load check | `teardownJSCVM` | same | parent, close task |
| `worker.terminate()` (busy loop too) | `notifyNeedTermination` → termination exception unwinds JS; `spin()` loop break / post-load check | `teardownJSCVM` | same | parent, close task |
| Uncaught exception / unhandled rejection | `onUnhandledRejection` requests termination and returns; `spin()` (`!handled` branch, post-load check, or loop break) | `teardownJSCVM` | same | parent, close task |
| Error in `startVM` (OOM, `initWorker` error) | none: `Output.panic` ends the process (unchanged) | n/a | n/a | n/a |

`dispatchExit` stays the last step that touches `this`; nothing after `shutdown()` returns touches it.

### Open risks (to check on the first build)

- The count-independent deref loop forces `~VM` even if some C++ object still holds a `RefPtr<VM>`; 1.4.5 accepts
  the same. The old code's actual count at teardown was not measured (gdb 17 fails on the snapshot's DWARF).
- `flushLogs` panics on `error.JSTerminated`; it runs before `shutdown()` with the termination request still set
  when `vm.log` has messages. Pre-existing for `terminate()`/`process.exit()`; now also reachable after an uncaught
  error with pending log messages.
- `VirtualMachine.uncaughtException` calls `process.exit()` then `@panic` for nested uncaught exceptions and
  `exit_on_uncaught_exception`; in a worker `process.exit()` returns, so that `@panic` is reachable from a worker.
  Pre-existing, unchanged by this fix; logged here.

## Regression test

- `test/js/node/test/parallel/test-zun-worker-thread-exit.js`: three Workers ending by draining the event loop, by
  `process.exit(3)` and by an uncaught error, with JS-visible checks (exit codes, `'error'` event). **Fails on the
  snapshot** (`kCurrentStackFrameMagic` CHECK after the first worker, exit 1). It should pass once A and B are in.
  It also covers B, since every Worker thread exits through `AsanThread::Destroy`. Extended with the paths that
  run with JS frames live or after `'online'`: `process.exit()` from a timer, an uncaught error from a timer, an
  unhandled rejection, and `terminate()` during a busy loop. Passes on Node 26; on the snapshot it still dies with
  the `kCurrentStackFrameMagic` CHECK (exit 1).
- Existing: `test-worker-nested-uncaught.js` and the other 46 tests in TQ-3 should move from SANITIZER/CRASH to
  their real result.

## Sibling search

- `rg 'exitThread\(' src`: the only caller is `web_worker.zig:738`. No other `pthread_exit`/`ExitThread` in
  `src/` (Windows `ExitThread` lives in the same helper).
- Other `noreturn` calls from Zig that can sit above live C++ frames: `bun.Global.exit`, `Output.panic`, `@panic`.
  These end the **process**, so no code runs on the stale stack except `atexit` handlers (which run below the live
  frames). Not affected. LSan at exit scans stacks but ignores shadow.
- Other threads that **exit** and were spawned with `std.Thread.spawn` would hit mechanism 2 at
  `AsanThread::Destroy`. Thread-pool, HTTP and watcher threads live for the whole process in the tests seen so far;
  any short-lived `std.Thread` would show the same `failed to deallocate 0x40000` report. Fix B covers them all.
- `JSC__VM__holdAPILock` is also used on the main thread, where it returns normally. Fine.
- Re-checked with the fix (2026-11-27): after A, the only `exitThread()` caller is
  `bun.maybeHandlePanicDuringProcessReload` (`src/bun.zig:1568`), reached from the crash handler's `panic` when
  another thread is re-`exec`ing the process. It abandons the panicking thread's frames (possibly C++) but the
  process image is replaced right after, so nothing runs on the stale stack except TSD destructors; left as is,
  noted here. `std.Thread.spawn` users (`HTTPThread`, `io`, `Debugger`, `fs_events`, `path_watcher`, `ThreadPool`,
  `Watcher`, `direct_host`, `Terminal`, `process`): none ends with `pthread_exit` or a `noreturn` call from Zig;
  `HTTPThread.processEvents` is `noreturn` only as an infinite loop for the process's life, and `process.zig`'s
  `Global.exit` ends the process. No napi thread ends from Zig (napi threadsafe functions run on the JS thread).

## Lessons

- A `noreturn` call from **Zig** never gets clang's `__asan_handle_no_return()`. Leaving C/C++ frames by a
  non-local exit from Zig (`pthread_exit`, `longjmp`, a hand-rolled stack switch) leaves stale ASAN shadow, and on any
  build it skips C++ destructors. Added to `docs/zig/lessons.md`.
- Zig ≥ 0.16 std attaches a TLS alt signal stack to every `std.Thread` and the main thread (`signal_stack_size`).
  Anything else that manages alt stacks (ASAN, a crash handler) must agree on who owns it. Added to
  `docs/zig/lessons.md`.
- An ASAN `HINT: this may be a false positive if your program uses some custom stack unwind mechanism` is a pointer to
  a real non-local exit in our own code, not a reason to suppress.
