'use strict';

// Process/port lifecycle helpers for the strategy-selection loop.
//
// The loop spawns one bypass process per strategy on a fixed port. Two things
// must hold before the next strategy is tried, or the run degrades into
// "ни одна стратегия не сработала":
//
//  1. The previous process is really gone. `child.kill()` only *requests* exit;
//     returning immediately leaves an orphan that keeps holding the port.
//  2. The port is released. A stale listener makes the liveness probe pass for
//     the wrong process, so a later strategy gets credited (or blamed) for
//     traffic it never handled.

const net = require('net');

const DEFAULT_PROBE_TIMEOUT_MS = 700;
const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_GRACE_MS = 1500;
const DEFAULT_KILL_TIMEOUT_MS = 3000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// True when something accepts a TCP connection on the port.
function probePort(port, { host = '127.0.0.1', timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (isOpen) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(isOpen);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    try {
      socket.connect(port, host);
    } catch (e) {
      finish(false);
    }
  });
}

// Poll until the port reaches the wanted state. Resolves false on timeout so
// callers decide whether that is fatal.
async function waitForPortState(port, wantOpen, timeoutMs, options = {}) {
  const {
    host = '127.0.0.1',
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    probe = probePort,
    sleep = delay,
    now = Date.now
  } = options;

  const deadline = now() + timeoutMs;
  for (;;) {
    if (await probe(port, { host }) === wantOpen) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

// Terminate a child and wait for the OS to reap it. SIGTERM first so the
// process can unbind its socket cleanly, SIGKILL if it ignores that.
// Resolves true when the child is confirmed gone.
function terminateChild(child, options = {}) {
  const { graceMs = DEFAULT_GRACE_MS, timeoutMs = DEFAULT_KILL_TIMEOUT_MS } = options;

  return new Promise((resolve) => {
    if (hasExited(child)) {
      resolve(true);
      return;
    }

    let settled = false;
    let graceTimer = null;
    let hardTimer = null;

    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      resolve(confirmed);
    };

    child.once('exit', () => finish(true));

    graceTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
    }, graceMs);

    hardTimer = setTimeout(() => finish(false), timeoutMs);

    try {
      child.kill('SIGTERM');
    } catch (e) {
      finish(hasExited(child));
    }
  });
}

module.exports = {
  DEFAULT_GRACE_MS,
  DEFAULT_KILL_TIMEOUT_MS,
  hasExited,
  probePort,
  terminateChild,
  waitForPortState
};
