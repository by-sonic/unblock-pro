'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// Exercise the actual production assembly without loading Electron, registering
// app handlers or changing system state. The surrounding dependencies are fakes.
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function strategyBuilder(context) {
  const start = mainSource.indexOf('function getStrategiesForPlatform()');
  const end = mainSource.indexOf('\nfunction sendStatus(', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(mainSource.slice(start, end) + '\ngetStrategiesForPlatform;', context);
}

test('installed Windows strategies use their verified bundled payloads without rewriting Program Files', () => {
  const runtime = 'C:\\Program Files\\UnblockPro\\resources\\bin';
  let seen;
  const build = strategyBuilder({
    process: { platform: 'win32' }, app: { isPackaged: true }, path: path.win32,
    getBinaryPath: () => path.win32.join(runtime, 'winws.exe'),
    getResourcePath: () => 'C:\\Users\\user\\AppData\\Roaming\\UnblockPro\\bin\\win32',
    ensureHostLists: () => 'generated-lists',
    ensureBinPatternFiles: () => assert.fail('installed payloads must not be generated or modified'),
    buildWin32Strategies: (bin, lists) => { seen = { bin, lists }; return ['actual-strategies']; },
    reorderStrategies: (items) => items
  });
  assert.deepEqual(Array.from(build()), ['actual-strategies']);
  assert.deepEqual(seen, { bin: runtime, lists: 'generated-lists' });
});

test('development strategy assembly retains its writable runtime and pattern generation', () => {
  const runtime = 'C:\\workspace\\bin\\win32';
  const generated = [];
  const build = strategyBuilder({
    process: { platform: 'win32' }, app: { isPackaged: false }, path: path.win32,
    getBinaryPath: () => path.win32.join(runtime, 'winws.exe'), getResourcePath: () => runtime,
    ensureHostLists: () => 'generated-lists', ensureBinPatternFiles: (bin) => generated.push(bin),
    buildWin32Strategies: (bin) => [bin], reorderStrategies: (items) => items
  });
  assert.deepEqual(Array.from(build()), [runtime]);
  assert.deepEqual(generated, [runtime]);
});

test('concurrent stop requests share one privileged cleanup and permit a later retry', async () => {
  const start = mainSource.indexOf('function stopProxy()');
  const end = mainSource.indexOf('\nasync function performStopProxy()', start);
  assert.ok(start >= 0 && end > start);
  let calls = 0;
  let finish;
  const context = vm.createContext({ stopPromise: null, performStopProxy: () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  } });
  const stop = vm.runInContext(mainSource.slice(start, end) + '\nstopProxy;', context);
  const first = stop();
  assert.equal(stop(), first);
  assert.equal(calls, 1);
  finish({ success: false });
  await first;
  const retry = stop();
  assert.equal(calls, 2);
  finish({ success: true });
  assert.equal((await retry).success, true);
});

