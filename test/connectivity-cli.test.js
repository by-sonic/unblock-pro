'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { BODY_SAMPLE_BYTES, PROBE_RULES } = require('../src/main/connectivity-probes');
const { probeHttps, probeGateway, runDiagnostics } = require('../scripts/run-connectivity-tests');

function stream() {
  const value = new EventEmitter();
  value.destroyed = false;
  value.destroy = () => { value.destroyed = true; };
  return value;
}

function responseRequest(status, body, ending = 'end') {
  const req = stream();
  const res = stream();
  res.statusCode = status;
  return { req, res, request: (_url, _options, callback) => {
    process.nextTick(() => {
      callback(res);
      res.emit('data', body);
      if (ending) res.emit(ending);
    });
    return req;
  } };
}

test('HTTP diagnostics reject ISP pages and HTTP errors, and use production service signatures', async () => {
  const bodies = [Buffer.from('ytcfg = {}'), Buffer.alloc(0), Buffer.from('{"url":"wss://gateway.discord.gg"}'), Buffer.from('89504e470d0a1a0a', 'hex')];
  for (const [i, rule] of PROBE_RULES.entries()) {
    const fixture = responseRequest(rule.statuses[0], bodies[i]);
    assert.equal((await probeHttps(rule.url, fixture)).ok, true, rule.kind);
    assert.equal(fixture.req.destroyed, true);
    assert.equal(fixture.res.destroyed, true);
    assert.equal((await probeHttps(rule.url, responseRequest(200, Buffer.from('blocked')))).ok, false, rule.kind);
    assert.equal((await probeHttps(rule.url, responseRequest(403, bodies[i]))).ok, false, rule.kind);
  }
});

test('HTTP deadline covers pending DNS and body stalls; incomplete responses fail', async () => {
  const req = stream();
  const pending = await probeHttps(PROBE_RULES[0].url, { timeoutMs: 15, request: () => req });
  assert.equal(pending.error, 'total-timeout');
  assert.equal(req.destroyed, true);
  const stalled = await probeHttps(PROBE_RULES[0].url, { ...responseRequest(200, Buffer.from('ytcfg'), null), timeoutMs: 15 });
  assert.equal(stalled.error, 'total-timeout');
  const aborted = await probeHttps(PROBE_RULES[0].url, responseRequest(200, Buffer.from('ytcfg'), 'aborted'));
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error, 'response-aborted');
});

test('HTTP diagnostics stop reading at the production body sample limit', async () => {
  const body = Buffer.alloc(BODY_SAMPLE_BYTES * 2, 32);
  body.write('ytcfg');
  const fixture = responseRequest(200, body, null);
  const result = await probeHttps(PROBE_RULES[0].url, fixture);
  assert.equal(result.ok, true);
  assert.equal(result.bytes, BODY_SAMPLE_BYTES);
  assert.equal(fixture.res.destroyed, true);
});

function upgradeRequest(valid) {
  const req = stream();
  const socket = stream();
  return { req, socket, request: (_url, options) => {
    const accept = crypto.createHash('sha1').update(options.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    process.nextTick(() => req.emit('upgrade', { statusCode: 101, headers: {
      upgrade: 'websocket', connection: 'keep-alive, Upgrade', 'sec-websocket-accept': valid ? accept : 'fake'
    } }, socket));
    return req;
  } };
}

test('WebSocket needs a verified 101 upgrade challenge response, not just status text', async () => {
  const fixture = upgradeRequest(true);
  const result = await probeGateway(fixture);
  assert.equal(result.ok, true);
  assert.equal(result.status, 101);
  assert.equal(fixture.socket.destroyed, true);
  const invalid = await probeGateway(upgradeRequest(false));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'invalid-websocket-handshake');
});

test('WebSocket rejects ordinary HTTP and bounds DNS without a socket', async () => {
  const req = stream();
  const res = stream();
  res.statusCode = 200;
  const ordinary = await probeGateway({ request: () => {
    process.nextTick(() => req.emit('response', res));
    return req;
  } });
  assert.equal(ordinary.ok, false);
  assert.equal(ordinary.error, 'websocket-upgrade-rejected');
  assert.equal(res.destroyed, true);
  const pending = await probeGateway({ timeoutMs: 15, request: () => stream() });
  assert.equal(pending.error, 'total-timeout');
});

test('JSON report covers all four production HTTP endpoints and WebSocket without claiming playback or voice', async () => {
  const urls = [];
  const report = await runDiagnostics({ httpProbe: async (url) => {
    urls.push(url);
    return { url, ok: true };
  }, gatewayProbe: async () => ({ ok: false, error: 'total-timeout' }) });
  assert.deepEqual(urls, PROBE_RULES.map((rule) => rule.url));
  assert.equal(report.results.length, 5);
  assert.equal(report.allEndpointChecksPassed, false);
  assert.match(report.limitation, /video playback, Discord voice.*not verified/);
  assert.equal(JSON.parse(JSON.stringify(report)).schemaVersion, 1);
});
