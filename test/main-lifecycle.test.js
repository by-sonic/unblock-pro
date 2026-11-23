'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Execute the production functions with OS/Electron dependencies replaced.
// No app boot, elevation, processes, or machine network settings are involved.
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');
function loadFunctions(names, bindings) {
  const functions = names.map((name) => {
    const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
    assert.ok(match, `production function ${name} exists`);
    const end = source.indexOf('\n}', match.index);
    assert.ok(end > match.index, `production function ${name} ends`);
    return source.slice(match.index, end + 2);
  });
  const context = vm.createContext(bindings);
  vm.runInContext(functions.join('\n'), context);
  return context;
}

function stopContext(overrides = {}) {
  const calls = [];
  const bindings = {
    process: { platform: 'darwin' },
    cancelRequested: false,
    elevatedCancelFile: null,
    macNetworkSettings: { restore: () => { calls.push('network-restore'); return { ok: true }; } },
    prepareHostsRemoval: () => ({ changed: true }),
    disableQuicBlock: async () => ({ ok: true }),
    applyHostsRemovalWindows: () => ({ ok: true }),
    stopWinwsMonitor: () => {},
    proxyGeneration: 1,
    proxyProcess: { kill: () => calls.push('child-kill') },
    execSync: () => {},
    isConnected: true,
    currentStrategy: 'test',
    currentOutcome: { level: 'full' },
    connectedSince: 123,
    strategyProgress: { current: 1 },
    cleanupFailed: false,
    lastError: null,
    lastErrorCode: null,
    clearError: () => calls.push('clear-error'),
    updateTrayMenu: () => {},
    sendStatus: () => calls.push('status'),
    sendLog: (event) => calls.push(event),
    ...overrides
  };
  return { calls, context: loadFunctions(['performStopProxy', 'logPendingNetworkRestore'], bindings) };
}

test('performStopProxy waits for macOS cleanup before reporting success', async () => {
  let finishCleanup;
  const cleanup = new Promise((resolve) => { finishCleanup = resolve; });
  const { calls, context } = stopContext({ disableQuicBlock: () => cleanup });
  let settled = false;
  const stopped = context.performStopProxy().then((result) => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(context.cancelRequested, true);
  assert.equal(settled, false, 'disconnect must await the elevated cleanup callback');
  assert.deepEqual(calls, ['network-restore', 'child-kill']);
  finishCleanup({ ok: true });
  const result = await stopped;
  assert.equal(result.success, true);
  assert.equal(context.cleanupFailed, false);
  assert.equal(context.proxyProcess, null);
  assert.equal(context.isConnected, false);
  assert.ok(calls.includes('clear-error'));
});

for (const platformCleanup of ['mac', 'windows']) {
  test(`performStopProxy preserves ${platformCleanup} cleanup failure and does not claim success`, async () => {
    const failing = { ok: false, error: 'cleanup denied' };
    const overrides = platformCleanup === 'mac'
      ? { disableQuicBlock: async () => failing }
      : { applyHostsRemovalWindows: () => failing };
    const { calls, context } = stopContext(overrides);
    const result = await context.performStopProxy();
    assert.equal(result.success, false);
    assert.equal(result.error, 'cleanup denied');
    assert.equal(context.cleanupFailed, true);
    assert.equal(context.lastErrorCode, 'CLEANUP_FAILED');
    assert.equal(calls.includes('clear-error'), false);
  });
}

test('performStopProxy treats failed macOS network restoration as a cleanup failure', async () => {
  const { context } = stopContext({
    macNetworkSettings: { restore: () => ({ ok: false, error: 'DNS restore denied' }) }
  });
  const result = await context.performStopProxy();
  assert.equal(result.success, false);
  assert.equal(result.error, 'DNS restore denied');
  assert.equal(context.cleanupFailed, true);
  assert.equal(context.lastErrorCode, 'CLEANUP_FAILED');
});

test('performStopProxy warns about an unavailable network service without blocking reconnect', async () => {
  const { calls, context } = stopContext({
    macNetworkSettings: { restore: () => ({ ok: true, pendingService: true }) }
  });
  const result = await context.performStopProxy();
  assert.equal(result.success, true);
  assert.equal(context.cleanupFailed, false);
  assert.ok(calls.some((call) => call.type === 'warning' && call.message.includes('недоступна')));
});
