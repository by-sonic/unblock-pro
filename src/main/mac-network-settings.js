'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isIP } = require('node:net');

const CLEAN_DNS = ['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4'];
const LOCALHOST = '127.0.0.1';

function networkSetup(...args) {
  return execFileSync('/usr/sbin/networksetup', args, {
    encoding: 'utf8', stdio: 'pipe', timeout: 5000, env: { ...process.env, LC_ALL: 'C' }
  }).trimEnd();
}

function listNetworkServices(run = networkSetup) {
  const [header, ...services] = run('-listallnetworkservices').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!header?.startsWith('An asterisk')) throw new Error('Unrecognized network service list');
  return services;
}

function readDns(run, service) {
  const output = run('-getdnsservers', service).trim();
  if (/^There aren't any DNS Servers set on .+\.$/i.test(output)) return [];
  const servers = output.split(/\s+/);
  if (!servers.every(isIP)) throw new Error('Unrecognized DNS settings');
  return servers;
}

function readProxy(run, service) {
  const output = run('-getsocksfirewallproxy', service);
  const enabled = /^Enabled:[ \t]*(Yes|No)[ \t]*$/mi.exec(output);
  const server = /^Server:[ \t]*(.*)$/m.exec(output);
  const port = /^Port:[ \t]*(\d+)[ \t]*$/m.exec(output);
  const authenticated = /^Authenticated Proxy Enabled:[ \t]*(0|1)[ \t]*$/m.exec(output);
  if (!enabled || !server || !port || !authenticated) throw new Error('Unrecognized SOCKS settings');
  const proxy = {
    enabled: enabled[1].toLowerCase() === 'yes',
    server: server[1].trim(),
    port: Number(port[1]),
    authenticated: authenticated[1] === '1'
  };
  if (!validProxy(proxy)) throw new Error('Unrecognized SOCKS settings');
  return proxy;
}

function validProxy(proxy) {
  return proxy && typeof proxy.enabled === 'boolean' && typeof proxy.server === 'string' &&
    Number.isInteger(proxy.port) && proxy.port >= 0 && proxy.port <= 65535 &&
    (proxy.port > 0 ? proxy.server.length > 0 : !proxy.enabled && !proxy.server) &&
    typeof proxy.authenticated === 'boolean';
}

function sameProxy(left, right) {
  return left.enabled === right.enabled && left.server === right.server &&
    left.port === right.port && left.authenticated === right.authenticated;
}

function sameDns(left, right) {
  return left.length === right.length && left.every((ip, index) => ip === right[index]);
}

function setProxyEndpoint(run, service, proxy) {
  // Setting the endpoint also enables SOCKS. Authentication is preserved by
  // leaving services with a saved authenticated proxy entirely alone.
  run('-setsocksfirewallproxy', service, proxy.server, String(proxy.port), 'off');
}

function validEntry(entry) {
  if (!entry || typeof entry.location !== 'string' || !entry.location ||
      typeof entry.service !== 'string' || !entry.service) return false;
  return entry.kind === 'dns'
    ? Array.isArray(entry.before) && entry.before.every(isIP) &&
      Array.isArray(entry.after) && entry.after.length > 0 && entry.after.every(isIP)
    : entry.kind === 'proxy' && validProxy(entry.before) && !entry.before.authenticated &&
      Number.isInteger(entry.port) && entry.port > 0 && entry.port <= 65535 &&
      (entry.restoring === undefined || entry.restoring === true);
}

function createMacNetworkSettings(snapshotPath, run = networkSetup) {
  function load() {
    let content;
    try {
      content = fs.readFileSync(snapshotPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const entries = JSON.parse(content);
    if (!Array.isArray(entries) || !entries.every(validEntry)) throw new Error('Invalid network settings snapshot');
    return entries;
  }

  function save(entries) {
    if (!entries.length) {
      fs.rmSync(snapshotPath, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
    const temporary = `${snapshotPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(entries), { flag: 'wx', mode: 0o600, flush: true });
      fs.renameSync(temporary, snapshotPath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  function currentLocation() {
    const location = run('-getcurrentlocation').trim();
    if (!location) throw new Error('Unrecognized network location');
    return location;
  }

  function apply(services, kind, port) {
    const result = { applied: 0, changed: 0 };
    if (!services.length) return result;
    const desiredProxy = { enabled: true, server: LOCALHOST, port, authenticated: false };
    let entries;
    let location;
    try {
      entries = load();
      location = currentLocation();
    } catch {
      return result;
    }
    for (const service of services) {
      try {
        if (entries.some((entry) => entry.kind === kind && entry.location === location && entry.service === service)) continue;
        const before = kind === 'dns' ? readDns(run, service) : readProxy(run, service);
        if (kind === 'proxy' && before.authenticated) continue;
        const unchanged = kind === 'dns' ? sameDns(before, CLEAN_DNS) : sameProxy(before, desiredProxy);
        if (!unchanged) {
          const entry = kind === 'dns'
            ? { kind, location, service, before, after: CLEAN_DNS }
            : { kind, location, service, before, port };
          // Write the original values before changing any system preferences.
          save([...entries, entry]);
          entries.push(entry);
          if (kind === 'dns') {
            run('-setdnsservers', service, ...CLEAN_DNS);
            if (!sameDns(readDns(run, service), CLEAN_DNS)) continue;
          } else {
            setProxyEndpoint(run, service, desiredProxy);
            if (!sameProxy(readProxy(run, service), desiredProxy)) continue;
          }
          result.changed++;
        }
        result.applied++;
      } catch {
        // Other services may still be configurable. A saved entry is kept even
        // if networksetup failed after partially applying a change.
      }
    }
    return result;
  }

  function restoreEntry(entry, entries) {
    const { service, before } = entry;
    if (entry.kind === 'dns') {
      const current = readDns(run, service);
      if (sameDns(current, entry.after)) {
        run('-setdnsservers', service, ...(before.length ? before : ['Empty']));
        if (sameDns(readDns(run, service), entry.after)) throw new Error('DNS settings were not restored');
      }
      return;
    }

    const current = readProxy(run, service);
    const desired = { enabled: true, server: LOCALHOST, port: entry.port, authenticated: false };
    const restoreInProgress = entry.restoring && sameProxy(current, { ...before, enabled: true });
    if (!sameProxy(current, desired) && !restoreInProgress) return;
    if (before.server && !restoreInProgress) {
      if (!before.enabled) {
        // Restoring a disabled configured proxy takes two commands. Persist the
        // halfway state so a failed second command can be retried safely.
        save(entries.map((item) => item === entry ? { ...item, restoring: true } : item));
        entry.restoring = true;
      }
      setProxyEndpoint(run, service, before);
    }
    if (!before.enabled) run('-setsocksfirewallproxystate', service, 'off');
    const restored = readProxy(run, service);
    if (sameProxy(restored, desired) ||
        (entry.restoring && sameProxy(restored, { ...before, enabled: true }))) {
      throw new Error('SOCKS settings were not restored');
    }
  }

  function restore() {
    try {
      let entries = load();
      if (!entries.length) return { ok: true };
      const location = currentLocation();
      const missingServices = new Set();
      let listedServices;
      for (const entry of [...entries]) {
        if (entry.location !== location) continue;
        try {
          restoreEntry(entry, entries);
          const remaining = entries.filter((item) => item !== entry);
          save(remaining);
          entries = remaining;
        } catch {
          // Keep failed entries for the next disconnect or launch.
          if (listedServices === undefined) {
            try { listedServices = new Set(listNetworkServices(run)); } catch { listedServices = null; }
          }
          if (listedServices && !listedServices.has(entry.service) && !listedServices.has(`*${entry.service}`)) {
            missingServices.add(entry.service);
          }
        }
      }
      if (entries.some((entry) => entry.location === location && !missingServices.has(entry.service))) {
        return { ok: false, error: 'Не удалось восстановить SOCKS-прокси или DNS. Повторите отключение.' };
      }
      const result = { ok: true };
      if (missingServices.size) result.pendingService = true;
      if (entries.some((entry) => entry.location !== location)) result.pendingLocation = true;
      return result;
    } catch {
      return { ok: false, error: 'Не удалось прочитать сохранённые настройки SOCKS-прокси и DNS.' };
    }
  }

  return {
    setDns: (services) => apply(services, 'dns'),
    setProxy: (services, port) => apply(services, 'proxy', port),
    restore,
    hasPending: () => fs.existsSync(snapshotPath)
  };
}

module.exports = { createMacNetworkSettings, listNetworkServices, networkSetup };
