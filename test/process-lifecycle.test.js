'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { after, test } = require('node:test');

const {
  hasExited,
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
