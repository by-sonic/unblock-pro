'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  HOSTS_DATA,
  HOSTS_DATA_SHA256,
  HOSTS_SOURCE_COMMIT,
  HOSTS_SOURCE_URL
} = require('../src/main/hosts-data');
const { validateHostsPayload } = require('../scripts/sync-hosts-data');

test('the shipped data matches its own recorded checksum', () => {
  const actual = crypto.createHash('sha256').update(HOSTS_DATA, 'utf8').digest('hex');
  assert.equal(actual, HOSTS_DATA_SHA256);
});

test('the source is pinned to a full commit, not to a branch', () => {
  assert.match(HOSTS_SOURCE_COMMIT, /^[0-9a-f]{40}$/);
  assert.ok(HOSTS_SOURCE_URL.includes(HOSTS_SOURCE_COMMIT));
  assert.ok(!/\/(main|master|HEAD)\//.test(HOSTS_SOURCE_URL), HOSTS_SOURCE_URL);
});

test('every shipped line is a plain hosts mapping', () => {
  assert.deepEqual(validateHostsPayload(HOSTS_DATA), []);
});

test('the validator rejects what must never reach a privileged write', () => {
  assert.ok(validateHostsPayload('1.2.3.4 example.com\nrm -rf /').length > 0, 'команда');
  assert.ok(validateHostsPayload('not-an-address example.com').length > 0, 'не адрес');
  assert.ok(validateHostsPayload('1.2.3.4 exa mple.com|evil').length > 0, 'мусорное имя');
  assert.ok(validateHostsPayload('1.2.3.4').length > 0, 'адрес без имени');
});

test('the validator accepts comments, blanks and IPv6', () => {
  assert.deepEqual(validateHostsPayload('# comment\n\n::1 localhost\n1.2.3.4 a.example.com b.example.com'), []);
});

test('the stale single-IP voice pin is gone', () => {
  // 2800 lines pointed every Discord voice region at one Cloudflare address.
  // When it went stale, voice hung on "connecting" forever and a reinstall did
  // not help, because the block stayed in hosts. Upstream removed those entries;
  // this asserts we do not reintroduce them.
  assert.ok(!HOSTS_DATA.includes('104.25.158.178'), 'закреплённый адрес голосовых серверов вернулся');
  assert.ok(!/\.discord\.media/.test(HOSTS_DATA), 'записи discord.media вернулись');
});

test('the block stays small enough to read in a diff', () => {
  const lines = HOSTS_DATA.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.ok(lines.length > 0, 'блок не пустой');
  assert.ok(lines.length < 300, `блок разросся до ${lines.length} строк — проверьте, что именно синхронизировали`);
});
