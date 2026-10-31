'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildMacCleanupCommand, buildMacConnectCommand, runMacCleanup, runMacConnect } = require('../src/main/macos-cleanup');

const hostsCleanup = { hostsPath: '/etc/hosts', original: '127.0.0.1 localhost\n# our block\n', next: '127.0.0.1 localhost\n' };
const options = { quicBlockEnabled: true, pfEnableToken: '12345', hostsCleanup };
const markers = 'UNBLOCK_CLEANUP_PF\nUNBLOCK_CLEANUP_TOKEN\nUNBLOCK_CLEANUP_HOSTS\n';

test('cleanup returns a failing status instead of hiding errors with exit 0', () => {
  const command = buildMacCleanupCommand({ restorePf: true, releaseToken: '12345', hostsCleanup });
  assert.doesNotMatch(command, /exit 0|rm -f/);
  assert.match(command, /exit "\$cleanup_status"/);
  assert.match(command, /shasum -a 256/);
  assert.match(command, /cp .*&& printf/);
});

test('no-op cleanup does not invoke a process or elevation', async () => {
  const result = await runMacCleanup({}, { execSync: () => assert.fail(), sudoExec: () => assert.fail() });
  assert.equal(result.ok, true);
  assert.equal(result.elevated, false);
});

test('successful unprivileged cleanup never prompts', async () => {
  const result = await runMacCleanup(options, { execSync: () => markers, sudoExec: () => assert.fail() });
  assert.equal(result.ok, true);
  assert.equal(result.elevated, false);
});

test('permission failure waits for the elevation callback before succeeding', async () => {
  let callback;
  let settled = false;
  const promise = runMacCleanup(options, {
    execSync: () => { throw new Error('Permission denied'); },
    sudoExec: (command, config, done) => { callback = done; }
  }).then((result) => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false);
  callback(null, markers);
  assert.equal((await promise).ok, true);
});

test('partial success retries only failed steps and never releases a token twice', async () => {
  const result = await runMacCleanup(options, {
    execSync: () => { const error = new Error('hosts denied'); error.stdout = 'UNBLOCK_CLEANUP_PF\nUNBLOCK_CLEANUP_TOKEN\n'; throw error; },
    sudoExec: (command, config, done) => {
      assert.doesNotMatch(command, /pfctl/);
      assert.match(command, /UNBLOCK_CLEANUP_HOSTS/);
      done(null, 'UNBLOCK_CLEANUP_HOSTS\n');
    }
  });
  assert.equal(result.ok, true);
});

test('cancelled elevation keeps unrecovered state available for a later retry', async () => {
  const result = await runMacCleanup(options, {
    execSync: () => { throw new Error('Permission denied'); },
    sudoExec: (command, config, done) => done(new Error('User cancelled'))
  });
  assert.equal(result.ok, false);
  assert.equal(result.pfRestored, false);
  assert.equal(result.tokenReleased, false);
  assert.equal(result.hostsRestored, false);
  assert.equal(result.error, 'User cancelled');
});

test('exit zero without success markers does not claim cleanup succeeded', async () => {
  const result = await runMacCleanup(options, { execSync: () => '', sudoExec: (command, config, done) => done(null, '') });
  assert.equal(result.ok, false);
});

test('invalid token and unvalidated hosts bytes fail before execution', async () => {
  const deps = { execSync: () => assert.fail(), sudoExec: () => assert.fail() };
  assert.equal((await runMacCleanup({ ...options, pfEnableToken: '123; touch /tmp/oops' }, deps)).ok, false);
  assert.equal((await runMacCleanup({ hostsCleanup: { hostsPath: '/etc/hosts', tempFile: '/tmp/unsafe' } }, deps)).ok, false);
});

const hostsUpdate = { hostsPath: '/etc/hosts', original: '127.0.0.1 localhost\n', next: '127.0.0.1 localhost\n# our block\n' };
const pfConfPath = '/Users/me/Library/Application Support/UnblockPro/pf-quic-block.conf';

test('connecting runs pf and hosts in one elevated command, so one password dialog', async () => {
  const commands = [];
  const result = await runMacConnect({ pfConfPath, hostsUpdate }, {
    sudoExec: (command, config, done) => { commands.push(command); done(null, 'UNBLOCK_CONNECT_HOSTS\n', 'Token : 777\n'); }
  });
  assert.equal(commands.length, 1);
  assert.match(commands[0], /pfctl -f '.*Application Support.*pf-quic-block\.conf'/);
  assert.match(commands[0], /pfctl -E/);
  assert.match(commands[0], /shasum -a 256/);
  assert.equal(result.pfLoaded, true);
  assert.equal(result.hostsUpdated, true);
  assert.match(result.output, /Token : 777/);
});

test('nothing to change means no password dialog at all', async () => {
  const result = await runMacConnect({}, { sudoExec: () => assert.fail('must not prompt') });
  assert.equal(result.elevated, false);
  assert.equal(buildMacConnectCommand({}), null);
});

test('a hosts failure does not lose the pf rules that must be undone on disconnect', async () => {
  const result = await runMacConnect({ pfConfPath, hostsUpdate }, {
    sudoExec: (command, config, done) => done(null, '', 'Token : 5\n')
  });
  assert.equal(result.pfLoaded, true);
  assert.equal(result.hostsUpdated, false);
});

test('a dismissed password dialog changes nothing and reports it', async () => {
  const denied = new Error('User did not grant permission.');
  const result = await runMacConnect({ pfConfPath, hostsUpdate }, {
    sudoExec: (command, config, done) => done(denied)
  });
  assert.equal(result.pfLoaded, false);
  assert.equal(result.hostsUpdated, false);
  assert.equal(result.error, denied);
});

test('the connect command refuses a stale hosts plan and never touches other files', () => {
  assert.throws(() => buildMacConnectCommand({ hostsUpdate: { ...hostsUpdate, hostsPath: '/tmp/hosts' } }));
  assert.throws(() => buildMacConnectCommand({ hostsUpdate: { ...hostsUpdate, next: '  ' } }));
});
