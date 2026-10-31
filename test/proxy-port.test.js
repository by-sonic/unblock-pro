'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DEFAULT_PROXY_PORT, normalizeProxyPort, resolveProxyPort } = require('../src/main/proxy-port');

test('an empty field means the default port', () => {
  assert.equal(normalizeProxyPort(''), DEFAULT_PROXY_PORT);
  assert.equal(normalizeProxyPort(undefined), DEFAULT_PROXY_PORT);
  assert.equal(normalizeProxyPort('  '), DEFAULT_PROXY_PORT);
});

test('a valid port is accepted from the field or from a number', () => {
  assert.equal(normalizeProxyPort('1081'), 1081);
  assert.equal(normalizeProxyPort(65535), 65535);
  assert.equal(normalizeProxyPort(' 1024 '), 1024);
});

test('ports tpws cannot bind and non-numbers are refused with an explanation', () => {
  for (const value of ['80', '1023', '65536', '0', '-1', '10.5', '1e4', '0x500', 'порт', '1080; rm -rf /']) {
    assert.throws(() => normalizeProxyPort(value), /от 1024 до 65535/, value);
  }
});

test('a broken settings file falls back to the default instead of stopping the connection', () => {
  assert.equal(resolveProxyPort('garbage'), DEFAULT_PROXY_PORT);
  assert.equal(resolveProxyPort(undefined), DEFAULT_PROXY_PORT);
  assert.equal(resolveProxyPort(1081), 1081);
});

test('main process uses the configured port everywhere tpws and the system proxy meet', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.doesNotMatch(source, /\b1080\b/, 'tpws, the system proxy and the probe must not drift apart');
  assert.match(source, /\['--port', String\(tpwsPort\), '--socks'\]/);
  assert.match(source, /enableSystemProxy\(tpwsPort\)/);
});
