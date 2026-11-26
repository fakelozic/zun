'use strict';
// zun regression test for TQ-10 (docs/rca/TQ-10-extra-stdio-pipe-double-close.md).
//
// An extra "pipe" stdio slot (index >= 3) of child_process.spawn() is a
// socketpair. The parent end used to have two owners: the net.Socket that
// child_process wraps around it (uSockets closes the fd when the socket
// closes) and the native Subprocess (`stdio_pipes[i] = .owned_fd`, closed
// again in finalizeStreams() when the Subprocess is garbage collected).
//
// The second close() hits whatever now has that fd number. This test reuses
// the number for a file, forces the Subprocess to be finalized, and checks the
// file's fd is still open. On a debug build the old code also panics with
// "close(N) = EBADF. This is an indication of a file descriptor UAF" when the
// number was not reused (e.g. under BUN_DESTRUCT_VM_ON_EXIT=1).

const common = require('../common');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const tmpdir = require('../common/tmpdir');

if (common.isWindows) common.skip('extra stdio is a libuv pipe handle on Windows');
if (typeof Bun === 'undefined') common.skip('checks Bun/zun Subprocess fd ownership');

tmpdir.refresh();
// A file child, not `-e`: keeps this test independent of argv handling.
const childFile = path.join(tmpdir.path, 'child-exit.js');
fs.writeFileSync(childFile, 'process.exit(0);\n');

function runOnce() {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [childFile], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    cp.on('close', common.mustCall((code) => {
      assert.strictEqual(code, 0);
      const sock = cp.stdio[3];
      assert.ok(sock, 'stdio[3] should be a socket');
      const fdNumber = sock._handle ? sock._handle.fd : undefined;
      if (!sock.destroyed) sock.destroy();
      // Let uSockets finish closing the parent end.
      setImmediate(() => resolve(fdNumber));
    }));
  });
}

(async () => {
  const fdNumber = await runOnce();

  // Take the lowest free fd numbers; one of them is the number the socket
  // just released. Keep them open across the forced finalization below.
  const files = [];
  for (let i = 0; i < 8; i++) {
    const p = path.join(tmpdir.path, `reuse-${i}.txt`);
    fs.writeFileSync(p, 'x');
    files.push(fs.openSync(p, 'r'));
  }
  if (typeof fdNumber === 'number' && fdNumber >= 0) {
    assert.ok(files.includes(fdNumber),
              `expected fd ${fdNumber} to be reused by one of ${files}`);
  }

  // Drop every reference to the ChildProcess/Subprocess and finalize it.
  for (let i = 0; i < 10; i++) {
    Bun.gc(true);
    await new Promise((r) => setImmediate(r));
  }

  // If finalizeStreams() closed the stale number again, one of these is gone.
  for (const fd of files) {
    assert.doesNotThrow(() => fs.fstatSync(fd), `fd ${fd} was closed behind our back`);
    fs.closeSync(fd);
  }
})().then(common.mustCall());
