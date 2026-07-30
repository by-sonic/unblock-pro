'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildBlockMarker,
  hasCurrentBlock,
  hasMarkedBlock,
  isSafeHostsRewrite,
  parsePfEnableToken,
  removeMarkedBlock,
  replaceMarkedBlock
} = require('../src/main/system-files');

const MARKER = '# UnblockPro Discord/Telegram hosts';

test('parses the pf enable token so it can be released on disconnect', () => {
  assert.equal(parsePfEnableToken('pf enabled\nToken : 12345678901234567890'), '12345678901234567890');
  assert.equal(parsePfEnableToken('Token: 42'), '42');
  assert.equal(parsePfEnableToken('pf already enabled'), null);
  assert.equal(parsePfEnableToken(''), null);
  assert.equal(parsePfEnableToken(null), null);
});

test('detects an existing block regardless of version', () => {
  const withOld = `127.0.0.1 localhost\n\n${MARKER} v2.0.18\n1.2.3.4 finland10000.discord.media\n`;

  assert.equal(hasMarkedBlock(withOld, MARKER), true);
  assert.equal(hasCurrentBlock(withOld, MARKER, '2.0.18'), true);
  // The version-aware check is what lets a stale block be refreshed instead of
  // trusted forever — Discord voice IPs rotate.
  assert.equal(hasCurrentBlock(withOld, MARKER, '2.0.19'), false);
  assert.equal(hasMarkedBlock('127.0.0.1 localhost\n', MARKER), false);
});

test('removing a block leaves unrelated entries untouched', () => {
  const hosts = [
    '##',
    '# Host Database',
    '##',
    '127.0.0.1 localhost',
    '255.255.255.255 broadcasthost',
    '',
    '# my own entry',
    '10.0.0.5 nas.local',
    '',
    `${MARKER} v2.0.18`,
    '1.2.3.4 finland10000.discord.media',
    '1.2.3.4 finland10001.discord.media',
    ''
  ].join('\n');

  const cleaned = removeMarkedBlock(hosts, MARKER);

  assert.ok(cleaned.includes('127.0.0.1 localhost'));
  assert.ok(cleaned.includes('10.0.0.5 nas.local'), 'user entries must survive');
  assert.ok(cleaned.includes('# my own entry'));
  assert.ok(!cleaned.includes('discord.media'), 'our entries must be gone');
  assert.ok(!cleaned.includes(MARKER));
  assert.equal(hasMarkedBlock(cleaned, MARKER), false);
});

test('removing is a no-op when no block is present', () => {
  const hosts = '127.0.0.1 localhost\n';
  assert.equal(removeMarkedBlock(hosts, MARKER), hosts);
});

test('removing twice is idempotent', () => {
  const hosts = `127.0.0.1 localhost\n\n${MARKER} v1\n1.2.3.4 a.discord.media\n`;
  const once = removeMarkedBlock(hosts, MARKER);
  assert.equal(removeMarkedBlock(once, MARKER), once);
});

test('replacing a stale block does not stack duplicates', () => {
  const hosts = `127.0.0.1 localhost\n\n${MARKER} v2.0.18\n1.1.1.1 finland10000.discord.media\n`;

  const updated = replaceMarkedBlock(hosts, MARKER, '2.0.19', '9.9.9.9 finland10000.discord.media');

  const markerCount = updated.split('\n').filter((l) => l.includes(MARKER)).length;
  assert.equal(markerCount, 1, 'exactly one marker after replace');
  assert.ok(updated.includes('9.9.9.9 finland10000.discord.media'), 'new IP present');
  assert.ok(!updated.includes('1.1.1.1'), 'stale IP gone');
  assert.ok(updated.includes('127.0.0.1 localhost'), 'system entries kept');
  assert.equal(hasCurrentBlock(updated, MARKER, '2.0.19'), true);
});

test('replacing on a file without a block simply appends', () => {
  const updated = replaceMarkedBlock('127.0.0.1 localhost\n', MARKER, '2.0.19', '9.9.9.9 a.discord.media');

  assert.ok(updated.startsWith('127.0.0.1 localhost\n'));
  assert.equal(hasCurrentBlock(updated, MARKER, '2.0.19'), true);
  assert.ok(updated.endsWith('\n'), 'hosts file must end with a newline');
});

test('repeated replaces never grow the file unboundedly', () => {
  let hosts = '127.0.0.1 localhost\n';
  for (let i = 0; i < 5; i++) {
    hosts = replaceMarkedBlock(hosts, MARKER, `2.0.${i}`, `9.9.9.${i} a.discord.media`);
  }

  const markerCount = hosts.split('\n').filter((l) => l.includes(MARKER)).length;
  assert.equal(markerCount, 1);
  assert.equal(hosts.split('\n').filter((l) => l.includes('discord.media')).length, 1);
});

test('buildBlockMarker appends the version when given one', () => {
  assert.equal(buildBlockMarker(MARKER, '2.0.19'), `${MARKER} v2.0.19`);
  assert.equal(buildBlockMarker(MARKER, null), MARKER);
});

test('the hosts rewrite guard accepts a correct replacement', () => {
  const original = `127.0.0.1 localhost\n10.0.0.5 nas.local\n\n${MARKER} v1\n1.1.1.1 a.discord.media\n`;
  const next = replaceMarkedBlock(original, MARKER, '2', '9.9.9.9 a.discord.media');

  assert.equal(isSafeHostsRewrite(original, next, MARKER), true);
});

test('the hosts rewrite guard blocks anything that drops user entries', () => {
  const original = `127.0.0.1 localhost\n10.0.0.5 nas.local\n\n${MARKER} v1\n1.1.1.1 a.discord.media\n`;

  // Truncated / clobbered candidates that must never reach /etc/hosts.
  assert.equal(isSafeHostsRewrite(original, '', MARKER), false, 'empty');
  assert.equal(isSafeHostsRewrite(original, '   \n', MARKER), false, 'whitespace only');
  assert.equal(
    isSafeHostsRewrite(original, `${MARKER} v2\n9.9.9.9 a.discord.media\n`, MARKER),
    false,
    'lost every system and user line'
  );
  assert.equal(
    isSafeHostsRewrite(original, `127.0.0.1 localhost\n${MARKER} v2\n9.9.9.9 a.discord.media\n`, MARKER),
    false,
    'lost the user NAS entry'
  );
});

test('the hosts rewrite guard requires a loopback mapping to survive', () => {
  const original = '127.0.0.1 localhost\n';
  assert.equal(isSafeHostsRewrite(original, 'somehost 1.2.3.4\n', MARKER), false);
});
