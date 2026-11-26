'use strict';
// zun regression test for TQ-3 (docs/rca/TQ-3-worker-thread-exit-under-asan.md).
//
// A Worker thread must end by returning from its thread function, not by
// pthread_exit() from inside live C++ frames (JSC__VM__holdAPILock's
// JSLockHolder, or the whole JS stack when an uncaught error ends the worker).
// On the ASAN debug build the old exit path leaves the abandoned frames'
// stack redzones poisoned; the pthread TSD destructors that run next on the
// same stack then trip `stack-buffer-underflow` (or ASAN's own
// `CHECK asan_thread.cpp:369 kCurrentStackFrameMagic`) and the process exits
// non-zero. The cases cover every way a worker ends: drain, process.exit() at top
// level and from a callback, uncaught error at top level and from a callback,
// unhandled rejection, and worker.terminate() during a busy loop.

const common = require('../common');
const assert = require('assert');
const { Worker } = require('worker_threads');

function run(source) {
  return new Promise((resolve) => {
    const w = new Worker(source, { eval: true });
    let error = null;
    w.on('error', (e) => { error = e; });
    w.on('exit', (code) => resolve({ code, error }));
  });
}

(async () => {
  // 1. Event loop runs dry.
  let r = await run('1 + 1;');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.error, null);

  // 2. process.exit() inside the worker.
  r = await run('process.exit(3);');
  assert.strictEqual(r.code, 3);

  // 3. Uncaught error (WebWorker.onUnhandledRejection path).
  r = await run('throw new Error("boom");');
  assert.strictEqual(r.code, 1);
  assert.ok(r.error instanceof Error);
  assert.strictEqual(r.error.message, 'boom');

  // 4. process.exit() from a callback, after 'online' (event-loop path).
  r = await run('setTimeout(() => process.exit(4), 1);');
  assert.strictEqual(r.code, 4);

  // 5. Uncaught error thrown from a callback, after 'online': the error ends
  //    the worker while its JS frames are live (onUnhandledRejection must not
  //    tear the VM down in place).
  r = await run('setTimeout(() => { throw new Error("late"); }, 1);');
  assert.strictEqual(r.code, 1);
  assert.ok(r.error instanceof Error);
  assert.strictEqual(r.error.message, 'late');

  // 6. Unhandled promise rejection.
  r = await run('Promise.reject(new Error("rejected"));');
  assert.strictEqual(r.code, 1);
  assert.ok(r.error instanceof Error);
  assert.strictEqual(r.error.message, 'rejected');

  // 7. worker.terminate() while the worker spins in a busy loop: the
  //    termination exception unwinds the JS frames, then the thread returns.
  await new Promise((resolve) => {
    const w = new Worker(`
      require('worker_threads').parentPort.postMessage('spinning');
      for (;;) {}
    `, { eval: true });
    w.on('error', common.mustNotCall());
    w.once('message', common.mustCall(() => { w.terminate(); }));
    w.on('exit', common.mustCall((code) => {
      // This test is about the thread ending cleanly, not the exit-code
      // parity of terminate() (Node reports 1), so only check that it exited.
      assert.strictEqual(typeof code, 'number');
      resolve();
    }));
  });
})().then(common.mustCall());
