'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createMacNetworkSettings } = require('../src/main/mac-network-settings');

const cleanDns = ['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4'];

function service(dns = [], proxy = {}) {
  return {
    dns,
    proxy: { enabled: false, server: '', port: 0, authenticated: false, ...proxy }
  };
}

function fakeNetwork(t, services = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-network-test-'));
  const journal = path.join(dir, 'restore.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { location: 'Automatic', services, calls: [], beforeCommand: () => {} };

  function run(command, name, ...args) {
    state.calls.push([command, name, ...args]);
    state.beforeCommand(command, name, ...args);
    if (command === '-getcurrentlocation') return state.location;
    if (command === '-listallnetworkservices') {
      const names = Object.entries(state.services).map(([name, entry]) => entry.disabled ? `*${name}` : name);
      return ['An asterisk (*) denotes that a network service is disabled.', ...names].join('\n');
    }
    const entry = state.services[name];
    if (!entry) throw new Error(`Unknown service: ${name}`);
    switch (command) {
      case '-getdnsservers':
        return entry.dns.length ? entry.dns.join('\n') : `There aren't any DNS Servers set on ${name}.`;
      case '-setdnsservers':
        entry.dns = args[0] === 'Empty' ? [] : args;
        break;
      case '-getsocksfirewallproxy':
        return `Enabled: ${entry.proxy.enabled ? 'Yes' : 'No'}\nServer: ${entry.proxy.server}\nPort: ${entry.proxy.port}\nAuthenticated Proxy Enabled: ${Number(entry.proxy.authenticated)}`;
      case '-setsocksfirewallproxy':
        entry.proxy = { enabled: true, server: args[0], port: Number(args[1]), authenticated: args[2] === 'on' };
        break;
      case '-setsocksfirewallproxystate':
        entry.proxy.enabled = args[0] === 'on';
        break;
      default:
        assert.fail(`Unexpected networksetup command: ${command}`);
    }
  }

  return { journal, state, open: () => createMacNetworkSettings(journal, run) };
}

test('cleanup with no journal does not read or alter any system settings', (t) => {
  const { state, open } = fakeNetwork(t, { 'Wi-Fi': service(['9.9.9.9']) });
  assert.deepEqual(open().restore(), { ok: true });
  assert.deepEqual(state.calls, []);
});

test('a new process can restore original DNS and SOCKS from the journal', (t) => {
  const office = { enabled: true, server: 'socks.example.test', port: 1081, authenticated: false };
  const wifi = service(['9.9.9.9', '2001:db8::53'], office);
  const ethernet = service();
  const { journal, state, open } = fakeNetwork(t, { 'Wi-Fi': wifi, Ethernet: ethernet });
  const settings = open();
  state.beforeCommand = (command, name) => {
    if (!command.startsWith('-set')) return;
    const snapshots = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.ok(snapshots.some((entry) => entry.service === name &&
      entry.kind === (command === '-setdnsservers' ? 'dns' : 'proxy')));
  };
  assert.deepEqual(settings.setDns(['Wi-Fi', 'Ethernet']), { applied: 2, changed: 2 });
  assert.deepEqual(settings.setProxy(['Wi-Fi', 'Ethernet'], 1080), { applied: 2, changed: 2 });
  assert.deepEqual(wifi.dns, cleanDns);
  assert.equal(wifi.proxy.server, '127.0.0.1');
  assert.equal(settings.hasPending(), true);

  const recovered = open();
  assert.deepEqual(recovered.restore(), { ok: true });
  assert.deepEqual(wifi.dns, ['9.9.9.9', '2001:db8::53']);
  assert.deepEqual(wifi.proxy, office);
  assert.deepEqual(ethernet.dns, []);
  assert.equal(ethernet.proxy.enabled, false); // no prior endpoint: local SOCKS is disabled
  assert.equal(recovered.hasPending(), false);
  state.calls.length = 0;
  assert.deepEqual(recovered.restore(), { ok: true });
  assert.deepEqual(state.calls, []);
});

test('cleanup preserves outside changes and applying SOCKS leaves authenticated proxies alone', (t) => {
  const wifi = service(['9.9.9.9']);
  const office = service([], { enabled: true, server: 'auth.example.test', port: 8080, authenticated: true });
  const { state, open } = fakeNetwork(t, { 'Wi-Fi': wifi, Office: office });
  const settings = open();
  settings.setDns(['Wi-Fi']);
  assert.deepEqual(settings.setProxy(['Wi-Fi', 'Office'], 1080), { applied: 1, changed: 1 });
  assert.equal(office.proxy.authenticated, true);
  assert.equal(office.proxy.server, 'auth.example.test');

  const vpn = { enabled: true, server: 'vpn.example.test', port: 9000, authenticated: false };
  wifi.proxy = vpn;
  wifi.dns = ['192.0.2.53'];
  state.calls.length = 0;
  assert.deepEqual(settings.restore(), { ok: true });
  assert.deepEqual(wifi.proxy, vpn);
  assert.deepEqual(wifi.dns, ['192.0.2.53']);
  assert.ok(state.calls.every(([command]) => !command.startsWith('-set')));
});

test('another process retries a partly restored disabled proxy and failed DNS', (t) => {
  const previous = { enabled: false, server: 'old.example.test', port: 1081, authenticated: false };
  const wifi = service(['9.9.9.9'], previous);
  wifi.disabled = true; // a listed disabled service is still present for restore
  const { state, open } = fakeNetwork(t, { 'Wi-Fi': wifi });
  const settings = open();
  settings.setDns(['Wi-Fi']);
  settings.setProxy(['Wi-Fi'], 1080);
  state.beforeCommand = (command) => {
    if (command === '-setsocksfirewallproxystate' || command === '-setdnsservers') throw new Error('restore failed');
  };
  assert.equal(settings.restore().ok, false);
  assert.equal(settings.hasPending(), true);
  assert.equal(wifi.proxy.server, previous.server);
  assert.equal(wifi.proxy.enabled, true);
  assert.deepEqual(wifi.dns, cleanDns);

  state.beforeCommand = () => {};
  const recovered = open();
  assert.deepEqual(recovered.restore(), { ok: true });
  assert.deepEqual(wifi.proxy, previous);
  assert.deepEqual(wifi.dns, ['9.9.9.9']);
  assert.equal(recovered.hasPending(), false);
});

test('a renamed service remains in the journal without touching the new name or blocking another connection', (t) => {
  const wifi = service(['9.9.9.9']);
  const ethernet = service();
  const { state, open } = fakeNetwork(t, { 'Wi-Fi': wifi, Ethernet: ethernet });
  const settings = open();
  settings.setDns(['Wi-Fi']);
  settings.setProxy(['Wi-Fi'], 1080);
  state.services.Office = wifi;
  delete state.services['Wi-Fi'];
  state.calls.length = 0;
  assert.deepEqual(settings.restore(), { ok: true, pendingService: true });
  assert.equal(settings.hasPending(), true);
  assert.ok(state.calls.every(([, name]) => name !== 'Office'));
  assert.deepEqual(settings.setDns(['Ethernet']), { applied: 1, changed: 1 });
  assert.deepEqual(settings.setProxy(['Ethernet'], 1080), { applied: 1, changed: 1 });
  assert.deepEqual(settings.restore(), { ok: true, pendingService: true });
  assert.deepEqual(ethernet.dns, []);
  assert.equal(ethernet.proxy.enabled, false);

  state.services['Wi-Fi'] = wifi;
  delete state.services.Office;
  assert.deepEqual(open().restore(), { ok: true });
  assert.deepEqual(wifi.dns, ['9.9.9.9']);
  assert.equal(wifi.proxy.enabled, false);
  assert.equal(settings.hasPending(), false);
});

test('switching network locations defers restoration until the original location is active', (t) => {
  const home = service(['9.9.9.9']);
  const office = service(['192.0.2.53']);
  const { state, open } = fakeNetwork(t, { 'Wi-Fi': home });
  const settings = open();
  settings.setDns(['Wi-Fi']);
  state.location = 'Office';
  state.services = { 'Wi-Fi': office };
  assert.deepEqual(settings.restore(), { ok: true, pendingLocation: true });
  assert.deepEqual(office.dns, ['192.0.2.53']);
  state.location = 'Automatic';
  state.services = { 'Wi-Fi': home };
  assert.deepEqual(open().restore(), { ok: true });
  assert.deepEqual(home.dns, ['9.9.9.9']);
});
