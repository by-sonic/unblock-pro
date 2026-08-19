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
const { spawn } = require('child_process');

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
// `shouldAbort` lets the caller stop waiting the moment the wait is pointless —
// e.g. the process that was supposed to bind the port has already died. Without
// it, a process that dies instantly still costs the full timeout per attempt.
async function waitForPortState(port, wantOpen, timeoutMs, options = {}) {
  const {
    host = '127.0.0.1',
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    probe = probePort,
    shouldAbort = null,
    sleep = delay,
    now = Date.now
  } = options;

  const deadline = now() + timeoutMs;
  for (;;) {
    if (await probe(port, { host }) === wantOpen) return true;
    if (shouldAbort && shouldAbort()) return false;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

// Sit out a startup grace period, returning early the moment the child dies.
// Resolves true if it is still alive when the window closes, false if it died.
//
// Needed where there is no port to poll (Windows `winws` works at driver level):
// a blind fixed pause charged every rejected strategy the full wait, which over
// ~50 strategies is most of the time the run takes.
async function waitForStartupWindow(child, timeoutMs, options = {}) {
  const {
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleep = delay,
    now = Date.now
  } = options;

  const deadline = now() + timeoutMs;
  for (;;) {
    if (hasExited(child)) return false;
    const remaining = deadline - now();
    if (remaining <= 0) return true;
    await sleep(Math.min(intervalMs, remaining));
  }
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
    // `child.kill()` reports a failed signal delivery (EPERM, and other
    // platform-specific cases) asynchronously as an 'error' event, not as a
    // throw. An 'error' event with no listener is rethrown by EventEmitter and
    // would take down the main process, so this primitive must not depend on the
    // caller having attached one.
    child.once('error', () => finish(hasExited(child)));

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

// Turns a dead child into something a user or a bug report can act on.
// A signal is not an exit code: reporting `код: null` for a SIGKILLed process
// hid the real cause, which on Apple Silicon is almost always the kernel
// refusing to run an unsigned binary.
function describeChildExit(child, stderrTail = '', platform = process.platform) {
  const stderrLine = String(stderrTail).trim().split('\n').filter(Boolean).pop();
  if (stderrLine) return stderrLine;

  const signal = child.signalCode;
  if (!signal) return `код выхода: ${child.exitCode}`;

  if (signal === 'SIGKILL' && platform === 'darwin') {
    return 'убит системой (SIGKILL) — вероятно, macOS отклонила подпись бинарника';
  }
  return `сигнал: ${signal}`;
}

// Runs the binary once before the strategy loop. If it cannot execute at all,
// iterating dozens of strategies just repeats the same failure and reports it as
// "ни одна стратегия не сработала", which sends everyone looking at the wrong
// thing. A non-zero exit still counts as success — it proves the binary ran.
function probeBinaryRuns(binaryPath, options = {}) {
  const { args = ['--help'], timeoutMs = 5000, platform = process.platform } = options;

  return new Promise((resolve) => {
    let stderrTail = '';
    let killedByUs = false;
    let child;

    try {
      child = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, reason: e.message });
      return;
    }

    const timer = setTimeout(() => {
      killedByUs = true;
      try { child.kill('SIGKILL'); } catch (e) {}
    }, timeoutMs);

    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-500); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, reason: err.message }); });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Our own timeout kill means it ran (and hung), which is not the failure
      // this check is looking for.
      if (signal && !killedByUs) {
        resolve({
          ok: false,
          signal,
          reason: describeChildExit({ exitCode: code, signalCode: signal }, stderrTail, platform)
        });
        return;
      }
      resolve({ ok: true });
    });
  });
}

module.exports = {
  DEFAULT_GRACE_MS,
  DEFAULT_KILL_TIMEOUT_MS,
  describeChildExit,
  hasExited,
  probeBinaryRuns,
  probePort,
  terminateChild,
  waitForPortState,
  waitForStartupWindow
};
