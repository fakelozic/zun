# TQ-10: extra stdio `"pipe"` fds of `child_process.spawn` have two owners and get closed twice

- **Status:** **fixed and verified 2026-11-27** (port of Bun 1.4.5 `"socket-fd"`, see "Fix (implemented)"). `test-zun-spawn-extra-pipe-double-close.js` passes; `test-net-socket-constructor` no longer hits EBADF/panic and now fails only on TQ-8 (forked child launcher). The `spawn.test.ts` cases need `bun:test` (Phase 4) to run. Earlier note:
  (no build slot). Keep open until the integration owner builds it and the regression test passes.
- **Severity:** high, security-relevant. The second `close()` happens when the GC finalizes the `Subprocess`, at an
  unpredictable time. By then the fd number has often been reused, so **zun closes an unrelated fd**: a file, a
  listening socket, a TLS connection, an epoll fd. Release builds do this silently. Only debug builds notice, and only
  when the number has *not* been reused (EBADF assertion → panic). Possible outcomes are data written to the wrong
  file or socket after the number is reused again, and dropped connections.
- **Found by / date:** parity harness 2026-11-26 (`test-net-socket-constructor`); RCA 2026-11-26 on the snapshot
  `build/snap-0a5b26b/zun-debug`.

## Symptom

In the parity run, `test-net-socket-constructor` (cluster child with `stdio: ['pipe','pipe','pipe','ipc','pipe',
'pipe','pipe']`, child fails early because of TQ-8) ends with
`debug warn: close(21[BADF]) = EBADF. This is an indication of a file descriptor UAF` and
`panic(main thread): reached unreachable code`.

Minimal reproduction, without cluster, IPC or TQ-8:

```sh
echo 'process.exit(0)' > child-exit.js
cat > s4.js <<'EOF'
const { spawn } = require('child_process');
const cp = spawn(process.execPath, [__dirname + '/child-exit.js'],
                 { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
cp.on('close', c => console.log('close', c));
EOF
BUN_DESTRUCT_VM_ON_EXIT=1 zun-debug s4.js; echo $?
# close 0
# debug warn: close(11[BADF]) = EBADF. This is an indication of a file descriptor UAF
# panic(main thread): reached unreachable code                                   → 132
```

