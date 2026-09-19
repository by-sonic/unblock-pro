'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { probeSocksRuntime } = require('../src/main/mac-runtime');
const { hasExited } = require('../src/main/process-lifecycle');

async function probeFixture(mode, timeoutMs = 1500) {
  let child;
  const result = await probeSocksRuntime('fixture', {
    timeoutMs,
    spawnImpl: (_binary, args, options) => {
      assert.ok(args.includes('--socks'));
      assert.ok(args.includes('--bind-addr=127.0.0.1'));
      child = spawn(process.execPath, [path.join(__dirname, 'fixtures/socks-runtime.js'), mode, ...args], options);
      return child;
    }
  });
  assert.equal(hasExited(child), true, 'preflight must reap its child');
  return result;
}

test('SOCKS runtime preflight transfers a local HTTP response and accepts controlled shutdown', async () => {
  assert.deepEqual(await probeFixture('relay'), { ok: true, check: 'loopback-http' });
});

test('SOCKS runtime accepts the pinned tpws local-destination policy response', async () => {
  assert.deepEqual(await probeFixture('deny'), { ok: true, check: 'socks5-local-policy' });
});

test('SOCKS runtime does not accept an arbitrary failed CONNECT response', async () => {
  const result = await probeFixture('invalid-reply');
  assert.equal(result.ok, false);
  assert.match(result.reason, /REP=1/);
});

for (const mode of ['invalid-version', 'invalid-reserved', 'invalid-address', 'truncated-policy']) {
  test(`SOCKS runtime rejects ${mode} even when REP says policy denial`, async () => {
    const result = await probeFixture(mode);
    assert.equal(result.ok, false);
  });
}

test('SOCKS runtime preflight catches a process that listens then dies', async () => {
  const result = await probeFixture('crash');
  assert.equal(result.ok, false);
  // Windows exposes a process self-kill as exit code 1, POSIX as SIGKILL.
  assert.match(result.reason, process.platform === 'win32' ? /код выхода: 1/ : /SIGKILL/);
  assert.doesNotMatch(result.reason, /подпис/);
});

for (const mode of ['never-listens', 'hang']) {
  test(`SOCKS runtime preflight bounds ${mode} and does not blame its own kill on macOS`, async () => {
    const started = Date.now();
    const result = await probeFixture(mode, 250);
    assert.equal(result.ok, false);
    assert.match(result.reason, /таймаут/);
    assert.equal(result.signal, undefined);
    assert.ok(Date.now() - started < 5000);
  });
}

test('SOCKS runtime preflight reports spawn failures', async () => {
  const result = await probeSocksRuntime(path.join(__dirname, 'no-such-tpws'), { timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ENOENT/);
});
