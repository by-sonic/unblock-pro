#!/usr/bin/env node
'use strict';

// Read-only diagnostics through the current system network route. These probes
// do not install or start a strategy, or prove video playback / Discord voice.
const https = require('node:https');
const crypto = require('node:crypto');
const {
  BODY_SAMPLE_BYTES,
  PROBE_RULES,
  probeLabel,
  validateProbe
} = require('../src/main/connectivity-probes');

const TIMEOUT_MS = 12000;
const GATEWAY_URL = 'https://gateway.discord.gg/?v=10&encoding=json';
const LIMITATION = 'Endpoint checks only: video playback, Discord voice and the effect of a particular strategy are not verified. VPN/proxy routing can affect results.';

function probeHttps(url, { timeoutMs = TIMEOUT_MS, request = https.get } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let req;
    let response;
    let done = false;
    let status = 0;
    let bytes = 0;
    const chunks = [];
    const finish = (error = null) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      const body = Buffer.concat(chunks, bytes);
      const ok = !error && validateProbe(url, status, body.toString('utf8'), body.subarray(0, 8).toString('hex'));
      response?.destroy();
      req?.destroy();
      resolve({ url, label: probeLabel(url), ok, status, bytes, elapsedMs: Date.now() - started,
        error: error || (ok ? null : 'response-validation-failed') });
    };
    // Covers DNS, connection establishment and slow responses, unlike a socket timeout.
    const deadline = setTimeout(() => finish('total-timeout'), timeoutMs);
    try {
      req = request(url, {
        agent: false,
        maxHeaderSize: 16384,
        headers: { 'User-Agent': 'Mozilla/5.0 UnblockPro connectivity diagnostics', 'Accept-Encoding': 'identity' }
      }, (res) => {
        if (done) { res.destroy(); return; }
        response = res;
        status = res.statusCode || 0;
        res.on('data', (chunk) => {
          if (done) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const sample = data.subarray(0, BODY_SAMPLE_BYTES - bytes);
          chunks.push(sample);
          bytes += sample.length;
          if (bytes === BODY_SAMPLE_BYTES) finish();
        });
        res.on('end', () => finish());
        res.on('aborted', () => finish('response-aborted'));
        res.on('error', (error) => finish(error.code || 'response-error'));
        res.on('close', () => { if (!done) finish('response-closed-before-end'); });
      });
      req.on('error', (error) => finish(error.code || 'request-error'));
      req.on('close', () => { if (!done && !response) finish('request-closed-before-response'); });
    } catch (error) {
      finish(error.code || 'request-setup-error');
    }
  });
}

function probeGateway({ timeoutMs = TIMEOUT_MS, request = https.get, randomBytes = crypto.randomBytes } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let req;
    let upgradedSocket;
    let response;
    let done = false;
    const finish = (ok, error = null, status = 0) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      upgradedSocket?.destroy();
      response?.destroy();
      req?.destroy();
      resolve({ url: GATEWAY_URL, label: 'Discord Gateway WebSocket', ok, status,
        elapsedMs: Date.now() - started, error });
    };
    const deadline = setTimeout(() => finish(false, 'total-timeout'), timeoutMs);
    try {
      const key = randomBytes(16).toString('base64');
      const expectedAccept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      req = request(GATEWAY_URL, {
        agent: false,
        maxHeaderSize: 16384,
        headers: { Upgrade: 'websocket', Connection: 'Upgrade',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      });
      req.on('upgrade', (res, socket) => {
        if (done) { socket.destroy(); return; }
        upgradedSocket = socket;
        const connection = String(res.headers.connection || '').toLowerCase().split(',').map((value) => value.trim());
        const valid = res.statusCode === 101 &&
          String(res.headers.upgrade || '').toLowerCase() === 'websocket' &&
          connection.includes('upgrade') && res.headers['sec-websocket-accept'] === expectedAccept;
        finish(valid, valid ? null : 'invalid-websocket-handshake', res.statusCode || 0);
      });
      req.on('response', (res) => {
        if (done) { res.destroy(); return; }
        response = res;
        finish(false, 'websocket-upgrade-rejected', res.statusCode || 0);
      });
      req.on('error', (error) => finish(false, error.code || 'request-error'));
      req.on('close', () => { if (!done) finish(false, 'request-closed-before-upgrade'); });
    } catch (error) {
      finish(false, error.code || 'request-setup-error');
    }
  });
}

async function runDiagnostics({ httpProbe = probeHttps, gatewayProbe = probeGateway } = {}) {
  const results = await Promise.all([
    ...PROBE_RULES.map((rule) => httpProbe(rule.url)),
    gatewayProbe()
  ]);
  return { schemaVersion: 1, checkedAt: new Date().toISOString(),
    allEndpointChecksPassed: results.every((result) => result.ok), limitation: LIMITATION, results };
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/run-connectivity-tests.js [--json]\n' + LIMITATION);
    return;
  }
  if (args.some((arg) => arg !== '--json')) throw new Error('Unknown argument. Use --help.');
  const report = await runDiagnostics();
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const result of report.results) {
      console.log(`${result.label}: ${result.ok ? 'PASS' : 'FAIL'} (HTTP ${result.status}, ${result.elapsedMs} ms)${result.error ? ` — ${result.error}` : ''}`);
    }
    console.log(LIMITATION);
  }
  process.exitCode = report.allEndpointChecksPassed ? 0 : 1;
}

if (require.main === module) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});

module.exports = { GATEWAY_URL, LIMITATION, probeHttps, probeGateway, runDiagnostics };
