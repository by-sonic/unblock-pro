'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { legacyBlockData } = require('../src/main/hosts-legacy');
const { HOSTS_DATA } = require('../src/main/hosts-data');
const { planHostsRemoval } = require('../src/main/system-files');

const MARKER = '# UnblockPro Discord/Telegram hosts';

// A block as releases up to 2.0.20 left it: an opening marker, the payload, and
// no closing sentinel — the shape whose extent can only be found by walking the
// lines and stopping at the first hostname that is not ours.
function legacyHostsFile() {
  return [
    '127.0.0.1 localhost',
    '255.255.255.255 broadcasthost',
    '10.0.0.5 nas.local',
    '',
    `${MARKER} v2.0.20`,
    legacyBlockData(),
    '',
    '192.168.1.50 printer',
    ''
  ].join('\n');
}

test('the legacy payload is what those versions actually wrote', () => {
  const data = legacyBlockData();

  assert.ok(data.includes('104.25.158.178 finland10000.discord.media'));
  assert.ok(data.includes('149.154.167.220 t.me'));
  // The blank separator between the two sections is part of the shape.
  assert.ok(data.includes('\n\n'));
  assert.equal(data.split('\n').filter((l) => l.includes('.discord.media')).length, 2800);
});

test('a block from 2.0.20 is removed whole, user entries intact', () => {
  const hosts = legacyHostsFile();

  const plan = planHostsRemoval(hosts, MARKER, legacyBlockData());

  assert.equal(plan.changed, true, plan.reason);
  assert.ok(!plan.next.includes('discord.media'), 'ни одной осиротевшей строки Discord');
  assert.ok(!plan.next.includes('149.154.167.220'), 'ни одной осиротевшей строки Telegram');
  assert.ok(!plan.next.includes(MARKER), 'маркер убран');
  assert.ok(plan.next.includes('127.0.0.1 localhost'));
  assert.ok(plan.next.includes('10.0.0.5 nas.local'));
  assert.ok(plan.next.includes('192.168.1.50 printer'), 'строка под блоком уцелела');
});

// This is why hosts-legacy.js exists at all. The shipped list no longer carries
// the voice entries, so matching an old block against it ends the block at its
// first line: the marker goes, the 2800 lines stay — unmarked and forever.
test('matching an old block against the current list would leave it behind', () => {
  const hosts = legacyHostsFile();

  const wrong = planHostsRemoval(hosts, MARKER, HOSTS_DATA);

  const leftovers = wrong.changed
    ? wrong.next.split('\n').filter((l) => l.includes('.discord.media')).length
    : hosts.split('\n').filter((l) => l.includes('.discord.media')).length;

  assert.ok(leftovers > 0, 'ожидалось, что чужой список не сможет ограничить блок');
});

test('a current block still removes cleanly without the legacy list', () => {
  const { replaceMarkedBlock } = require('../src/main/system-files');
  const hosts = replaceMarkedBlock('127.0.0.1 localhost\n', MARKER, '2.0.21', HOSTS_DATA);

  const plan = planHostsRemoval(hosts, MARKER, legacyBlockData());

  assert.equal(plan.changed, true, plan.reason);
  assert.equal(plan.next, '127.0.0.1 localhost\n');
});
