'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { after, test } = require('node:test');

const {
  describeChildExit,
  hasExited,
  probeBinaryRuns,
  probePort,
  terminateChild,
  waitForPortState
} = require('../src/main/process-lifecycle');

const spawned = [];

function spawnIdleChild(extraSource = '') {
  const child = spawn(process.execPath, ['-e', `${extraSource}setInterval(() => {}, 1000);`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  spawned.push(child);
  return child;
}

function listenOnFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

after(() => {
  for (const child of spawned) {
    try { child.kill('SIGKILL'); } catch (e) {}
  }
});

test('probePort reports an open port and a closed one', async () => {
  const { server, port } = await listenOnFreePort();

  assert.equal(await probePort(port), true);

  await new Promise((resolve) => server.close(resolve));

  assert.equal(await probePort(port), false);
});

test('waitForPortState resolves once the port opens', async () => {
  const { server, port } = await new Promise((resolve) => {
    const s = net.createServer();
    // Bind late so the waiter has to poll at least once.
    setTimeout(() => s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port })), 60);
  });

  assert.equal(await waitForPortState(port, true, 2000), true);
  await new Promise((resolve) => server.close(resolve));
});

test('waitForPortState resolves false when the state never arrives', async () => {
  const { server, port } = await listenOnFreePort();

  // The port stays open, so waiting for "free" must time out rather than hang.
  assert.equal(await waitForPortState(port, false, 300, { intervalMs: 50 }), false);

  await new Promise((resolve) => server.close(resolve));
});

test('terminateChild waits for the process to actually exit', async () => {
  const child = spawnIdleChild();
  assert.equal(hasExited(child), false);

  const confirmed = await terminateChild(child);

  assert.equal(confirmed, true, 'termination should be confirmed');
  assert.equal(hasExited(child), true, 'child must be reaped before resolving');
});

test('terminateChild escalates to SIGKILL when SIGTERM is ignored', async () => {
  // SIGTERM handler that refuses to exit. On Windows SIGTERM is not catchable,
  // so this only proves escalation on POSIX; elsewhere the plain path is used.
  const child = spawnIdleChild("process.on('SIGTERM', () => {});");

  const confirmed = await terminateChild(child, { graceMs: 200, timeoutMs: 4000 });

  assert.equal(confirmed, true, 'SIGKILL escalation should still confirm exit');
  assert.equal(hasExited(child), true);
});

test('terminateChild is idempotent on an already-dead process', async () => {
  const child = spawnIdleChild();
  await terminateChild(child);

  assert.equal(await terminateChild(child), true);
});

test('a released port is observable as free right after termination', async () => {
  // The regression this guards: the loop moved to the next strategy while the
  // previous process still held the port, so the liveness probe passed for a
  // stale listener.
  const { server, port } = await listenOnFreePort();
  await new Promise((resolve) => server.close(resolve));

  const child = spawn(
    process.execPath,
    ['-e', `require('net').createServer().listen(${port}, '127.0.0.1');`],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  spawned.push(child);

  assert.equal(await waitForPortState(port, true, 5000), true, 'child should bind the port');

  await terminateChild(child);

  assert.equal(await waitForPortState(port, false, 5000), true, 'port must be free after exit');
});

test('waitForPortState bails out as soon as shouldAbort says so', async () => {
  // The regression this guards: a binary that dies instantly still cost the full
  // 8s timeout per strategy, so 15 dead strategies burned two minutes and the
  // log looked identical to a slow-but-working run.
  const { server, port } = await listenOnFreePort();
  await new Promise((resolve) => server.close(resolve));

  // Abort flips partway through, standing in for the child dying mid-wait.
  let dead = false;
  setTimeout(() => { dead = true; }, 200);

  const started = Date.now();
  const result = await waitForPortState(port, true, 8000, {
    intervalMs: 20,
    shouldAbort: () => dead
  });
  const elapsed = Date.now() - started;

  assert.equal(result, false);
  assert.ok(elapsed < 2000, `should abort near the 200ms mark, waited ${elapsed}ms`);

  // Already-dead on entry must return on the first pass.
  const quickStart = Date.now();
  assert.equal(await waitForPortState(port, true, 8000, { intervalMs: 20, shouldAbort: () => true }), false);
  assert.ok(Date.now() - quickStart < 1000, 'immediate abort must return immediately');
});

test('waitForPortState still honours its timeout when nothing aborts', async () => {
  const { server, port } = await listenOnFreePort();
  await new Promise((resolve) => server.close(resolve));

  const started = Date.now();
  assert.equal(
    await waitForPortState(port, true, 400, { intervalMs: 50, shouldAbort: () => false }),
    false
  );
  assert.ok(Date.now() - started >= 350, 'must not give up before the deadline');
});

test('describeChildExit prefers stderr, then signal, then exit code', () => {
  assert.equal(
    describeChildExit({ exitCode: 1, signalCode: null }, 'tpws: bad option --nope\n'),
    'tpws: bad option --nope'
  );
  assert.equal(describeChildExit({ exitCode: 2, signalCode: null }, ''), 'код выхода: 2');
  assert.equal(describeChildExit({ exitCode: null, signalCode: 'SIGTERM' }, ''), 'сигнал: SIGTERM');
});

test('describeChildExit names the macOS signing cause instead of "код: null"', () => {
  // A SIGKILLed process has exitCode null. Reporting that as "код: null" is what
  // made #39-style reports impossible to act on.
  const killed = { exitCode: null, signalCode: 'SIGKILL' };

  assert.match(describeChildExit(killed, '', 'darwin'), /SIGKILL/);
  assert.match(describeChildExit(killed, '', 'darwin'), /подпись/);
  assert.equal(describeChildExit(killed, '', 'win32'), 'сигнал: SIGKILL');
  assert.ok(!describeChildExit(killed, '', 'darwin').includes('null'));
});

test('probeBinaryRuns accepts a binary that runs, whatever its exit code', async () => {
  // node --help exits 0; node with a bad flag exits non-zero. Both prove the
  // binary is executable, which is all this check is about.
  assert.deepEqual(await probeBinaryRuns(process.execPath, { args: ['--help'] }), { ok: true });
  assert.deepEqual(await probeBinaryRuns(process.execPath, { args: ['--definitely-not-a-flag'] }), { ok: true });
});

test('probeBinaryRuns rejects a binary that cannot be executed', async () => {
  const result = await probeBinaryRuns(path.join(__dirname, 'no-such-binary-here'));

  assert.equal(result.ok, false);
  assert.ok(result.reason && result.reason.length > 0, 'must explain why');
});

test('probeBinaryRuns treats a hang as runnable rather than broken', async () => {
  // Our own timeout kill must not be reported as the kernel killing the binary.
  const result = await probeBinaryRuns(process.execPath, {
    args: ['-e', 'setInterval(() => {}, 1000);'],
    timeoutMs: 300
  });

  assert.deepEqual(result, { ok: true });
});
