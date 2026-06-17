'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FLOWSEAL_BUNDLE_MARKER,
  FLOWSEAL_BUNDLE_SHA256,
  FLOWSEAL_BUNDLE_URL,
  FLOWSEAL_BUNDLE_VERSION,
  FLOWSEAL_REQUIRED_WINDOWS_FILES,
  installBundledFlowsealBundle,
  isFlowsealBundleCurrent
} = require('../src/main/flowseal-bundle');
const {
  buildFlowsealStrategies,
  snapshot
} = require('../src/main/flowseal-strategies');

function splitProfiles(args) {
  const profiles = [];
  let profile = [];
  for (const arg of args.slice(2)) {
    if (arg === '--new') {
      profiles.push(profile);
      profile = [];
    } else {
      profile.push(arg);
    }
  }
  profiles.push(profile);
  return profiles;
}

test('pins the audited Flowseal Windows bundle', () => {
  assert.equal(FLOWSEAL_BUNDLE_VERSION, '1.9.9c');
  assert.equal(snapshot.version, FLOWSEAL_BUNDLE_VERSION);
  assert.match(FLOWSEAL_BUNDLE_URL, /releases\/download\/1\.9\.9c\/.+\.zip$/);
  assert.match(FLOWSEAL_BUNDLE_SHA256, /^[a-f0-9]{64}$/);
  assert.ok(FLOWSEAL_REQUIRED_WINDOWS_FILES.includes('quic_initial_dbankcloud_ru.bin'));
});

test('forces a refresh when an installed bundle is stale or incomplete', (t) => {
  const platformDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-pro-bundle-'));
  t.after(() => fs.rmSync(platformDir, { recursive: true, force: true }));

  for (const file of FLOWSEAL_REQUIRED_WINDOWS_FILES) {
    fs.writeFileSync(path.join(platformDir, file), 'fixture');
  }
  fs.writeFileSync(path.join(platformDir, FLOWSEAL_BUNDLE_MARKER), `${FLOWSEAL_BUNDLE_VERSION}\n`);
  assert.equal(isFlowsealBundleCurrent(platformDir), true);

  fs.rmSync(path.join(platformDir, 'quic_initial_dbankcloud_ru.bin'));
  assert.equal(isFlowsealBundleCurrent(platformDir), false);
});

test('seeds a writable Windows runtime from packaged resources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-pro-seed-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(source);

  for (const file of FLOWSEAL_REQUIRED_WINDOWS_FILES) {
    fs.writeFileSync(path.join(source, file), file);
  }
  fs.writeFileSync(path.join(source, FLOWSEAL_BUNDLE_MARKER), `${FLOWSEAL_BUNDLE_VERSION}\n`);

  assert.equal(installBundledFlowsealBundle(source, destination), true);
  assert.equal(isFlowsealBundleCurrent(destination), true);
});

test('ships every current Flowseal strategy without unresolved batch variables', () => {
  const expectedNames = [
    'ALT', 'ALT10', 'ALT11', 'ALT12', 'ALT2', 'ALT3', 'ALT4', 'ALT5', 'ALT6',
    'ALT7', 'ALT8', 'ALT9', 'FAKE TLS AUTO ALT', 'FAKE TLS AUTO ALT2',
    'FAKE TLS AUTO ALT3', 'FAKE TLS AUTO', 'SIMPLE FAKE ALT', 'SIMPLE FAKE ALT2',
    'SIMPLE FAKE', 'general'
  ];
  assert.equal(snapshot.strategies.length, 20);
  assert.deepEqual(snapshot.strategies.map((strategy) => strategy.name).sort(), expectedNames.sort());

  for (const strategy of snapshot.strategies) {
    const command = strategy.args.join(' ');
    assert.doesNotMatch(command, /%|GameFilter|-user\.txt/);
    assert.match(strategy.args[0], /,12$/);
    assert.match(strategy.args[1], /,12$/);
  }
});

test('resolves paths and keeps exact ALT9 and ALT12 profile layouts', () => {
  const strategies = buildFlowsealStrategies(path.join('C:', 'bin'), path.join('C:', 'lists'));
  assert.equal(new Set(strategies.map((strategy) => strategy.name)).size, 20);
  assert.doesNotMatch(strategies.flatMap((strategy) => strategy.args).join(' '), /\{BIN\}|\{LISTS\}/);

  const alt9 = strategies.find((strategy) => strategy.name === 'ALT9');
  const alt12 = strategies.find((strategy) => strategy.name === 'ALT12');
  assert.equal(splitProfiles(alt9.args).length, 9);
  assert.equal(splitProfiles(alt12.args).length, 9);
  assert.ok(alt9.args.includes('--dpi-desync-fooling=ts,md5sig'));
  assert.ok(alt12.args.includes('--dpi-desync=fake,multisplit'));
  assert.ok(alt12.args.some((arg) => arg.endsWith('quic_initial_dbankcloud_ru.bin')));
});