test('normal quit waits for cleanup and stays open on a failed cleanup', async () => {
  const start = mainSource.indexOf("  app.on('before-quit',");
  const end = mainSource.indexOf('  // Ensure proxy cleanup on any exit scenario', start);
  assert.ok(start >= 0 && end > start);
  for (const success of [true, false]) {
    let handler;
    let finish;
    let quitCount = 0;
    let prevented = 0;
    const errors = [];
    const context = {
      quitRequested: false,
      app: { isQuitting: false, on: (_event, callback) => { handler = callback; }, quit: () => { quitCount++; } },
      stopAndWaitForSearch: () => new Promise((resolve) => { finish = resolve; }),
      dialog: { showErrorBox: (...args) => errors.push(args) }
    };
    vm.runInNewContext(mainSource.slice(start, end), context);
    handler({ preventDefault: () => { prevented++; } });
    assert.equal(prevented, 1);
    assert.equal(quitCount, 0, 'must not quit while the password/cleanup callback is pending');
    finish({ success, error: 'cleanup failure' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(quitCount, success ? 1 : 0);
    assert.equal(errors.length, success ? 0 : 1);
    assert.equal(context.quitRequested, success);
  }
});

function startLifecycle(overrides = {}) {
  const start = mainSource.indexOf('async function startProxy()');
  const end = mainSource.indexOf('\nasync function runProxyStartAttempt()', start);
  const stopStart = mainSource.indexOf('function stopProxy()');
  const stopEnd = mainSource.indexOf('\nasync function performStopProxy()', stopStart);
  assert.ok(start >= 0 && end > start && stopStart >= 0 && stopEnd > stopStart);
  const context = vm.createContext({
    stopPromise: null, cleanupFailed: false, isSearching: false, searchCompletion: null,
    quitRequested: false, quicBlockEnabled: false, pfEnableToken: null, originalDnsSettings: {},
    isConnected: false, cancelRequested: false, activeTargetUrl: '', lastError: null, lastErrorCode: null,
    updateTrayMenu: () => {}, sendStatus: () => {}, sendLog: () => {},
    loadSettings: () => ({}), normalizeTargetUrl: (value) => value,
    runProxyStartAttempt: () => assert.fail('unexpected new search'),
    ...overrides
  });
  vm.runInContext(mainSource.slice(start, end) + '\n' + mainSource.slice(stopStart, stopEnd), context);
  return context;
}

test('reconnect refuses a failed pending cleanup or a failed retry of earlier cleanup', async () => {
  for (const pending of [true, false]) {
    const failure = { success: false, error: 'password cancelled' };
    let retries = 0;
    const context = startLifecycle({
      stopPromise: pending ? Promise.resolve(failure) : null,
      cleanupFailed: !pending,
      performStopProxy: async () => { retries++; return failure; }
    });
    assert.equal(await context.startProxy(), failure);
    assert.equal(context.isSearching, false);
    assert.equal(retries, pending ? 0 : 1);
  }
});

test('stop waits for a late search mutation and cleans it again before completing', async () => {
  let finishMutation;
  let dirty = false;
  let stopped = false;
  let cleanupCalls = 0;
  const mutation = new Promise((resolve) => { finishMutation = resolve; });
  const context = startLifecycle({
    runProxyStartAttempt: async () => {
      await mutation;
      dirty = true; // delayed pf/hosts elevation callback arrives after Stop
      return { success: false };
    },
    performStopProxy: async () => {
      context.cancelRequested = true;
      dirty = false;
      cleanupCalls++;
      return { success: true };
    }
  });
  const searching = context.startProxy();
  const stopping = context.stopAndWaitForSearch().then((result) => { stopped = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, 'stop/quit must wait for the outstanding elevation callback');
  assert.equal(cleanupCalls, 1);
  finishMutation();
  await searching;
  assert.equal((await stopping).success, true);
  assert.equal(dirty, false);
  assert.ok(cleanupCalls >= 2, 'the late mutation needs a second cleanup');
  assert.equal(context.isSearching, false);
  assert.equal(context.searchCompletion, null);
});

test('cleanup invoked inside a failed search does not wait for itself and preserves its diagnostic', async () => {
  const context = startLifecycle({
    runProxyStartAttempt: async () => {
      await context.stopProxy();
      context.lastError = 'runtime failed';
      context.lastErrorCode = 'BINARY_RUNTIME_FAILED';
      return { success: false, error: context.lastError };
    },
    performStopProxy: async () => {
      context.cancelRequested = true;
      context.lastError = null;
      context.lastErrorCode = null;
      return { success: true };
    }
  });
  const result = await context.startProxy();
  assert.equal(result.error, 'runtime failed');
  assert.equal(context.lastError, 'runtime failed');
  assert.equal(context.lastErrorCode, 'BINARY_RUNTIME_FAILED');
});

test('an early failed search restores already-applied network changes even without cancellation', async () => {
  let cleaned = 0;
  const context = startLifecycle({
    runProxyStartAttempt: async () => {
      context.quicBlockEnabled = true;
      context.pfEnableToken = '1234';
      context.originalDnsSettings = { WiFi: 'original' };
      context.lastError = 'Port 1080 is occupied';
      context.lastErrorCode = 'PORT_IN_USE';
      return { success: false, error: context.lastError };
    },
    performStopProxy: async () => {
      cleaned++;
      context.quicBlockEnabled = false;
      context.pfEnableToken = null;
      context.originalDnsSettings = {};
      context.lastError = null;
      context.lastErrorCode = null;
      return { success: true };
    }
  });
  await context.startProxy();
  assert.equal(cleaned, 1);
  assert.equal(context.lastErrorCode, 'PORT_IN_USE');
  assert.equal(context.quicBlockEnabled, false);
});

test('quit prevents a new start both immediately and after an already-pending cleanup', async () => {
  const immediate = startLifecycle({ quitRequested: true });
  assert.equal((await immediate.startProxy()).success, false);
  let finish;
  const pending = startLifecycle({ stopPromise: new Promise((resolve) => { finish = resolve; }) });
  const start = pending.startProxy();
  pending.quitRequested = true;
  finish({ success: true });
  assert.equal((await start).success, false);
  assert.equal(pending.isSearching, false);
});
