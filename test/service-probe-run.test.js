'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runServiceProbes } = require('../src/main/service-probe-run');

const YT_HOME = 'https://www.youtube.com/';
const YT_VIDEO = 'https://redirector.googlevideo.com/';
const DC_API = 'https://discord.com/api/v10/gateway';
const DC_CDN = 'https://cdn.discordapp.com/embed/avatars/0.png';

// Builds probe functions that pass exactly the listed urls, and records the
// order in which they were called.
function probes(passing, calls = []) {
  const run = (url) => {
    calls.push(url);
    return Promise.resolve(passing.includes(url));
  };
  return { screen: run, full: run, calls };
}

test('everything passing is a full outcome', async () => {
  const { screen, full } = probes([YT_HOME, YT_VIDEO, DC_API, DC_CDN]);
  const { outcome, failed } = await runServiceProbes({ screen, full });

  assert.equal(outcome.level, 'full');
  assert.deepEqual(failed, []);
});

test('Discord blocked, YouTube fine — a partial result instead of a rejection', async () => {
  const { screen, full } = probes([YT_HOME, YT_VIDEO]);
  const { outcome, failed } = await runServiceProbes({ screen, full });

  assert.equal(outcome.level, 'partial');
  assert.deepEqual(outcome.services, { youtube: true, discord: false });
  assert.deepEqual(failed, ['Discord API']);
});

test('YouTube blocked, Discord fine — the mirror case is also partial', async () => {
  const { screen, full } = probes([DC_API, DC_CDN]);
  const { outcome } = await runServiceProbes({ screen, full });

  assert.deepEqual(outcome.services, { youtube: false, discord: true });
});

test('a service that fails screening does not pay for the expensive probe', async () => {
  const calls = [];
  const { screen, full } = probes([DC_API, DC_CDN], calls);
  await runServiceProbes({ screen, full });

  assert.ok(calls.includes(YT_VIDEO), 'дешёвая проба YouTube всё же выполняется');
  assert.ok(!calls.includes(YT_HOME), 'страница YouTube не скачивается для мёртвой службы');
});

test('when both services fail screening nothing else runs at all', async () => {
  const calls = [];
  const { screen, full } = probes([], calls);
  const { outcome } = await runServiceProbes({ screen, full });

  assert.equal(outcome.level, 'none');
  assert.deepEqual(calls.sort(), [DC_API, YT_VIDEO].sort());
});

test('a failing gateway WebSocket disqualifies Discord even when HTTP passed', async () => {
  const { screen, full } = probes([YT_HOME, YT_VIDEO, DC_API, DC_CDN]);
  const { outcome, failed } = await runServiceProbes({
    screen,
    full,
    discordExtra: async () => false
  });

  assert.equal(outcome.services.discord, false);
  assert.equal(outcome.services.youtube, true);
  assert.ok(failed.includes('Discord gateway (WebSocket)'));
});

test('the gateway check is skipped when Discord is already out', async () => {
  let called = false;
  const { screen, full } = probes([YT_HOME, YT_VIDEO]);
  await runServiceProbes({
    screen,
    full,
    discordExtra: async () => { called = true; return true; }
  });

  assert.equal(called, false);
});

test('failures are reported by human label, for the log and the error text', async () => {
  const { screen, full } = probes([YT_VIDEO, DC_API]);
  const { failed } = await runServiceProbes({ screen, full });

  assert.deepEqual(failed.sort(), ['Discord CDN', 'YouTube Web']);
});

test('what is logged names the probes that failed', async () => {
  const entries = [];
  const { screen, full } = probes([YT_HOME, YT_VIDEO]);
  await runServiceProbes({ screen, full, log: (e) => entries.push(e) });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'warning');
  assert.match(entries[0].message, /Discord API/);
});

test('a clean run logs nothing', async () => {
  const entries = [];
  const { screen, full } = probes([YT_HOME, YT_VIDEO, DC_API, DC_CDN]);
  await runServiceProbes({ screen, full, log: (e) => entries.push(e) });

  assert.deepEqual(entries, []);
});
