'use strict';

const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { describeChildExit, hasExited, terminateChild, waitForPortState, waitForStartupWindow } = require('./process-lifecycle');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Negotiate SOCKS5 and make a domain CONNECT request to localhost. Pinned tpws
// deliberately rejects local destinations with REP=2 (tpws_conn.c,
// proxy_mode_connect_remote). That complete response proves its event loop and
// request parser and resolver worker ran; it does not prove external forwarding
// or DPI bypass. An IPv4 CONNECT would miss macOS resolver-stack crashes.
// If local forwarding is supported, verify our endpoint's unpredictable body.
// Only the local localhost name is resolved; no external sites, system proxy,
// pf or privilege changes are involved.
function requestThroughSocks(proxyPort, targetPort, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    let settled = false;
    const finish = (err, check) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolve(check);
    };
    const timer = setTimeout(() => finish(new Error('SOCKS runtime: таймаут локального запроса')), timeoutMs);
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.once('error', finish);
    socket.once('end', () => finish(new Error('SOCKS runtime: соединение закрыто до ответа')));
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 16384) return finish(new Error('SOCKS runtime: слишком большой ответ'));
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5 || buffer[1] !== 0) return finish(new Error('SOCKS runtime: неверное приветствие'));
        buffer = buffer.subarray(2);
        stage = 'connect';
        const hostname = Buffer.from('localhost', 'ascii');
        socket.write(Buffer.concat([
          Buffer.from([5, 1, 0, 3, hostname.length]), hostname,
          Buffer.from([targetPort >> 8, targetPort & 255])
        ]));
      }
      if (stage === 'connect') {
        if (buffer.length < 5) return;
        if (buffer[0] !== 5 || buffer[2] !== 0) return finish(new Error('SOCKS runtime: неверный ответ CONNECT'));
        const length = buffer[3] === 1 ? 10 : buffer[3] === 4 ? 22 : buffer[3] === 3 ? 7 + buffer[4] : 0;
        if (!length) return finish(new Error('SOCKS runtime: неверный адрес ответа'));
        if (buffer.length < length) return;
        if (buffer[1] === 2) return finish(null, 'socks5-local-policy');
        if (buffer[1] !== 0) return finish(new Error(`SOCKS runtime: CONNECT отклонён (REP=${buffer[1]})`));
        buffer = buffer.subarray(length);
        stage = 'http';
        socket.write('GET /runtime-check HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      }
      if (stage === 'http' && buffer.toString().includes(`\r\n\r\n${token}`)) finish(null, 'loopback-http');
    });
  });
}

async function probeSocksRuntime(binaryPath, options = {}) {
  const { timeoutMs = 5000, spawnImpl = spawn } = options;
  const token = randomBytes(24).toString('hex');
  const sockets = new Set();
  const target = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${token.length}\r\nConnection: close\r\n\r\n${token}`));
  });
  const reservation = net.createServer();
  let child;
  let stderrTail = '';
  let result;
  let spawnError;
  try {
    const targetPort = await listen(target);
    const proxyPort = await listen(reservation);
    await close(reservation);
    const args = ['--socks', '--bind-addr=127.0.0.1', `--port=${proxyPort}`];
    child = spawnImpl(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', (err) => { spawnError = err; });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (data) => { stderrTail = (stderrTail + data.toString()).slice(-2000); });
    const deadline = Date.now() + timeoutMs;
    const listening = await waitForPortState(proxyPort, true, timeoutMs, {
      intervalMs: 25,
      shouldAbort: () => Boolean(spawnError) || hasExited(child)
    });
    if (spawnError) throw spawnError;
    if (hasExited(child)) throw new Error(describeChildExit(child, stderrTail));
    if (!listening) throw new Error('SOCKS runtime: таймаут запуска listener');
    const check = await requestThroughSocks(proxyPort, targetPort, token, Math.max(1, deadline - Date.now()));
    if (hasExited(child)) throw new Error(describeChildExit(child, stderrTail));
    result = { ok: true, check };
  } catch (err) {
    // A reset can precede the OS exit notification by a few milliseconds.
    // Collect that evidence before controlled cleanup changes signalCode.
    if (child && !spawnError) await waitForStartupWindow(child, 100, { intervalMs: 10 });
    const exited = child && hasExited(child);
    result = {
      ok: false,
      reason: spawnError ? spawnError.message : exited ? describeChildExit(child, stderrTail) : err.message,
      ...(exited && child.signalCode ? { signal: child.signalCode } : {})
    };
  } finally {
    // Our normal SIGTERM/SIGKILL must never become a crash diagnosis.
    if (child && !(await terminateChild(child))) {
      result = { ok: false, reason: 'SOCKS runtime: не удалось остановить проверочный процесс' };
    }
    for (const socket of sockets) socket.destroy();
    if (target.listening) await close(target);
    if (reservation.listening) await close(reservation);
  }
  return result;
}

module.exports = { probeSocksRuntime };