Variations: `['pipe','pipe','pipe','pipe']` and the 7-slot cluster layout fail the same way.
`['pipe','pipe','pipe']` and `['pipe','pipe','pipe','ipc']` pass. One extra `"pipe"` slot is enough.
`BUN_DESTRUCT_VM_ON_EXIT=1` (set by `scripts/parity.ts` and upstream's runner for leak checking) only makes the
finalizer run deterministically at exit. Without it the double close still happens whenever GC collects the
`Subprocess` (see the regression test, which uses `Bun.gc(true)`).

The debug log shows the whole life of the fd:

```
[sys] socketpair() = [11 12]
[sys] posix_spawn_bun(...) = 0
[sys] close(12[socket:[…]])            ← child end, closed after spawn (correct)
[socket] onOpen …                       ← child_process wraps fd 11 in a net.Socket (uSockets adopts it)
[uws] us_socket_close(…) / [socket] onClose   ← socket closed: uSockets close()s fd 11  (1st close)
close 0
[subprocess] finalize
[subprocess] finalizeStreams
debug warn: close(11[BADF]) = EBADF …   ← Subprocess closes fd 11 again                (2nd close)
```

## Root cause

For an extra stdio slot (index ≥ 3) set to `"pipe"`, the parent end of the socketpair ends up with two owners:

1. **Native `Subprocess`.** `spawnProcessPosix` (`src/runtime/api/bun/process.zig:1558-1576`, the `.ipc, .buffer`
   arm) creates the socketpair and records the parent end as `extra_fds.append(.{ .owned_fd = fds[0] })`. The
   `ExtraPipe` doc (`process.zig:1196-1205`) says an `owned_fd` is closed by `finalizeStreams`, and
   `Subprocess.finalizeStreams` does that (`src/runtime/api/bun/subprocess.zig:775-784`, `.owned_fd => |fd| fd.close()`).
   `Subprocess.getStdio` (`subprocess.zig:494-504`) also hands the raw number to JS as `subprocess.stdio[i]`.
2. **The JS `net.Socket`.** `ChildProcess#getBunSpawnIo` (`src/js/node/child_process.ts:1214-1219`) takes that number
   and does `NetModule.connect({ fd })`. The socket adopts the fd in uSockets, which closes it when the socket closes.
   `hasSocketsToEagerlyLoad` (`:1314`, `:1389`) makes this happen for every spawn with ≥ 3 stdio entries.

The socket closes first (child exits → EOF → socket end/close → `close(11)`). The `Subprocess` closes the same number
later, from its GC finalizer. `FD.close()` (`src/sys/fd.zig:236`) only asserts in debug builds; in release builds
`close()` on a reused number succeeds and closes someone else's fd.

The IPC slot had the same double-owner problem and was fixed upstream by moving ownership: after uSockets adopts the
IPC fd, `js_bun_spawn_bindings.zig:839-840` sets `stdio_pipes[ipc_channel] = .unavailable` ("uws owns the fd now
(owns_fd=1); neutralize the slot so finalizeStreams doesn't double-close"). The plain `"pipe"` slots never got the
same treatment.

**Introduced by:** upstream Bun. `subprocess.zig`, the `ExtraPipe` union and `child_process.ts` are byte-identical to
`bun-v1.3.14` except Zig 0.16/0.17 syntax (`diff` against the tag). Carried into this tree by cruller `a1c009d`.
**Fixed upstream by 1.4.5** (the exact upstream commit was not identified; shallow clone): `child_process.ts` maps
`"pipe"` at i ≥ 3 to a new Bun.spawn stdio mode `"socket-fd"` (async spawn, non-Windows only), and the native side
stores that slot as `UnownedFd`. JS then has the only owner, and `finalize_streams` never touches it (see
`src/js/node/child_process.ts` in `bun-v1.4.5`, the comment above `bunStdio[i] = "socket-fd"`).

## Why it wasn't caught

- The double close is only **visible** in debug builds, and only when the fd number was not reused in between. Release
  builds and the "reused" case are silent.
- The second close happens in a GC finalizer. Without `BUN_DESTRUCT_VM_ON_EXIT=1` a short test usually exits before
  the `Subprocess` is collected. The only test that hit it, `test-net-socket-constructor`, failed for an unrelated
  reason first (TQ-8), so the report was read as fallout.
- No test checked that fds survive a `Subprocess` being finalized.

## Fix (implemented, not yet built/verified): port the Bun 1.4.5 ownership handoff

Implemented after reading 1.4.5's `spawn/stdio.rs`, `spawn_sys/spawn_process.rs`, `js_bun_spawn_bindings.rs`,
`subprocess/{Readable,Writable}.rs`, `child_process.ts` and its `spawn.test.ts`. One deliberate difference from the
proposal below, taken from 1.4.5: the slot is **not** recorded as `.unowned_fd` at spawn time. It starts as
`.owned_fd` like `"pipe"`, and is downgraded to `.unowned_fd` only after the last fallible step of `Bun.spawn`.
That keeps a single owner on every path:

| Path | Who closes the parent end |
|------|---------------------------|
| `posix_spawn` / setup fails | `to_close_on_error` in `spawnProcessPosix` (unchanged) |
| `Writable.init` (stdin) fails | `finalizeStreams()` in its error arm (slot still `.owned_fd`) |
| JS exception / stdin or stdout/stderr `start()` fails after `toJS` | the `Subprocess` GC finalizer → `finalizeStreams` (slot still `.owned_fd`; JS never got the Subprocess) |
| Success | the caller, via `.stdio[i]`; `finalizeStreams` skips `.unowned_fd` |
| Child exits early | no change: process exit does not touch `stdio_pipes`; the caller still owns the fd |
| `child_process` never creates the socket | fd leaks (no double close). See "Residual" below |

Changes:

- `src/runtime/api/bun/spawn/stdio.zig`: new `Stdio.socket_fd`. `extract` parses `"socket-fd"`, throws
  `'socket-fd' is only supported at indices >= 3` for i < 3 and `'socket-fd' cannot be used with spawnSync` for sync
  spawns (same messages as 1.4.5). `toPosix` maps it to `SpawnOptions.Stdio.socket_fd`; `toWindows` maps it to a
  plain libuv pipe (`.buffer`), as 1.4.5 does. `isPiped`/`canUseMemfd` treat it as not piped (1.4.5 same).
- `src/runtime/api/bun/process.zig`: `PosixSpawnOptions.Stdio.socket_fd`. The extra-fd loop handles it like
  `.buffer` (socketpair, non-blocking parent end, child end `dup2`'d) and records `.owned_fd`. The stdin/stdout/stderr
  loop panics on it (unreachable by `extract`; a panic rather than `unreachable` keeps release builds defined).
- `src/runtime/api/bun/subprocess/{Readable,Writable}.zig`: panic prongs for the same unreachable case.
- `src/runtime/api/bun/js_bun_spawn_bindings.zig`: after the last error return (just before the abort listener, the
  same place as 1.4.5), every `extra_fds[j] == .socket_fd` slot whose `stdio_pipes[j]` is `.owned_fd` becomes
  `.unowned_fd`. POSIX only.
- `src/js/node/child_process.ts`: `#spawn` rewrites `bunStdio[i] === "pipe"` to `"socket-fd"` for i >= 3 when not on
  Windows; `#getBunSpawnIo` and `#createStdioObject` accept `"socket-fd"` next to `"pipe"`. `spawnSync` unchanged.
- `packages/bun-types/bun.d.ts`: documents `"socket-fd"` and who owns `.stdio[i]`.

**Bun.spawn surface:** `"socket-fd"` is reachable from `Bun.spawn` too, as in 1.4.5 (it is in 1.4.5's public
`bun.d.ts`). Existing `Bun.spawn` users are unaffected: `"pipe"` behaves as before.

**Not ported (open question):** 1.4.5 also changed `Subprocess.getStdio` to downgrade *every* `.owned_fd` slot to
`.unowned_fd` once `.stdio` is read ("reading this property transfers ownership of any `pipe` fds to the caller"),
which also fixes the `Bun.spawn` sibling below, at the cost of leaking the fd for callers who read `.stdio` and never
close it. That changes existing `Bun.spawn` semantics, so it was left out of this change; decide separately.

**Residual (same as 1.4.5):** if `child_process` gets the `Subprocess` back but never wraps the fd (an exception in
`#spawn` between `Bun.spawn` and the eager `this.stdio` read at the end of the `try`, or `net.connect({ fd })`
throwing), nobody owns the fd and it leaks until exit. A leak, never a close of someone else's fd.

### Original proposal (kept for the record)

1. `src/runtime/api/bun/spawn/stdio.zig` (~`:346`): accept the string `"socket-fd"` as a new `Stdio` variant
   (`.socket_fd`, POSIX only; on Windows fall back to `.pipe` or reject it). In the `asSpawnOption` mapping (~`:189`)
   map it to a new `SpawnOptions.Stdio.socket_fd`.
2. `src/runtime/api/bun/process.zig` `spawnProcessPosix` extra-fd loop (`:1540-1584`): `.socket_fd` does exactly what
   `.buffer` does (socketpair, non-blocking parent end, child end `dup2`'d and closed), except it records
   `extra_fds.append(.{ .unowned_fd = fds[0] })`. `to_close_on_error` already covers `fds[0]` if spawn fails, so the
   pre-spawn error path keeps a single owner.
3. `src/js/node/child_process.ts` `#spawn` (after `getBunStdioFromOptions(stdio)`, `:1297`): when
   `process.platform !== "win32"`, rewrite `bunStdio[i] === "pipe"` to `"socket-fd"` for `i >= 3`. Accept
   `"socket-fd"` next to `"pipe"` in `#getBunSpawnIo` (`:1214`) and `#createStdioObject`. Leave `spawnSync` alone:
   it never wraps extra fds, so they stay `owned_fd` and are still closed by `finalizeStreams`.

This removes the cause: each fd has exactly one owner at every point (the `Subprocess` until JS takes it, then the
socket), which is the rule the IPC slot already follows. It does not add a "close unless already closed" check. That
would be wrong anyway, because the number may already belong to someone else.

Bun.spawn users who wrap `proc.stdio[N]` in their own socket or stream hit the same double ownership. With the fix
they can pass `"socket-fd"` to opt into owning it; document that next to `stdio` in the Bun.spawn docs.

## Regression test

`test/js/node/test/parallel/test-zun-spawn-extra-pipe-double-close.js`: spawns a child with
`['ignore','ignore','ignore','pipe']`, waits for `close`, destroys `stdio[3]`, then opens 8 files so the released
number is reused (it asserts it was), forces GC (`Bun.gc(true)` ×10), and checks every file fd is still open.
**Fails on the snapshot**: `AssertionError: … fd 12 was closed behind our back` (silent close of a reused fd, the
release-build failure mode, reproduced on the debug build). Re-checked 2026-11-26 on `snap-0a5b26b`: still fails. It
should pass once the fix is built.

Also added (from 1.4.5's `spawn.test.ts`) to `test/js/bun/spawn/spawn.test.ts`, `describe("stdio 'socket-fd'")`:
rejected at i < 3, rejected with `spawnSync`, and a caller-owned fd that is still readable after the child exits and
closed only by the caller.
`test-net-socket-constructor` also needs TQ-8 fixed before it can pass.

## Sibling search

Searched for native code that hands a raw fd number to JS while keeping ownership, and for JS that adopts fd numbers:
`rg 'jsNumber\([a-z_.]*fd' src/runtime src/jsc`, `rg '\{ ?fd[ ,}:]|\.stdio\[' src/js`.

- **IPC stdio slot** (`js_bun_spawn_bindings.zig:839`): already hands off correctly (`.unavailable`).
- **SCM_RIGHTS fds received over IPC** (`src/jsc/ipc.zig`): handed to JS with `bun.take(&incoming_fd)` (single owner,
  OK). **Not covered by the `"socket-fd"` fix** (different code path). **Separate finding (leak, not double close):** `onFd` (`ipc.zig:1347-1350`) overwrites an already-stashed
  `incoming_fd` and only logs "overwriting". The earlier fd leaks, so an IPC peer that sends several fds per handle
  message can exhaust the process's fds. Same as upstream 1.3.14. Logged in `docs/security/known-issues.md` (IPC-1).
- **`memfd_create` binding** (`node_fs_binding.zig:227`): returns a fresh fd, owned by JS only. OK.
- **`process.stdin/stdout/stderr`** (`BunProcess.cpp:2604`, `ProcessObjectInternals.ts`): fds 0-2, which
  `FD.close` refuses to close (`closeAllowingBadFileDescriptor` skips stdio). OK.
- **`Socket.fd` getters** (`sockets.classes.ts:99, :274`) and `net.Socket({ fd })` / `server.listen({ fd })`
  (`net.ts`, `Ipc.ts:221`, `cluster/RoundRobinHandle.ts:32`): adopting a number the user got from another live
  owner gives double ownership by user choice. Node behaves the same. Not a zun bug; documentation only.
- **`Bun.spawn` `stdio[N]`** for extra `"pipe"` slots: native-owned by design. Users wrapping it themselves hit this
  bug. They can now opt into `"socket-fd"`; the 1.4.5 "reading `.stdio` transfers ownership" change that would fix it
  for plain `"pipe"` is not ported (open question above).

## Lessons

- When native code gives JS a raw fd number, it has to say who owns it, and the owner has to change in one place
  (the IPC slot shows how: `.unavailable` after the handoff). A raw fd number in a getter is a red flag.
- `FD.close()`'s EBADF assertion only catches the lucky case. Tests for fd ownership must reuse the number and check
  the new owner survives, as the regression test does.
